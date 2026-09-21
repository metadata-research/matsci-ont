// Exercise the production query against a tiny in-memory Jena dataset.
// Shared IRIs must not multiply incoming references or borrow source labels.
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { jenaEnvironment, runJena } from "../shared/tools.mjs"
import { queryLoader } from "../shared/queries.mjs"
import { common } from "./lib/substitutions.mjs"

const base = "https://example.org/"
const predicate = `${base}references`
const dataset = new Map()
function add(graph, triple) {
  if (!dataset.has(graph)) dataset.set(graph, [])
  dataset.get(graph).push(triple)
}
function describe(source, subject, label) {
  add(
    common.DEFS,
    `<${base}entries/${source}/${subject}> ont:entity <${base}${subject}> ;
      ont:fromSource <${base}sources/${source}> ; ont:label ${JSON.stringify(label)} .`
  )
}
function reference(source, subject, target) {
  add(
    `${base}${source}`,
    `<${base}${subject}> <${predicate}> <${base}${target}> .`
  )
}
for (const source of ["alpha", "beta"]) {
  add(
    common.CATALOG,
    `<${base}sources/${source}> ont:namedGraph <${base}${source}> .`
  )
  for (const subject of ["identical", "conflicting"]) {
    describe(
      source,
      subject,
      subject === "identical" ? "same label" : `${source} label`
    )
    reference(source, subject, "small")
  }
}
// A label available only elsewhere must not be attached to these references.
describe("beta", "unlabelled", "beta-only label")
reference("alpha", "unlabelled", "small")
describe("alpha", "uncatalogued", "alpha-only label")
reference("uncatalogued-graph", "uncatalogued", "small")

for (let index = 0; index < 52; index += 1) {
  const subject = `ref-${String(index).padStart(2, "0")}`
  describe("alpha", subject, `reference ${index}`)
  describe(
    "beta",
    subject,
    index % 2 ? `beta reference ${index}` : `reference ${index}`
  )
  reference("alpha", subject, "many")
}

const environment = await jenaEnvironment()
environment.env.JVM_ARGS = "-Xmx256m"
const query = queryLoader(new URL("queries/", import.meta.url).pathname)
const work = await mkdtemp(join(tmpdir(), "matsci-ont-incoming-test-"))
try {
  const dataPath = join(work, "references.trig")
  await writeFile(
    dataPath,
    `@prefix ont: <${common.ONT}> .\n${[...dataset]
      .map(([graph, triples]) => `<${graph}> {\n${triples.join("\n")}\n}`)
      .join("\n")}`
  )
  async function incoming(target) {
    const queryPath = join(work, "incoming.rq")
    await writeFile(
      queryPath,
      await query("incoming", { ...common, IRI: `${base}${target}` })
    )
    const result = runJena(environment, "arq", [
      `--data=${dataPath}`,
      `--query=${queryPath}`,
      "--results=JSON"
    ])
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout).results.bindings
  }

  const small = await incoming("small")
  assert.equal(small.length, 6, "each incoming source triple appears once")
  for (const row of small) {
    const subject = row.s.value.slice(base.length)
    const source = row.g.value.slice(base.length)
    assert.equal(
      row.label?.value,
      subject === "identical"
        ? "same label"
        : subject === "conflicting"
          ? `${source} label`
          : undefined,
      "labels come only from the source graph that asserts the reference"
    )
  }

  const many = await incoming("many")
  assert.equal(many.length, 51, "the overflow sentinel is retained")
  assert.equal(
    new Set(many.map((row) => `${row.g.value} ${row.s.value} ${row.p.value}`))
      .size,
    51,
    "duplicate descriptions cannot consume the result cap"
  )
  assert.deepEqual(
    many.map((row) => row.label.value),
    Array.from({ length: 51 }, (_, index) => `reference ${index}`),
    "all 51 distinct references retain their own source labels"
  )
  console.log("OK: incoming references retain source labels and unique rows")
} finally {
  await rm(work, { recursive: true, force: true })
}
