// Read-only export from a quiescent, versioned local store. No production
// endpoint is needed during a GPU run. Run from the repository root.
import { createHash } from "node:crypto"
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"
import { queryLoader } from "../../shared/queries.mjs"
import { startFuseki, stopFuseki } from "../../shared/fuseki.mjs"
import { queryUrl } from "../../shared/endpoint.mjs"
import { ROOT, STORE } from "../../shared/paths.mjs"
import { entryIri } from "../../shared/vocabulary.mjs"
import { common } from "../../app/lib/substitutions.mjs"
import { literal } from "../../app/lib/terms.mjs"
import { pageRanges, readCatalogue } from "../../app/lib/lookup-load.mjs"
import { loadManifest } from "../lib/manifest.mjs"

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "build/gpu-search/corpus" },
    "local-store": { type: "boolean", default: false }
  }
})
const destination = resolve(values.out)
const staging = `${destination}.partial`
const queries = queryLoader(new URL("../queries/", import.meta.url).pathname)
const appQueries = queryLoader(
  new URL("../../app/queries/", import.meta.url).pathname
)
const manifest = (await loadManifest()).filter(
  (s) => s.kind === "external-snapshot" && s.republishable
)
const report = JSON.parse(
  await readFile(join(ROOT, "build/ingest-report.json"), "utf8")
)
if (!report.publication || report.notClearedForPublication.length)
  throw new Error("Export requires the existing publication build")

async function select(text) {
  const response = await fetch(queryUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/sparql-query",
      Accept: "application/sparql-results+json"
    },
    body: text,
    signal: AbortSignal.timeout(25000)
  })
  if (!response.ok) throw new Error(`SPARQL HTTP ${response.status}`)
  return (await response.json()).results.bindings
}

let server
let output
try {
  // Exclusive staging prevents accidental replacement of another export.
  await mkdir(resolve(destination, ".."), { recursive: true })
  await mkdir(staging)
  if (values["local-store"]) {
    if (process.env.MATSCI_ONT_QUERY_URL)
      throw new Error("Unset MATSCI_ONT_QUERY_URL for --local-store")
    server = await startFuseki({ storeLocation: STORE })
  }
  const before = await readCatalogue()
  const catalogRows = await select(
    await appQueries("lookup-fingerprint", common)
  )
  for (const source of manifest) {
    const row = catalogRows.find((r) => r.key.value === source.key)
    if (
      !row ||
      row.sha256?.value !== source.sha256 ||
      row.version?.value !== source.version ||
      row.graph?.value !== source.graphIri ||
      row.republishable?.value !== "true"
    )
      throw new Error(`Catalogue and source manifest disagree: ${source.key}`)
  }
  if (before.sources.length !== manifest.length)
    throw new Error("Catalogue contains an unexpected cleared source")
  output = await open(join(staging, "corpus.jsonl"), "wx")
  const hash = createHash("sha256")
  const counts = {}
  let total = 0
  for (const source of manifest.sort((a, b) => a.key.localeCompare(b.key))) {
    const [count] = await select(
      await appQueries("lookup-count", { ...common, KEY: literal(source.key) })
    )
    const expected = Number(count.entries.value)
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > 500000)
      throw new Error("Unexpected source size")
    const seen = new Set()
    let missingDefinitions = 0
    for (const range of pageRanges(
      source.key,
      Math.max(1, Math.ceil(expected / 12000))
    )) {
      const tests = []
      if (range.from !== null)
        tests.push(`STR(?entry) >= ${literal(range.from)}`)
      if (range.below !== null)
        tests.push(`STR(?entry) < ${literal(range.below)}`)
      const rows = await select(
        await queries("gpu-corpus", {
          ...common,
          KEY: literal(source.key),
          GRAPH: source.graphIri,
          PAGE: tests.length ? `FILTER(${tests.join(" && ")})` : ""
        })
      )
      rows.sort((a, b) =>
        a.entry.value < b.entry.value
          ? -1
          : a.entry.value > b.entry.value
            ? 1
            : 0
      )
      let lines = ""
      for (const row of rows) {
        const id = row.entry.value
        if (seen.has(id) || id !== entryIri(source.key, row.iri.value))
          throw new Error(`Duplicate or invalid description identity: ${id}`)
        if (
          row.version.value !== source.version ||
          row.license.value !== source.license
        )
          throw new Error(`Description attribution disagrees: ${id}`)
        seen.add(id)
        const definition = row.definition?.value ?? ""
        if (!definition) missingDefinitions++
        lines +=
          JSON.stringify({
            id,
            iri: row.iri.value,
            source: source.key,
            graph: source.graphIri,
            version: row.version.value,
            license: row.license.value,
            label: row.label.value,
            label_language: row.label["xml:lang"] ?? "",
            definition,
            definition_language: row.definition?.["xml:lang"] ?? "",
            typed: row.typed.value === "true",
            lower: row.lower.value,
            text: `${row.label.value}${definition ? `\n${definition}` : ""}`
          }) + "\n"
      }
      hash.update(lines)
      await output.writeFile(lines)
    }
    if (seen.size !== expected)
      throw new Error(
        `Incomplete export of ${source.key}: ${seen.size}/${expected}`
      )
    counts[source.key] = { records: seen.size, missingDefinitions }
    total += seen.size
    console.log(`${source.key}: ${seen.size} descriptions`)
  }
  const after = await readCatalogue()
  if (before.fingerprint !== after.fingerprint)
    throw new Error("Catalogue changed during export")
  await output.sync()
  await output.close()
  output = undefined
  await writeFile(
    join(staging, "manifest.json"),
    JSON.stringify(
      {
        format: "matsci-ont-corpus-v1",
        exportedAt: new Date().toISOString(),
        records: total,
        sha256: hash.digest("hex"),
        catalogueFingerprint: before.fingerprint,
        codeCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: ROOT,
          encoding: "utf8"
        }).trim(),
        buildDate: report.builtAt,
        counts,
        sources: manifest,
        textRecipe:
          "label + newline + definition when present; publisher text unchanged",
        excludedSources: report.excludedFromPublication
      },
      null,
      2
    ) + "\n"
  )
  await rename(staging, destination)
  console.log(`Export complete: ${destination}`)
} finally {
  await output?.close()
  await stopFuseki(server)
}
