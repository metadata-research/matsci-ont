// The graph view: the elements Cytoscape draws, and the page that draws
// them. The drawing code itself is served as a static asset rather than
// inlined, so no value is ever interpolated into JavaScript.

import { checkKey } from "../lib/terms.mjs"
import { select } from "../lib/store.mjs"
import {
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

  const rows = await select("graph", hierarchySubstitutions(source, false))
  const nodes = new Map()
  const edges = []
  for (const row of rows) {
    if (row.kind.value === "node") {
      nodes.set(row.a.value, {
        data: {
          id: row.a.value,
          label: row.label.value,
          url: entityUrl(row.a.value)
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
<p><a href="/source/${attr(key)}">Back to the source page</a></p>
<p><input id="filter" type="search" placeholder="Filter nodes by label"> <span id="note" class="mark"></span></p>
<div id="cy" data-source="${attr(key)}"></div>
<script src="/assets/cytoscape.min.js"></script>
<script src="/assets/dagre.min.js"></script>
<script src="/assets/cytoscape-dagre.min.js"></script>
<script src="/assets/graph.js"></script>`
    )
  }
}
