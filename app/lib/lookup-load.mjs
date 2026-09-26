// Reads the lookup index from the store: the catalogue fingerprint, and
// each cleared source's descriptions, streamed page by page into the
// builder in lookup-index.mjs. lookup-state.mjs runs the load in a worker
// thread, and the index crosses back with packIndex and unpackIndex.

import { createHash } from "node:crypto"
import { entryPrefix } from "../../shared/vocabulary.mjs"
import { AnswerTooLarge, select, selectStream } from "./store.mjs"
import { common } from "./substitutions.mjs"
import { checkIri, checkKey, literal } from "./terms.mjs"
import { createIndexBuilder, LookupIndexError } from "./lookup-index.mjs"

const CATALOGUE_TIMEOUT_MS = 5000
// A source is read in pages of about this many descriptions. The store
// stops any query at 30 seconds, and a page's cost is a fixed part, reading
// every entry IRI of its source, plus about 20 microseconds a description
// here and 90 on the smallest host. At this size a ChEBI page takes about
// 0.6 seconds here and 2 seconds of the store's time on that host, so a
// host six times slower than this workstation and busy with other lookups
// still stays far inside the limit. A source of this size or smaller is
// read whole, with the query unchanged.
export const ENTRIES_PER_PAGE = 16384
// Fuseki stops a page's query at this deadline, well before its own 30
// seconds, and the load stops waiting a little later if it does not.
export const PAGE_TIMEOUT_MS = 20000
const PAGE_GRACE_MS = 5000
// The count is one index read of the source's key.
const COUNT_TIMEOUT_MS = 15000
// A page or count the store stopped, or could not answer, is asked again
// after these pauses, and only then fails the load, which lookup-state.mjs
// retries whole.
export const RETRY_PAUSES_MS = [2000, 8000]
export const MAX_ROWS = 1000000
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024
// What a load may add to its thread's memory, counting the JavaScript heap
// and the arrays and buffers outside it, which hold most of the index. The
// current store, 222,925 descriptions, peaks at about 92 MB in the worker
// and leaves an index of about 58 MB. The application's unit starts
// reclaiming memory at 384 MB, so an index that needs more than this is
// abandoned rather than loaded.
//
// This, not the store's time limit, is what bounds the index. Twice the
// current descriptions peaked at 166 MB, with the whole process at 350 MB,
// and three times went past this budget and was abandoned. So the index
// holds about 500,000 descriptions at most. More needs this budget, the
// worker's heap below and the unit's MemoryHigh and MemoryMax raised
// together, on a host with the memory to spare.
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

// How many pages a source of this many descriptions is read in.
export function pagesFor(entries, perPage = ENTRIES_PER_PAGE) {
  return Math.max(1, Math.ceil(entries / perPage))
}

// The entry IRI ranges that split a source into `pages` pages: [from,
// below), where a null bound is open. The inner bounds are the source's
// entry prefix and four hex digits, evenly spaced, because the rest of an
// entry IRI is a SHA-256 in hex. The first range has no lower bound and the
// last no upper one, so the ranges cover every string exactly once, and
// only the balance between pages depends on how entries are minted.
export function pageRanges(key, pages) {
  if (pages <= 1) return [{ from: null, below: null }]
  const prefix = entryPrefix(key)
  const bound = (page) =>
    prefix +
    Math.floor((0x10000 * page) / pages)
      .toString(16)
      .padStart(4, "0")
  return Array.from({ length: pages }, (_, page) => ({
    from: page === 0 ? null : bound(page),
    below: page === pages - 1 ? null : bound(page + 1)
  }))
}

// The FILTER lookup-entries.rq carries for one range, empty for a whole
// source.
function pageFilter({ from, below }) {
  const tests = []
  if (from !== null) tests.push(`STR(?entry) >= ${literal(from)}`)
  if (below !== null) tests.push(`STR(?entry) < ${literal(below)}`)
  return tests.length ? `FILTER(${tests.join(" && ")})` : ""
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A source whose pages did not hold exactly the descriptions the store
// counts for it. Either the store changed between the count and the pages,
// or the store's own descriptions do not add up, such as one with two
// labels. Only the catalogue can tell which, so lookup-state.mjs reads it
// again: a changed store is loaded again at once, and an unchanged one is
// abandoned until it changes, since reading it again would not help.
export class LookupCountMismatch extends Error {}

// Runs one step of a load, asking again after each pause when the store
// stopped it or could not answer, and counts each repeated ask in
// `retries`. What the store holds is not asked again.
async function withRetries(what, step, { pauses, sleep, retries }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step()
    } catch (error) {
      if (error instanceof LookupIndexError || error instanceof AnswerTooLarge)
        throw error
      if (attempt >= pauses.length)
        throw new Error(
          `${what}: ${error.message}${attempt > 0 ? ` (asked ${attempt + 1} times)` : ""}`
        )
      retries.count++
      await sleep(pauses[attempt])
    }
  }
}

// The number of descriptions the store holds for one source.
async function countEntries(source) {
  const [row] = await select(
    "lookup-count",
    { ...common, KEY: literal(source.key) },
    {
      signal: AbortSignal.timeout(COUNT_TIMEOUT_MS + PAGE_GRACE_MS),
      deadline: Date.now() + COUNT_TIMEOUT_MS
    }
  )
  const entries = Number(row?.entries?.value)
  if (!Number.isSafeInteger(entries) || entries < 0)
    throw new Error(`the store gave no count of the ${source.key} descriptions`)
  return entries
}

// One page, whole or not at all: its descriptions, in the order the store
// sent them, once its end row has arrived.
async function readPage(source, range, { maxBytes, maxRows, onRow }) {
  const started = performance.now()
  const entries = []
  let complete = false
  const { bytes } = await selectStream(
    "lookup-entries",
    {
      ...common,
      KEY: literal(source.key),
      GRAPH: source.graph,
      PAGE: pageFilter(range)
    },
    (row) => {
      if (complete) throw new Error("rows followed the end of the answer")
      if (row.end) {
        complete = true
        return
      }
      entries.push(entryOf(row))
      onRow()
    },
    {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS + PAGE_GRACE_MS),
      deadline: Date.now() + PAGE_TIMEOUT_MS,
      maxBytes,
      maxRows: maxRows + 1
    }
  )
  if (!complete) throw new Error("the answer ended before its end row")
  return { entries, bytes, ms: Math.round(performance.now() - started) }
}

// Streams each source's descriptions into a new index, page by page, which
// records the most memory the load added (loadPeakBytes) and how long each
// source's pages took (loadPages).
//
// A page is added to the index only once it has arrived whole, so a page
// read again is never added twice. A source is kept only when its pages
// together held exactly the descriptions the store counts for it, which is
// what makes a page missed or read twice fail the load rather than change
// the index. A source that does not add up fails the load with a
// LookupCountMismatch.
//
// Only what the store holds refuses the index for good, with a
// LookupIndexError: a description the index cannot reproduce, or more rows,
// bytes or memory than the limits allow. A store that stops a query, or
// cannot be reached, fails this load with a plain Error, and the next one
// tries again. The limits, the page size and the pauses can be changed for
// tests, and `ranges` replaces pageRanges.
export async function loadIndex(
  { fingerprint, sources },
  {
    maxRows = MAX_ROWS,
    maxSourceBytes = MAX_SOURCE_BYTES,
    memoryBudget = MEMORY_BUDGET_BYTES,
    entriesPerPage = ENTRIES_PER_PAGE,
    ranges = pageRanges,
    pauses = RETRY_PAUSES_MS,
    sleep = pause
  } = {}
) {
  const builder = createIndexBuilder({ fingerprint, maxRows })
  const before = footprint()
  let peak = 0
  let read = 0
  const guard = () => {
    const grown = footprint() - before
    if (grown > peak) peak = grown
    if (grown > memoryBudget)
      throw new LookupIndexError(
        `the index needed more than ${Math.round(memoryBudget / 1048576)} MB while loading`
      )
  }
  const onRow = () => {
    if (++read % GUARD_EVERY_ROWS === 0) guard()
  }
  const loadPages = []
  for (const source of sources) {
    const retries = { count: 0 }
    const asking = { pauses, sleep, retries }
    const entries = await withRetries(
      `counting the ${source.key} descriptions`,
      () => countEntries(source),
      asking
    )
    if (entries > maxRows - builder.rows)
      throw new LookupIndexError(
        `the store holds more than ${maxRows} descriptions`
      )
    builder.beginSource(source.key, source.graph)
    const pages = ranges(source.key, pagesFor(entries, entriesPerPage))
    const started = performance.now()
    let slowestMs = 0
    let held = 0
    let bytes = 0
    for (const [number, range] of pages.entries()) {
      let page
      try {
        page = await withRetries(
          `page ${number + 1} of ${pages.length} of ${source.key}`,
          () =>
            readPage(source, range, {
              maxBytes: maxSourceBytes - bytes,
              maxRows: maxRows - builder.rows,
              onRow
            }),
          asking
        )
      } catch (error) {
        if (error instanceof AnswerTooLarge)
          throw new LookupIndexError(
            `the ${source.key} descriptions are larger than the index accepts: ${error.message}`
          )
        throw error
      }
      slowestMs = Math.max(slowestMs, page.ms)
      bytes += page.bytes
      held += page.entries.length
      for (const entry of page.entries) builder.addRow(entry)
      guard()
    }
    if (held !== entries)
      throw new LookupCountMismatch(
        `the ${pages.length} pages of ${source.key} held ${held} descriptions and the store counts ${entries}`
      )
    loadPages.push(
      Object.freeze({
        key: source.key,
        entries,
        pages: pages.length,
        ms: Math.round(performance.now() - started),
        slowestMs,
        retries: retries.count
      })
    )
  }
  guard()
  const index = builder.build()
  guard()
  return Object.freeze({ ...index, loadPeakBytes: peak, loadPages })
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
    loadPages: index.loadPages,
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
