// Reasoning: the pairs it added, the record the catalogue publishes, and
// that nothing it produced merely repeats what the source already said.

import { rows, countOf } from "../../../shared/fuseki.mjs"
import { inferredGraphFor } from "../../../shared/vocabulary.mjs"

export async function checkReasoning(context) {
  await checkPairCounts(context)
  await checkEntailedRecord(context)
  await checkNoOverlap(context)
}

// The pairs the reasoner adds, after the ones the source already asserts
// are subtracted, and the recorded reason for every source not reasoned.
async function checkPairCounts({ record, ask, counts, fixtures, graphs, ont }) {
  const { sources, skipped } = fixtures.reasoning
  const wrong = []
  for (const [key, expected] of Object.entries(sources)) {
    const actual = counts.get(inferredGraphFor(key)) ?? 0
    if (actual !== expected.newPairs)
      wrong.push(`${key}: ${actual}, expected ${expected.newPairs}`)
  }
  const unrecorded = []
  for (const key of skipped) {
    const said = rows(
      await ask("reasoning-skipped", {
        CATALOG: graphs.catalog,
        ONT: ont,
        KEY: key
      })
    )
    if (said.length !== 1) unrecorded.push(key)
  }
  record(
    "reasoning produced the recorded pair counts",
    wrong.length === 0 && unrecorded.length === 0,
    wrong.length > 0 || unrecorded.length > 0
      ? [
          ...wrong,
          ...unrecorded.map((k) => `${k}: skipped but no reason recorded`)
        ].join("\n")
      : `${Object.entries(sources)
          .map(([k, v]) => `${k} ${v.newPairs}`)
          .join(", ")}; ${skipped.join(", ")} skipped and recorded`
  )
}

// The count the reasoner entailed before subtraction, recorded so the
// catalogue shows how much of a hierarchy is asserted rather than derived.
async function checkEntailedRecord({ record, ask, fixtures, graphs, ont }) {
  const recorded = new Map(
    rows(
      await ask("entailed-pairs", { CATALOG: graphs.catalog, ONT: ont })
    ).map((b) => [b.key.value, Number(b.n.value)])
  )
  const wrong = Object.entries(fixtures.reasoning.sources)
    .filter(([key, expected]) => recorded.get(key) !== expected.entailedPairs)
    .map(
      ([key, expected]) =>
        `${key}: ${recorded.get(key) ?? "nothing"} recorded, expected ${expected.entailedPairs}`
    )
  record(
    "the catalogue records what was entailed before subtraction",
    wrong.length === 0,
    wrong.join("\n") ||
      [...recorded.entries()].map(([k, v]) => `${k} ${v}`).join(", ")
  )
}

// An inferred pair the source already asserts would be noise, and its
// presence would mean the reasoning step lost --create-new-ontology.
async function checkNoOverlap({ record, ask, manifest, counts }) {
  const overlaps = []
  for (const entry of manifest) {
    const inferred = inferredGraphFor(entry.key)
    if (!(counts.get(inferred) > 0)) continue
    const n = countOf(
      await ask("inferred-overlap", {
        INFERRED: inferred,
        SOURCE: entry.graphIri
      })
    )
    if (n !== 0) overlaps.push(`${entry.key}: ${n}`)
  }
  record(
    "no inferred pair repeats an asserted one",
    overlaps.length === 0,
    overlaps.join("\n") || "every inferred graph is disjoint from its source"
  )
}
