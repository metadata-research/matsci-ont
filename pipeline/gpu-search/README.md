# Corpus export for the retrieval experiments

These two scripts export the publication-cleared descriptions of the ONT store
for the GPU experiments in the `matsci-retrieval` repository. That repository
holds the index build, the LoRA trials, the search and their tests. The scripts
stay here because they import ONT modules.

`export.mjs` is a bounded, read-only export with per-source counts, stable
description ids, source, version and licence metadata, a corpus SHA-256 and
manifest provenance. `lexical-baseline.mjs` runs the existing ONT grounding on
that snapshot for a query file.

From the ONT repository root, with no other process on the local TDB2 store:

```bash
systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 \
  node --max-old-space-size=512 pipeline/gpu-search/export.mjs --local-store
systemd-run --user --scope -p MemoryMax=768M -p MemorySwapMax=0 \
  node --max-old-space-size=384 pipeline/gpu-search/lexical-baseline.mjs \
  build/gpu-search/corpus ../matsci-retrieval/queries.draft.json
```

The export starts and stops its own Fuseki on the configured ONT port, normally
3031. It never opens port 3030 of SAM. Without `--local-store` it reads the
configured ONT query endpoint. Use a quiescent snapshot. The catalogue comparison
detects changed source metadata and cannot prove that no graph was edited in
place.

An export refuses an existing staging directory. Inspect a failed `.partial`
directory and choose a new `--out` path for a fresh attempt. Only an export that
finishes every source gets `manifest.json` and its final directory name. Exports
belong under the git-ignored `build/gpu-search/`.

The query file lives in `matsci-retrieval`. Its entries carry
`relevant_ids: null`, which means unjudged.
