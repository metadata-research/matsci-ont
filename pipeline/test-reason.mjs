// Checks that reasoning fails loudly where it must.
//
//   node pipeline/test-reason.mjs
//
// Two failures matter more than any success here. An inconsistent ontology
// must stop the build rather than contribute nonsense, and an import this
// pipeline did not pin must not be fetched from the network. Both are
// exercised against the real ROBOT jar.
//
// The pure parsing this phase also depends on is in test-parse.mjs, which
// needs no Java and so runs on every push.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { robotEnvironment, runRobot } from "../shared/tools.mjs"
import { reasonSource } from "./reason.mjs"

const failures = []
function expect(label, condition, detail) {
  process.stdout.write(`${condition ? "pass" : "FAIL"}  ${label}\n`)
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`)
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
