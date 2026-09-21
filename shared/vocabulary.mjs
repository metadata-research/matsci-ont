// The identifiers MatSci-ONT mints for itself, and nothing else.
//
// Both layers need these: the pipeline writes the derived graphs under
// them, and the application reads them back. They are neither build logic
// nor serving logic, so they are here rather than in either, which is what
// keeps the two layers from importing each other.

export function baseUrl() {
  const base =
    process.env.MATSCI_ONT_BASE_URL ?? "https://ego.cci.drexel.edu/ont/"
  return base.endsWith("/") ? base : `${base}/`
}

// The small vocabulary for derived catalogue and description records.
// Source entities keep the IRI their publisher minted.
export function vocabularyIri() {
  return `${baseUrl()}vocab#`
}

export function graphIris() {
  const base = baseUrl()
  return {
    catalog: `${base}graphs/catalog`,
    definitions: `${base}graphs/definitions`
  }
}

// One inferred graph per source, so a reader can see which source's
// reasoning produced a placement and a rebuild can replace one of them.
export function inferredGraphFor(key) {
  return `${baseUrl()}graphs/inferred/${key}`
}

// The prefix every inferred graph shares, which the page queries use to
// exclude them from panels that state what a source says.
export function inferredGraphPrefix() {
  return `${baseUrl()}graphs/inferred/`
}
