// Checks that reasoning fails loudly where it must.
//
//   node pipeline/test-reason.mjs
//
// Two failures matter more than any success here. An inconsistent ontology
// must stop the build rather than contribute nonsense, and an import this
// pipeline did not pin must not be fetched from the network. Both are
// exercised against the real ROBOT jar.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { robotEnvironment, runRobot } from "./lib/tools.mjs"
import { reasonSource, parsePairCsv, subtractAsserted } from "./reason.mjs"

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

const environment = await robotEnvironment()
const root = await mkdtemp(join(tmpdir(), "matsci-ont-reason-"))
const work = join(root, "work")
await mkdir(work, { recursive: true })

// An ontology whose axioms cannot all hold: x is both an A and a B, and the
// two are disjoint.
const inconsistent = join(root, "inconsistent.ttl")
await writeFile(
  inconsistent,
  `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <http://example.org/> .
ex:o a owl:Ontology .
ex:A a owl:Class ; owl:disjointWith ex:B .
ex:B a owl:Class .
ex:x a ex:A, ex:B .
`
)
{
  const output = join(work, "out.nt")
  const result = runRobot(environment, [
    "reason",
    "--input",
    inconsistent,
    "--reasoner",
    "hermit",
    "--output",
    output
  ])
  const said = `${result.stdout}\n${result.stderr}`.toLowerCase()
  expect(
    "an inconsistent ontology fails with a nonzero exit",
    result.status !== 0,
    `exit ${result.status}`
  )
  expect(
    "the failure says the ontology is inconsistent",
    said.includes("inconsistent")
  )
}

// An import that is neither pinned nor mapped to the empty ontology. The
// proxy guard turns any attempt to fetch it into an immediate failure, so
// the build cannot come to depend on a file nobody recorded.
{
  const unpinned = join(root, "unpinned.ttl")
  await writeFile(
    unpinned,
    `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<http://example.org/o> a owl:Ontology ;
  owl:imports <https://w3id.org/emmo/1.0.3/disciplines/isq> .
`
  )
  let threw = false
  let message = ""
  try {
    await reasonSource(
      environment,
      { key: "unpinned", format: "ttl", sha256: "x", downloadUrl: "x" },
      work
    )
  } catch (error) {
    threw = true
    message = error.message
  }
  // The entry has no cached file, so this first fails on the missing input,
  // which is itself a loud failure. The network case is exercised below
  // with a real file.
  expect("a source with no cached artifact fails", threw, message.slice(0, 120))

  const output = join(work, "unpinned.nt")
  const result = runRobot(environment, [
    "reason",
    "--input",
    unpinned,
    "--reasoner",
    "hermit",
    "--output",
    output
  ])
  const said = `${result.stdout}\n${result.stderr}`
  expect(
    "an unmapped import fails instead of being fetched",
    result.status !== 0,
    `exit ${result.status}`
  )
  expect(
    "the failure names the unresolvable import",
    /UnloadableImportException|Could not load imported ontology|Connection refused/i.test(
      said
    ),
    said
      .split("\n")
      .find((line) => /import|refused/i.test(line))
      ?.slice(0, 120) ?? ""
  )
}

await rm(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log("\nOK: reasoning fails loudly where it must")
