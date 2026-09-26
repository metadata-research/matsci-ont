// Small read-only contracts for an external application's hierarchy panel.
// One shared deadline covers every query in a request; no ontology-wide
// ancestor traversal or raw entity/blank-node export is needed.
//
// Candidates are matched by the in-memory lookup index when it is ready and
// current, with candidates.rq and candidate-source.rq as the reference it
// reproduces and the fallback whenever it cannot answer. Both paths produce
// the same rows, which one function shapes.
import { select, namedQuery, requestBudget } from "./lib/store.mjs"
import { common } from "./lib/substitutions.mjs"
import { checkLimit } from "./data.mjs"
import {
  candidateRows,
  indexCovers,
  indexReadsTerm
} from "./lib/lookup-index.mjs"
import { lookupIndexFor, noteLookup } from "./lib/lookup-state.mjs"
import {
  checkIri,
  checkKey,
  literal,
  regexLiteral,
  RejectedInput
} from "./lib/terms.mjs"

export const PREVIEW_MAX_BYTES = 128 * 1024
export const PREVIEW_TIMEOUT_MS = 12000
const MAX_SOURCES = 32
const PARENT_LIMIT = 50

function requestOptions(signal) {
  return {
    ...requestBudget(PREVIEW_TIMEOUT_MS, signal),
    maxBytes: PREVIEW_MAX_BYTES
  }
}

function boundedAnswer(answer) {
  if (Buffer.byteLength(JSON.stringify(answer)) > PREVIEW_MAX_BYTES)
    throw new Error("The hierarchy preview exceeds the response limit.")
  return answer
}

function sourceInfo(source) {
  return {
    key: source.key,
    title: source.title,
    ...(source.version ? { version: source.version } : {}),
    license: source.license
  }
}

async function previewSources(options) {
  const rows = await select("preview-sources", common, options)
  if (rows.length > MAX_SOURCES)
    throw new Error("Too many sources for a bounded hierarchy preview.")
  return rows.map((row) => ({
    key: checkKey(row.key.value),
    title: row.title.value,
    version: row.version?.value,
    license: row.license.value,
    graph: checkIri(row.graph.value)
  }))
}

// `lookup` is for verification and tests: "sparql" skips the index, and
// "index" fails rather than fall back to SPARQL.
export async function findCandidates(
  q,
  { limitPerSource, mode = "exact", signal, lookup = "auto" } = {}
) {
  if (
    typeof q !== "string" ||
    !q.trim() ||
    q.length > 200 ||
    [...q.trim()].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    throw new RejectedInput(
      "A candidate search needs a term of at most 200 characters."
    )
  const text = q.trim()
  if (mode !== "exact" && mode !== "similar")
    throw new RejectedInput("Candidate mode must be exact or similar.")
  const limit = checkLimit(limitPerSource, 5, 20)
  const options = requestOptions(signal)
  const sources = await previewSources(options)
  if (sources.length === 0) return { query: text, mode, sources: [] }
  const { index, release } =
    lookup !== "sparql" && indexReadsTerm(text)
      ? await lookupIndexFor(options.signal)
      : { index: null, release: () => {} }
  let rows
  try {
    if (index && indexCovers(index, sources)) {
      rows = candidateRows(index, {
        text,
        mode,
        limit,
        keys: sources.map((source) => source.key)
      })
      noteLookup(true)
    } else {
      if (lookup === "index")
        throw new Error("The lookup index cannot answer this candidate search.")
      rows = await storeCandidateRows(text, mode, limit, sources, options)
      noteLookup(false)
    }
  } finally {
    release()
  }
  return boundedAnswer({
    query: text,
    mode,
    sources: sources.flatMap((source) => {
      const matches = rows.filter((row) => row.key === source.key)
      return matches.length
        ? [
            {
              source: sourceInfo(source),
              candidates: matches.slice(0, limit).map((row) => ({
                iri: row.iri,
                label: row.label,
                match: row.tier === 0 ? "exact" : "label"
              })),
              truncated: matches.length > limit
            }
          ]
        : []
    })
  })
}

async function storeCandidateRows(text, mode, limit, sources, options) {
  const branches = await Promise.all(
    sources.map((source) =>
      namedQuery("candidate-source", {
        ...common,
        KEY: literal(source.key),
        GRAPH: source.graph,
        TEXT: literal(text),
        REGEX: regexLiteral(text),
        TIER: mode === "exact" ? 0 : 1,
        LIMIT: limit + 1
      })
    )
  )
  const rows = await select(
    "candidates",
    {
      ...common,
      BRANCHES: branches.map((branch) => `{ ${branch} }`).join("\nUNION\n")
    },
    options
  )
  return rows.map((row) => ({
    key: row.key.value,
    iri: row.iri.value,
    label: row.label.value,
    tier: row.tier.value === "0" ? 0 : 1
  }))
}

export async function getHierarchy(iri, { source, signal } = {}) {
  checkIri(iri)
  checkKey(source)
  const options = requestOptions(signal)
  const selected = (await previewSources(options)).find(
    (item) => item.key === source
  )
  if (!selected) throw new RejectedInput("No available source has this key.")
  const substitutions = {
    ...common,
    IRI: iri,
    KEY: literal(source),
    GRAPH: selected.graph
  }
  const entities = await select("hierarchy-entity", substitutions, options)
  if (entities.length === 0)
    throw new RejectedInput(
      "This source does not index this entity as a class or concept."
    )
  if (entities.length !== 1)
    throw new Error("The source has conflicting indexed labels.")
  const parents = await select("hierarchy-parents", substitutions, options)
  return boundedAnswer({
    source: sourceInfo(selected),
    entity: { iri, label: entities[0].label.value },
    parents: parents.slice(0, PARENT_LIMIT).map((row) => ({
      iri: row.iri.value,
      ...(row.label ? { label: row.label.value } : {}),
      predicate: row.predicate.value,
      direction: row.direction.value
    })),
    truncated: parents.length > PARENT_LIMIT,
    hasAnonymousSuperclasses: entities[0].anonymous.value === "true"
  })
}
