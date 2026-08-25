// Checks how a caller's own SPARQL is read.
//
//   node app/test-sparql.mjs
//
// These decide whether a query is answered and how it is bounded, so an
// approximation here is a security bug rather than a rendering glitch. All
// of it is pure text handling: no store, no Java, and so it runs on every
// push.

import {
  maskQuery,
  splitQuery,
  queryForm,
  checkQueryForm,
  withRowLimit
} from "./lib/sparql.mjs"
import { RejectedInput } from "./lib/terms.mjs"

const failures = []
function expect(label, condition, detail) {
  process.stdout.write(`${condition ? "pass" : "FAIL"}  ${label}\n`)
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`)
}

// The masker decides what counts as syntax. A character following a closing
// quote used to skip every check, so a comment glued to a literal hid its
// contents from the keyword scan.
{
  const masked = maskQuery('SELECT ?s WHERE { ?s ?p "x"#FROM hidden\n }')
  expect(
    "a comment straight after a literal is masked",
    !masked.includes("FROM"),
    masked
  )
  expect(
    "an IRI straight after a literal is masked",
    !maskQuery('X "a"<http://x/secret> Z').includes("secret"),
    maskQuery('X "a"<http://x/secret> Z')
  )
  expect(
    "masking preserves length and line structure",
    maskQuery('a "b" # c\nd').length === 'a "b" # c\nd'.length &&
      maskQuery('a "b" # c\nd').includes("\n")
  )
  // Long quotes end only at their own delimiter, so a single quote inside
  // one is content. Reading it as a terminator would unmask the rest.
  expect(
    "a quote inside a long literal does not end it",
    !maskQuery('X """a "b" INSERT""" Y').includes("INSERT"),
    maskQuery('X """a "b" INSERT""" Y')
  )
  expect(
    "an escaped quote does not end a literal",
    !maskQuery('X "a\\"INSERT" Y').includes("INSERT"),
    maskQuery('X "a\\"INSERT" Y')
  )
  // Masking replaces content position for position, so an offset found on
  // the copy means the same place in the original.
  expect(
    "masking never changes a character's position",
    maskQuery('PREFIX x: <http://x/> SELECT "lit" # note').length ===
      'PREFIX x: <http://x/> SELECT "lit" # note'.length
  )
}

// The prologue split, which the row cap depends on: a LIMIT must go after
// the PREFIX declarations, not before them.
{
  const split = splitQuery(
    'PREFIX x: <http://x/>\nSELECT ?s WHERE { ?s ?p "a" }'
  )
  expect(
    "the prologue is separated from the body",
    split.prologue === "PREFIX x: <http://x/>" &&
      split.body.startsWith("SELECT"),
    `${split.prologue} | ${split.body}`
  )
  expect("the body comes back unmasked", split.body.includes('"a"'), split.body)
  expect(
    "a query with no prologue splits cleanly",
    splitQuery("SELECT ?s WHERE { ?s ?p ?o }").prologue === ""
  )
}

// The form, read from the masked copy so that neither a comment nor a
// literal can pass for a keyword.
{
  expect(
    "an update is refused whatever precedes it",
    queryForm("# SELECT\nINSERT DATA { }") === "INSERT" &&
      queryForm('SELECT ?s WHERE { ?s ?p "INSERT DATA" }') === "SELECT"
  )
  const refuses = (query) => {
    try {
      checkQueryForm(query)
      return false
    } catch (error) {
      return error instanceof RejectedInput
    }
  }
  expect("an update is rejected by name", refuses("INSERT DATA { }"))
  expect("a DROP is rejected", refuses("DROP GRAPH <http://x/>"))
  expect("an empty query is rejected", refuses(""))
  expect("a word that is no form is rejected", refuses("EXPLAIN { }"))
  for (const form of ["SELECT", "ASK", "CONSTRUCT", "DESCRIBE"]) {
    expect(
      `${form} is answered`,
      checkQueryForm(`${form} ?s WHERE { ?s ?p ?o }`) === form
    )
  }
}

// The row cap. Without it a caller's query is bounded only by the size
// ceiling, which is reached by transferring most of the store first.
{
  expect(
    "a variable named from is not a dataset clause",
    withRowLimit("SELECT ?from WHERE { ?from ?p ?o }", 5) !== null
  )
  expect(
    "a real dataset clause is left alone",
    withRowLimit("SELECT ?s FROM <http://g> WHERE { ?s ?p ?o }", 5) === null
  )
  expect(
    "a prefixed name ending in from is not a dataset clause",
    withRowLimit(
      "PREFIX x: <http://x/> SELECT ?s WHERE { ?s x:from ?o }",
      5
    ) !== null
  )
  expect(
    "the word FROM inside a literal is not a dataset clause",
    withRowLimit('SELECT ?s WHERE { ?s ?p "FROM" }', 5) !== null
  )
  const capped = withRowLimit(
    "PREFIX x: <http://x/>\nSELECT ?s WHERE { ?s ?p ?o }",
    5
  )
  expect(
    "the cap goes after the prologue",
    capped.startsWith("PREFIX x: <http://x/>") && capped.endsWith("LIMIT 5"),
    capped
  )
  // A query ending in a partial-line comment used to swallow the closing
  // braces that followed it on the same line.
  const commented = withRowLimit("SELECT ?s WHERE { ?s ?p ?o } # done", 5)
  expect(
    "a trailing comment does not swallow the closing braces",
    commented.includes("\n} } LIMIT 5"),
    commented
  )
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log("\nOK: caller SPARQL is read as documented")
