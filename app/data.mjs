// Data access shared by the browse pages and the MCP tools. Every function
// answers from the loopback SPARQL endpoint, read only, and returns plain
// objects. The one exception is grounding, which answers from the in-memory
// lookup index in lib/lookup-index.mjs when it is ready and current. The
// index is a copy of the store's definitions graph, grounding.rq remains the
// reference it reproduces, and grounding falls back to it whenever the index
// cannot answer.
//
// Reading a caller's own SPARQL is in lib/sparql.mjs, which is pure text
// handling and tested as such; what remains here is the transport and the
// shapes returned.

import { descriptionsFrom, chooseDescription } from "./lib/descriptions.mjs"
import { inferredGraphFor } from "../shared/vocabulary.mjs"
import {
  checkIri,
  checkKey,
  literal,
  regexLiteral,
  RejectedInput
} from "./lib/terms.mjs"
import {
  select,
  readCapped,
  requestBudget,
  MAX_ANSWER_BYTES
} from "./lib/store.mjs"
import {
  groundingRows,
  indexHasKeys,
  indexReadsTerm
} from "./lib/lookup-index.mjs"
import { lookupIndexFor, noteLookup } from "./lib/lookup-state.mjs"
import { checkQueryForm, withRowLimit } from "./lib/sparql.mjs"
import { queryUrl } from "../shared/endpoint.mjs"
import { common, ONT } from "./lib/substitutions.mjs"

export const ROW_CAP = 500
// Matches arq:queryTimeout in the reviewed Fuseki configuration.
export const STORE_TIMEOUT_MS = 30000
// One deadline for both of a grounding lookup's store calls, below the
// 15 seconds MatSci-SAM waits and the store's own 30.
export const GROUNDING_TIMEOUT_MS = 12000

export function checkLimit(value, fallback, cap) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1 || value > cap) {
    throw new RejectedInput(`limit must be a whole number between 1 and ${cap}`)
  }
  return value
}

// A mirror has no version and no ontology IRI of its own, so those are
// absent rather than empty, and it says instead what it mirrors and when
// its publisher last projected it.
export async function listSources() {
  const rows = await select("catalogue", common)
  return rows.map((row) => ({
    key: row.key.value,
    title: row.title.value,
    license: row.license.value,
    graphIri: row.graphIri.value,
    triples: Number(row.triples.value),
    entries: Number(row.entries?.value ?? 0),
    clearedForPublication: row.republishable?.value === "true",
    ...(row.version ? { version: row.version.value } : {}),
    ...(row.ontologyIri ? { ontologyIri: row.ontologyIri.value } : {}),
    ...(row.mirrorOf
      ? {
          mirrorOf: row.mirrorOf.value,
          mirroredFrom: row.mirroredFrom?.value,
          authorityBase: row.authorityBase?.value
        }
      : {})
  }))
}

export async function getSource(key) {
  checkKey(key)
  const source = (await listSources()).find((row) => row.key === key)
  if (!source) throw new RejectedInput(`no source is named ${key}`)

  // The catalogue holds more than the listing shows, the reasoning record
  // among it. Only this project's own predicates are read: the Dublin Core
  // and VoID statements repeat fields the listing already carries, in
  // their own IRIs, and adding them would return each value twice under
  // two names.
  const detail = await select("source-detail", { ...common, KEY: literal(key) })
  const multiple = new Set(["module"])
  for (const row of detail) {
    if (!row.p.value.startsWith(ONT)) continue
    const name = row.p.value.slice(ONT.length)
    if (["sourceKey", "namedGraph", "ontologyIri"].includes(name)) continue
    const value = row.o.datatype?.endsWith("#integer")
      ? Number(row.o.value)
      : row.o.value
    if (multiple.has(name)) {
      source[`${name}s`] = [...(source[`${name}s`] ?? []), value]
    } else {
      source[name] = value
    }
  }
  return source
}

export async function getEntity(iri, { source } = {}) {
  if (source !== undefined) checkKey(source)
  checkIri(iri)
  const rows = await select("entity", { ...common, IRI: iri })
  if (rows.length === 0) {
    // The entity query matches the IRI as a subject. An IRI from an
    // ontology this store does not hold, an upper-level class among them,
    // commonly appears only as an object, and saying nothing mentions it
    // would be false.
    const references = await select("incoming", { ...common, IRI: iri })
    if (references.length === 0) {
      throw new RejectedInput(`nothing in the store mentions ${iri}`)
    }
    if (source !== undefined)
      throw new RejectedInput("This source does not describe the entity.")
    return {
      iri,
      describedHere: false,
      note: "No source in this store describes this entity. It appears only as the object of statements made about others.",
      referencedBy: references.slice(0, 50).map((row) => ({
        iri: row.s.value,
        label: row.label?.value,
        predicate: row.p.value
      })),
      truncated: references.length > 50
    }
  }

  const descriptions = descriptionsFrom(
    await select("descriptions", { ...common, IRI: iri })
  )
  const entry = descriptions.length
    ? chooseDescription(descriptions, source)
    : {}
  const catalogue = await listSources()
  const chosen = catalogue.find((item) =>
    entry.sourceKey
      ? item.key === entry.sourceKey
      : (source === undefined || item.key === source) &&
        rows.some((row) => row.g.value === item.graphIri)
  )
  if (source !== undefined && !chosen)
    throw new RejectedInput("This source does not describe the entity.")
  const selectedGraph = chosen?.graphIri
  const triples = []
  for (const row of rows) {
    if (selectedGraph && row.g.value !== selectedGraph) continue
    triples.push({
      subject: row.s.type === "bnode" ? `_:${row.s.value}` : row.s.value,
      predicate: row.p.value,
      object: row.o.type === "bnode" ? `_:${row.o.value}` : row.o.value,
      objectKind: row.o.type,
      language: row.o["xml:lang"],
      graph: row.g.value
    })
  }

  // The inferred placements sit in their own graph, which entity.rq
  // excludes, so they are fetched separately and marked as derived.
  const inferred = entry.sourceKey
    ? await select("entity-inferred", {
        ...common,
        IRI: iri,
        INFGRAPH: checkIri(inferredGraphFor(checkKey(entry.sourceKey)))
      })
    : []

  // An entity the definitions index skipped, because it has no label,
  // still comes from a source: the graph its triples are in names it.
  const graphKeys = new Set(triples.map((triple) => triple.graph))
  const fromGraph = entry.sourceKey
    ? undefined
    : catalogue.find((source) => graphKeys.has(source.graphIri))

  return {
    iri,
    describedHere: true,
    label: entry.label,
    definition: entry.definition,
    definitionProperty: entry.definitionProperty,
    descriptions: descriptions.map((item) => ({
      label: item.label,
      definition: item.definition,
      definitionProperty: item.definitionProperty,
      source: {
        key: item.sourceKey,
        ...(item.sourceVersion !== "mirror"
          ? { version: item.sourceVersion }
          : {}),
        license: item.license,
        ...mirrorFacts(catalogue, item.sourceKey)
      }
    })),
    ...(descriptions.length > 1
      ? {
          note: `Description from ${entry.sourceKey}; use source to select another description of this IRI.`
        }
      : {}),
    source: entry.sourceKey
      ? {
          key: entry.sourceKey,
          ...(entry.sourceVersion && entry.sourceVersion !== "mirror"
            ? { version: entry.sourceVersion }
            : {}),
          license: entry.license,
          // A client is told to act on these, so every payload naming a
          // source carries them, not only the catalogue listing.
          ...mirrorFacts(catalogue, entry.sourceKey)
        }
      : fromGraph
        ? {
            key: fromGraph.key,
            ...(fromGraph.version ? { version: fromGraph.version } : {}),
            license: fromGraph.license,
            ...mirrorFacts(catalogue, fromGraph.key)
          }
        : undefined,
    triples: triples.slice(0, ROW_CAP),
    truncated: triples.length > ROW_CAP,
    inferredParents: inferred.map((row) => row.parent.value)
  }
}

// What a client needs in order to say where something came from and
// whether it may be passed on.
function mirrorFacts(catalogue, key) {
  const source = catalogue.find((row) => row.key === key)
  if (!source) return {}
  return {
    clearedForPublication: source.clearedForPublication,
    ...(source.mirrorOf
      ? { mirrorOf: source.mirrorOf, mirroredFrom: source.mirroredFrom }
      : {})
  }
}

export async function findEntities(q, { sources, limit } = {}) {
  const text = String(q ?? "").trim()
  if (text === "") throw new RejectedInput("a search needs a term")
  const cap = checkLimit(limit, 20, 200)

  // Keys are validated before they reach the fragment, so no caller text
  // enters the query.
  const filter =
    sources && sources.length > 0
      ? `FILTER(?key IN (${sources.map((key) => `"${checkKey(key)}"`).join(", ")}))`
      : ""

  const rows = await select("find", {
    ...common,
    TEXT: literal(text.slice(0, 200)),
    REGEX: regexLiteral(text.slice(0, 200)),
    SOURCEFILTER: filter,
    LIMIT: String(cap + 1)
  })

  const catalogue = await listSources()
  return {
    results: rows.slice(0, cap).map((row) => ({
      iri: row.s.value,
      label: row.label.value,
      definition: row.definition?.value,
      source: row.key.value,
      // "mirror" is a placeholder the index writes where a version would
      // be, not a version. A client is not given it as one.
      ...(row.version.value === "mirror" ? {} : { version: row.version.value }),
      license: row.license.value,
      ...mirrorFacts(catalogue, row.key.value)
    })),
    truncated: rows.length > cap
  }
}

// Which sources a grounding lookup may draw on.
//
// A source not cleared for publication never appears, whatever else is
// asked for. The route hands definition text to a caller who will put it
// in front of a reader, and the clearance flag is the record that its
// licence permits that.
//
// A mirror is excluded again by default, for a different reason: this
// route exists to serve MatSci-SAM, and returning its own vocabulary to it
// would be circular. `includeMirror` lifts that, but it cannot lift the
// clearance rule, so while the MatSci-SAM licence is undeclared the option
// can add nothing. The answer says so rather than returning silently.
export function allowedSources(catalogue, { sources, includeMirror } = {}) {
  const cleared = catalogue.filter((source) => source.clearedForPublication)
  const withoutMirrors = includeMirror
    ? cleared
    : cleared.filter((source) => !source.mirrorOf)
  if (!sources || sources.length === 0) {
    return {
      keys: withoutMirrors.map((source) => source.key),
      mirrorsAvailable: cleared.some((source) => source.mirrorOf)
    }
  }
  const asked = new Set(sources.map((key) => checkKey(key)))
  return {
    keys: withoutMirrors
      .filter((source) => asked.has(source.key))
      .map((source) => source.key),
    mirrorsAvailable: cleared.some((source) => source.mirrorOf)
  }
}

// The catalogue fields grounding reads, without listSources' entry counts,
// which count every description in the store on each call.
async function groundingSources(options) {
  const rows = await select("grounding-sources", common, options)
  return rows.map((row) => ({
    key: row.key.value,
    title: row.title.value,
    clearedForPublication: row.republishable?.value === "true",
    ...(row.mirrorOf ? { mirrorOf: row.mirrorOf.value } : {})
  }))
}

// `lookup` is for verification and tests: "sparql" skips the index, and
// "index" fails rather than fall back to SPARQL.
export async function grounding(
  q,
  { sources, limit, includeMirror, signal, lookup = "auto" } = {}
) {
  const text = String(q ?? "").trim()
  if (text === "") throw new RejectedInput("a grounding lookup needs a term")
  const cap = checkLimit(limit, 10, 50)

  const budget = requestBudget(GROUNDING_TIMEOUT_MS, signal)
  const catalogue = await groundingSources(budget)
  const { keys, mirrorsAvailable } = allowedSources(catalogue, {
    sources,
    includeMirror
  })
  const note =
    includeMirror && !mirrorsAvailable
      ? "No mirrored source is cleared for publication, so includeMirror added nothing."
      : undefined

  if (keys.length === 0) {
    return {
      query: text,
      results: [],
      truncated: false,
      ...(note ? { note } : {})
    }
  }

  const titles = new Map(catalogue.map((source) => [source.key, source.title]))
  const term = text.slice(0, 200)
  const { index, release } =
    lookup !== "sparql" && indexReadsTerm(term)
      ? await lookupIndexFor(budget)
      : { index: null, release: () => {} }
  let rows
  try {
    if (index && indexHasKeys(index, keys)) {
      rows = groundingRows(index, { text: term, keys, cap })
      noteLookup(true)
    } else {
      if (lookup === "index")
        throw new Error("The lookup index cannot answer this grounding lookup.")
      const bindings = await select(
        "grounding",
        {
          ...common,
          TEXT: literal(term),
          REGEX: regexLiteral(term),
          SOURCEFILTER: `FILTER(?key IN (${keys.map((key) => `"${key}"`).join(", ")}))`,
          LIMIT: String(cap + 1)
        },
        budget
      )
      rows = bindings.map((row) => ({
        iri: row.iri.value,
        label: row.label.value,
        definition: row.definition.value,
        key: row.key.value,
        version: row.version.value,
        license: row.license.value
      }))
      noteLookup(false)
    }
  } finally {
    release()
  }

  return {
    query: text,
    results: rows.slice(0, cap).map((row) => ({
      term: row.label,
      definition: row.definition,
      source: titles.get(row.key) ?? row.key,
      sourceIri: row.iri,
      sourceKey: row.key,
      version: row.version,
      license: row.license
    })),
    truncated: rows.length > cap,
    ...(note ? { note } : {})
  }
}

export async function sparqlQuery(query, { limit } = {}) {
  const text = String(query ?? "").trim()
  if (text === "") throw new RejectedInput("a query is required")
  const cap = checkLimit(limit, 200, ROW_CAP)

  const form = checkQueryForm(text)

  const wantsGraph = form === "CONSTRUCT" || form === "DESCRIBE"
  const sent = form === "SELECT" ? (withRowLimit(text, cap + 1) ?? text) : text
  let response
  try {
    response = await fetch(queryUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/sparql-query",
        Accept: wantsGraph ? "text/turtle" : "application/sparql-results+json"
      },
      body: sent,
      // Above the 30 seconds the store allows a query, so a store that
      // stops one answers first and this is only the backstop.
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS + 5000)
    })
  } catch (error) {
    throw new Error(
      error.name === "TimeoutError"
        ? `the query ran longer than the store allows (${STORE_TIMEOUT_MS / 1000} seconds). Narrow it or add a LIMIT.`
        : `the store could not be reached: ${error.message}`
    )
  }

  if (!response.ok) {
    throw new Error(
      `the store refused the query (HTTP ${response.status}): ${(await readCapped(response)).body.slice(0, 300).trim()}`
    )
  }

  // Read with a ceiling. A query that matches most of the store would
  // otherwise be assembled whole in this process, which serves the pages
  // too: one call could take the application down. The store stopping a
  // query mid-stream also leaves a partial body, which is what reading it
  // whole turned into an unreadable internal error.
  const { body: answer, exceeded } = await readCapped(response)
  if (exceeded) {
    throw new Error(
      `the answer passed ${MAX_ANSWER_BYTES / (1024 * 1024)} MB before it finished. Add a LIMIT or ask for less.`
    )
  }

  if (wantsGraph) return { form, turtle: answer, truncated: false }

  let parsed
  try {
    parsed = JSON.parse(answer)
  } catch {
    // The store answers 200 and then stops a long query part-way, leaving
    // a truncated body. Below the size ceiling that arrives here as a
    // parse failure, and the caller needs the reason, not the position
    // where the JSON broke.
    throw new Error(
      `the query ran longer than the store allows (${STORE_TIMEOUT_MS / 1000} seconds) and was stopped part-way. Narrow it or add a LIMIT.`
    )
  }
  if (parsed.boolean !== undefined)
    return { form, boolean: parsed.boolean, truncated: false }

  const bindings = parsed.results.bindings
  const rows = bindings.slice(0, cap).map((binding) => {
    const row = {}
    for (const [name, term] of Object.entries(binding)) {
      row[name] = term.type === "bnode" ? `_:${term.value}` : term.value
    }
    return row
  })
  return {
    form,
    variables: parsed.head.vars,
    rows,
    truncated: bindings.length > cap
  }
}
