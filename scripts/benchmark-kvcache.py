#!/usr/bin/env python3
"""
KV Cache Quantization Benchmark — Casterly Rock
=================================================

Measures perplexity impact of KV cache quantization strategies on the
MLX inference backend for the DeepLoop model (Qwen3.5-122B-A10B).

The 122B model uses a hybrid attention architecture:
  - 12 full attention layers (standard KV cache, grows with context)
  - 36 linear attention layers (fixed-size state, not affected by KV quant)

Strategies tested:
  - FP16:  Full-precision KV cache (baseline)
  - Q8:    Uniform 8-bit quantization (keys=8, values=8)
  - Q4:    Uniform 4-bit quantization (keys=4, values=4)
  - K8V4:  Asymmetric quantization (keys=8, values=4) — custom impl

Context lengths tested: 4K, 16K, 64K, 128K

Each test:
  1. Verifies the configuration fits in available system memory
  2. Pre-fills the KV cache with context tokens
  3. Measures cross-entropy loss on held-out tokens
  4. Reports perplexity with standard error

Memory verification:
  Before each test, estimates KV cache memory and checks against
  available system memory (accounting for Ollama and safety margin).

Usage:
  # Unload the 122B from Ollama first, then:
  python scripts/benchmark-kvcache.py

  # Quick test with smaller context:
  python scripts/benchmark-kvcache.py --context-lengths 4096 --num-samples 2

  # Custom model:
  python scripts/benchmark-kvcache.py --model mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit
"""

import argparse
import gc
import json
import math
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Memory helpers — run BEFORE importing mlx (which allocates GPU memory)
# ---------------------------------------------------------------------------

PAGE_SIZE = 16384  # macOS ARM64 page size


def get_system_memory_gb() -> float:
    """Total physical memory in GB."""
    import platform
    if platform.system() != "Darwin":
        raise RuntimeError("This benchmark requires macOS (Apple Silicon)")
    result = subprocess.run(
        ["sysctl", "-n", "hw.memsize"],
        capture_output=True, text=True, check=True,
    )
    return int(result.stdout.strip()) / (1024 ** 3)


def get_available_memory_gb() -> float:
    """Estimate available memory in GB (free + inactive + purgeable)."""
    result = subprocess.run(
        ["vm_stat"], capture_output=True, text=True, check=True,
    )
    stats = {}
    for line in result.stdout.strip().split("\n")[1:]:
        parts = line.split(":")
        if len(parts) == 2:
            key = parts[0].strip().strip('"')
            val = parts[1].strip().rstrip(".")
            try:
                stats[key] = int(val)
            except ValueError:
                pass

    free = stats.get("Pages free", 0)
    inactive = stats.get("Pages inactive", 0)
    purgeable = stats.get("Pages purgeable", 0)

    return (free + inactive + purgeable) * PAGE_SIZE / (1024 ** 3)


def get_ollama_memory_gb() -> float:
    """Estimate Ollama's loaded model memory via its API."""
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:11434/api/ps", timeout=3) as resp:
            data = json.loads(resp.read())
        total = 0
        for m in data.get("models", []):
            total += m.get("size_vram", m.get("size", 0))
        return total / (1024 ** 3)
    except Exception:
        return 0.0


def estimate_kv_memory_gb(
    context_length: int,
    n_kv_layers: int,
    n_kv_heads: int,
    head_dim: int,
    strategy: str,
) -> float:
    """
    Estimate KV cache memory in GB for full attention layers only.

    The 122B model has 48 layers but only 12 use full attention with
    standard KV cache. The other 36 use linear attention with fixed-size state.
    """
    if strategy == "fp16":
        bytes_per_element = 2.0
    elif strategy == "q8":
        bytes_per_element = 1.0
    elif strategy == "q4":
        bytes_per_element = 0.5
    elif strategy == "k8v4":
        bytes_per_element = 0.75  # avg of 1.0 (keys) + 0.5 (values)
    else:
        raise ValueError(f"Unknown strategy: {strategy}")

    # K + V caches for full attention layers only
    kv_elements = 2 * context_length * n_kv_layers * n_kv_heads * head_dim
    # ~15% overhead for quantization scales, zeros, and alignment padding
    overhead = 1.15 if strategy != "fp16" else 1.0
    return kv_elements * bytes_per_element * overhead / (1024 ** 3)


# ---------------------------------------------------------------------------
# Asymmetric K8V4 KV Cache — keys at 8-bit, values at 4-bit
# ---------------------------------------------------------------------------

def make_k8v4_cache_class():
    """
    Create an asymmetric K8V4 cache class.
    Based on KIVI (Liu et al., 2024) and KVQuant (Hooper et al., 2024).
    """
    import mlx.core as mx
    from mlx_lm.models.cache import _BaseCache, create_attention_mask
    from mlx.utils import tree_map

    class K8V4KVCache(_BaseCache):
        """
        Asymmetric quantized KV cache: keys=8-bit, values=4-bit.

        Stores K/V in quantized form for memory savings, but dequantizes
        before returning to attention. This is necessary because
        mx.fast.scaled_dot_product_attention doesn't support mixed-precision
        quantized K/V tuples (different bits for K vs V).

        Storage benefit: ~25% less memory than uniform Q8.
        """

        step = 256

        def __init__(self, group_size: int = 64):
            self.keys = None
            self.values = None
            self.offset = 0
            self.group_size = group_size
            self.key_bits = 8
            self.value_bits = 4
            self._k_head_dim = 0
            self._v_head_dim = 0

        def update_and_fetch(self, keys, values):
            B, n_kv_heads, num_steps, k_head_dim = keys.shape
            v_head_dim = values.shape[-1]
            self._k_head_dim = k_head_dim
            self._v_head_dim = v_head_dim
            prev = self.offset

            if self.keys is None or (prev + num_steps) > self.keys[0].shape[-2]:
                new_steps = (self.step + num_steps - 1) // self.step * self.step
                shape = (B, n_kv_heads, new_steps)

                def init_quant(dim, bits):
                    el_per_int = 8 * mx.uint32.size // bits
                    return (
                        mx.zeros((*shape, dim // el_per_int), dtype=mx.uint32),
                        mx.zeros((*shape, dim // self.group_size), dtype=keys.dtype),
                        mx.zeros((*shape, dim // self.group_size), dtype=keys.dtype),
                    )

                def expand_quant(x):
                    new_x = mx.zeros((*shape, x.shape[-1]), dtype=x.dtype)
                    return mx.concatenate([x, new_x], axis=-2)

                if self.keys is not None:
                    if prev % self.step != 0:
                        self.keys, self.values = tree_map(
                            lambda x: x[..., :prev, :], (self.keys, self.values)
                        )
                    self.keys, self.values = tree_map(
                        expand_quant, (self.keys, self.values)
                    )
                else:
                    self.keys = init_quant(k_head_dim, self.key_bits)
                    self.values = init_quant(v_head_dim, self.value_bits)

            self.offset += num_steps

            q_keys = mx.quantize(keys, group_size=self.group_size, bits=self.key_bits)
            q_values = mx.quantize(values, group_size=self.group_size, bits=self.value_bits)

            for i in range(len(self.keys)):
                self.keys[i][..., prev:self.offset, :] = q_keys[i]
            for i in range(len(self.values)):
                self.values[i][..., prev:self.offset, :] = q_values[i]

            # Dequantize and return plain arrays for attention.
            # Storage is still quantized (asymmetric K8V4 saves memory),
            # but attention operates on full-precision data.
            k_sliced = tree_map(lambda x: x[..., :self.offset, :], self.keys)
            v_sliced = tree_map(lambda x: x[..., :self.offset, :], self.values)

            dk = mx.dequantize(*k_sliced, group_size=self.group_size, bits=self.key_bits)
            dv = mx.dequantize(*v_sliced, group_size=self.group_size, bits=self.value_bits)

            return dk, dv

        @property
        def state(self):
            if self.keys is None:
                return None
            # Return dequantized state for compatibility
            k_sliced = tree_map(lambda x: x[..., :self.offset, :], self.keys)
            v_sliced = tree_map(lambda x: x[..., :self.offset, :], self.values)
            dk = mx.dequantize(*k_sliced, group_size=self.group_size, bits=self.key_bits)
            dv = mx.dequantize(*v_sliced, group_size=self.group_size, bits=self.value_bits)
            return dk, dv

        @state.setter
        def state(self, v):
            # Re-quantize incoming state
            keys, values = v
            self.keys = mx.quantize(keys, group_size=self.group_size, bits=self.key_bits)
            self.values = mx.quantize(values, group_size=self.group_size, bits=self.value_bits)
            self.offset = keys.shape[-2]

        def is_trimmable(self):
            return True

        def trim(self, n):
            n = min(self.offset, n)
            self.offset -= n
            return n

        def make_mask(self, *args, **kwargs):
            return create_attention_mask(*args, offset=self.offset, **kwargs)

        def empty(self):
            return self.keys is None

    return K8V4KVCache


# ---------------------------------------------------------------------------
# Benchmark core
# ---------------------------------------------------------------------------

@dataclass
class BenchmarkResult:
    strategy: str
    context_length: int
    perplexity: float
    std_error: float
    peak_memory_gb: float
    eval_time_s: float
    tokens_per_second: float
    kv_memory_estimate_gb: float
    skipped: bool = False
    skip_reason: str = ""


@dataclass
class BenchmarkConfig:
    model_id: str = "nightmedia/Qwen3.5-122B-A10B-Text-mxfp4-mlx"
    strategies: list = field(default_factory=lambda: ["fp16", "q8", "q4", "k8v4"])
    context_lengths: list = field(default_factory=lambda: [4096, 16384, 65536, 131072])
    eval_tokens: int = 256       # Tokens to measure loss on (after prefill)
    num_samples: int = 4         # Number of evaluation sequences
    group_size: int = 64         # Quantization group size
    memory_safety_margin_gb: float = 5.0  # Conservative safety margin
    model_size_gb: float = 65.0  # Approximate model weight size in GPU memory
    # Architecture: Qwen3.5-122B-A10B — hybrid attention
    n_layers: int = 48           # Total layers
    n_kv_layers: int = 12        # Full attention layers (with KV cache)
    n_kv_heads: int = 2          # KV heads per full attention layer
    head_dim: int = 256          # Head dimension


def load_evaluation_data(tokenizer, context_length: int, eval_tokens: int, num_samples: int):
    """Load and tokenize evaluation data from wikitext-2."""
    import numpy as np

    total_needed = (context_length + eval_tokens) * num_samples

    # Try loading wikitext-2 via datasets library directly
    try:
        from datasets import load_dataset as hf_load_dataset
        print("  Loading wikitext-2-raw-v1 from HuggingFace...")
        ds = hf_load_dataset("wikitext", "wikitext-2-raw-v1", split="test")

        data = []
        perm = np.random.permutation(len(ds)).tolist()
        idx = 0
        while len(data) < total_needed and idx < len(ds):
            text = ds[perm[idx]]["text"]
            if text.strip():
                tokens = tokenizer.encode(text)
                data.extend(tokens)
            idx += 1

        if len(data) >= context_length + eval_tokens:
            return data[:total_needed] if len(data) >= total_needed else data
    except Exception as e:
        print(f"  Warning: Could not load wikitext dataset: {e}")

    # Fallback: use a diverse synthetic corpus
    print("  Using synthetic evaluation corpus...")
    paragraphs = [
        "The development of artificial intelligence has progressed rapidly over the past decade. "
        "Machine learning models have grown from simple classifiers to complex systems capable of "
        "generating human-like text, translating languages, and solving mathematical problems. "
        "The transformer architecture, introduced in 2017, revolutionized the field by enabling "
        "models to process sequences in parallel rather than sequentially. ",

        "In computer science, a cache is a hardware or software component that stores data so "
        "that future requests for that data can be served faster. The data stored in a cache might "
        "be the result of an earlier computation or a copy of data stored elsewhere. A cache hit "
        "occurs when the requested data can be found in a cache, while a cache miss occurs when "
        "it cannot. Cache hits are served by reading data from the cache, which is faster than "
        "recomputing a result or reading from a slower data store. ",

        "Quantization in the context of neural networks refers to the process of reducing the "
        "number of bits used to represent each weight or activation. This technique is essential "
        "for deploying large language models on resource-constrained devices. The key insight "
        "behind KV cache quantization is that keys and values in the attention mechanism have "
        "different sensitivity to precision loss. Keys are typically more sensitive because they "
        "directly influence the attention pattern through the softmax operation. ",

        "Apple Silicon represents a significant shift in computing architecture. The M4 Max chip "
        "features a unified memory architecture where CPU, GPU, and Neural Engine share the same "
        "memory pool. This eliminates the traditional bottleneck of copying data between separate "
        "CPU and GPU memory spaces. The Neural Engine provides specialized hardware for matrix "
        "operations common in machine learning workloads. ",

        "The concept of mixture of experts in machine learning allows a model to have a very "
        "large number of parameters while only activating a small subset for each input. This "
        "sparse activation pattern means that the computational cost per token is much lower than "
        "a dense model of equivalent size. Expert routing decisions are made by a gating network "
        "that learns to assign inputs to the most relevant experts during training. ",
    ]
    text = " ".join(paragraphs * 2000)
    tokens = tokenizer.encode(text)
    while len(tokens) < total_needed:
        tokens = tokens + tokens
    return tokens[:total_needed]


def make_cache_for_strategy(model, strategy: str, group_size: int):
    """
    Create the cache list for a given strategy.

    Uses model.make_cache() to get the correct hybrid cache structure
    (ArraysCache for linear attention + KVCache for full attention),
    then replaces KVCache entries with quantized variants for non-FP16 strategies.
    """
    from mlx_lm.models.cache import KVCache, QuantizedKVCache

    cache = model.make_cache()

    if strategy == "fp16":
        return cache  # Default FP16 KVCache entries

    # Replace KVCache entries with quantized versions
    K8V4Class = None
    if strategy == "k8v4":
        K8V4Class = make_k8v4_cache_class()

    for i, c in enumerate(cache):
        if isinstance(c, KVCache):
            if strategy == "q8":
                cache[i] = QuantizedKVCache(group_size=group_size, bits=8)
            elif strategy == "q4":
                cache[i] = QuantizedKVCache(group_size=group_size, bits=4)
            elif strategy == "k8v4":
                cache[i] = K8V4Class(group_size=group_size)

    return cache


def eval_cache_state(cache_list):
    """Evaluate (materialize) cache state for non-empty caches."""
    import mlx.core as mx
    states = []
    for c in cache_list:
        s = c.state
        if s is not None:
            states.append(s)
    if states:
        mx.eval(states)


def run_single_benchmark(
    model,
    tokenizer,
    data_tokens: list,
    context_length: int,
    eval_tokens: int,
    strategy: str,
    group_size: int,
    num_samples: int,
    config: BenchmarkConfig,
) -> BenchmarkResult:
    """Run perplexity measurement for a single strategy + context length."""
    import mlx.core as mx
    import mlx.nn as nn

    # Memory estimate (only full attention layers)
    kv_mem = estimate_kv_memory_gb(
        context_length, config.n_kv_layers, config.n_kv_heads,
        config.head_dim, strategy,
    )

    # Check available memory
    available = get_available_memory_gb()
    needed = kv_mem + config.memory_safety_margin_gb

    if available < needed:
        return BenchmarkResult(
            strategy=strategy,
            context_length=context_length,
            perplexity=0.0,
            std_error=0.0,
            peak_memory_gb=0.0,
            eval_time_s=0.0,
            tokens_per_second=0.0,
            kv_memory_estimate_gb=kv_mem,
            skipped=True,
            skip_reason=f"Insufficient memory: need {needed:.1f} GB free, have {available:.1f} GB",
        )

    print(f"  KV cache estimate: {kv_mem:.2f} GB | Available: {available:.1f} GB")

    # Reset peak memory tracking
    try:
        mx.reset_peak_memory()
    except AttributeError:
        mx.metal.reset_peak_memory()  # Fallback for older mlx

    all_losses = []
    start_time = time.time()
    total_tokens = context_length + eval_tokens

    for sample_idx in range(num_samples):
        offset = sample_idx * total_tokens
        if offset + total_tokens > len(data_tokens):
            print(f"  Warning: only {sample_idx} samples fit in data")
            break

        sample = data_tokens[offset : offset + total_tokens]
        tokens = mx.array(sample)

        # Create cache with correct hybrid structure for this strategy
        cache_list = make_cache_for_strategy(model, strategy, group_size)

        # Prefill: process context tokens in chunks
        prefill_size = 2048
        for chunk_start in range(0, context_length, prefill_size):
            chunk_end = min(chunk_start + prefill_size, context_length)
            chunk = tokens[chunk_start:chunk_end].reshape(1, -1)
            model(chunk, cache=cache_list)
            eval_cache_state(cache_list)

            # Progress for large contexts
            if context_length >= 16384 and chunk_start % (prefill_size * 8) == 0:
                pct = chunk_end / context_length * 100
                print(f"  Prefill: {pct:.0f}%  ", end="\r")

        if context_length >= 16384:
            print(f"  Prefill: done ({context_length} tokens)     ")

        # Evaluate: measure loss on eval tokens in small batches
        sample_losses = []
        eval_batch_size = min(64, eval_tokens)

        for batch_start in range(0, eval_tokens, eval_batch_size):
            batch_end = min(batch_start + eval_batch_size, eval_tokens)
            start_pos = context_length + batch_start
            end_pos = context_length + batch_end

            if end_pos > len(sample):
                break

            # Input: tokens[start_pos-1 : end_pos-1], Target: tokens[start_pos : end_pos]
            input_chunk = tokens[start_pos - 1 : end_pos - 1].reshape(1, -1)
            target_chunk = tokens[start_pos : end_pos].reshape(1, -1)

            logits = model(input_chunk, cache=cache_list)
            eval_cache_state(cache_list)

            # Per-token cross-entropy loss
            losses = nn.losses.cross_entropy(
                logits.astype(mx.float32), target_chunk, reduction="none"
            )
            mx.eval(losses)
            sample_losses.extend(losses.reshape(-1).tolist())

        all_losses.extend(sample_losses)
        print(f"  Sample {sample_idx + 1}/{num_samples}: {len(sample_losses)} eval tokens")

        # Free cache memory between samples
        del cache_list
        gc.collect()

    eval_time = time.time() - start_time

    try:
        peak_mem = mx.get_peak_memory() / (1024 ** 3)
    except AttributeError:
        peak_mem = mx.metal.get_peak_memory() / (1024 ** 3)

    if not all_losses:
        return BenchmarkResult(
            strategy=strategy,
            context_length=context_length,
            perplexity=0.0,
            std_error=0.0,
            peak_memory_gb=peak_mem,
            eval_time_s=eval_time,
            tokens_per_second=0.0,
            kv_memory_estimate_gb=kv_mem,
            skipped=True,
            skip_reason="No losses computed",
        )

    mean_loss = sum(all_losses) / len(all_losses)
    ppl = math.exp(min(mean_loss, 20.0))  # Cap to avoid overflow

    # Standard error via delta method
    n = len(all_losses)
    variance = sum((l - mean_loss) ** 2 for l in all_losses) / max(n - 1, 1)
    std_dev = math.sqrt(variance)
    se_loss = std_dev / math.sqrt(n)
    se_ppl = ppl * se_loss

    tokens_per_sec = len(all_losses) / eval_time if eval_time > 0 else 0

    return BenchmarkResult(
        strategy=strategy,
        context_length=context_length,
        perplexity=ppl,
        std_error=se_ppl,
        peak_memory_gb=peak_mem,
        eval_time_s=eval_time,
        tokens_per_second=tokens_per_sec,
        kv_memory_estimate_gb=kv_mem,
    )


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_banner(model_id: str):
    print()
    print("=" * 72)
    print("  Casterly Rock — KV Cache Quantization Benchmark")
    print(f"  Model: {model_id}")
    print("=" * 72)


def print_results_table(results: list):
    print()
    print("=" * 72)
    print("  RESULTS SUMMARY")
    print("=" * 72)
    print()
    print(f"{'Strategy':<10} {'Context':<10} {'PPL':>10} {'± SE':>10} {'Peak GB':>10} {'Time (s)':>10} {'tok/s':>10}")
    print("-" * 72)

    for r in results:
        if r.skipped:
            ctx = f"{r.context_length // 1024}K"
            print(f"{r.strategy:<10} {ctx:<10} {'SKIP':>10} {'':>10} {'':>10} {'':>10} {'':>10}  {r.skip_reason}")
        else:
            ctx = f"{r.context_length // 1024}K"
            print(
                f"{r.strategy:<10} {ctx:<10} "
                f"{r.perplexity:>10.3f} {r.std_error:>10.3f} "
                f"{r.peak_memory_gb:>10.2f} {r.eval_time_s:>10.1f} "
                f"{r.tokens_per_second:>10.1f}"
            )

    # Degradation vs FP16
    print()
    print("Degradation vs FP16 baseline:")
    print("-" * 55)
    fp16_ppls = {
        r.context_length: r.perplexity
        for r in results if r.strategy == "fp16" and not r.skipped
    }

    for r in results:
        if r.skipped or r.strategy == "fp16":
            continue
        baseline = fp16_ppls.get(r.context_length)
        if baseline and baseline > 0:
            delta = r.perplexity - baseline
            pct = (delta / baseline) * 100
            ctx = f"{r.context_length // 1024}K"
            print(f"  {r.strategy:<6} @ {ctx:>6}: Δ = {delta:+.4f} ({pct:+.2f}%)")


def save_results(results: list, model_id: str, output_path: str):
    data = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model": model_id,
        "results": [
            {
                "strategy": r.strategy,
                "context_length": r.context_length,
                "perplexity": r.perplexity,
                "std_error": r.std_error,
                "peak_memory_gb": r.peak_memory_gb,
                "eval_time_s": r.eval_time_s,
                "tokens_per_second": r.tokens_per_second,
                "kv_memory_estimate_gb": r.kv_memory_estimate_gb,
                "skipped": r.skipped,
                "skip_reason": r.skip_reason,
            }
            for r in results
        ],
    }
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"\nResults saved to {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="KV Cache Quantization Benchmark for Casterly Rock"
    )
    parser.add_argument(
        "--model", type=str,
        default="nightmedia/Qwen3.5-122B-A10B-Text-mxfp4-mlx",
        help="MLX model ID or local path",
    )
    parser.add_argument(
        "--eval-tokens", type=int, default=256,
        help="Tokens to evaluate after prefill (default: 256)",
    )
    parser.add_argument(
        "--num-samples", type=int, default=4,
        help="Evaluation samples per config (default: 4)",
    )
    parser.add_argument(
        "--strategies", type=str, nargs="+",
        default=["fp16", "q8", "q4", "k8v4"],
        help="KV cache strategies to test",
    )
    parser.add_argument(
        "--context-lengths", type=int, nargs="+",
        default=[4096, 16384, 65536, 131072],
        help="Context lengths to test",
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Output JSON path (default: benchmarks/kvcache-TIMESTAMP.json)",
    )

    args = parser.parse_args()

    config = BenchmarkConfig(
        model_id=args.model,
        strategies=args.strategies,
        context_lengths=sorted(args.context_lengths),
        eval_tokens=args.eval_tokens,
        num_samples=args.num_samples,
    )

    # Auto-detect model size for non-default models
    if "30B" in args.model or "30b" in args.model:
        config.model_size_gb = 4.5
        config.n_kv_layers = 48  # All layers are full attention in 30B
        config.n_kv_heads = 4
        config.head_dim = 128

    print_banner(config.model_id)

    # --- Pre-flight checks ---
    total_mem = get_system_memory_gb()
    available_mem = get_available_memory_gb()
    ollama_mem = get_ollama_memory_gb()

    print(f"\nSystem: {total_mem:.0f} GB total | {available_mem:.1f} GB available | Ollama: {ollama_mem:.1f} GB")
    print(f"Model: ~{config.model_size_gb:.0f} GB | Safety margin: {config.memory_safety_margin_gb:.0f} GB")
    print(f"Architecture: {config.n_layers} layers ({config.n_kv_layers} full attn), {config.n_kv_heads} KV heads, dim={config.head_dim}")
    print()

    # Memory estimate table
    print("Estimated KV cache memory (GB) — full attention layers only:")
    print(f"{'Strategy':<10}", end="")
    for cl in config.context_lengths:
        print(f" {cl//1024:>6}K", end="")
    print()
    print("-" * (10 + 8 * len(config.context_lengths)))

    for strategy in config.strategies:
        print(f"{strategy:<10}", end="")
        for cl in config.context_lengths:
            mem = estimate_kv_memory_gb(
                cl, config.n_kv_layers, config.n_kv_heads,
                config.head_dim, strategy,
            )
            print(f" {mem:>6.2f}", end="")
        print()

    # --- Load model ---
    print(f"\nLoading model: {config.model_id}")
    import mlx.core as mx
    import numpy as np
    from mlx_lm.utils import load

    np.random.seed(42)
    mx.random.seed(42)

    model, tokenizer = load(config.model_id)

    try:
        peak = mx.get_peak_memory() / 1e9
    except AttributeError:
        peak = mx.metal.get_peak_memory() / 1e9
    print(f"Model loaded. Peak memory: {peak:.2f} GB")

    # --- Load evaluation data ---
    max_context = max(config.context_lengths)
    total_needed = (max_context + config.eval_tokens) * config.num_samples
    print(f"\nLoading evaluation data ({total_needed:,} tokens needed)...")

    data_tokens = load_evaluation_data(
        tokenizer, max_context, config.eval_tokens, config.num_samples,
    )
    print(f"Loaded {len(data_tokens):,} tokens")

    # --- Run benchmarks ---
    results = []

    for context_length in config.context_lengths:
        for strategy in config.strategies:
            print(f"\n{'─' * 60}")
            print(f"  {strategy.upper()} @ {context_length // 1024}K context")
            print(f"{'─' * 60}")

            result = run_single_benchmark(
                model=model,
                tokenizer=tokenizer,
                data_tokens=data_tokens,
                context_length=context_length,
                eval_tokens=config.eval_tokens,
                strategy=strategy,
                group_size=config.group_size,
                num_samples=config.num_samples,
                config=config,
            )

            results.append(result)

            if result.skipped:
                print(f"  SKIPPED: {result.skip_reason}")
            else:
                print(f"  PPL: {result.perplexity:.4f} ± {result.std_error:.4f}")
                print(f"  Peak: {result.peak_memory_gb:.2f} GB | Time: {result.eval_time_s:.1f}s")

            gc.collect()

    # --- Results ---
    print_results_table(results)

    output_path = args.output
    if output_path is None:
        benchmarks_dir = Path(__file__).parent.parent / "benchmarks"
        benchmarks_dir.mkdir(exist_ok=True)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        output_path = str(benchmarks_dir / f"kvcache-{timestamp}.json")

    save_results(results, config.model_id, output_path)


if __name__ == "__main__":
    main()
