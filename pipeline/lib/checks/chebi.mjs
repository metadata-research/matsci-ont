// Phase 11: the real pinned ChEBI content, source identity and bounded views.
import {
  getEntity,
  listSources,
  grounding,
  findEntities
} from "../../../app/data.mjs"
import { escape } from "../../../app/lib/html.mjs"
import { countOf } from "../../../shared/fuseki.mjs"

export async function checkChebi({ record, page, ask, graphs, ont, fixtures }) {
  const fixture = fixtures.chebi
  const source = (await listSources()).find((row) => row.key === "chebi")
  record(
    "ChEBI CORE has the pinned size, version and licence",
    source?.triples === fixture.triples &&
      source?.entries === fixture.entries &&
      source?.version === "254" &&
      source?.license === "CC-BY-4.0" &&
      source?.clearedForPublication,
    `${source?.triples} triples, ${source?.entries} indexed descriptions`
  )
  const invalid = countOf(
    await ask("invalid-descriptions", {
      DEFS: graphs.definitions,
      CATALOG: graphs.catalog,
      ONT: ont
    })
  )
  record(
    "every indexed description owns exactly one entity and source attribution",
    invalid === 0,
    `${invalid} invalid records`
  )
  const result = (await grounding("water", { sources: ["chebi"], limit: 1 }))
    .results[0]
  record(
    "ChEBI grounds water with its publisher definition and identifier",
    result?.sourceIri === fixture.water &&
      result?.definition === fixture.waterDefinition &&
      result?.version === "254" &&
      result?.license === "CC-BY-4.0",
    result?.sourceIri
  )
  const found = (await findEntities("water", { sources: ["chebi"], limit: 1 }))
    .results[0]
  record(
    "an exact ChEBI search match survives the result cap",
    found?.iri === fixture.water,
    found?.iri
  )
  const shared = await getEntity(fixture.shared, { source: "chebi" })
  const alternate = await getEntity(fixture.shared, { source: "pmdco" })
  record(
    "a shared ChEBI IRI offers coherent ChEBI and PMD descriptions",
    shared.label === "iron atom" &&
      shared.source.version === "254" &&
      alternate.source.version === "3.1.0" &&
      shared.descriptions.length === 2 &&
      shared.triples.every((row) => row.graph === source.graphIri) &&
      alternate.triples.every((row) => row.graph === "https://w3id.org/pmd/co/")
  )
  const rendered = await page(
    `/entity?iri=${encodeURIComponent(fixture.shared)}&source=pmdco`
  )
  record(
    "source selection reaches the rendered entity page and links back to ChEBI",
    rendered.status === 200 &&
      rendered.text.includes("version 3.1.0") &&
      rendered.text.includes("&amp;source=chebi") &&
      rendered.text.includes(escape(alternate.definition))
  )
  const wrong = await page(
    `/entity?iri=${encodeURIComponent(fixture.water)}&source=nist-imrr`
  )
  record(
    "a source that does not describe an entity is refused",
    wrong.status === 404,
    `HTTP ${wrong.status}`
  )
  const graph = JSON.parse((await page("/graph/chebi.json")).text)
  const ids = new Set(graph.elements.nodes.map((node) => node.data.id))
  record(
    "the ChEBI graph is bounded and every displayed edge connects displayed nodes",
    graph.truncated === true &&
      ids.size > 0 &&
      ids.size <= 300 &&
      graph.elements.edges.length <= 1200 &&
      graph.elements.edges.every(
        (edge) => ids.has(edge.data.source) && ids.has(edge.data.target)
      ) &&
      graph.elements.nodes.every((node) =>
        node.data.url.endsWith("&source=chebi")
      ),
    `${ids.size} nodes, ${graph.elements.edges.length} edges`
  )
  const roots = await page("/source/chebi")
  record(
    "ChEBI starts with a declared roots-only view and retains hierarchy navigation",
    roots.status === 200 &&
      roots.text.includes("root classes") &&
      roots.text.includes("chemical entity") &&
      roots.text.includes("&amp;source=chebi")
  )
}
