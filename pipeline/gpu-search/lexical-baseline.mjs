// The actual ONT grounding algorithm on the exported snapshot, not an
// approximation of it. Draft queries have no relevance judgements yet.
import { readFile, writeFile } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  createIndexBuilder,
  groundingRows
} from "../../app/lib/lookup-index.mjs"
import { entryIri } from "../../shared/vocabulary.mjs"

const corpus = process.argv[2] ?? "build/gpu-search/corpus"
const queriesPath = process.argv[3] ?? "pipeline/gpu-search/queries.draft.json"
const manifest = JSON.parse(
  await readFile(join(corpus, "manifest.json"), "utf8")
)
const hash = createHash("sha256")
for await (const bytes of createReadStream(join(corpus, "corpus.jsonl")))
  hash.update(bytes)
if (hash.digest("hex") !== manifest.sha256)
  throw new Error("Corpus digest mismatch")
const builder = createIndexBuilder({ fingerprint: manifest.sha256 })
let source
for await (const line of createInterface({
  input: createReadStream(join(corpus, "corpus.jsonl"))
})) {
  const row = JSON.parse(line)
  if (source !== row.source) {
    source = row.source
    builder.beginSource(source, row.graph)
  }
  builder.addRow({
    ...row,
    tag: row.label_language,
    definition: row.definition || undefined
  })
}
const index = builder.build()
const queries = JSON.parse(await readFile(queriesPath, "utf8"))
const results = queries.map((q) => ({
  ...q,
  results: groundingRows(index, {
    text: q.query,
    keys: manifest.sources.map((s) => s.key),
    cap: 9
  }).map((r) => ({ ...r, id: entryIri(r.key, r.iri) }))
}))
await writeFile(
  join(corpus, "lexical-baseline.json"),
  JSON.stringify(
    {
      corpusSha256: manifest.sha256,
      method: "existing ONT groundingRows; top 10",
      judged: false,
      queries: results
    },
    null,
    2
  ) + "\n"
)
console.log(
  `Saved ${results.length} queries against ${index.size} descriptions`
)
