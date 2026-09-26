// Two sources intentionally disagree about one publisher IRI. Exercise real
// SPARQL, data APIs and rendered pages, including a deployment under /ont.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { jenaEnvironment, runJena } from "../shared/tools.mjs"
import { startFuseki, stopFuseki } from "../shared/fuseki.mjs"
import { graphIris } from "../shared/vocabulary.mjs"
import { definitionsTurtle, catalogTurtle } from "./lib/derive.mjs"

const iri = "https://example.org/shared"
const rdfs = "http://www.w3.org/2000/01/rdf-schema#"
const skos = "http://www.w3.org/2004/02/skos/core#"
const manifest = ["alpha", "beta"].map((key, index) => ({
  key,
  title: key,
  kind: "external-snapshot",
  graphIri: `https://example.org/${key}`,
  ontologyIri: `https://example.org/${key}`,
  downloadUrl: `https://example.org/${key}.ttl`,
  version: `${index + 1}`,
  license: index ? "CC0-1.0" : "CC-BY-4.0",
  republishable: true,
  sha256: "0".repeat(64)
}))
const byGraph = new Map(
  manifest.map((source) => [
    source.graphIri,
    new Map([
      [
        iri,
        new Map([
          [`${rdfs}label`, [{ value: `${source.key} shared` }]],
          [`${skos}definition`, [{ value: `${source.key} definition` }]]
        ])
      ],
      [
        `${source.graphIri}/parent`,
        new Map([[`${rdfs}label`, [{ value: `${source.key} parent` }]]])
      ]
    ])
  ])
)
const work = await mkdtemp(join(tmpdir(), "matsci-ont-source-test-"))
let fuseki
try {
  const store = join(work, "store")
  await mkdir(store)
  const environment = await jenaEnvironment()
  const load = async (graph, turtle, name) => {
    const path = join(work, `${name}.ttl`)
    await writeFile(path, turtle)
    const result = runJena(environment, "tdb2.tdbloader", [
      `--loc=${store}`,
      `--graph=${graph}`,
      path
    ])
    assert.equal(result.status, 0, result.stderr)
  }
  for (const source of manifest) {
    await load(
      source.graphIri,
      `<${iri}> a <http://www.w3.org/2002/07/owl#Class> ;
      <${rdfs}label> "${source.key} shared" ; <${skos}definition> "${source.key} definition" ;
      <${rdfs}subClassOf> <${source.graphIri}/parent> .
      <${source.graphIri}/parent> <${rdfs}label> "${source.key} parent" .
      <https://example.org/unlabelled> <${skos}definition> "${source.key} unlabelled" .`,
      source.key
    )
  }
  await load(
    graphIris().definitions,
    definitionsTurtle(manifest, byGraph).turtle,
    "definitions"
  )
  await load(graphIris().catalog, catalogTurtle(manifest, new Map()), "catalog")
  fuseki = await startFuseki({ storeLocation: store, port: 3195 })
  process.env.MATSCI_ONT_QUERY_URL = `${fuseki.base}/query`
  process.env.MATSCI_ONT_BASE_PATH = "/ont"
  const { findEntities, getEntity, grounding } = await import("../app/data.mjs")
  const { entityPage } = await import("../app/pages/entity.mjs")
  const found = (await findEntities("shared")).results
  assert.equal(found.length, 2, "one result per source, no Cartesian products")
  const grounded = (await grounding("shared")).results
  assert.equal(grounded.length, 2)
  for (const source of manifest) {
    const hit = found.find((row) => row.source === source.key)
    assert.deepEqual(
      [hit.label, hit.definition, hit.version, hit.license],
      [
        `${source.key} shared`,
        `${source.key} definition`,
        source.version,
        source.license
      ]
    )
    const ground = grounded.find((row) => row.sourceKey === source.key)
    assert.equal(ground.definition, `${source.key} definition`)
    assert.equal(ground.license, source.license)
    const entity = await getEntity(iri, { source: source.key })
    assert.equal(entity.label, hit.label)
    assert.equal(entity.definition, hit.definition)
    assert.equal(entity.source.version, source.version)
    assert.equal(entity.source.license, source.license)
    assert.equal(entity.descriptions.length, 2)
    assert.ok(entity.triples.every((row) => row.graph === source.graphIri))
    const page = await entityPage(iri, false, source.key)
    assert.equal(page.status, 200)
    assert.ok(page.html.includes(`<h1>${hit.label}</h1>`))
    assert.ok(page.html.includes(`${source.key} definition`))
    assert.ok(
      !page.html.includes(
        `${source.key === "alpha" ? "beta" : "alpha"} definition`
      )
    )
    assert.ok(
      page.html.includes(
        `/ont/entity?iri=${encodeURIComponent(source.graphIri + "/parent")}&amp;source=${source.key}`
      )
    )
    assert.ok(
      page.html.includes(
        `&amp;source=${source.key === "alpha" ? "beta" : "alpha"}`
      )
    )
  }
  const unlabelled = await getEntity("https://example.org/unlabelled", {
    source: "beta"
  })
  assert.equal(unlabelled.source.key, "beta")
  assert.ok(
    unlabelled.triples.every((row) => row.graph === "https://example.org/beta")
  )
  assert.equal((await getEntity(iri)).source.key, "alpha", "stable default")
  await assert.rejects(
    getEntity(iri, { source: "missing" }),
    /does not describe/
  )
  await assert.rejects(getEntity(iri, { source: "../bad" }))

  // The lookup index, loaded from this store in its worker, grounds alike.
  const { loadLookupIndex, resetLookupIndex } = await import(
    "../app/lib/lookup-state.mjs"
  )
  const index = await loadLookupIndex()
  assert.ok(index, "the lookup index loads from the store")
  assert.deepEqual(
    index.sources.map((source) => source.key),
    ["alpha", "beta"]
  )
  for (const term of ["shared", "definition", "alpha", "parent"]) {
    for (const options of [{}, { sources: ["beta"] }, { limit: 1 }]) {
      assert.deepEqual(
        await grounding(term, { ...options, lookup: "index" }),
        await grounding(term, { ...options, lookup: "sparql" }),
        `grounding ${term} ${JSON.stringify(options)}`
      )
    }
  }
  resetLookupIndex()
  console.log(
    "OK: source-specific text, attribution, triples, grounding and navigation survive conflicting descriptions"
  )
} finally {
  await stopFuseki(fuseki)
  await rm(work, { recursive: true, force: true })
}
