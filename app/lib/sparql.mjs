// Reading a caller's SPARQL without executing it.
//
// Everything here is a pure function of the query text. That is the point:
// these decide whether a query is answered at all and how it is bounded, so
// they must be testable without a store, and they are the part where being
// approximately right is a security bug rather than a rendering glitch.
//
// The rule the whole module rests on: syntax is read from a masked copy in
// which comments, string literals and IRIs have been replaced by spaces,
// never from the text itself. The text that reaches the store is always the
// caller's original.

import { RejectedInput } from "./terms.mjs"

export const UPDATE_FORMS = [
  "INSERT",
  "DELETE",
  "LOAD",
  "CLEAR",
  "DROP",
  "CREATE",
  "ADD",
  "MOVE",
  "COPY"
]

export const READ_FORMS = ["SELECT", "ASK", "CONSTRUCT", "DESCRIBE"]

const PROLOGUE = /^((?:\s*(?:BASE\s*<[^>]*>|PREFIX\s+[^\s:]*:\s*<[^>]*>))*)/i

// Returns the query with the inside of comments, string literals and IRIs
// replaced by spaces, position for position. Keywords are then read from
// this copy, so a word a caller wrote inside a literal or a comment cannot
// be mistaken for syntax.
export function maskQuery(query) {
  const out = new Array(query.length).fill("")
  let i = 0
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) out[k] = query[k] === "\n" ? "\n" : " "
  }
  while (i < query.length) {
    const rest = query.slice(i)
    if (query[i] === "#") {
      const end = query.indexOf("\n", i)
      const stop = end === -1 ? query.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (query[i] === "<" && /^<[^\s<>"{}|\\^`]*>/.test(rest)) {
      const stop = i + rest.indexOf(">") + 1
      out[i] = "<"
      blank(i + 1, stop - 1)
      out[stop - 1] = ">"
      i = stop
      continue
    }
    let quoted = false
    for (const quote of ['"""', "'''", '"', "'"]) {
      if (rest.startsWith(quote)) {
        quoted = true
        let j = i + quote.length
        while (j < query.length) {
          if (query[j] === "\\") {
            j += 2
            continue
          }
          if (query.startsWith(quote, j)) break
          j += 1
        }
        const stop = Math.min(j + quote.length, query.length)
        for (let k = 0; k < quote.length; k += 1) out[i + k] = quote[0]
        blank(i + quote.length, stop)
        i = stop
        break
      }
    }
    // The quote branch advanced past a whole literal, so the next character
    // has not been examined yet and must go round again. Testing out[i]
    // instead read the index after the advance, where nothing had been
    // written, so the character following a closing quote skipped the
    // comment and IRI checks entirely.
    if (quoted) continue
    out[i] = query[i]
    i += 1
  }
  return out.join("")
}

// Splits a query into its prologue and the rest. The split point is found
// on the masked copy and applied to the original.
export function splitQuery(query) {
  const masked = maskQuery(query)
  const end = PROLOGUE.exec(masked)?.[0].length ?? 0
  return {
    prologue: query.slice(0, end).trim(),
    body: query.slice(end).trim(),
    maskedBody: masked.slice(end).trim()
  }
}

export function queryForm(query) {
  const { maskedBody } = splitQuery(query)
  return /^([A-Za-z]+)/.exec(maskedBody)?.[1]?.toUpperCase() ?? ""
}

// A query whose form is not one of the four read operations is refused here
// rather than at the endpoint, which would answer with a parser error.
export function checkQueryForm(query) {
  const form = queryForm(query)
  if (UPDATE_FORMS.includes(form)) {
    throw new RejectedInput(
      `${form} is an update, and this endpoint answers queries only. Use SELECT, ASK, CONSTRUCT or DESCRIBE.`
    )
  }
  if (!READ_FORMS.includes(form)) {
    throw new RejectedInput(
      `the query form ${form || "(none)"} is not one this endpoint answers. Use SELECT, ASK, CONSTRUCT or DESCRIBE.`
    )
  }
  return form
}

// Puts the caller's row cap into the query, so the store returns what was
// asked for rather than everything for this process to cut afterwards. One
// row beyond the cap is asked for, which is how truncation is detected.
//
// A query with its own dataset clause is left alone: FROM is not allowed in
// a subselect, and rewriting it would turn a working query into a parse
// error. Those fall back to the size ceiling. The closing braces go on
// their own line, because a query ending in a partial-line comment would
// otherwise swallow them.
export function withRowLimit(query, limit) {
  const { prologue, body, maskedBody } = splitQuery(query)
  // A dataset clause, not a variable named from, nor a prefixed name ending
  // in it. Treating those as dataset clauses would drop the cap and leave
  // the query to be bounded by size alone.
  if (/(?<![?$:\w])FROM(?![\w:])/i.test(maskedBody)) return null
  return `${prologue}\nSELECT * WHERE { {\n${body}\n} } LIMIT ${limit}`.trim()
}
