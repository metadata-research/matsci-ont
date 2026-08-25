// The catalogue and the definitions index: that every source is described
// once, that known entities resolve, and that one term reaches more than
// one source.

import { rows, countOf } from "../../../shared/fuseki.mjs"
import { literal } from "../../../app/lib/terms.mjs"

export async function checkCatalogue(context) {
  await checkFixtures(context)
  await checkOnePerSource(context)
  await checkCrossSource(context)
}

// Entities chosen in fixtures.json because a reader would look for them.
// Resolving means the store holds triples about the IRI and one of them is
// the label the fixture states, so a graph loaded under the wrong IRI or
// stripped of its labels fails here rather than at the page.
async function checkFixtures({ record, ask, fixtures }) {
  const unresolved = []
  for (const fixture of fixtures.entities) {
    const bindings = rows(await ask("fixture", { IRI: fixture.iri }))
    const labels = bindings.map((b) => b.label?.value).filter(Boolean)
    const labelled = labels.some(
      (l) => l.toLowerCase() === fixture.expectLabel.toLowerCase()
    )
    if (bindings.length === 0 || !labelled) {
      unresolved.push(
        `${fixture.iri} (triples=${bindings.length}, expected label ${fixture.expectLabel})`
      )
    }
  }
  record(
    "known entities resolve with their labels",
    unresolved.length === 0,
    unresolved.length > 0
      ? unresolved.join("\n")
      : `${fixtures.entities.length} fixtures`
  )
}

// One catalogue resource per source, no more and no fewer.
async function checkOnePerSource({ record, ask, manifest, graphs, ont }) {
  const counted = new Map(
    rows(
      await ask("catalogue-keys", { CATALOG: graphs.catalog, ONT: ont })
    ).map((b) => [b.key.value, Number(b.n.value)])
  )
  const wrong = manifest
    .filter((entry) => counted.get(entry.key) !== 1)
    .map((entry) => `${entry.key}: ${counted.get(entry.key) ?? 0}`)
  const extra = [...counted.keys()].filter(
    (key) => !manifest.some((entry) => entry.key === key)
  )
  record(
    "every source has exactly one catalogue resource",
    wrong.length === 0 && extra.length === 0,
    [...wrong, ...extra.map((k) => `${k}: not in the manifest`)].join("\n") ||
      `${counted.size} sources`
  )
}

// The point of holding several sources at once: one term, several
// independent vocabularies, in one answer.
async function checkCrossSource({ record, ask, graphs, ont }) {
  const sources = rows(
    await ask("cross-source", {
      DEFS: graphs.definitions,
      ONT: ont,
      TERM: literal("sintering")
    })
  ).map((b) => b.key.value)
  record(
    "a known term is found in more than one source",
    sources.length > 1,
    `sintering: ${sources.join(", ") || "no source"}`
  )
}

// A definition served without its licence cannot be passed on safely.
// Naming a licence includes naming it as undeclared; what must never happen
// is an entry that says nothing at all, which a caller would read as free
// to reuse.
export async function checkLicences({ record, ask, graphs, ont }) {
  const unlicensed = countOf(
    await ask("unlicensed", { DEFS: graphs.definitions, ONT: ont })
  )
  record(
    "every definitions entry names a licence",
    unlicensed === 0,
    `${unlicensed} entries without a licence`
  )
}
