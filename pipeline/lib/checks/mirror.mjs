// The mirrored MatSci-SAM graphs: what they hold, that they agree with the
// publisher's own description of them, that none is cleared for public
// serving while its licence is undeclared, and that the join they exist to
// make actually reaches across.

import { rows, firstRow, countOf } from "../../../shared/fuseki.mjs"

// The mirrored vocabulary, whose terms are the left-hand side of the join.
const VOCABULARY_KEY = "sam-vocabulary"
// The meta graph describes the other four, not itself, so it is the one
// mirror with no published count of its own.
const DESCRIBING_KEY = "sam-meta"

export async function checkMirror(context) {
  const mirrors = context.manifest.filter(
    (entry) => entry.kind === "matsci-sam-mirror"
  )
  if (mirrors.length === 0) return
  checkLoaded(context, mirrors)
  await checkAgainstPublisher(context, mirrors)
  await checkNotCleared(context, mirrors)
  await checkJoin(context)
}

function checkLoaded({ record, counts }, mirrors) {
  const short = mirrors.filter((entry) => !(counts.get(entry.graphIri) > 0))
  record(
    "every mirrored graph loaded",
    short.length === 0,
    short.length > 0
      ? `empty: ${short.map((e) => e.key).join(", ")}`
      : mirrors
          .map((e) => `${e.key} ${counts.get(e.graphIri).toLocaleString()}`)
          .join(", ")
  )
}

// Every mirror the publisher describes must match, and a mirror the
// publisher does not describe is reported rather than skipped. Reporting
// agreement when only some mirrors were compared would pass on a store
// that had lost content.
async function checkAgainstPublisher({ record, ask, counts }, mirrors) {
  const stated = await ask("mirror-stated", {
    MIRRORGRAPHS: mirrors.map((entry) => `<${entry.graphIri}>`).join(" ")
  })
  const drift = []
  const compared = new Set()
  for (const binding of rows(stated)) {
    const graph = binding.graph.value
    const entry = mirrors.find((e) => e.graphIri === graph)
    if (!entry) continue
    compared.add(entry.key)
    const loaded = counts.get(graph) ?? 0
    if (loaded !== Number(binding.n.value)) {
      drift.push(
        `${entry.key}: loaded ${loaded}, publisher states ${binding.n.value}`
      )
    }
  }
  const describes = mirrors.filter((entry) => entry.key !== DESCRIBING_KEY)
  for (const entry of describes) {
    if (!compared.has(entry.key)) {
      drift.push(`${entry.key}: the publisher states no count for it`)
    }
  }
  record(
    "every mirrored graph holds what its publisher says it holds",
    drift.length === 0,
    drift.join("\n") ||
      `${compared.size} of ${describes.length} compared against the published description`
  )
}

async function checkNotCleared({ record, ask, graphs, ont }, mirrors) {
  const marked = countOf(
    await ask("mirror-cleared", { CATALOG: graphs.catalog, ONT: ont })
  )
  record(
    "no mirror is cleared for public serving while its licence is undeclared",
    marked === mirrors.length,
    `${marked} of ${mirrors.length} mirrors marked not republishable`
  )
}

// The reason the mirror exists: one query reaching a term and an ontology
// class together.
async function checkJoin({ record, ask, graphs, ont }) {
  const joined = firstRow(
    await ask("mirror-join", {
      DEFS: graphs.definitions,
      ONT: ont,
      VOCABKEY: VOCABULARY_KEY
    })
  )
  const terms = Number(joined.terms.value)
  record(
    "one query joins a vocabulary term to an ontology class",
    terms > 0,
    `${terms} vocabulary term(s) reach a class in another source`
  )
}
