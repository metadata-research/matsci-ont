// The graph view: the elements Cytoscape draws, and the page that draws
// them. The drawing code itself is served as a static asset rather than
// inlined, so no value is ever interpolated into JavaScript.

import { checkKey, checkIri } from "../lib/terms.mjs"
import {
  needsOverview,
  ROOT_LIMIT,
  OVERVIEW_NODE_LIMIT,
  OVERVIEW_EDGE_LIMIT
} from "../lib/browse-limits.mjs"
import { select } from "../lib/store.mjs"
import {
  base,
  escape,
  attr,
  layout,
  errorPage,
  entityUrl,
  localName
} from "../lib/html.mjs"
import { sourceByKey, mirrorBanner, hierarchySubstitutions } from "./common.mjs"

export async function graphJson(key) {
  checkKey(key)
  const source = await sourceByKey(key)
  if (!source) return { status: 404, body: { error: `no source ${key}` } }

  if (needsOverview(source)) {
    const substitutions = hierarchySubstitutions(source, false)
    const roots = await select("roots", substitutions)
    const nodes = new Map(
      roots.slice(0, ROOT_LIMIT).map((row) => [row.s.value, row])
    )
    let frontier = [...nodes.keys()]
    for (
      let depth = 1;
      depth <= 2 && frontier.length && nodes.size < OVERVIEW_NODE_LIMIT;
      depth += 1
    ) {
      const children = await select("overview", {
        ...substitutions,
        PARENTS: frontier.map((iri) => `<${checkIri(iri)}>`).join(" "),
        LIMIT: OVERVIEW_NODE_LIMIT + 1
      })
      frontier = []
      for (const row of children) {
        if (nodes.has(row.s.value)) continue
        nodes.set(row.s.value, row)
        frontier.push(row.s.value)
        if (nodes.size === OVERVIEW_NODE_LIMIT) break
      }
    }
    const shown = [...nodes.values()]
    const edgeRows = shown.length
      ? await select("overview-edges", {
          ...substitutions,
          NODES: shown.map((row) => `<${checkIri(row.s.value)}>`).join(" ")
        })
      : []
    return {
      status: 200,
      body: {
        source: key,
        overview: true,
        truncated: true,
        note: `Large-source overview: up to ${ROOT_LIMIT} roots and two hierarchy levels, at most ${OVERVIEW_NODE_LIMIT} nodes and ${OVERVIEW_EDGE_LIMIT} edges. Open a node to browse its ancestors and children. This is not the complete hierarchy.`,
        elements: {
          nodes: shown.map((row) => ({
            data: {
              id: row.s.value,
              label: row.label.value,
              url: entityUrl(row.s.value, false, key)
            }
          })),
          edges: edgeRows.slice(0, OVERVIEW_EDGE_LIMIT).map((row, index) => ({
            data: {
              id: `s${index}`,
              source: row.a.value,
              target: row.b.value,
              kind: "subClassOf"
            },
            classes: "hierarchy"
          }))
        }
      }
    }
  }

  const rows = await select("graph", hierarchySubstitutions(source, false))
  const nodes = new Map()
  const edges = []
  for (const row of rows) {
    if (row.kind.value === "node") {
      nodes.set(row.a.value, {
        data: {
          id: row.a.value,
          label: row.label.value,
          url: entityUrl(row.a.value, false, key)
        }
      })
    }
  }
  let propertyEdges = 0
  for (const row of rows) {
    if (row.kind.value === "edge" && nodes.has(row.a.value)) {
      if (!nodes.has(row.b.value)) {
        nodes.set(row.b.value, {
          data: {
            id: row.b.value,
            label: localName(row.b.value),
            url: entityUrl(row.b.value)
          },
          classes: "external"
        })
      }
      edges.push({
        data: {
          id: `s${edges.length}`,
          source: row.a.value,
          target: row.b.value,
          kind: "subClassOf"
        },
        classes: "hierarchy"
      })
    }
  }
  const truncated = nodes.size > 300
  if (!truncated) {
    for (const row of rows) {
      if (
        row.kind.value === "prop" &&
        nodes.has(row.a.value) &&
        nodes.has(row.b.value)
      ) {
        edges.push({
          data: {
            id: `p${edges.length}`,
            source: row.a.value,
            target: row.b.value,
            label: row.label?.value ?? "",
            kind: "property"
          },
          classes: "property"
        })
        propertyEdges += 1
      }
    }
  }
  return {
    status: 200,
    body: {
      source: key,
      truncated,
      note: truncated
        ? "More than 300 nodes: property edges are omitted, the hierarchy is kept."
        : `Object properties render as ${propertyEdges} labelled edge(s). Union domains and ranges are omitted.`,
      elements: { nodes: [...nodes.values()], edges }
    }
  }
}

export async function graphPage(key) {
  checkKey(key)
  const source = await sourceByKey(key)
  if (!source)
    return { status: 404, html: errorPage(404, `No source is named ${key}.`) }
  return {
    status: 200,
    html: layout(
      `Graph: ${source.title.value}`,
      `<h1>${escape(source.title.value)}</h1>
${mirrorBanner(source)}
<p><a href="${base}/source/${attr(key)}">Back to the source page</a></p>
<p><input id="filter" type="search" placeholder="Filter nodes by label" disabled> <span id="note" class="mark" aria-live="polite">Loading hierarchy…</span></p>
<p class="graph-controls"><button id="zoom-in" type="button" disabled>Zoom in</button> <button id="zoom-out" type="button" disabled>Zoom out</button> <button id="fit-graph" type="button" disabled>Fit overview</button> <span class="mark">Drag to pan. Filter to center a matching term.</span></p>
<div id="cy" data-source="${attr(key)}" data-base="${attr(base)}"></div>
<script src="${base}/assets/cytoscape.min.js"></script>
<script src="${base}/assets/dagre.min.js"></script>
<script src="${base}/assets/cytoscape-dagre.min.js"></script>
<script src="${base}/assets/graph.js"></script>`
    )
  }
}
