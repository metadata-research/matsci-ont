// The catalogue and one source's class hierarchy.

import { checkKey } from "../lib/terms.mjs"
import { select } from "../lib/store.mjs"
import { escape, attr, layout, errorPage, termLink } from "../lib/html.mjs"
import { buildForest } from "../lib/tree.mjs"
import {
  catalogueRows,
  sourceByKey,
  hasInferred,
  mirrorBanner,
  hierarchySubstitutions
} from "./common.mjs"

export async function cataloguePage() {
  const rows = await catalogueRows()
  const cards = rows
    .map(
      (row) => `<section class="card">
<h2><a href="/source/${attr(row.key.value)}">${escape(row.title.value)}</a></h2>
<table>
<tr><th>${row.mirrorOf ? "Kind" : "Version"}</th><td>${
        row.mirrorOf
          ? "Mirror of a published dataset"
          : escape(row.version?.value ?? "")
      }</td></tr>
<tr><th>License</th><td>${escape(row.license.value)}${
        row.republishable?.value === "false"
          ? ' <span class="mark">not cleared for public serving</span>'
          : ""
      }</td></tr>
${row.ontologyIri ? `<tr><th>Ontology IRI</th><td><code>${escape(row.ontologyIri.value)}</code></td></tr>` : ""}
<tr><th>Triples</th><td>${escape(Number(row.triples.value).toLocaleString("en-US"))}</td></tr>
<tr><th>Indexed entries</th><td>${escape(Number(row.entries?.value ?? 0).toLocaleString("en-US"))}</td></tr>
</table>
<p><a href="/source/${attr(row.key.value)}">Browse</a> ·
<a href="/graph/${attr(row.key.value)}">Graph view</a></p>
</section>`
    )
    .join("\n")
  return layout(
    "Catalogue",
    `<h1>Sources</h1>
<p>Versioned snapshots of published materials-science ontologies. Each
entity keeps the identifier its publisher minted.</p>
${cards}`
  )
}

export async function sourcePage(key, inferred) {
  checkKey(key)
  const source = await sourceByKey(key)
  if (!source)
    return { status: 404, html: errorPage(404, `No source is named ${key}.`) }

  const showInferred = inferred && (await hasInferred(key))
  const rows = await select(
    "tree",
    hierarchySubstitutions(source, showInferred)
  )
  const { forest, count } = buildForest(rows)

  // Each node is one list item. A node with children carries a collapsible
  // details around its own label and the child list, so the tree is
  // nested correctly and folds with no JavaScript.
  const renderNode = (node) => {
    const marks = [
      node.repeat
        ? '<span class="mark" title="Also shown under another parent">also above</span>'
        : "",
      node.inferredEdge
        ? '<span class="mark inferred" title="Inferred placement">inferred</span>'
        : "",
      node.externalParents?.length
        ? `<span class="mark" title="Parent not in this store: ${attr(node.externalParents.join(", "))}">external parent</span>`
        : ""
    ]
      .filter(Boolean)
      .join(" ")
    const label = `${termLink(node.iri, node.label, showInferred)} ${marks}`
    if (node.children.length === 0) return `<li>${label}</li>`
    return `<li><details open><summary>${label}</summary>
<ul>${node.children.map(renderNode).join("\n")}</ul>
</details></li>`
  }
  const treeHtml = `<ul>${forest.map(renderNode).join("\n")}</ul>`

  const toggle = (await hasInferred(key))
    ? `<p><a href="/source/${attr(key)}${showInferred ? "" : "?inferred=1"}">${
        showInferred
          ? "Show the asserted hierarchy"
          : "Show the inferred hierarchy"
      }</a></p>`
    : ""

  return {
    status: 200,
    html: layout(
      source.title.value,
      `<h1>${escape(source.title.value)}</h1>
${mirrorBanner(source)}
<table>
${source.version ? `<tr><th>Version</th><td>${escape(source.version.value)}</td></tr>` : ""}
<tr><th>License</th><td>${escape(source.license.value)}</td></tr>
${source.ontologyIri ? `<tr><th>Ontology IRI</th><td><code>${escape(source.ontologyIri.value)}</code></td></tr>` : ""}
<tr><th>Named graph</th><td><code>${escape(source.graphIri.value)}</code></td></tr>
<tr><th>Triples</th><td>${escape(Number(source.triples.value).toLocaleString("en-US"))}</td></tr>
<tr><th>Indexed entries</th><td>${escape(Number(source.entries?.value ?? 0).toLocaleString("en-US"))}</td></tr>
</table>
<p><a href="/graph/${attr(key)}">Graph view</a></p>
${toggle}
<h2>Hierarchy${showInferred ? " (asserted and inferred)" : ""}</h2>
<p class="mark">${escape(count.toLocaleString("en-US"))} classes.</p>
<div class="tree">
${treeHtml}
</div>`
    )
  }
}
