// The browse application, served against the same store.
//
// These check rendered pages rather than query answers. The distinction
// matters: a check that counted rows in the store said nothing about
// whether the page showed them, and one that did exactly that passed while
// the page was dropping children.

import { rows, firstRow } from "../../../shared/fuseki.mjs"
import { inferredGraphFor } from "../../../shared/vocabulary.mjs"
import { escape as escapeHtml } from "../../../app/lib/html.mjs"

export async function checkBrowse(context) {
  await checkRoutes(context)
  await checkNotFound(context)
  await checkChildrenRendered(context)
  await checkTreeFollowsBroader(context)
  await checkDefinitionAndAttribution(context)
  await checkAxiomVerbalized(context)
  await checkSearch(context)
  await checkInferredToggle(context)
  await checkGraphExport(context)
}

async function checkRoutes({ record, page, manifest }) {
  const routes = ["/", "/search?q=sinter"]
  for (const entry of manifest) {
    routes.push(
      `/source/${entry.key}`,
      `/graph/${entry.key}`,
      `/graph/${entry.key}.json`
    )
  }
  const broken = []
  for (const route of routes) {
    const result = await page(route)
    if (result.status !== 200) broken.push(`${route} answered ${result.status}`)
  }
  record(
    "every application route answers",
    broken.length === 0,
    broken.join("\n") || `${routes.length} routes`
  )
}

async function checkNotFound({ record, page }) {
  const missing = await page("/entity?iri=https%3A%2F%2Fexample.org%2Fnope")
  const badPath = await page("/nope")
  record(
    "unknown pages answer clean 404s",
    missing.status === 404 && badPath.status === 404,
    `entity ${missing.status}, path ${badPath.status}`
  )
}

// Every child IRI the store reports must appear as a link on the rendered
// page, not merely exist in the store.
async function checkChildrenRendered({
  record,
  ask,
  page,
  fixtures,
  graphIriFor
}) {
  const { source, label, expect } = fixtures.browse.children
  const graph = graphIriFor(source)
  const parent = firstRow(
    await ask("labelled-class", { GRAPH: graph, LABEL: label })
  )
  if (!parent) {
    record(
      `the ${source} ${label} class shows all its children on the source page`,
      false,
      `no class labelled ${label} in ${graph}`
    )
    return
  }
  const children = rows(
    await ask("direct-children", { GRAPH: graph, PARENT: parent.c.value })
  ).map((b) => b.child.value)
  const html = (await page(`/source/${source}`)).text
  const linked = children.filter((child) =>
    html.includes(`iri=${encodeURIComponent(child)}`)
  )
  record(
    `the ${source} ${label} class shows all ${expect} children on the source page`,
    children.length === expect && linked.length === expect,
    `${children.length} children in the store, ${linked.length} linked on the page`
  )
}

// The NIST vocabulary has no subClassOf at all, so its tree exists only if
// skos:broader is followed. Counting list openers proved nothing, because
// any non-empty tree has them, and a threshold on edge count was a guess.
// A concept renders as a collapsible section exactly when it has children
// in the index, so the sections and the distinct in-set parents are the
// same number, and a tree that had stopped following broader would have
// none at all.
async function checkTreeFollowsBroader({
  record,
  ask,
  page,
  fixtures,
  graphs,
  ont,
  graphIriFor
}) {
  const { source } = fixtures.browse.tree
  const html = (await page(`/source/${source}`)).text
  const nested = (html.match(/<details/g) ?? []).length
  const parents = Number(
    firstRow(
      await ask("broader-parents", {
        GRAPH: graphIriFor(source),
        DEFS: graphs.definitions,
        ONT: ont,
        KEY: source
      })
    ).n.value
  )
  record(
    "the NIST tree nests once per parent, so skos:broader was followed",
    parents > 0 && nested === parents,
    `${nested} nested section(s), ${parents} parent(s) in the data`
  )
}

// Attribution and the definition text the precedence chose, which for
// CHAMEO is the EMMO elucidation rather than rdfs:comment.
async function checkDefinitionAndAttribution({
  record,
  ask,
  page,
  fixtures,
  graphIriFor
}) {
  const { source, iri, expectVersion, expectLicense } =
    fixtures.browse.definition
  const rendered = await page(`/entity?iri=${encodeURIComponent(iri)}`)
  const found = firstRow(
    await ask("elucidation", { GRAPH: graphIriFor(source), IRI: iri })
  )
  const text = found?.d.value
  record(
    "the FatigueTesting page attributes CHAMEO and shows its elucidation",
    rendered.status === 200 &&
      rendered.text.includes(expectVersion) &&
      rendered.text.includes(expectLicense) &&
      Boolean(text) &&
      rendered.text.includes(escapeHtml(text)),
    `status ${rendered.status}, elucidation ${text ? "present" : "absent"}`
  )
}

async function checkAxiomVerbalized({ record, page, fixtures }) {
  const { iri, expect } = fixtures.browse.cardinality
  const rendered = await page(`/entity?iri=${encodeURIComponent(iri)}`)
  const shown = rendered.text.includes(expect)
  record(
    "a cardinality restriction renders verbalized",
    shown,
    shown ? `${iri} shows ${expect}` : "not found"
  )
}

// Grouped under the source title, each group naming its licence, and never
// matching a word that merely contains the letters.
async function checkSearch({ record, page, fixtures }) {
  const { term, expectTitles, expectLicense, expectAbsent } =
    fixtures.browse.search
  const text = (await page(`/search?q=${encodeURIComponent(term)}`)).text
  const groups = (text.match(/<h2>/g) ?? []).length
  const missingTitle = expectTitles.filter((title) => !text.includes(title))
  record(
    "search groups sources, names their licences, and honors word boundaries",
    groups > 1 &&
      missingTitle.length === 0 &&
      text.includes(expectLicense) &&
      !text.includes(expectAbsent),
    missingTitle.length > 0
      ? `no group for ${missingTitle.join(", ")}`
      : `${groups} source group(s)`
  )
}

// The inferred toggle shows a placement the asserted view does not, and the
// panels stating what a source says must not draw on the inferred graphs.
async function checkInferredToggle({
  record,
  ask,
  page,
  fixtures,
  graphIriFor
}) {
  const { source } = fixtures.browse.inferred
  const pair = firstRow(
    await ask("inferred-only", {
      INFERRED: inferredGraphFor(source),
      SOURCE: graphIriFor(source)
    })
  )
  if (!pair) {
    record(
      "the inferred toggle shows a parent the asserted view does not",
      false,
      "no inferred-only pair found"
    )
    return
  }

  const link = `/entity?iri=${encodeURIComponent(pair.c.value)}`
  const asserted = await page(link)
  const withInferred = await page(`${link}&inferred=1`)
  const parentLink = `iri=${encodeURIComponent(pair.p.value)}`

  // The marker must be in the hierarchy card itself. Looking for it
  // anywhere on the page would be satisfied by the children list, which has
  // marked inferred rows since the browse application landed. The card runs
  // from its own div to whichever of the children heading or the definition
  // heading comes first; a regex to its closing tag would stop at the first
  // nested row instead.
  const start = withInferred.text.indexOf('<div class="hierarchy">')
  const ends = ["<h3>Children", "<h2>Definition"]
    .map((marker) => withInferred.text.indexOf(marker, start))
    .filter((index) => index > start)
  const card =
    start < 0
      ? ""
      : withInferred.text.slice(
          start,
          Math.min(...ends, withInferred.text.length)
        )

  record(
    "the inferred toggle marks an inferred step in the hierarchy card",
    !asserted.text.includes(parentLink) &&
      withInferred.text.includes(parentLink) &&
      card.includes("mark inferred"),
    `${pair.c.value} under ${pair.p.value}`
  )
  record(
    "the asserted view shows no inferred triple in its panels",
    !asserted.text.includes(parentLink),
    asserted.text.includes(parentLink)
      ? "an inferred pair reached the asserted page"
      : "clean"
  )
}

async function checkGraphExport({ record, page, fixtures }) {
  const { truncated, whole } = fixtures.browse.graphExport
  const large = JSON.parse((await page(`/graph/${truncated}.json`)).text)
  const small = JSON.parse((await page(`/graph/${whole}.json`)).text)
  record(
    "the graph export truncates above 300 nodes and not below",
    large.truncated === true && small.truncated === false,
    `${truncated} ${large.elements.nodes.length} nodes, ${whole} ${small.elements.nodes.length}`
  )
}
