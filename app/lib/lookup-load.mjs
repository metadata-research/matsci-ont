// Reads the lookup index from the store: the catalogue fingerprint, and
// each cleared source's descriptions, streamed into the builder in
// lookup-index.mjs. lookup-state.mjs runs the load in a worker thread, and
// the index crosses back with packIndex and unpackIndex.

import { createHash } from "node:crypto"
import { AnswerTooLarge, select, selectStream } from "./store.mjs"
import { common } from "./substitutions.mjs"
import { checkIri, checkKey, literal } from "./terms.mjs"
import { createIndexBuilder, LookupIndexError } from "./lookup-index.mjs"

const CATALOGUE_TIMEOUT_MS = 5000
// Each source is one streamed query, which the store's own 30 second limit
// also bounds. This is the backstop for a store that stops answering.
const SOURCE_TIMEOUT_MS = 60000
export const MAX_ROWS = 1000000
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024
// What a load may add to its thread's memory, counting the JavaScript heap
// and the arrays and buffers outside it, which hold most of the index. The
// current store peaks at about 92 MB in the worker and leaves an index of
// about 58 MB. The application's unit starts reclaiming memory at 384 MB,
// so an index that needs more than this is abandoned rather than loaded.
export const MEMORY_BUDGET_BYTES = 192 * 1024 * 1024
// The worker's heap limits. The build of the current store keeps under
// 60 MB live. A small young generation keeps the worker's peak resident
// memory down at no measurable cost in load time.
export const WORKER_HEAP_MB = 256
export const WORKER_YOUNG_MB = 8
const GUARD_EVERY_ROWS = 16384
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string"
const LANGUAGE_TAG = /^[A-Za-z]+(-[A-Za-z0-9]+)*$/

// What identifies each source's content. The digest is optional because a
// store built before it existed does not state it.
function fingerprintOf(rows) {
  const term = (value) =>
    value
      ? `${value.type}:${value.value}@${value["xml:lang"] ?? ""}^${value.datatype ?? ""}`
      : "-"
  const lines = rows.map((row) =>
    [
      "key",
      "graph",
      "republishable",
      "sha256",
      "version",
      "triples",
      "mirrorOf",
      "mirroredFrom",
      "digest"
    ]
      .map((name) => term(row[name]))
      .join("|")
  )
  return createHash("sha256")
    .update([...lines].sort().join("\n"))
    .digest("hex")
}

// The sources the index holds: those cleared for publication, since no
// route serves the others, each with the one graph that types its entries.
function sourcesOf(rows) {
  const graphs = new Map()
  for (const row of rows) {
    if (row.republishable?.value !== "true" || row.graph?.type !== "uri")
      continue
    const key = row.key.value
    if (!graphs.has(key)) graphs.set(key, new Set())
    graphs.get(key).add(row.graph.value)
  }
  const sources = []
  for (const [key, set] of graphs) {
    // A source naming two graphs would type its entries against either,
    // which the candidate query does not do, so it is left to SPARQL.
    if (set.size !== 1) continue
    try {
      sources.push({ key: checkKey(key), graph: checkIri([...set][0]) })
    } catch {
      // Not a key or graph a query can carry; left to SPARQL.
    }
  }
  return sources.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// The catalogue's fingerprint and the sources an index would hold.
export async function readCatalogue() {
  const rows = await select("lookup-fingerprint", common, {
    signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS)
  })
  return { fingerprint: fingerprintOf(rows), sources: sourcesOf(rows) }
}

// What this thread holds, inside the heap and out.
function footprint() {
  const { heapUsed, arrayBuffers } = process.memoryUsage()
  return heapUsed + arrayBuffers
}

// Streams each source's descriptions into a new index, which records the
// most memory the load added (loadPeakBytes).
//
// Only what the store holds refuses the index for good, with a
// LookupIndexError: a description the index cannot reproduce, or more rows,
// bytes or memory than the limits allow. A store that stops a query, or
// cannot be reached, fails this load with a plain Error, and the next one
// tries again. The limits can be lowered for tests.
export async function loadIndex(
  { fingerprint, sources },
  {
    maxRows = MAX_ROWS,
    maxSourceBytes = MAX_SOURCE_BYTES,
    memoryBudget = MEMORY_BUDGET_BYTES
  } = {}
) {
  const builder = createIndexBuilder({ fingerprint, maxRows })
  const before = footprint()
  let peak = 0
  const guard = () => {
    const grown = footprint() - before
    if (grown > peak) peak = grown
    if (grown > memoryBudget)
      throw new LookupIndexError(
        `the index needed more than ${Math.round(memoryBudget / 1048576)} MB while loading`
      )
  }
  for (const source of sources) {
    builder.beginSource(source.key, source.graph)
    let complete = false
    try {
      await selectStream(
        "lookup-entries",
        { ...common, KEY: literal(source.key), GRAPH: source.graph },
        (row) => {
          if (complete) throw new Error("rows followed the end of the answer")
          if (row.end) {
            complete = true
            return
          }
          builder.addRow(entryOf(row))
          if (builder.rows % GUARD_EVERY_ROWS === 0) guard()
        },
        {
          signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
          maxBytes: maxSourceBytes,
          maxRows: maxRows + 1
        }
      )
    } catch (error) {
      if (error instanceof AnswerTooLarge)
        throw new LookupIndexError(
          `the ${source.key} descriptions are larger than the index accepts: ${error.message}`
        )
      throw error
    }
    if (!complete)
      throw new Error(`the ${source.key} descriptions ended before their end`)
  }
  guard()
  const index = builder.build()
  guard()
  return Object.freeze({ ...index, loadPeakBytes: peak })
}

// One description as the index holds it. Anything the build does not write,
// and so the index does not reproduce, refuses the whole index.
function entryOf(row) {
  const { iri, label, definition } = row
  if (iri?.type !== "uri")
    throw new LookupIndexError("a description names no IRI entity")
  if (
    label?.type !== "literal" ||
    (label.datatype !== undefined && label.datatype !== XSD_STRING) ||
    (label["xml:lang"] !== undefined && !LANGUAGE_TAG.test(label["xml:lang"]))
  )
    throw new LookupIndexError(`${iri.value} has a label that is not text`)
  if (definition !== undefined && definition.type !== "literal")
    throw new LookupIndexError(`${iri.value} has a definition that is not text`)
  if (row.lower !== undefined && row.lower.type !== "literal")
    throw new LookupIndexError(`${iri.value} has a lowercase that is not text`)
  return {
    iri: iri.value,
    label: label.value,
    tag: label["xml:lang"] ?? "",
    definition: definition?.value,
    version: row.version?.value,
    license: row.license?.value,
    typed: row.typed?.value === "true",
    lower: row.lower?.value
  }
}

// The index's arrays move between threads without a copy, and everything
// else is cloned. The scratch bitmap is made again on arrival.
export function packIndex(index) {
  const transfer = new Set()
  const take = (array) => {
    if (array.byteLength > 0) transfer.add(array.buffer)
    return array
  }
  const words = (dictionary) => ({
    tokens: dictionary.tokens,
    offsets: take(dictionary.offsets),
    postings: take(dictionary.postings),
    always: take(dictionary.always)
  })
  const column = (value) => ({
    blocks: value.blocks.map((block) => take(block)),
    starts: take(value.starts),
    ends: take(value.ends)
  })
  const packed = {
    fingerprint: index.fingerprint,
    loadPeakBytes: index.loadPeakBytes,
    size: index.size,
    sources: index.sources,
    tagNames: index.tagNames,
    values: index.values,
    rowOf: take(index.rowOf),
    iriColumn: column(index.iriColumn),
    definitionColumn: column(index.definitionColumn),
    labels: index.labels,
    tags: take(index.tags),
    versions: take(index.versions),
    licences: take(index.licences),
    flags: take(index.flags),
    byCandidate: take(index.byCandidate),
    candidateRank: take(index.candidateRank),
    hashes: take(index.hashes),
    hashIds: take(index.hashIds),
    trimmedIds: take(index.trimmedIds),
    labelWords: words(index.labelWords),
    definitionWords: words(index.definitionWords),
    alphabet: index.alphabet,
    lowered: index.lowered
  }
  return { packed, transfer: [...transfer] }
}

export function unpackIndex(packed) {
  const column = (value) => ({
    ...value,
    blocks: value.blocks.map((array) =>
      Buffer.from(array.buffer, array.byteOffset, array.byteLength)
    )
  })
  const sources = packed.sources.map((source) => Object.freeze(source))
  return Object.freeze({
    ...packed,
    sources,
    sourceByKey: new Map(sources.map((source) => [source.key, source])),
    iriColumn: column(packed.iriColumn),
    definitionColumn: column(packed.definitionColumn),
    bitmap: new Uint32Array(Math.ceil(packed.size / 32) + 1)
  })
}
