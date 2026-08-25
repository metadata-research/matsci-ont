// Builds the two graphs MatSci-ONT derives from the sources it loaded.
//
//   catalog      one resource per source: what it is, which version, which
//                licence, where it came from, how large it is
//   definitions  one entry per named class, property or concept that carries
//                a label: the chosen label and definition, and the source
//
// Both are functions of the manifest and the loaded sources. Nothing here
// reads the clock: a wall-clock stamp in the store would make two builds of
// one manifest differ, and the ingest time is recorded in the build report
// instead, which is not part of the store.
//
// Identifiers: only the catalog resources and the small vocabulary are
// minted here, under a configurable base. Entities keep the IRI their
// publisher minted, and the index states its own properties about them
// rather than restating or re-licensing their vocabulary.

import { writeFile } from "node:fs/promises"
import { runJena } from "../../shared/tools.mjs"
import { baseUrl } from "../../shared/vocabulary.mjs"

const SKOS = "http://www.w3.org/2004/02/skos/core#"
const RDFS = "http://www.w3.org/2000/01/rdf-schema#"
const IAO_DEFINITION = "http://purl.obolibrary.org/obo/IAO_0000115"
// EMMO names its annotation properties with opaque IRIs. This one is
// elucidation, which is where a CHAMEO class keeps its definition.
const EMMO_ELUCIDATION =
  "https://w3id.org/emmo#EMMO_967080e5_2f42_4eb2_a3a9_c58143e835f9"

// Ordered. The first property that yields a literal wins.
export const LABEL_PROPERTIES = [`${SKOS}prefLabel`, `${RDFS}label`]
export const DEFINITION_PROPERTIES = [
  `${SKOS}definition`,
  IAO_DEFINITION,
  EMMO_ELUCIDATION,
  `${RDFS}comment`
]

const ENTITY_TYPES = [
  "http://www.w3.org/2002/07/owl#Class",
  `${RDFS}Class`,
  "http://www.w3.org/2002/07/owl#ObjectProperty",
  "http://www.w3.org/2002/07/owl#DatatypeProperty",
  "http://www.w3.org/2002/07/owl#AnnotationProperty",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property",
  // A SKOS concept scheme has no classes. Without this the NIST vocabulary,
  // 993 concepts and the reason that source is in the manifest, contributes
  // nothing to the index.
  `${SKOS}Concept`
]

const escapeLiteral = (value) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")

const literal = (binding) => {
  const text = `"${escapeLiteral(binding.value)}"`
  if (binding["xml:lang"]) return `${text}@${binding["xml:lang"]}`
  return text
}

// English first, then any other tagged language, then an untagged literal.
// PMDco carries German alongside English, and NIST tags some labels en-US.
function preferred(candidates) {
  if (candidates.length === 0) return null
  const language = (binding) => (binding["xml:lang"] ?? "").toLowerCase()
  return (
    candidates.find((c) => language(c) === "en") ??
    candidates.find((c) => language(c).startsWith("en")) ??
    candidates.find((c) => language(c) === "") ??
    candidates[0]
  )
}

export function selectQuery() {
  const iris = (items) => items.map((iri) => `<${iri}>`)
  return `SELECT ?g ?s ?p ?o WHERE {
  GRAPH ?g { ?s ?p ?o }
  VALUES ?p { ${iris([...LABEL_PROPERTIES, ...DEFINITION_PROPERTIES]).join(" ")} }
  FILTER(isLiteral(?o))
  FILTER(!isBlank(?s))
  FILTER EXISTS {
    GRAPH ?g { ?s a ?type }
    FILTER(?type IN (${iris(ENTITY_TYPES).join(", ")}))
  }
}`
}

// Reads every label and definition candidate out of the loaded sources in
// one query, then chooses per entity in code so the precedence is explicit
// and testable.
export async function readEntities(environment, location, queryPath) {
  await writeFile(queryPath, `${selectQuery()}\n`)
  const result = runJena(environment, "tdb2.tdbquery", [
    `--loc=${location}`,
    "--results=JSON",
    `--query=${queryPath}`
  ])
  if (result.status !== 0)
    throw new Error(`entity query failed\n${result.stderr}`)

  const byGraph = new Map()
  for (const binding of JSON.parse(result.stdout).results.bindings) {
    const graph = binding.g.value
    const subject = binding.s.value
    if (!byGraph.has(graph)) byGraph.set(graph, new Map())
    const entities = byGraph.get(graph)
    if (!entities.has(subject)) entities.set(subject, new Map())
    const properties = entities.get(subject)
    if (!properties.has(binding.p.value)) properties.set(binding.p.value, [])
    properties.get(binding.p.value).push(binding.o)
  }
  return byGraph
}

// A MatSci-SAM term does not carry its definition as a literal. It points
// at one revision per competing definition, and the text is the rdf:value
// of that revision. The vocabulary is built on rival definitions, so there
// is no single answer in the graph: the index takes the most settled status
// and, among equals, the lowest definition number, and records how many
// rivals there were so the choice is visible rather than implied.
const STATUS_RANK = { stable: 0, "community-reviewed": 1, proposed: 2 }
const MATSCI = "metadata#"

export function mirrorDefinitionQuery(graphIri) {
  return `PREFIX skos: <${SKOS}>
PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?term ?text ?status ?revision WHERE {
  GRAPH <${graphIri}> {
    ?term skos:definition ?revision .
    ?revision rdf:value ?text .
    OPTIONAL { ?revision ?statusProperty ?status
               FILTER(STRENDS(STR(?statusProperty), "${MATSCI}status")) }
  }
}
ORDER BY ?term ?revision`
}

export async function readMirrorDefinitions(
  environment,
  location,
  graphIri,
  queryPath
) {
  await writeFile(queryPath, `${mirrorDefinitionQuery(graphIri)}\n`)
  const result = runJena(environment, "tdb2.tdbquery", [
    `--loc=${location}`,
    "--results=JSON",
    `--query=${queryPath}`
  ])
  if (result.status !== 0)
    throw new Error(`mirror definition query failed\n${result.stderr}`)

  const byTerm = new Map()
  for (const binding of JSON.parse(result.stdout).results.bindings) {
    const term = binding.term.value
    if (!byTerm.has(term)) byTerm.set(term, [])
    byTerm.get(term).push({
      text: binding.text,
      status: binding.status?.value ?? "proposed",
      revision: binding.revision.value
    })
  }
  return byTerm
}

// Numbers in an IRI compare as numbers. Comparing the IRIs as text would
// place definition 10 before definition 2, which is not the documented rule
// and would change which definition a reader is shown once a term reaches
// ten rivals.
function numbersIn(iri) {
  return (iri.match(/\d+/g) ?? []).map(Number)
}

export function chooseMirrorDefinition(candidates) {
  if (!candidates || candidates.length === 0) return null
  const ordered = [...candidates].sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    if (rank !== 0) return rank
    const left = numbersIn(a.revision)
    const right = numbersIn(b.revision)
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const difference = (left[i] ?? -1) - (right[i] ?? -1)
      if (difference !== 0) return difference
    }
    return a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0
  })
  return { ...ordered[0], rivals: candidates.length }
}

function choose(properties, ordered) {
  for (const property of ordered) {
    const chosen = preferred(properties.get(property) ?? [])
    if (chosen) return { property, binding: chosen }
  }
  return null
}

const PREFIXES = `@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix void:    <http://rdfs.org/ns/void#> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
`

export function catalogTurtle(
  manifest,
  counts,
  reasoning = [],
  mirrorModified
) {
  const base = baseUrl()
  const byKey = new Map(reasoning.map((record) => [record.key, record]))
  const lines = [PREFIXES, `@prefix ont: <${base}vocab#> .`, ""]
  for (const entry of manifest) {
    const subject = `<${base}sources/${entry.key}>`
    const record = byKey.get(entry.key)
    const mirror = entry.kind === "matsci-sam-mirror"
    lines.push(`${subject} a ont:Source, void:Dataset ;`)
    lines.push(`    ont:sourceKey "${escapeLiteral(entry.key)}" ;`)
    lines.push(`    dcterms:title "${escapeLiteral(entry.title)}" ;`)
    lines.push(`    ont:namedGraph <${entry.graphIri}> ;`)
    lines.push(`    dcterms:license "${escapeLiteral(entry.license)}" ;`)
    lines.push(
      `    ont:republishable ${entry.republishable ? "true" : "false"} ;`
    )
    if (mirror) {
      // A mirror states where it came from and when the publisher last
      // projected it, which is the date a reader needs to judge it. It
      // states no version or digest, because it is not pinned.
      lines.push(`    ont:mirrorOf <${entry.sourceDataset}> ;`)
      lines.push(`    ont:authorityBase <${entry.authorityBase}> ;`)
      lines.push(`    dcterms:source <${entry.fetchUrl}> ;`)
      if (mirrorModified) {
        lines.push(
          `    ont:mirroredFrom "${escapeLiteral(mirrorModified)}"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;`
        )
      }
    } else {
      lines.push(`    ont:ontologyIri <${entry.ontologyIri}> ;`)
      lines.push(`    dcterms:hasVersion "${escapeLiteral(entry.version)}" ;`)
      lines.push(`    dcterms:source <${entry.downloadUrl}> ;`)
      lines.push(`    ont:sha256 "${entry.sha256}" ;`)
    }
    for (const module of entry.modules ?? []) {
      lines.push(`    ont:module <${module.url}> ;`)
    }
    // The reasoning record: what produced the inferred graph, or why there
    // is none. A source with no record predates reasoning entirely.
    if (record?.reasoned) {
      lines.push(`    ont:reasoner "${escapeLiteral(record.reasoner)}" ;`)
      lines.push(`    ont:inferredPairs ${record.pairs} ;`)
      lines.push(`    ont:entailedPairs ${record.entailed} ;`)
      if (record.pairs > 0)
        lines.push(`    ont:inferredGraph <${record.graphIri}> ;`)
    } else if (record) {
      lines.push(
        `    ont:reasoningSkipped "${escapeLiteral(record.skipped)}" ;`
      )
    }
    lines.push(`    void:triples ${counts.get(entry.graphIri) ?? 0} .`)
    lines.push("")
  }
  return lines.join("\n")
}

export function definitionsTurtle(
  manifest,
  byGraph,
  mirrorDefinitions = new Map()
) {
  const base = baseUrl()
  const lines = [PREFIXES, `@prefix ont: <${base}vocab#> .`, ""]
  let entries = 0

  for (const entry of manifest) {
    const entities = byGraph.get(entry.graphIri)
    if (!entities) continue
    const source = `<${base}sources/${entry.key}>`
    const revisions = mirrorDefinitions.get(entry.key)

    for (const [subject, properties] of [...entities.entries()].sort()) {
      const label = choose(properties, LABEL_PROPERTIES)
      // An entry without a label is not findable and not useful to a
      // reader, so the index skips it.
      if (!label) continue
      const definition = choose(properties, DEFINITION_PROPERTIES)
      const mirrored = revisions
        ? chooseMirrorDefinition(revisions.get(subject))
        : null

      lines.push(`<${subject}>`)
      lines.push(`    ont:fromSource ${source} ;`)
      lines.push(`    ont:sourceKey "${escapeLiteral(entry.key)}" ;`)
      // Version and licence are repeated on every entry so that one query
      // pattern answers the grounding contract of Phase 5. They are stated
      // with properties of this index: a dcterms:license here would be a
      // claim about somebody else's entity rather than about the text this
      // index serves. A mirror has no version, so it states the kind of
      // source it is instead.
      lines.push(
        `    ont:sourceVersion "${escapeLiteral(entry.version ?? "mirror")}" ;`
      )
      lines.push(`    ont:license "${escapeLiteral(entry.license)}" ;`)
      lines.push(`    ont:labelProperty <${label.property}> ;`)
      if (mirrored) {
        lines.push(`    ont:definitionProperty <${SKOS}definition> ;`)
        lines.push(`    ont:definitionRevision <${mirrored.revision}> ;`)
        lines.push(
          `    ont:definitionStatus "${escapeLiteral(mirrored.status)}" ;`
        )
        if (mirrored.rivals > 1)
          lines.push(`    ont:rivalDefinitions ${mirrored.rivals} ;`)
        lines.push(`    ont:definition ${literal(mirrored.text)} ;`)
      } else if (definition) {
        lines.push(`    ont:definitionProperty <${definition.property}> ;`)
        lines.push(`    ont:definition ${literal(definition.binding)} ;`)
      }
      lines.push(`    ont:label ${literal(label.binding)} .`)
      lines.push("")
      entries += 1
    }
  }
  return { turtle: lines.join("\n"), entries }
}
