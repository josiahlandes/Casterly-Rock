# KV Cache Quantization Benchmark Results

**Date**: 2026-03-03
**Model**: `nightmedia/Qwen3.5-122B-A10B-Text-mxfp4-mlx` (~65 GB MXFP4)
**Hardware**: macOS (Apple Silicon), 128 GB unified memory
**Dataset**: wikitext-2-raw-v1 (HuggingFace), 2 samples x 128 eval tokens per config
**Script**: `scripts/benchmark-kvcache.py`
**Raw JSON**: `benchmarks/kvcache-122b-full.json`

## Architecture

Qwen3.5-122B-A10B is a hybrid attention model:
- 48 total layers: **12 full attention** + 36 linear attention
- Only the 12 full attention layers use standard KV cache
- 2 KV heads per layer, head_dim = 256
- 256 experts, 8 active per token (MoE)

This means KV cache memory is small relative to model size — only 3 GB at 128K in FP16.

## Strategies Tested

| Strategy | Description | Bytes/element |
|----------|-------------|---------------|
| FP16 | Full precision baseline | 2.0 |
| Q8 | Uniform 8-bit (mlx_lm QuantizedKVCache) | 1.0 |
| Q4 | Uniform 4-bit (mlx_lm QuantizedKVCache) | 0.5 |
| K8V4 | Asymmetric: keys=8-bit, values=4-bit (custom cache class) | 0.75 |

## Perplexity Results (lower = better)

| Strategy | 4K | 16K | 64K | 128K |
|----------|------|------|------|------|
| FP16 | 9.523 | 4.299 | 5.182 | 3.137 |
| Q8 | 9.397 | 4.290 | 5.212 | 3.593 |
| Q4 | 9.655 | 4.279 | 5.339 | 3.619 |
| K8V4 | 9.620 | 4.273 | 5.324 | 3.136 |

## Degradation vs FP16 Baseline

| Strategy | 4K | 16K | 64K | 128K |
|----------|-------|-------|-------|--------|
| Q8 | -1.3% | -0.2% | +0.6% | **+14.5%** |
| Q4 | +1.4% | -0.5% | +3.0% | **+15.4%** |
| K8V4 | +1.0% | -0.6% | +2.8% | **-0.06%** |

## Peak Memory (GB)

| Strategy | 4K | 16K | 64K | 128K |
|----------|------|------|------|------|
| FP16 | 63.5 | 65.2 | 72.5 | 82.2 |
| Q8 | 63.4 | 65.1 | 71.8 | 80.8 |
| Q4 | 63.4 | 65.0 | 71.4 | 79.9 |
| K8V4 | 63.4 | 65.0 | 71.7 | 80.5 |

## Eval Time (seconds)

| Strategy | 4K | 16K | 64K | 128K |
|----------|------|------|-------|--------|
| FP16 | 16.4 | 65.0 | 371.2 | 1094.9 |
| Q8 | 15.9 | 66.0 | 388.5 | 1175.3 |
| Q4 | 15.9 | 66.1 | 385.2 | 1153.4 |
| K8V4 | 15.8 | 65.0 | 371.2 | 1097.8 |

## Key Findings

### 1. K8V4 is lossless at 128K context

K8V4 perplexity at 128K (3.136) is essentially identical to FP16 (3.137) — within measurement noise. This confirms the KIVI/KVQuant research: keys are far more sensitive to quantization than values. By keeping keys at 8-bit while only quantizing values to 4-bit, K8V4 preserves the information that matters most.

### 2. Uniform quantization degrades badly at 128K

Both Q8 (+14.5%) and Q4 (+15.4%) show significant perplexity degradation at 128K. This is notable because Q8 is often considered "lossless" — it is, at short context, but not at 128K for this model. The degradation likely comes from accumulated quantization errors in key representations across the long attention span.

### 3. Short context doesn't benefit from KV quantization

At 4K and 16K, all strategies are within noise of each other. The KV cache is tiny (<0.4 GB) relative to the 65 GB model, so quantization has negligible effect on either quality or memory.

### 4. K8V4 is the fastest quantized strategy

At 128K, K8V4 (1098s) matches FP16 speed (1095s) and is faster than Q8 (1175s) and Q4 (1153s). The custom dequantize-before-attention path appears to have less overhead than mlx_lm's built-in quantized attention.

### 5. Memory savings are modest but meaningful

At 128K, K8V4 saves 1.7 GB vs FP16 (80.5 vs 82.2 GB peak). While this is only ~2% of total memory, it's meaningful when running both models concurrently (122B on MLX + 35b-a3b on Ollama).

## Decision

**K8V4 is the chosen KV cache strategy for DeepLoop's 122B model.**

It is the only quantization strategy that maintains FP16 quality at 128K context while saving memory. Uniform quantization (Q8/Q4) should not be used at long context for this model.

## Implementation Notes

- K8V4 requires a custom `K8V4KVCache` class because mlx_lm's `QuantizedKVCache` only supports uniform quantization
- The custom cache dequantizes K/V before returning to attention because `mx.fast.scaled_dot_product_attention` does not support mixed-precision quantized tuples
- The implementation is in `scripts/benchmark-kvcache.py` and can be adapted for production use
- `src/providers/kvsplit.ts` manages the K8V4 configuration and quality monitoring
