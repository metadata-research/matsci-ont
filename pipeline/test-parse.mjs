// The parsing behind the inferred hierarchy. Both functions are pure, and
// both fail silently when they are wrong: a mis-parsed CSV fills the
// inferred graph with restatements, and pages then mark placements the
// source asserts as inferred. Neither needs Java, so both belong where
// continuous integration can run them.
//
//   node pipeline/test-parse.mjs

import { parsePairCsv, subtractAsserted } from "./reason.mjs"

const failures = []
function expect(label, condition, detail) {
  process.stdout.write(`${condition ? "pass" : "FAIL"}  ${label}\n`)
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`)
}

// The subtraction that makes an inferred graph mean "what reasoning added".
// Jena's CSV is CRLF, and a parser that keeps the carriage return matches
// nothing while reporting success, so both are pinned here.
{
  const csv = "s,o\r\nhttp://x/a,http://x/b\r\nhttp://x/c,http://x/d\r\n"
  const pairs = parsePairCsv(csv)
  expect(
    "CRLF csv parses without a stray carriage return",
    pairs.has("http://x/a http://x/b") &&
      pairs.has("http://x/c http://x/d") &&
      pairs.size === 2,
    [...pairs].join(" | ")
  )
  expect(
    "LF csv parses too",
    parsePairCsv("s,o\nhttp://x/a,http://x/b\n").size === 1
  )

  // Jena quotes any value holding a comma or a quote. Splitting on the
  // first comma would key such a pair wrongly and publish it as inferred.
  const quoted = parsePairCsv('s,o\r\n"http://x/a,b",http://x/c\r\n')
  expect(
    "a quoted value containing a comma keeps its comma",
    quoted.has("http://x/a,b http://x/c"),
    [...quoted].join(" | ")
  )
  const doubled = parsePairCsv('s,o\r\n"http://x/say""hi",http://x/c\r\n')
  expect(
    "a doubled quote inside a value becomes one quote",
    doubled.has('http://x/say"hi http://x/c'),
    [...doubled].join(" | ")
  )

  const subclass = "<http://www.w3.org/2000/01/rdf-schema#subClassOf>"
  const lines = [
    `<http://x/a> ${subclass} <http://x/b> .`,
    `<http://x/e> ${subclass} <http://x/f> .`
  ]
  const kept = subtractAsserted(lines, pairs)
  expect(
    "an asserted pair is dropped and a new one is kept",
    kept.length === 1 && kept[0].includes("http://x/e"),
    kept.join(" | ")
  )
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log("\nOK: the inferred-hierarchy parsing holds")
