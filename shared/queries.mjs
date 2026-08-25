// Loads SPARQL from named files and fills in its placeholders.
//
// Queries live as .rq files rather than as strings in the code that runs
// them: a query is then readable on its own, can carry the comment that
// explains why it is shaped as it is, and can be pasted into an endpoint
// unchanged when it needs debugging. Two directories use this, the browse
// application's and the pipeline's, and they share the loader so the
// substitution rule is written once.

import { readFile } from "node:fs/promises"
import { join } from "node:path"

// Reads from one directory, caching each file after its first use.
export function queryLoader(directory) {
  const cache = new Map()
  return async function namedQuery(name, substitutions) {
    if (!cache.has(name)) {
      cache.set(name, await readFile(join(directory, `${name}.rq`), "utf8"))
    }
    return fill(name, cache.get(name), substitutions ?? {})
  }
}

// One pass over the template, so a value is never scanned for tokens.
// Replacing token by token would let a value inserted early, a caller's
// search text among them, be read as a template for a later token and
// carry unescaped quotes into the query.
export function fill(name, template, values) {
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
