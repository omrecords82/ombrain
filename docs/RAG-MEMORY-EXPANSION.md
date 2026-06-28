# Memory-Layer Expansion & RAG Retriever

> **Status:** Phase 2 — core implemented & tested offline; live tuning blocked on LiteLLM
> **Date:** 2026-06-28

## What this delivers

The TODO item "Memory layer expansion (work memory, RAG tuning)" was blocked on
"LiteLLM live/tested". This change implements everything that does **not**
require live inference, behind interfaces that drop in the live embedder later:

- **`src/memory/ragRetriever.js`** — a `RagRetriever` that embeds a query and
  ranks candidate memory rows (`knowledge_memory`, `theological_memory`, etc.)
  by cosine similarity using the existing `vectorStore` math. Returns scored,
  top-k chunks with `minScore` filtering.
- **Pluggable embedding** — `embed(text) => number[]` is injected. In production
  it is backed by the local LiteLLM/Ollama model (`BRAIN_LLM_EMBEDDING_MODEL`,
  e.g. `nomic-embed-text`, dim 768). With no embedder provided, a deterministic
  hashing fallback keeps the pipeline runnable and unit-testable offline.
- **Vector source flexibility** — rows may carry a precomputed Float32 BLOB
  embedding (decoded via `vectorStore.decodeVector`), a plain `number[]`, or
  none (embedded on the fly).
- **6 unit tests** (`test/ragRetriever.test.js`): determinism, overlap ranking,
  `k`/`minScore`, injected-embedder path, BLOB decoding, empty inputs.

## Why a fallback embedder

A sandboxed agent cannot reach the LAN LiteLLM endpoint, and the retriever must
never call the network itself (LAN-only doctrine). The deterministic embedder is
**not semantically meaningful** — it exists solely so the ranking/retrieval code
is exercised and regression-tested without external services. Swapping in the
real embedder requires no retriever code change:

```js
const { RagRetriever } = require('./memory/ragRetriever');
const ai = new BrainAIClient(/* local LiteLLM */);
const retriever = new RagRetriever({ embed: (t) => ai.embed(t), dim: 768 });
```

## What remains BLOCKED (needs live LiteLLM)

These are intentionally **not** claimed as done — they require the live model on
om-dev (`.254`) and cannot be validated from the sandbox:

1. **Real semantic embeddings** — wiring `RagRetriever.embed` to the live
   `nomic-embed-text` model and backfilling `embedding` columns.
2. **RAG tuning** — choosing `k`, `minScore`, and chunk sizing against real
   embeddings + a labeled query set; measuring retrieval quality.
3. **Work-memory enrichment** — extending `work_memory` writes with retrieved
   context once embeddings are live.

These should be picked up on the server (or by Cursor with LiteLLM access). The
interfaces above are stable, so that work is purely configuration + evaluation.

## References

- `src/memory/vectorStore.js` (cosine/topK math, sqlite-vec probe)
- `src/config/index.js` (`BRAIN_LLM_EMBEDDING_MODEL`, `embeddingDim`)
- `src/ai/client.js` (local-only inference client)
