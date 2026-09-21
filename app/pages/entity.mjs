// One entity: what the sources say about it, and where that came from.
//
// This function fetches and assembles; each panel is rendered by
// panels.mjs. The order below is the order a reader needs it in — what it
// is, where it sits, what it means, then the detail and finally the raw
// triples the rest was derived from.

import { checkIri, checkKey, safeHref, RejectedInput } from "../lib/terms.mjs"
import { descriptionsFrom, chooseDescription } from "../lib/descriptions.mjs"
import { select } from "../lib/store.mjs"
import {
  base,
  escape,
  licenseLink,
  attr,
  layout,
  errorPage,
  entityUrl,
  localName
} from "../lib/html.mjs"
import { buildAncestry } from "../lib/hierarchy.mjs"
import { verbalize } from "../lib/axioms.mjs"
import { common } from "../lib/substitutions.mjs"
import {
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

export async function entityPage(iri, inferred, sourceKey) {
  try {
    checkIri(iri)
    if (sourceKey !== undefined) checkKey(sourceKey)
  } catch {
    return {
      status: 404,
      html: errorPage(404, "That is not an entity IRI this store can hold.")
    }
  }

  let rows = await select("entity", { ...common, IRI: iri })
  if (rows.length === 0) {
    return {
      status: 404,
      html: errorPage(404, `Nothing in the store mentions ${iri}.`)
    }
  }

  const descriptions = descriptionsFrom(
    await select("descriptions", { ...common, IRI: iri })
  )
  const entry = descriptions.length
    ? chooseDescription(descriptions, sourceKey)
    : undefined
  const field = (name) => entry?.[name]
  const key = field("sourceKey")
  const source = key
    ? await sourceByKey(key)
    : sourceKey !== undefined
      ? await sourceByKey(sourceKey)
      : await sourceByGraph(rows[0].g.value)
  if (
    sourceKey !== undefined &&
    (!source || !rows.some((row) => row.g.value === source.graphIri.value))
  )
    throw new RejectedInput("This source does not describe the entity.")
  if (source) rows = rows.filter((row) => row.g.value === source.graphIri.value)
  const alternatives =
    descriptions.length > 1
      ? `<p class="source-choices">Descriptions of this entity: ${descriptions
          .map((item) =>
            item.sourceKey === key
              ? `<strong>${escape(item.sourceKey)}</strong>`
              : `<a href="${attr(entityUrl(iri, false, item.sourceKey))}">${escape(item.sourceKey)}</a>`
          )
          .join(" · ")}</p>`
      : ""

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

  const chainHtml = hierarchyChain(ancestry, iri, showInferred, key)
  const secondaryHtml = secondaryParents(ancestry, showInferred, key)
  const children = childrenList(childRows, showInferred, key)
  const annotationsHtml = annotationsTable(rows, iri)
  const axiomsHtml = axiomsList(axioms, disjoint, showInferred)
  const mappingsHtml = mappingsList(rows, iri)
  const incomingHtml = incomingList(incomingRows, showInferred)
  const rawHtml = rawTable(rows)

  const definition = field("definition")
  const definitionProperty = field("definitionProperty")

  const label = field("label") ?? localName(iri)
  const toggleHtml = inferredAvailable
    ? `<p><a href="${attr(entityUrl(iri, !showInferred, key))}">${
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
          ? `From <a href="${base}/source/${attr(source.key.value)}">${escape(source.title.value)}</a>${
              source.version ? `, version ${escape(source.version.value)}` : ""
            }, license ${licenseLink(source.license.value)}.`
          : "Not indexed from a catalogued source."
      }</p>
<p><code>${escape(iri)}</code>${safeHref(iri) ? ` · <a href="${attr(iri)}" rel="noopener">Publisher record</a>` : ""}</p>
${alternatives}
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
