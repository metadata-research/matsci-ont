// One entity: what the sources say about it, and where that came from.
//
// This function fetches and assembles; each panel is rendered by
// panels.mjs. The order below is the order a reader needs it in — what it
// is, where it sits, what it means, then the detail and finally the raw
// triples the rest was derived from.

import { checkIri, safeHref } from "../lib/terms.mjs"
import { select } from "../lib/store.mjs"
import {
  escape,
  attr,
  layout,
  errorPage,
  entityUrl,
  localName
} from "../lib/html.mjs"
import { buildAncestry } from "../lib/hierarchy.mjs"
import { verbalize } from "../lib/axioms.mjs"
import {
  common,
  graphs,
  ONT,
  sourceByKey,
  sourceByGraph,
  hasInferred,
  mirrorBanner,
  hierarchySubstitutions
} from "./common.mjs"
import {
  hierarchyChain,
  secondaryParents,
  childrenList,
  annotationsTable,
  axiomsList,
  mappingsList,
  incomingList,
  rawTable,
  INCOMING_LIMIT
} from "./panels.mjs"

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

  // The definitions index is this project's own view of the entity: which
  // source it was indexed from, and the label and definition chosen by the
  // precedence in the pipeline.
  const definitionRows = rows.filter(
    (row) => row.g.value === graphs.definitions
  )
  const field = (name) =>
    definitionRows.find((row) => row.p.value === `${ONT}${name}`)?.o.value
  const key = field("sourceKey")
  const source = key
    ? await sourceByKey(key)
    : await sourceByGraph(rows[0].g.value)

  const inferredAvailable = Boolean(key) && (await hasInferred(key))
  const showInferred = Boolean(inferred && inferredAvailable)
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

  const chainHtml = hierarchyChain(ancestry, iri, showInferred)
  const secondaryHtml = secondaryParents(ancestry, showInferred)
  const children = childrenList(childRows, showInferred)
  const annotationsHtml = annotationsTable(rows, iri)
  const axiomsHtml = axiomsList(axioms, disjoint, showInferred)
  const mappingsHtml = mappingsList(rows, iri)
  const incomingHtml = incomingList(incomingRows, showInferred)
  const rawHtml = rawTable(rows)

  const definition = field("definition")
  const definitionProperty = definitionRows.find(
    (row) => row.p.value === `${ONT}definitionProperty`
  )?.o.value

  const label = field("label") ?? localName(iri)
  const toggleHtml = inferredAvailable
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
${children.html ? `<h3>Children</h3><ul>${children.html}</ul>${children.overflow}` : ""}
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
${incomingHtml ? `<h2>Referenced by</h2><ul>${incomingHtml}</ul>${incomingRows.length > INCOMING_LIMIT ? `<p>Only the first ${INCOMING_LIMIT} references are shown.</p>` : ""}` : ""}
<details>
<summary>Raw triples (${rows.length})</summary>
<table class="raw">${rawHtml}</table>
<p class="mark">Blank node structures are fetched to depth five.</p>
</details>`
    )
  }
}
