// Checks the manifest rules. They decide what may enter the store and what
// may be served from it, they need no Java and no built store, and they had
// no test at all while they were trapped inside the command that runs them.
//
//   node pipeline/test-manifest.mjs

import { checkEntry, checkAcrossEntries, UNDECLARED } from "./lib/manifest.mjs"

const failures = []
function expect(label, condition, detail) {
  process.stdout.write(`${condition ? "pass" : "FAIL"}  ${label}\n`)
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`)
}

const pinned = {
  key: "demo",
  kind: "external-snapshot",
  title: "Demo",
  ontologyIri: "https://example.org/demo",
  graphIri: "https://example.org/demo",
  version: "1.0",
  downloadUrl: "https://example.org/demo.ttl",
  sha256: "a".repeat(64),
  format: "ttl",
  license: "CC-BY-4.0",
  republishable: true
}
const mirror = {
  key: "demo",
  kind: "matsci-sam-mirror",
  title: "Demo mirror",
  graphIri: "https://example.org/graphs/x",
  fetchUrl: "https://example.org/graphs/x",
  sourceDataset: "https://example.org/dataset",
  authorityBase: "https://example.org/",
  format: "ttl",
  license: UNDECLARED,
  republishable: false,
  reason: false
}
const problems = (entry) => checkEntry(entry, "demo.json")
const withOut = (entry, field) => {
  const copy = { ...entry }
  delete copy[field]
  return copy
}

expect(
  "a valid pinned entry passes",
  problems(pinned).length === 0,
  problems(pinned).join("; ")
)
expect(
  "a valid mirror passes",
  problems(mirror).length === 0,
  problems(mirror).join("; ")
)

// The two rules the project says it enforces on every entry.
expect(
  "a missing licence fails",
  problems(withOut(pinned, "license")).length > 0
)
expect(
  "a missing digest fails on a pinned source",
  problems(withOut(pinned, "sha256")).length > 0
)
expect(
  "a digest that is not a digest fails",
  problems({ ...pinned, sha256: "not-a-digest" }).length > 0
)

// Clearance is a claim that a licence permits publication, so it cannot be
// made while the licence says nobody has stated one.
expect(
  "an undeclared licence cannot be cleared for publication",
  problems({ ...mirror, republishable: true }).some((p) =>
    p.includes("UNDECLARED")
  ),
  problems({ ...mirror, republishable: true }).join("; ")
)
expect(
  "a declared licence may be cleared",
  problems({ ...mirror, license: "CC-BY-4.0", republishable: true }).length ===
    0
)

// A mirror is the moving source, so pinning fields are refused on it and
// required on everything else.
expect(
  "a mirror may not carry a digest",
  problems({ ...mirror, sha256: "b".repeat(64) }).length > 0
)
expect(
  "a mirror may not carry a version",
  problems({ ...mirror, version: "1.0" }).length > 0
)
expect(
  "a pinned source may not carry a fetch URL",
  problems({ ...pinned, fetchUrl: "https://x/y" }).length > 0
)
expect(
  "a mirror needs the dataset it mirrors",
  problems(withOut(mirror, "sourceDataset")).length > 0
)

// A module the reasoning catalogue cannot name would be loaded and then
// left out of the reasoning input.
const withModule = (module) => ({ ...pinned, modules: [module] })
expect(
  "a reasoned module needs its import IRI",
  problems(withModule({ url: "https://x/m.ttl", sha256: "c".repeat(64) }))
    .length > 0
)
expect(
  "a module with its import IRI passes",
  problems(
    withModule({
      url: "https://x/m.ttl",
      sha256: "c".repeat(64),
      importIri: "https://x/m"
    })
  ).length === 0
)
expect(
  "an import mapped both to a module and to nothing fails",
  problems({
    ...pinned,
    modules: [
      {
        url: "https://x/m.ttl",
        sha256: "c".repeat(64),
        importIri: "https://x/m"
      }
    ],
    importsToEmpty: ["https://x/m"]
  }).some((p) => p.includes("mapped both"))
)

// Two sources loading into one graph would overwrite each other.
expect(
  "two entries may not share a graph",
  checkAcrossEntries(
    [pinned, { ...pinned, key: "other" }],
    ["a.json", "b.json"]
  ).length === 1
)
expect(
  "distinct graphs are fine",
  checkAcrossEntries(
    [pinned, { ...pinned, key: "other", graphIri: "https://example.org/two" }],
    ["a.json", "b.json"]
  ).length === 0
)

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log("\nOK: the manifest rules hold")
