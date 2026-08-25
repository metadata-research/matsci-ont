// What every page needs: the catalogue lookups and the two fragments that
// must look the same on whichever page they appear.
//
// Substitution values reach queries only through the typed guards in
// lib/terms.mjs, which produce quoted literals and checked IRIs. Nothing
// here builds a query by concatenation.

import {
  graphIris,
  vocabularyIri,
  inferredGraphFor,
  inferredGraphPrefix
} from "../../shared/vocabulary.mjs"
import { checkIri, literal } from "../lib/terms.mjs"
import { select } from "../lib/store.mjs"
import { escape, attr } from "../lib/html.mjs"

export const graphs = graphIris()
export const ONT = vocabularyIri()

export const common = {
  ONT,
  CATALOG: graphs.catalog,
  DEFS: graphs.definitions,
  INFPREFIX: inferredGraphPrefix()
}

export async function catalogueRows() {
  return select("catalogue", common)
}

export async function sourceByKey(key) {
  const rows = await catalogueRows()
  return rows.find((row) => row.key.value === key)
}

export async function sourceByGraph(graphIri) {
  const rows = await catalogueRows()
  return rows.find((row) => row.graphIri.value === graphIri)
}

export async function hasInferred(key) {
  return select("inferred-present", {
    ...common,
    INFGRAPH: checkIri(inferredGraphFor(key))
  })
}

// A mirror is a copy of a living dataset published elsewhere. A page that
// shows one names the publisher, gives the date it was last projected, and
// links to the authoritative copy, so a reader can tell which service is
// the source of record.
export function mirrorBanner(source) {
  if (!source?.mirrorOf) return ""
  const when = source.mirroredFrom?.value
  const cleared = source.republishable?.value === "true"
  return `<p class="banner">Mirror of
<a href="${attr(source.mirrorOf.value)}" rel="noopener">MatSci-SAM</a>${
    when
      ? `, as its publisher projected it on ${escape(when.slice(0, 10))}`
      : ""
  }. MatSci-SAM is the source of record.${
    cleared
      ? ""
      : " The licence is undeclared, so this copy is not cleared for public serving."
  }</p>`
}

// The graphs a hierarchy query reads. When the inferred view is off, the
// inferred graph is set to the source graph rather than left out, so one
// query serves both views.
export function hierarchySubstitutions(source, inferred) {
  const graph = checkIri(source.graphIri.value)
  const inferredGraph = inferred
    ? checkIri(inferredGraphFor(source.key.value))
    : graph
  return {
    ...common,
    GRAPH: graph,
    INFGRAPH: inferredGraph,
    KEY: literal(source.key.value)
  }
}
