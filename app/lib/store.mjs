// Reads the store: named queries, and the one HTTP client that runs them.
//
// The endpoint is resolved per call rather than captured when this module
// loads. Capturing it made the answer depend on import order, which a
// caller cannot see: a harness that set the variable one statement too
// late queried a different store and said nothing.

import { queryUrl } from "../../shared/endpoint.mjs"
import { queryLoader } from "../../shared/queries.mjs"

// The application's own queries. The loader and its substitution rule are
// shared with the pipeline; only the directory differs.
export const namedQuery = queryLoader(
  new URL("../queries/", import.meta.url).pathname
)

// Reads a response body up to a ceiling, reporting whether it stopped
// early. Nothing here assembles an answer larger than the ceiling.
export async function readCapped(response, cap = MAX_ANSWER_BYTES) {
  const reader = response.body?.getReader()
  if (!reader) return { body: "", exceeded: false }
  const decoder = new TextDecoder()
  const parts = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) {
      await reader.cancel()
      return { body: parts.join(""), exceeded: true }
    }
    parts.push(decoder.decode(value, { stream: true }))
  }
  parts.push(decoder.decode())
  return { body: parts.join(""), exceeded: false }
}

// The page and tool queries are bounded by their own LIMIT clauses, but a
// store that stops answering, or an argument that makes one large, must not
// hold this process open or fill it. The two guards match the ones on the
// arbitrary-query path.
export const NAMED_QUERY_TIMEOUT_MS = 35000
export const NAMED_QUERY_MAX_BYTES = 16 * 1024 * 1024
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024

// An answer larger than its caller's cap. Unlike a store that stops or
// cannot be reached, this is a property of what the store holds, so a
// caller may treat it as lasting.
export class AnswerTooLarge extends Error {}

// One budget for every store call a request makes: a deadline, and a signal
// that fires at the deadline or when the client that asked goes away.
export function requestBudget(ms, parent) {
  const timeout = AbortSignal.timeout(ms)
  return {
    signal: parent ? AbortSignal.any([timeout, parent]) : timeout,
    deadline: Date.now() + ms
  }
}

// Where a query with this deadline is sent. Fuseki reads the timeout
// parameter in whole seconds and applies the smaller of it and its own
// arq:queryTimeout, so the store stops a query at the caller's deadline,
// whether or not anyone is still waiting for it, instead of running on to
// its own 30 seconds. Fuseki ignores a fraction, hence the floor, and the
// parameter is at least one second.
export function storeQueryUrl(deadline) {
  if (deadline === undefined) return queryUrl()
  const url = new URL(queryUrl())
  const seconds = Math.max(1, Math.floor((deadline - Date.now()) / 1000))
  url.searchParams.set("timeout", String(seconds))
  return url.toString()
}

async function post(name, query, accept, { signal, deadline, maxBytes }) {
  let response
  try {
    response = await fetch(storeQueryUrl(deadline), {
      method: "POST",
      headers: {
        "Content-Type": "application/sparql-query",
        Accept: accept
      },
      body: query,
      signal
    })
  } catch (error) {
    // A timeout is the deadline passing. Any other abort is the caller
    // giving up, such as a client that disconnected, which says nothing
    // about the store.
    throw new Error(
      error.name === "TimeoutError"
        ? `query ${name} ran longer than the store allows`
        : error.name === "AbortError"
          ? `query ${name} was cancelled before the store answered`
          : `query ${name} could not reach the store: ${error.message}`
    )
  }
  if (!response.ok) {
    const { body } = await readCapped(response, Math.min(maxBytes, 1024))
    throw new Error(
      `query ${name} answered HTTP ${response.status}: ${body.slice(0, 300)}`
    )
  }
  return response
}

export async function select(
  name,
  substitutions,
  {
    signal = AbortSignal.timeout(NAMED_QUERY_TIMEOUT_MS),
    maxBytes = NAMED_QUERY_MAX_BYTES,
    deadline
  } = {}
) {
  const query = await namedQuery(name, substitutions)
  const response = await post(name, query, "application/sparql-results+json", {
    signal,
    deadline,
    maxBytes
  })
  const { body: text, exceeded } = await readCapped(response, maxBytes)
  if (exceeded)
    throw new AnswerTooLarge(
      `query ${name} answered with more than this service will assemble`
    )
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // A store that stops a query mid-stream has already sent a 200 and a
    // partial body, so the parse failure is the timeout, not bad data.
    throw new Error(
      `query ${name} did not complete before the store stopped it`
    )
  }
  if (body.boolean !== undefined) return body.boolean
  return body.results.bindings
}

// Streams a SELECT answer row by row, for an answer too large to assemble.
//
// The answer is read as SPARQL TSV and parsed a line at a time straight from
// the bytes, so each value becomes its own string rather than a slice that
// would keep a whole network chunk alive. TSV has no closing bracket, so an
// answer cut short at a line boundary would look complete: a query read
// this way ends with a row binding ?end, which it produces last, and a
// caller that needs completeness checks for it.
//
// A store that stops a query part way, at its deadline, still ends the
// answer cleanly. Fuseki cuts the current row after whichever term it had
// written, then writes an empty line and two lines starting with ##. Jena
// writes every row with one field per variable, so a line with another
// number of fields, or one starting with #, is where the store stopped, and
// the answer is incomplete rather than wrong.
export const STREAM_MAX_BYTES = 256 * 1024 * 1024
const HASH = 35

export async function selectStream(
  name,
  substitutions,
  onRow,
  {
    signal = AbortSignal.timeout(NAMED_QUERY_TIMEOUT_MS),
    maxBytes = STREAM_MAX_BYTES,
    maxRows = Infinity,
    deadline
  } = {}
) {
  const query = await namedQuery(name, substitutions)
  const response = await post(name, query, "text/tab-separated-values", {
    signal,
    deadline,
    maxBytes
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`query ${name} answered without a body`)
  let names = null
  let pending = null
  let bytes = 0
  let rows = 0
  const stopped = () =>
    new Error(`query ${name} did not complete before the store stopped it`)
  const line = (buffer, start, end) => {
    if (buffer[start] === HASH) throw stopped()
    if (names === null) {
      names = buffer
        .toString("utf8", start, end)
        .split("\t")
        .map((variable) => variable.replace(/^\?/, ""))
      return
    }
    const row = parseTsvRow(buffer, start, end, names)
    if (row === null) throw stopped()
    if (++rows > maxRows)
      throw new AnswerTooLarge(
        `query ${name} answered with more than ${maxRows} rows`
      )
    onRow(row)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes)
        throw new AnswerTooLarge(
          `query ${name} answered with more than this service will assemble`
        )
      const chunk = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength
      )
      let start = 0
      // Only a line split across chunks is copied, not the chunks.
      if (pending) {
        const end = chunk.indexOf(10)
        if (end < 0) {
          pending = Buffer.concat([pending, chunk])
          continue
        }
        const joined = Buffer.concat([pending, chunk.subarray(0, end)])
        pending = null
        line(joined, 0, joined.length)
        start = end + 1
      }
      for (;;) {
        const end = chunk.indexOf(10, start)
        if (end < 0) break
        line(chunk, start, end)
        start = end + 1
      }
      if (start < chunk.length) pending = Buffer.from(chunk.subarray(start))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  if (pending !== null || names === null)
    throw new Error(
      `query ${name} did not complete before the store stopped it`
    )
  return { rows, bytes }
}

const XSD = "http://www.w3.org/2001/XMLSchema#"
const TAB = 9
const QUOTE = 34

// One row, with a property for each bound variable, or null when the line
// does not have one field for each variable and so is not a whole row.
export function parseTsvRow(chunk, start, end, names) {
  const row = {}
  let field = 0
  let from = start
  while (from <= end) {
    let to = chunk.indexOf(TAB, from)
    if (to < 0 || to > end) to = end
    if (field >= names.length) return null
    if (to > from) row[names[field]] = parseTsvTerm(chunk, from, to)
    field++
    from = to + 1
  }
  return field === names.length ? row : null
}

// One RDF term as Jena writes it in TSV: <iri>, "lexical" with an optional
// @tag or ^^<datatype>, _:label, or a bare number or boolean.
export function parseTsvTerm(chunk, from, to) {
  const first = chunk[from]
  if (first === 60)
    return { type: "uri", value: unescaped(chunk, from + 1, to - 1) }
  if (first === QUOTE) {
    const close = chunk.lastIndexOf(QUOTE, to - 1)
    if (close <= from) throw new Error("a TSV literal has no closing quote")
    const term = { type: "literal", value: unescaped(chunk, from + 1, close) }
    if (chunk[close + 1] === 64)
      term["xml:lang"] = chunk.toString("utf8", close + 2, to)
    else if (chunk[close + 1] === 94)
      term.datatype = unescaped(chunk, close + 4, to - 1)
    else if (close + 1 !== to)
      throw new Error("a TSV literal has trailing text")
    return term
  }
  const text = chunk.toString("utf8", from, to)
  if (text.startsWith("_:")) return { type: "bnode", value: text.slice(2) }
  if (text === "true" || text === "false")
    return { type: "literal", value: text, datatype: `${XSD}boolean` }
  if (/^[+-]?\d+$/.test(text))
    return { type: "literal", value: text, datatype: `${XSD}integer` }
  if (/^[+-]?\d*\.\d+$/.test(text))
    return { type: "literal", value: text, datatype: `${XSD}decimal` }
  if (/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(text))
    return { type: "literal", value: text, datatype: `${XSD}double` }
  throw new Error(`an unreadable TSV term: ${text.slice(0, 40)}`)
}

const ESCAPES = {
  t: "\t",
  b: "\b",
  n: "\n",
  r: "\r",
  f: "\f",
  '"': '"',
  "'": "'",
  "\\": "\\"
}

function unescaped(chunk, from, to) {
  const text = chunk.toString("utf8", from, to)
  if (!text.includes("\\")) return text
  return text.replace(
    /\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/gs,
    (whole, short, long, single) => {
      if (short || long)
        return String.fromCodePoint(parseInt(short ?? long, 16))
      if (Object.hasOwn(ESCAPES, single)) return ESCAPES[single]
      throw new Error(`an unknown escape in a TSV term: ${whole}`)
    }
  )
}
