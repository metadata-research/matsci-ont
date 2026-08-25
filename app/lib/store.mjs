// Reads the store: named queries, and the one HTTP client that runs them.
//
// The endpoint is resolved per call rather than captured when this module
// loads. Capturing it made the answer depend on import order, which a
// caller cannot see: a harness that set the variable one statement too
// late queried a different store and said nothing.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { queryUrl } from "../../shared/endpoint.mjs"

const QUERY_DIR = new URL("../queries/", import.meta.url).pathname

const queryCache = new Map()

export async function namedQuery(name, substitutions) {
  if (!queryCache.has(name)) {
    queryCache.set(name, await readFile(join(QUERY_DIR, `${name}.rq`), "utf8"))
  }
  const template = queryCache.get(name)
  const values = substitutions ?? {}
  // One pass over the template, so a value is never scanned for tokens.
  // Replacing token by token would let a value inserted early, a caller's
  // search text among them, be read as a template for a later token and
  // carry unescaped quotes into the query.
  let missing
  const text = template.replace(/@@([A-Z_]+)@@/g, (whole, token) => {
    if (!(token in values)) {
      missing = token
      return whole
    }
    return String(values[token])
  })
  if (missing)
    throw new Error(`query ${name} is missing substitution ${missing}`)
  return text
}

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

export async function select(name, substitutions) {
  const query = await namedQuery(name, substitutions)
  let response
  try {
    response = await fetch(queryUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/sparql-query",
        Accept: "application/sparql-results+json"
      },
      body: query,
      signal: AbortSignal.timeout(NAMED_QUERY_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(
      error.name === "TimeoutError"
        ? `query ${name} ran longer than the store allows`
        : `query ${name} could not reach the store: ${error.message}`
    )
  }
  if (!response.ok) {
    throw new Error(
      `query ${name} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`
    )
  }
  const { body: text, exceeded } = await readCapped(
    response,
    NAMED_QUERY_MAX_BYTES
  )
  if (exceeded)
    throw new Error(
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
