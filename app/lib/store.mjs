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

export async function select(
  name,
  substitutions,
  {
    signal = AbortSignal.timeout(NAMED_QUERY_TIMEOUT_MS),
    maxBytes = NAMED_QUERY_MAX_BYTES
  } = {}
) {
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
      signal
    })
  } catch (error) {
    throw new Error(
      error.name === "TimeoutError"
        ? `query ${name} ran longer than the store allows`
        : `query ${name} could not reach the store: ${error.message}`
    )
  }
  if (!response.ok) {
    const { body } = await readCapped(response, Math.min(maxBytes, 1024))
    throw new Error(
      `query ${name} answered HTTP ${response.status}: ${body.slice(0, 300)}`
    )
  }
  const { body: text, exceeded } = await readCapped(response, maxBytes)
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
