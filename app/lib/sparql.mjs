// Loads named queries from mcp/queries/ and runs them against the loopback
// Fuseki query endpoint. User input reaches a query only through the typed
// substitutions here, never through raw string interpolation.

import { readFile } from "node:fs/promises"
import { join } from "node:path"

const QUERY_DIR = new URL("../queries/", import.meta.url).pathname

export const QUERY_URL =
  process.env.MATSCI_ONT_QUERY_URL ??
  `http://127.0.0.1:${process.env.MATSCI_ONT_FUSEKI_PORT ?? 3031}/matsci-ont/query`

// Thrown when client-supplied input is not a shape the store can hold. The
// server turns it into a 404, distinct from a 502 for a store failure.
export class RejectedInput extends Error {}

// An IRI substitution goes between angle brackets, so anything that could
// close the bracket or smuggle whitespace is refused rather than escaped. An
// http or https IRI only, which is every identifier these sources mint.
// 2048 characters is longer than any identifier these publishers mint and
// short enough that a query built around one cannot be made large by the
// argument alone.
export const MAX_IRI_LENGTH = 2048

export function checkIri(value) {
  if (typeof value !== "string" || value.length > MAX_IRI_LENGTH) {
    throw new RejectedInput(
      `an IRI must be text of at most ${MAX_IRI_LENGTH} characters`
    )
  }
  if (!/^https?:\/\/[^\s<>"{}|\\^`]+$/.test(value)) {
    throw new RejectedInput(`not a substitutable IRI: ${value.slice(0, 80)}`)
  }
  return value
}

export function checkKey(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new RejectedInput(`not a source key: ${String(value).slice(0, 80)}`)
  }
  return value
}

export function literal(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`
}

// Escapes Java-regex metacharacters so a search string is matched verbatim
// inside the word-boundary pattern the search query builds around it.
export function regexLiteral(value) {
  return literal(String(value).replace(/[.\\+*?[\]^$(){}=!<>|:#-]/g, "\\$&"))
}

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

// An href allowlist for IRIs that come from the store as link targets. A
// mapping object can be any IRI its author wrote, javascript: and data:
// included, so only http and https reach an href attribute; anything else
// renders as plain text.
export function safeHref(iri) {
  return /^https?:\/\//i.test(iri) ? iri : null
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
    response = await fetch(QUERY_URL, {
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
