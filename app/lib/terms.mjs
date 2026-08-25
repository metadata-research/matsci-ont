// Validating and escaping the values that reach a query or a page.
//
// Nothing here does any IO, so every guard is unit-testable, and a module
// that needs only the guards does not pull a HTTP client in with them.

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

// An href allowlist for IRIs that come from the store as link targets. A
// mapping object can be any IRI its author wrote, javascript: and data:
// included, so only http and https reach an href attribute; anything else
// renders as plain text.
export function safeHref(iri) {
  return /^https?:\/\//i.test(iri) ? iri : null
}
