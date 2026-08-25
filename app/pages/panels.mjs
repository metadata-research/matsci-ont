// The panels of the entity page.
//
// Each is a pure function from rows to HTML, so what a panel shows can be
// checked without a store. That matters here more than elsewhere: these
// decide what a reader is told an ontology says, and two of them have been
// wrong in ways no query check would have caught — a nested list built
// inside its own parent, and a mapping target used as an href.

import { safeHref } from "../lib/terms.mjs"
import { escape, attr, termLink, localName } from "../lib/html.mjs"
import { graphs } from "./common.mjs"

export const INFERRED_MARK =
  '<span class="mark inferred" title="Placed here by the reasoner">inferred</span>'

// Annotations the hierarchy, axioms and definition panels already show.
// Repeating them as raw properties would tell a reader the same thing three
// times in three vocabularies.
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

// The chain upward, one indent per level. The inferred marker sits on the
// node whose step upward the reasoner supplied, so a reader can see which
// link in the chain is inferred rather than being told the page as a whole
// contains inference.
export function hierarchyChain(ancestry, iri, showInferred) {
  return ancestry.chain
    .map((node, index) => {
      const text =
        node.iri === iri
          ? `<strong>${escape(node.label ?? localName(node.iri))}</strong>`
          : termLink(node.iri, node.label, showInferred) +
            (node.external ? ' <span class="mark">external</span>' : "")
      const mark = node.inferredEdge ? ` ${INFERRED_MARK}` : ""
      return `<div style="padding-left:${index * 1.25}rem">↳ ${text}${mark}</div>`
    })
    .join("\n")
}

export function secondaryParents(ancestry, showInferred) {
  if (ancestry.secondary.length === 0) return ""
  return `<p>Also below: ${ancestry.secondary
    .map(
      (node) =>
        termLink(node.iri, node.label, showInferred) +
        (node.inferredEdge ? ` ${INFERRED_MARK}` : "")
    )
    .join(", ")}</p>`
}

const CHILD_LIMIT = 25

export function childrenList(childRows, showInferred) {
  const html = childRows
    .slice(0, CHILD_LIMIT)
    .map(
      (row) =>
        `<li>${termLink(row.child.value, row.label?.value, showInferred)}${
          row.inferred?.value === "true"
            ? ' <span class="mark inferred">inferred</span>'
            : ""
        }</li>`
    )
    .join("\n")
  const overflow =
    childRows.length > CHILD_LIMIT
      ? `<p>Only the first ${CHILD_LIMIT} children are shown.</p>`
      : ""
  return { html, overflow }
}

// Literal properties the entity states about itself, other than the ones
// another panel already shows and the ones this project derived.
export function annotationsTable(rows, iri) {
  return rows
    .filter(
      (row) =>
        row.s.type === "uri" &&
        row.s.value === iri &&
        row.o.type === "literal" &&
        row.g.value !== graphs.definitions &&
        row.g.value !== graphs.catalog &&
        !HIDDEN_ANNOTATIONS.has(row.p.value)
    )
    .map(
      (row) =>
        `<tr><td><code title="${attr(row.p.value)}">${escape(localName(row.p.value))}</code></td><td>${escape(row.o.value)}${
          row.o["xml:lang"]
            ? ` <span class="mark">@${escape(row.o["xml:lang"])}</span>`
            : ""
        }</td></tr>`
    )
    .join("\n")
}

export function axiomsList(axioms, disjoint, showInferred) {
  const tokensHtml = (tokens) =>
    tokens
      .map((token) =>
        token.kind === "term"
          ? termLink(token.iri, undefined, showInferred)
          : escape(token.text)
      )
      .join(" ")
  return [
    ...axioms.map(
      (axiom) =>
        `<li>${escape(axiom.relation)} ${tokensHtml(axiom.tokens)}</li>`
    ),
    ...disjoint.map(
      (other) =>
        `<li>disjoint with ${termLink(other, undefined, showInferred)}</li>`
    )
  ].join("\n")
}

// A mapping target is an IRI its author wrote and cannot be trusted as an
// href. An http or https target links out, anything else shows as text: a
// javascript: target once rendered as a working link.
export function mappingsList(rows, iri) {
  return rows
    .filter(
      (row) =>
        row.s.value === iri &&
        row.o.type === "uri" &&
        MAPPING_PREDICATES.has(row.p.value)
    )
    .map((row) => {
      const href = safeHref(row.o.value)
      const target = href
        ? `<a href="${attr(href)}" rel="noopener nofollow">${escape(row.o.value)}</a>`
        : `<code>${escape(row.o.value)}</code>`
      return `<li><code>${escape(localName(row.p.value))}</code> ${target}</li>`
    })
    .join("\n")
}

export const INCOMING_LIMIT = 50

// References to this entity, grouped by predicate. The child list goes
// inside the group's own list item: built as a sibling it rendered as a
// list inside a list with no item around it.
export function incomingList(incomingRows, showInferred) {
  const byPredicate = new Map()
  for (const row of incomingRows.slice(0, INCOMING_LIMIT)) {
    if (!byPredicate.has(row.p.value)) byPredicate.set(row.p.value, [])
    byPredicate.get(row.p.value).push(row)
  }
  return [...byPredicate.entries()]
    .map(
      ([predicate, refs]) =>
        `<li><code title="${attr(predicate)}">${escape(localName(predicate))}</code>
<ul>${refs.map((row) => `<li>${termLink(row.s.value, row.label?.value, showInferred)}</li>`).join("\n")}</ul></li>`
    )
    .join("\n")
}

export function rawTable(rows) {
  return rows
    .map(
      (row) =>
        `<tr><td>${escape(row.s.type === "bnode" ? `_:${row.s.value}` : localName(row.s.value))}</td>` +
        `<td title="${attr(row.p.value)}">${escape(localName(row.p.value))}</td>` +
        `<td>${escape(row.o.type === "bnode" ? `_:${row.o.value}` : row.o.value)}</td>` +
        `<td class="graph">${escape(localName(row.g.value))}</td></tr>`
    )
    .join("\n")
}
