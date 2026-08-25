// Verbalizes OWL class axioms from entity.rq rows. Pure.
//
// Covers what the four pinned sources actually use, one step past the
// OntServe verbalizer, which left cardinality in raw Turtle: existential
// and universal restrictions, hasValue, plain and qualified cardinalities,
// intersections and unions with their member lists, complements, and
// disjointness. Anything unrecognized keeps its blank node visible in the
// raw panel, and verbalize() reports whether it dropped to that fallback.

const OWL = "http://www.w3.org/2002/07/owl#"
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
const RDFS = "http://www.w3.org/2000/01/rdf-schema#"

// Rows come from a SPARQL JSON result: {g,s,p,o} with term objects. The
// subgraph groups them by subject, blank nodes included, since labels are
// consistent within one result set.
export function subgraphOf(rows) {
  const bySubject = new Map()
  for (const row of rows) {
    const key = row.s.type === "bnode" ? `_:${row.s.value}` : row.s.value
    if (!bySubject.has(key)) bySubject.set(key, [])
    bySubject.get(key).push(row)
  }
  return bySubject
}

const objectKey = (term) =>
  term.type === "bnode" ? `_:${term.value}` : term.value

function valuesOf(subgraph, subject, predicate) {
  return (subgraph.get(subject) ?? [])
    .filter((row) => row.p.value === predicate)
    .map((row) => row.o)
}

function one(subgraph, subject, predicate) {
  return valuesOf(subgraph, subject, predicate)[0]
}

// Returns the members and whether the list was complete. A cell missing
// from the fetched subgraph (the depth-five closure clips a long list) or
// missing rdf:first ends the walk and reports truncation, so the caller
// never presents a shortened list as the whole axiom.
function listMembers(subgraph, head, path) {
  const members = []
  let current = head
  while (current && objectKey(current) !== `${RDF}nil`) {
    const key = objectKey(current)
    if (path.has(key)) return { members, complete: false }
    if (!subgraph.has(key)) return { members, complete: false }
    const first = one(subgraph, key, `${RDF}first`)
    if (!first) return { members, complete: false }
    members.push(first)
    current = one(subgraph, key, `${RDF}rest`)
  }
  return { members, complete: current !== undefined }
}

// A class expression renders to a token list: {kind:"term",iri} for named
// classes (linked by the page) and {kind:"word",text} for everything else.
// Returns null when the expression is not one this page verbalizes, so the
// caller counts it as a fallback rather than dropping it. `path` tracks the
// blank nodes on the current branch for cycle detection, and is removed on
// exit so a node shared between two branches of a DAG still renders on the
// second branch.
export function renderExpression(subgraph, term, path = new Set()) {
  if (term.type === "uri") return [{ kind: "term", iri: term.value }]
  if (term.type !== "bnode") return [{ kind: "word", text: term.value }]

  const key = objectKey(term)
  if (path.has(key) || !subgraph.has(key)) return null
  path.add(key)
  try {
    const onProperty = one(subgraph, key, `${OWL}onProperty`)
    if (onProperty) {
      const forms = [
        [`${OWL}someValuesFrom`, "some", true],
        [`${OWL}allValuesFrom`, "only", true],
        [`${OWL}hasValue`, "value", true],
        [`${OWL}minCardinality`, "min", false],
        [`${OWL}maxCardinality`, "max", false],
        [`${OWL}cardinality`, "exactly", false],
        [`${OWL}minQualifiedCardinality`, "min", false],
        [`${OWL}maxQualifiedCardinality`, "max", false],
        [`${OWL}qualifiedCardinality`, "exactly", false]
      ]
      for (const [predicate, keyword, fillerIsExpression] of forms) {
        const value = one(subgraph, key, predicate)
        if (!value) continue
        const tokens = [
          { kind: "term", iri: onProperty.value },
          { kind: "word", text: keyword }
        ]
        if (fillerIsExpression) {
          const filler = renderExpression(subgraph, value, path)
          if (!filler) return null
          tokens.push(...filler)
        } else {
          tokens.push({ kind: "word", text: value.value })
          const onClass = one(subgraph, key, `${OWL}onClass`)
          if (onClass) {
            const filler = renderExpression(subgraph, onClass, path)
            if (!filler) return null
            tokens.push(...filler)
          }
        }
        return tokens
      }
      return null
    }

    for (const [predicate, word] of [
      [`${OWL}intersectionOf`, "and"],
      [`${OWL}unionOf`, "or"]
    ]) {
      const head = one(subgraph, key, predicate)
      if (!head) continue
      const { members, complete } = listMembers(subgraph, head, path)
      if (members.length === 0) return null
      const tokens = [{ kind: "word", text: "(" }]
      let ok = true
      members.forEach((member, index) => {
        if (index > 0) tokens.push({ kind: "word", text: word })
        const rendered = renderExpression(subgraph, member, path)
        if (!rendered) ok = false
        else tokens.push(...rendered)
      })
      // A dropped member or a clipped list means the axiom is not shown in
      // full, which is a fallback, not a partial render pretending to be
      // whole.
      if (!ok || !complete) return null
      tokens.push({ kind: "word", text: ")" })
      return tokens
    }

    const complement = one(subgraph, key, `${OWL}complementOf`)
    if (complement) {
      const inner = renderExpression(subgraph, complement, path)
      return inner ? [{ kind: "word", text: "not" }, ...inner] : null
    }
    return null
  } finally {
    path.delete(key)
  }
}

// The entity-page axioms panel: verbalized superclass restrictions and
// equivalences from the entity's own rows, plus disjointness.
export function verbalize(rows, entityIri) {
  const subgraph = subgraphOf(rows)
  const axioms = []
  const disjoint = []
  let fallbacks = 0

  for (const row of subgraph.get(entityIri) ?? []) {
    const relations = {
      [`${RDFS}subClassOf`]: "subclass of",
      [`${OWL}equivalentClass`]: "equivalent to"
    }
    const relation = relations[row.p.value]
    if (relation && row.o.type === "bnode") {
      const tokens = renderExpression(subgraph, row.o)
      if (tokens) {
        axioms.push({ relation, tokens })
      } else {
        fallbacks += 1
      }
    }
    if (row.p.value === `${OWL}disjointWith` && row.o.type === "uri") {
      disjoint.push(row.o.value)
    }
  }
  return { axioms, disjoint: disjoint.sort(), fallbacks }
}
