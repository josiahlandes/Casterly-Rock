#!/usr/bin/env python3
"""
Ollama vs MLX Inference Speed Benchmark
========================================

Compares tokens/s between:
  - Ollama (Metal, FP16 KV cache) — stock configuration
  - MLX via vllm-mlx (K8V4 KV cache) — optimized configuration

Both use the Qwen3.5-122B model at 131K context window.
Tests prefill speed and decode speed at multiple prompt sizes.

Usage:
  python scripts/benchmark-ollama-vs-mlx.py
"""

import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Optional

import urllib.request
import urllib.error

# ── Configuration ────────────────────────────────────────────────────────────

OLLAMA_URL = "http://localhost:11434"
MLX_URL = "http://localhost:8000"

OLLAMA_MODEL = "qwen3.5:122b"
MLX_MODEL = "nightmedia/Qwen3.5-122B-A10B-Text-mxfp4-mlx"

NUM_CTX = 131072  # 131K — standard extended tier

# Generate this many tokens per test
GENERATE_TOKENS = 200

# Prompt templates at different sizes
SHORT_PROMPT = """Write a Python function that implements a binary search tree with insert, delete, and search operations. Include type hints and docstrings."""

MEDIUM_PROMPT_BASE = """You are an expert software engineer. Review the following code and suggest improvements.

```python
{code}
```

Provide specific, actionable feedback on:
1. Code correctness and edge cases
2. Performance optimizations
3. Type safety improvements
4. Error handling gaps
"""

# Pad to ~4K tokens worth of "code" context
PADDING_CODE = """
class TaskScheduler:
    def __init__(self, max_workers=4, queue_size=100):
        self.max_workers = max_workers
        self.queue_size = queue_size
        self.tasks = []
        self.workers = []
        self.running = False
        self.lock = threading.Lock()
        self.condition = threading.Condition(self.lock)
        self.results = {}
        self.errors = {}
        self.retry_count = {}
        self.max_retries = 3

    def submit(self, task_id, fn, *args, **kwargs):
        with self.lock:
            if len(self.tasks) >= self.queue_size:
                raise RuntimeError("Task queue is full")
            self.tasks.append((task_id, fn, args, kwargs))
            self.condition.notify()
        return task_id

    def _worker_loop(self, worker_id):
        while self.running:
            task = None
            with self.condition:
                while self.running and not self.tasks:
                    self.condition.wait(timeout=1.0)
                if self.tasks:
                    task = self.tasks.pop(0)
            if task:
                task_id, fn, args, kwargs = task
                try:
                    result = fn(*args, **kwargs)
                    self.results[task_id] = result
                except Exception as e:
                    retries = self.retry_count.get(task_id, 0)
                    if retries < self.max_retries:
                        self.retry_count[task_id] = retries + 1
                        with self.lock:
                            self.tasks.append(task)
                    else:
                        self.errors[task_id] = str(e)

    def start(self):
        self.running = True
        for i in range(self.max_workers):
            t = threading.Thread(target=self._worker_loop, args=(i,), daemon=True)
            t.start()
            self.workers.append(t)

    def stop(self, timeout=30):
        self.running = False
        with self.condition:
            self.condition.notify_all()
        for w in self.workers:
            w.join(timeout=timeout)
        self.workers.clear()

    def get_result(self, task_id, timeout=None):
        start = time.time()
        while True:
            if task_id in self.results:
                return self.results.pop(task_id)
            if task_id in self.errors:
                raise RuntimeError(self.errors.pop(task_id))
            if timeout and (time.time() - start) > timeout:
                raise TimeoutError(f"Task {task_id} timed out")
            time.sleep(0.01)
""" * 3  # Repeat 3x for ~4K tokens


MEDIUM_PROMPT = MEDIUM_PROMPT_BASE.format(code=PADDING_CODE)


# ── Data Classes ─────────────────────────────────────────────────────────────

@dataclass
class BenchmarkResult:
    backend: str
    prompt_name: str
    prompt_tokens: int
    generated_tokens: int
    prefill_time_s: float
    decode_time_s: float
    total_time_s: float
    prefill_tok_s: float
    decode_tok_s: float
    error: Optional[str] = None


# ── Ollama API ───────────────────────────────────────────────────────────────

def ollama_generate(prompt: str, num_ctx: int = NUM_CTX) -> dict:
    """Call Ollama /api/generate and return the full response with timing stats."""
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {
            "num_ctx": num_ctx,
            "num_predict": GENERATE_TOKENS,
            "temperature": 0.1,
        },
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read())


def ollama_load_model():
    """Ensure the model is loaded by sending a minimal prompt."""
    print(f"  Loading {OLLAMA_MODEL} in Ollama (this may take a minute)...")
    start = time.time()
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "prompt": "hi",
        "stream": False,
        "options": {"num_ctx": 4096, "num_predict": 1},
        "keep_alive": -1,
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    with urllib.request.urlopen(req, timeout=300) as resp:
        json.loads(resp.read())

    elapsed = time.time() - start
    print(f"  Model loaded in {elapsed:.1f}s")


def ollama_unload_model():
    """Unload the model from Ollama to free memory for MLX."""
    print(f"  Unloading {OLLAMA_MODEL} from Ollama...")
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "keep_alive": 0,
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    # Ollama needs a prompt to process keep_alive
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "prompt": "",
        "stream": False,
        "keep_alive": 0,
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
        print("  Model unloaded")
    except Exception as e:
        print(f"  Warning: unload may have failed: {e}")

    # Give it a moment to free memory
    time.sleep(5)


def run_ollama_benchmark(prompt: str, prompt_name: str) -> BenchmarkResult:
    """Run a single Ollama benchmark and return results."""
    print(f"  [{prompt_name}] Generating {GENERATE_TOKENS} tokens at {NUM_CTX} num_ctx...")
    start = time.time()

    try:
        result = ollama_generate(prompt, NUM_CTX)
        total_time = time.time() - start

        prompt_eval_count = result.get("prompt_eval_count", 0)
        eval_count = result.get("eval_count", 0)
        prompt_eval_duration = result.get("prompt_eval_duration", 1) / 1e9  # ns → s
        eval_duration = result.get("eval_duration", 1) / 1e9  # ns → s

        prefill_tps = prompt_eval_count / prompt_eval_duration if prompt_eval_duration > 0 else 0
        decode_tps = eval_count / eval_duration if eval_duration > 0 else 0

        print(f"    Prefill: {prompt_eval_count} tokens in {prompt_eval_duration:.2f}s = {prefill_tps:.1f} tok/s")
        print(f"    Decode:  {eval_count} tokens in {eval_duration:.2f}s = {decode_tps:.1f} tok/s")

        return BenchmarkResult(
            backend="Ollama (FP16 KV)",
            prompt_name=prompt_name,
            prompt_tokens=prompt_eval_count,
            generated_tokens=eval_count,
            prefill_time_s=prompt_eval_duration,
            decode_time_s=eval_duration,
            total_time_s=total_time,
            prefill_tok_s=prefill_tps,
            decode_tok_s=decode_tps,
        )

    except Exception as e:
        return BenchmarkResult(
            backend="Ollama (FP16 KV)",
            prompt_name=prompt_name,
            prompt_tokens=0,
            generated_tokens=0,
            prefill_time_s=0,
            decode_time_s=0,
            total_time_s=time.time() - start,
            prefill_tok_s=0,
            decode_tok_s=0,
            error=str(e),
        )


# ── MLX / vllm-mlx API ──────────────────────────────────────────────────────

def mlx_generate(prompt: str) -> dict:
    """Call vllm-mlx OpenAI-compatible completions endpoint."""
    payload = json.dumps({
        "model": MLX_MODEL,
        "prompt": prompt,
        "max_tokens": GENERATE_TOKENS,
        "temperature": 0.1,
        "stream": False,
    }).encode()

    req = urllib.request.Request(
        f"{MLX_URL}/v1/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read())


def mlx_start_server() -> Optional[int]:
    """Start vllm-mlx server and wait for it to be ready."""
    print(f"  Starting vllm-mlx with {MLX_MODEL}...")

    # Check if already running
    try:
        req = urllib.request.Request(f"{MLX_URL}/health")
        with urllib.request.urlopen(req, timeout=5):
            print("  vllm-mlx already running")
            return None
    except Exception:
        pass

    log_dir = os.path.expanduser("~/.casterly/mlx/logs")
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, f"benchmark-{int(time.time())}.log")

    cmd = [
        "vllm-mlx", "serve", MLX_MODEL,
        "--host", "127.0.0.1",
        "--port", "8000",
        "--enable-auto-tool-choice",
        "--tool-call-parser", "qwen",
        "--reasoning-parser", "qwen3",
        "--max-tokens", "16384",
    ]

    with open(log_file, "w") as lf:
        proc = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT)

    print(f"  PID: {proc.pid}, log: {log_file}")
    print("  Waiting for server to be ready", end="", flush=True)

    for i in range(180):  # Up to 6 min
        try:
            req = urllib.request.Request(f"{MLX_URL}/health")
            with urllib.request.urlopen(req, timeout=2):
                print(f"\n  Server ready after {i * 2}s")
                return proc.pid
        except Exception:
            pass

        if proc.poll() is not None:
            print(f"\n  ERROR: Server process exited with code {proc.returncode}")
            with open(log_file) as lf:
                print("  Last 20 lines of log:")
                lines = lf.readlines()
                for line in lines[-20:]:
                    print(f"    {line.rstrip()}")
            return None

        print(".", end="", flush=True)
        time.sleep(2)

    print("\n  ERROR: Server failed to start within 6 minutes")
    proc.terminate()
    return None


def mlx_stop_server(pid: Optional[int]):
    """Stop the vllm-mlx server."""
    if pid is None:
        return

    print(f"  Stopping vllm-mlx (PID: {pid})...")
    try:
        os.kill(pid, signal.SIGTERM)
        # Wait for it to exit
        for _ in range(15):
            try:
                os.kill(pid, 0)  # Check if still running
                time.sleep(1)
            except ProcessLookupError:
                break
        else:
            os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    print("  Server stopped")
    time.sleep(3)  # Let memory free up


def run_mlx_benchmark(prompt: str, prompt_name: str) -> BenchmarkResult:
    """Run a single MLX benchmark and return results."""
    print(f"  [{prompt_name}] Generating {GENERATE_TOKENS} tokens via vllm-mlx...")
    start = time.time()

    try:
        result = mlx_generate(prompt)
        total_time = time.time() - start

        usage = result.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)

        # vllm-mlx doesn't split prefill/decode timing in the response,
        # so we estimate from total time. For a fair comparison, we'll
        # also do a prefill-only call (max_tokens=1) to isolate prefill.
        print(f"    Total: {prompt_tokens} prompt + {completion_tokens} generated in {total_time:.2f}s")

        # Overall throughput (combined prefill + decode)
        overall_tps = completion_tokens / total_time if total_time > 0 else 0

        return BenchmarkResult(
            backend="MLX (K8V4 KV)",
            prompt_name=prompt_name,
            prompt_tokens=prompt_tokens,
            generated_tokens=completion_tokens,
            prefill_time_s=0,  # Will be filled by separate prefill test
            decode_time_s=total_time,  # Approximate
            total_time_s=total_time,
            prefill_tok_s=0,  # Will be filled separately
            decode_tok_s=overall_tps,
        )

    except Exception as e:
        return BenchmarkResult(
            backend="MLX (K8V4 KV)",
            prompt_name=prompt_name,
            prompt_tokens=0,
            generated_tokens=0,
            prefill_time_s=0,
            decode_time_s=0,
            total_time_s=time.time() - start,
            prefill_tok_s=0,
            decode_tok_s=0,
            error=str(e),
        )


def run_mlx_prefill_only(prompt: str, prompt_name: str) -> tuple[float, int]:
    """Run a prefill-only call (max_tokens=1) to isolate prefill speed."""
    print(f"  [{prompt_name}] Prefill-only (max_tokens=1)...")
    payload = json.dumps({
        "model": MLX_MODEL,
        "prompt": prompt,
        "max_tokens": 1,
        "temperature": 0.1,
        "stream": False,
    }).encode()

    req = urllib.request.Request(
        f"{MLX_URL}/v1/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    start = time.time()
    with urllib.request.urlopen(req, timeout=600) as resp:
        result = json.loads(resp.read())
    elapsed = time.time() - start

    prompt_tokens = result.get("usage", {}).get("prompt_tokens", 0)
    prefill_tps = prompt_tokens / elapsed if elapsed > 0 else 0
    print(f"    Prefill: {prompt_tokens} tokens in {elapsed:.2f}s = {prefill_tps:.1f} tok/s")
    return elapsed, prompt_tokens


# ── Main ─────────────────────────────────────────────────────────────────────

def print_comparison(ollama_results: list[BenchmarkResult], mlx_results: list[BenchmarkResult]):
    """Print a formatted comparison table."""
    print("\n" + "=" * 80)
    print("BENCHMARK RESULTS: Ollama (FP16 KV) vs MLX (K8V4 KV)")
    print("=" * 80)
    print(f"  Ollama model: {OLLAMA_MODEL} (Q4_K_M, Metal)")
    print(f"  MLX model:    {MLX_MODEL} (MXFP4, MLX native)")
    print(f"  Context:      {NUM_CTX:,} tokens")
    print(f"  Generate:     {GENERATE_TOKENS} tokens per test")
    print()

    # Match results by prompt_name
    for o in ollama_results:
        m = next((r for r in mlx_results if r.prompt_name == o.prompt_name), None)
        if not m:
            continue

        if o.error or m.error:
            print(f"  {o.prompt_name}: ERROR")
            if o.error:
                print(f"    Ollama: {o.error}")
            if m.error:
                print(f"    MLX:    {m.error}")
            continue

        print(f"  ┌─ {o.prompt_name} ({o.prompt_tokens} prompt tokens)")
        print(f"  │")

        # Prefill comparison
        if o.prefill_tok_s > 0 and m.prefill_tok_s > 0:
            prefill_speedup = m.prefill_tok_s / o.prefill_tok_s
            prefill_pct = (prefill_speedup - 1) * 100
            winner = "MLX" if prefill_speedup > 1 else "Ollama"
            print(f"  │  Prefill (tok/s):  Ollama {o.prefill_tok_s:>8.1f}  │  MLX {m.prefill_tok_s:>8.1f}  │  {winner} {abs(prefill_pct):+.0f}%")

        # Decode comparison
        if o.decode_tok_s > 0 and m.decode_tok_s > 0:
            decode_speedup = m.decode_tok_s / o.decode_tok_s
            decode_pct = (decode_speedup - 1) * 100
            winner = "MLX" if decode_speedup > 1 else "Ollama"
            print(f"  │  Decode  (tok/s):  Ollama {o.decode_tok_s:>8.1f}  │  MLX {m.decode_tok_s:>8.1f}  │  {winner} {abs(decode_pct):+.0f}%")

        # Total time
        time_speedup = o.total_time_s / m.total_time_s if m.total_time_s > 0 else 0
        time_pct = (time_speedup - 1) * 100
        winner = "MLX" if time_speedup > 1 else "Ollama"
        print(f"  │  Total time (s):   Ollama {o.total_time_s:>8.2f}  │  MLX {m.total_time_s:>8.2f}  │  {winner} {abs(time_pct):+.0f}%")
        print(f"  └─")
        print()


def main():
    start_time = time.time()
    print("=" * 60)
    print("Ollama vs MLX Inference Speed Benchmark")
    print("=" * 60)
    print()

    prompts = [
        ("short (~100 tok)", SHORT_PROMPT),
        ("medium (~4K tok)", MEDIUM_PROMPT),
    ]

    # ── Phase 1: Ollama benchmarks ───────────────────────────────────
    print("Phase 1: Ollama (FP16 KV cache, Metal backend)")
    print("-" * 50)

    ollama_load_model()

    # Warmup
    print("  Warmup run...")
    ollama_generate("Say hello.", 4096)
    print("  Warmup complete")

    ollama_results: list[BenchmarkResult] = []
    for name, prompt in prompts:
        result = run_ollama_benchmark(prompt, name)
        ollama_results.append(result)
        print()

    elapsed_phase1 = time.time() - start_time
    print(f"Phase 1 complete in {elapsed_phase1:.0f}s")
    print()

    # ── Phase 2: Unload Ollama, start MLX ────────────────────────────
    print("Phase 2: Switching to MLX backend")
    print("-" * 50)

    ollama_unload_model()

    mlx_pid = mlx_start_server()
    if mlx_pid is None and not _mlx_is_running():
        print("ERROR: Could not start MLX server. Skipping MLX benchmarks.")
        print_comparison(ollama_results, [])
        return

    # ── Phase 3: MLX benchmarks ──────────────────────────────────────
    print()
    print("Phase 3: MLX (K8V4 KV cache, Apple Silicon native)")
    print("-" * 50)

    # Warmup
    print("  Warmup run...")
    try:
        mlx_generate("Say hello.")
        print("  Warmup complete")
    except Exception as e:
        print(f"  Warmup failed: {e}")

    mlx_results: list[BenchmarkResult] = []
    for name, prompt in prompts:
        # Prefill-only test first
        try:
            prefill_time, prefill_tokens = run_mlx_prefill_only(prompt, name)
        except Exception:
            prefill_time, prefill_tokens = 0, 0

        # Full generation test
        result = run_mlx_benchmark(prompt, name)

        # Compute isolated decode speed:
        # total_time ≈ prefill_time + decode_time
        # decode_time = total_time - prefill_time
        if prefill_time > 0 and result.total_time_s > prefill_time:
            decode_time = result.total_time_s - prefill_time
            result.prefill_time_s = prefill_time
            result.decode_time_s = decode_time
            result.prefill_tok_s = prefill_tokens / prefill_time if prefill_time > 0 else 0
            result.decode_tok_s = result.generated_tokens / decode_time if decode_time > 0 else 0
            print(f"    Prefill: {prefill_tokens} tokens in {prefill_time:.2f}s = {result.prefill_tok_s:.1f} tok/s")
            print(f"    Decode:  {result.generated_tokens} tokens in {decode_time:.2f}s = {result.decode_tok_s:.1f} tok/s")

        mlx_results.append(result)
        print()

    # ── Phase 4: Cleanup ─────────────────────────────────────────────
    print("Phase 4: Cleanup")
    print("-" * 50)
    mlx_stop_server(mlx_pid)

    # Reload Ollama model so the system is back to normal
    print("  Reloading Ollama model...")
    ollama_load_model()

    # ── Results ──────────────────────────────────────────────────────
    print_comparison(ollama_results, mlx_results)

    total_elapsed = time.time() - start_time
    print(f"Total benchmark time: {total_elapsed:.0f}s ({total_elapsed/60:.1f} min)")


def _mlx_is_running() -> bool:
    try:
        req = urllib.request.Request(f"{MLX_URL}/health")
        with urllib.request.urlopen(req, timeout=2):
            return True
    except Exception:
        return False


if __name__ == "__main__":
    main()
