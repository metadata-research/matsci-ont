// What the built store holds, before anything is served from it.
//
// These read the store by location rather than through Fuseki. The served
// dataset unions the named graphs into the default graph, which would hide
// whether anything really landed in the default graph, and hide a graph
// nobody declared by folding it in with the rest.

import { inferredGraphFor } from "../../../shared/vocabulary.mjs"

export const DEFAULT_GRAPH = "urn:x-arq:DefaultGraph"

export function checkStore({ record, manifest, counts, graphs }) {
  const missing = manifest.filter((entry) => !(counts.get(entry.graphIri) > 0))
  record(
    "every source loaded a nonempty graph",
    missing.length === 0,
    missing.length > 0
      ? `empty or absent: ${missing.map((e) => e.key).join(", ")}`
      : manifest
          .map(
            (e) => `${e.key} ${counts.get(e.graphIri).toLocaleString()} triples`
          )
          .join("\n")
  )

  // Every source names its graph, so anything in the default graph arrived
  // by accident, and a union-default-graph service would serve it invisibly.
  const strays = counts.get(DEFAULT_GRAPH) ?? 0
  record(
    "nothing loaded into the default graph",
    strays === 0,
    strays === 0
      ? "default graph empty"
      : `${strays} quads outside any named graph`
  )

  // An inferred graph is declared only for a source the manifest allows to
  // be reasoned, so one appearing for a skipped source is undeclared.
  const declared = new Set([
    ...manifest.map((entry) => entry.graphIri),
    ...manifest
      .filter((entry) => entry.reason !== false)
      .map((entry) => inferredGraphFor(entry.key)),
    graphs.catalog,
    graphs.definitions
  ])
  const unexpected = [...counts.keys()].filter(
    (graph) => graph !== DEFAULT_GRAPH && !declared.has(graph)
  )
  record(
    "the store holds no undeclared graph",
    unexpected.length === 0,
    unexpected.length > 0
      ? unexpected.join("\n")
      : `${declared.size} declared graphs`
  )

  record(
    "both derived graphs are present",
    counts.get(graphs.catalog) > 0 && counts.get(graphs.definitions) > 0,
    `catalog ${counts.get(graphs.catalog) ?? 0}, definitions ${counts.get(graphs.definitions) ?? 0} triples`
  )
}
