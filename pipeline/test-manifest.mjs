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
  }).some((p) => p.includes("mapped more than once"))
)
expect(
  "a main-file IRI repeated as a module is the same collision",
  problems({
    ...pinned,
    importIri: "https://x/m",
    modules: [
      {
        url: "https://x/m.ttl",
        sha256: "c".repeat(64),
        importIri: "https://x/m"
      }
    ]
  }).some((p) => p.includes("mapped more than once"))
)

// Reasoning through another entry's pinned files. The files never load
// into the referencing graph, so the catalog they join must be complete:
// a referenced artifact with no import IRI is part of the closure that
// would resolve nowhere.
const closureMain = {
  ...pinned,
  key: "closure",
  graphIri: "https://example.org/closure",
  importIri: "https://example.org/1.0/closure",
  modules: [
    {
      url: "https://x/m.ttl",
      sha256: "c".repeat(64),
      importIri: "https://example.org/1.0/m"
    }
  ]
}
const consumer = {
  ...pinned,
  key: "consumer",
  graphIri: "https://example.org/consumer",
  importsFrom: ["closure"]
}
const across = (entries) =>
  checkAcrossEntries(
    entries,
    entries.map((e) => `${e.key}.json`)
  )
expect(
  "an entry may reason through another entry's pins",
  across([closureMain, consumer]).length === 0,
  across([closureMain, consumer]).join("; ")
)
expect(
  "an entry-level import IRI must be an IRI",
  problems({ ...pinned, importIri: "not-an-iri" }).length > 0
)
expect(
  "importsFrom naming no entry fails",
  across([{ ...consumer, importsFrom: ["nothing"] }]).length === 1
)
expect(
  "importsFrom naming itself fails",
  across([{ ...consumer, importsFrom: ["consumer"] }]).length === 1
)
expect(
  "importsFrom naming a mirror fails",
  across([mirror, { ...consumer, importsFrom: ["demo"] }]).length === 1
)
expect(
  "a referenced entry whose main file has no import IRI fails",
  across([withOut(closureMain, "importIri"), consumer]).some((problem) =>
    problem.includes("no import IRI")
  )
)
expect(
  "importsFrom may not name an entry twice",
  problems({ ...consumer, importsFrom: ["closure", "closure"] }).some((p) =>
    p.includes("twice")
  )
)
expect(
  "importsFrom on a source that is not reasoned is refused",
  problems({ ...consumer, reason: false }).some((p) =>
    p.includes("not reasoned")
  )
)
expect(
  "a cleared source may not reason through an uncleared one",
  across([
    { ...closureMain, license: UNDECLARED, republishable: false },
    consumer
  ]).some((p) => p.includes("publication build excludes")),
  across([
    { ...closureMain, license: UNDECLARED, republishable: false },
    consumer
  ]).join("; ")
)
expect(
  "one IRI inherited from two entries is a collision",
  across([
    closureMain,
    {
      ...closureMain,
      key: "closure2",
      graphIri: "https://example.org/closure2",
      importIri: "https://example.org/1.0/other",
      modules: closureMain.modules
    },
    { ...consumer, importsFrom: ["closure", "closure2"] }
  ]).some((p) => p.includes("inherited from both")),
  across([
    closureMain,
    {
      ...closureMain,
      key: "closure2",
      graphIri: "https://example.org/closure2",
      importIri: "https://example.org/1.0/other",
      modules: closureMain.modules
    },
    { ...consumer, importsFrom: ["closure", "closure2"] }
  ]).join("; ")
)
expect(
  "an IRI mapped here and inherited is a collision",
  across([
    closureMain,
    { ...consumer, importsToEmpty: ["https://example.org/1.0/m"] }
  ]).some((problem) => problem.includes("inherited")),
  across([
    closureMain,
    { ...consumer, importsToEmpty: ["https://example.org/1.0/m"] }
  ]).join("; ")
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
