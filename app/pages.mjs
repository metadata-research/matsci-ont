// Page renderers. Each page is its named queries plus rendering, nothing
// else. Substitution values reach queries only through the typed helpers in
// lib/sparql.mjs.

import {
  graphIris,
  vocabularyIri,
  inferredGraphFor,
  inferredGraphPrefix
} from "../shared/vocabulary.mjs"
import {
  checkIri,
  checkKey,
  literal,
  regexLiteral,
  safeHref
} from "./lib/terms.mjs"
import { select } from "./lib/store.mjs"
import {
  escape,
  attr,
  layout,
  errorPage,
  termLink,
  entityUrl,
  localName
} from "./lib/html.mjs"
import { buildForest } from "./lib/tree.mjs"
import { buildAncestry } from "./lib/hierarchy.mjs"
import { verbalize } from "./lib/axioms.mjs"

const graphs = graphIris()
const ONT = vocabularyIri()

const common = {
  ONT,
  CATALOG: graphs.catalog,
  DEFS: graphs.definitions,
  INFPREFIX: inferredGraphPrefix()
}

async function catalogueRows() {
  return select("catalogue", common)
}

async function sourceByKey(key) {
  const rows = await catalogueRows()
  return rows.find((row) => row.key.value === key)
}

async function sourceByGraph(graphIri) {
  const rows = await catalogueRows()
  return rows.find((row) => row.graphIri.value === graphIri)
}

async function hasInferred(key) {
  return select("inferred-present", {
    ...common,
    INFGRAPH: checkIri(inferredGraphFor(key))
  })
}

// A mirror is a copy of a living dataset published elsewhere. A page that
// shows one names the publisher, gives the date it was last projected, and
// links to the authoritative copy, so a reader can tell which service is
// the source of record.
function mirrorBanner(source) {
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

function hierarchySubstitutions(source, inferred) {
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

const HIDDEN_ANNOTATIONS = new Set([
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  "http://www.w3.org/2000/01/rdf-schema#subClassOf",
  "http://www.w3.org/2004/02/skos/core#broader",
  "http://www.w3.org/2004/02/skos/core#narrower",
  "http://www.w3.org/2002/07/owl#equivalentClass",
  "http://www.w3.org/2002/07/owl#disjointWith"
])

const MAPPING_PREDICATES = new Set([
  "http://www.w3.org/2004/02/skos/core#exactMatch",
  "http://www.w3.org/2004/02/skos/core#closeMatch",
  "http://www.w3.org/2004/02/skos/core#broadMatch",
  "http://www.w3.org/2004/02/skos/core#narrowMatch",
  "http://www.w3.org/2004/02/skos/core#relatedMatch",
  "http://www.w3.org/2000/01/rdf-schema#seeAlso"
])

export async function entityPage(iri, inferred) {
  try {
    checkIri(iri)
  } catch {
    return {
      status: 404,
      html: errorPage(404, "That is not an entity IRI this store can hold.")
    }
  }

  const rows = await select("entity", { ...common, IRI: iri })
  if (rows.length === 0) {
    return {
      status: 404,
      html: errorPage(404, `Nothing in the store mentions ${iri}.`)
    }
  }

  const definitionRows = rows.filter(
    (row) => row.g.value === graphs.definitions
  )
  const field = (name) =>
    definitionRows.find((row) => row.p.value === `${ONT}${name}`)?.o.value
  const key = field("sourceKey")
  const source = key
    ? await sourceByKey(key)
    : await sourceByGraph(rows[0].g.value)

  const showInferred = Boolean(inferred && key && (await hasInferred(key)))
  const substitutions = source
    ? hierarchySubstitutions(source, showInferred)
    : null
  const ancestryRows = substitutions
    ? await select("ancestry", { ...substitutions, IRI: iri })
    : []
  const childRows = substitutions
    ? await select("children", { ...substitutions, IRI: iri })
    : []
  const incomingRows = await select("incoming", { ...common, IRI: iri })

  const ancestry = buildAncestry(ancestryRows, iri)
  const { axioms, disjoint, fallbacks } = verbalize(rows, iri)

  const inferredMark =
    '<span class="mark inferred" title="Placed here by the reasoner">inferred</span>'
  const chainHtml = ancestry.chain
    .map((node, index) => {
      const text =
        node.iri === iri
          ? `<strong>${escape(node.label ?? localName(node.iri))}</strong>`
          : termLink(node.iri, node.label, showInferred) +
            (node.external ? ' <span class="mark">external</span>' : "")
      // The marker sits on the node whose step upward the reasoner
      // supplied, so a reader can see which link in the chain is inferred.
      const mark = node.inferredEdge ? ` ${inferredMark}` : ""
      return `<div style="padding-left:${index * 1.25}rem">↳ ${text}${mark}</div>`
    })
    .join("\n")
  const secondaryHtml = ancestry.secondary.length
    ? `<p>Also below: ${ancestry.secondary
        .map(
          (node) =>
            termLink(node.iri, node.label, showInferred) +
            (node.inferredEdge ? ` ${inferredMark}` : "")
        )
        .join(", ")}</p>`
    : ""
  const childHtml = childRows
    .slice(0, 25)
    .map(
      (row) =>
        `<li>${termLink(row.child.value, row.label?.value, showInferred)}${
          row.inferred?.value === "true"
            ? ' <span class="mark inferred">inferred</span>'
            : ""
        }</li>`
    )
    .join("\n")
  const childOverflow =
    childRows.length > 25 ? "<p>Only the first 25 children are shown.</p>" : ""

  const definition = field("definition")
  const definitionProperty = definitionRows.find(
    (row) => row.p.value === `${ONT}definitionProperty`
  )?.o.value
  const annotationRows = rows.filter(
    (row) =>
      row.s.type === "uri" &&
      row.s.value === iri &&
      row.o.type === "literal" &&
      row.g.value !== graphs.definitions &&
      row.g.value !== graphs.catalog &&
      !HIDDEN_ANNOTATIONS.has(row.p.value)
  )
  const annotationsHtml = annotationRows
    .map(
      (row) =>
        `<tr><td><code title="${attr(row.p.value)}">${escape(localName(row.p.value))}</code></td><td>${escape(row.o.value)}${
          row.o["xml:lang"]
            ? ` <span class="mark">@${escape(row.o["xml:lang"])}</span>`
            : ""
        }</td></tr>`
    )
    .join("\n")

  const tokensHtml = (tokens) =>
    tokens
      .map((token) =>
        token.kind === "term"
          ? termLink(token.iri, undefined, showInferred)
          : escape(token.text)
      )
      .join(" ")
  const axiomsHtml = [
    ...axioms.map(
      (axiom) =>
        `<li>${escape(axiom.relation)} ${tokensHtml(axiom.tokens)}</li>`
    ),
    ...disjoint.map(
      (other) =>
        `<li>disjoint with ${termLink(other, undefined, showInferred)}</li>`
    )
  ].join("\n")

  const mappingRows = rows.filter(
    (row) =>
      row.s.value === iri &&
      row.o.type === "uri" &&
      MAPPING_PREDICATES.has(row.p.value)
  )
  // A mapping target is an IRI its author wrote and cannot be trusted as an
  // href. An http or https target links out, anything else shows as text.
  const mappingsHtml = mappingRows
    .map((row) => {
      const href = safeHref(row.o.value)
      const target = href
        ? `<a href="${attr(href)}" rel="noopener nofollow">${escape(row.o.value)}</a>`
        : `<code>${escape(row.o.value)}</code>`
      return `<li><code>${escape(localName(row.p.value))}</code> ${target}</li>`
    })
    .join("\n")

  // Incoming references grouped by predicate.
  const incomingByPredicate = new Map()
  for (const row of incomingRows.slice(0, 50)) {
    if (!incomingByPredicate.has(row.p.value))
      incomingByPredicate.set(row.p.value, [])
    incomingByPredicate.get(row.p.value).push(row)
  }
  const incomingHtml = [...incomingByPredicate.entries()]
    .map(
      ([predicate, refs]) =>
        `<li><code title="${attr(predicate)}">${escape(localName(predicate))}</code>
<ul>${refs.map((row) => `<li>${termLink(row.s.value, row.label?.value, showInferred)}</li>`).join("\n")}</ul></li>`
    )
    .join("\n")

  const rawHtml = rows
    .map(
      (row) =>
        `<tr><td>${escape(row.s.type === "bnode" ? `_:${row.s.value}` : localName(row.s.value))}</td>` +
        `<td title="${attr(row.p.value)}">${escape(localName(row.p.value))}</td>` +
        `<td>${escape(row.o.type === "bnode" ? `_:${row.o.value}` : row.o.value)}</td>` +
        `<td class="graph">${escape(localName(row.g.value))}</td></tr>`
    )
    .join("\n")

  const label = field("label") ?? localName(iri)
  const toggleHtml =
    key && (await hasInferred(key))
      ? `<p><a href="${attr(entityUrl(iri, !showInferred))}">${
          showInferred
            ? "Show only the asserted hierarchy"
            : "Show the inferred hierarchy"
        }</a></p>`
      : ""

  return {
    status: 200,
    html: layout(
      label,
      `<h1>${escape(label)}</h1>
${mirrorBanner(source)}
${
  source?.mirrorOf && safeHref(iri) && field("label")
    ? `<p><a href="${attr(safeHref(iri))}" rel="noopener">Open this on MatSci-SAM</a></p>`
    : ""
}
<p class="attribution">${
        source
          ? `From <a href="/source/${attr(source.key.value)}">${escape(source.title.value)}</a>${
              source.version ? `, version ${escape(source.version.value)}` : ""
            }, license ${escape(source.license.value)}.`
          : "Not indexed from a catalogued source."
      }</p>
<p><code>${escape(iri)}</code></p>
${toggleHtml}
<h2>Hierarchy</h2>
<div class="hierarchy">${chainHtml || "<p>No named ancestors in the store.</p>"}</div>
${ancestry.truncated ? "<p>The chain display stops at 16 levels.</p>" : ""}
${secondaryHtml}
${childHtml ? `<h3>Children</h3><ul>${childHtml}</ul>${childOverflow}` : ""}
<h2>Definition</h2>
${
  definition
    ? `<p>${escape(definition)}</p><p class="mark">from <code>${escape(localName(definitionProperty ?? ""))}</code></p>`
    : "<p>The source states no definition for this entity.</p>"
}
${annotationsHtml ? `<h3>Annotations</h3><table>${annotationsHtml}</table>` : ""}
${axiomsHtml ? `<h2>Axioms</h2><ul class="axioms">${axiomsHtml}</ul>` : ""}
${fallbacks > 0 ? `<p>${fallbacks} axiom(s) use expressions this page does not verbalize. They appear in the raw triples below.</p>` : ""}
${mappingsHtml ? `<h2>Mappings and references</h2><ul>${mappingsHtml}</ul>` : ""}
${incomingHtml ? `<h2>Referenced by</h2><ul>${incomingHtml}</ul>${incomingRows.length > 50 ? "<p>Only the first 50 references are shown.</p>" : ""}` : ""}
<details>
<summary>Raw triples (${rows.length})</summary>
<table class="raw">${rawHtml}</table>
<p class="mark">Blank node structures are fetched to depth five.</p>
</details>`
    )
  }
}

export async function searchPage(q) {
  const query = (q ?? "").trim().slice(0, 200)
  if (!query)
    return layout("Search", "<h1>Search</h1><p>Type a term above.</p>")
  const rows = await select("search", { ...common, REGEX: regexLiteral(query) })

  const byKey = new Map()
  for (const row of rows) {
    if (!byKey.has(row.key.value)) byKey.set(row.key.value, [])
    byKey.get(row.key.value).push(row)
  }
  const catalogue = new Map(
    (await catalogueRows()).map((row) => [row.key.value, row])
  )
  const sections = [...byKey.entries()]
    .map(
      ([
        key,
        hits
      ]) => `<h2>${escape(catalogue.get(key)?.title.value ?? key)}</h2>
${
  catalogue.get(key)?.mirrorOf
    ? `<p class="mark">Mirrored from MatSci-SAM, licence ${escape(
        catalogue.get(key)?.license.value ?? ""
      )}.</p>`
    : `<p class="mark">${escape(catalogue.get(key)?.license.value ?? "")}</p>`
}
<ul>${hits
        .map(
          (row) =>
            `<li>${termLink(row.s.value, row.label.value)}${
              row.definition
                ? `<span class="mark">: ${escape(row.definition.value.slice(0, 200))}</span>`
                : ""
            }</li>`
        )
        .join("\n")}</ul>`
    )
    .join("\n")
  // The query caps at 200, so a full page of results may not be all of them.
  const overflow =
    rows.length >= 200 ? "<p>Only the first 200 results are shown.</p>" : ""
  return layout(
    `Search: ${query}`,
    `<h1>Search</h1>
<p>${rows.length} result(s) for <strong>${escape(query)}</strong>, matched on word boundaries.</p>
${overflow}
${sections || "<p>Nothing matched.</p>"}`
  )
}

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
<div id="cy"></div>
<script src="/assets/cytoscape.min.js"></script>
<script src="/assets/dagre.min.js"></script>
<script src="/assets/cytoscape-dagre.min.js"></script>
<script>
(async () => {
  const data = await (await fetch("/graph/${attr(key)}.json")).json();
  document.getElementById("note").textContent = data.note;
  const cy = cytoscape({
    container: document.getElementById("cy"),
    elements: data.elements,
    layout: { name: "dagre", rankDir: "BT", nodeSep: 30, rankSep: 60, animate: false },
    style: [
      { selector: "node", style: { label: "data(label)", "font-size": "10px",
        "text-wrap": "wrap", "text-max-width": "90px", width: 24, height: 24,
        "background-color": "#4a6fa5" } },
      { selector: "node.external", style: { "background-color": "#b0b0b0" } },
      { selector: "edge.hierarchy", style: { "curve-style": "bezier",
        "target-arrow-shape": "triangle", width: 1, "line-color": "#888",
        "target-arrow-color": "#888" } },
      { selector: "edge.property", style: { "curve-style": "bezier",
        "line-style": "dashed", "line-color": "#8e6fae", width: 1,
        label: "data(label)", "font-size": "8px", "text-rotation": "autorotate" } },
      { selector: ".dim", style: { opacity: 0.15 } },
    ],
  });
  cy.on("tap", "node", (event) => { window.location = event.target.data("url"); });
  document.getElementById("filter").addEventListener("input", (event) => {
    const q = event.target.value.toLowerCase();
    cy.batch(() => {
      cy.elements().removeClass("dim");
      if (!q) return;
      const keep = cy.nodes().filter((n) => n.data("label").toLowerCase().includes(q));
      cy.elements().not(keep).not(keep.connectedEdges()).addClass("dim");
    });
  });
})();
</script>`
    )
  }
}
