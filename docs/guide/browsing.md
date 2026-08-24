# Browsing the hub

MatSci-ONT serves versioned snapshots of published materials-science
ontologies. The browse application shows what the store holds. It is
read-only: the ontologies belong to their publishers, and each source and
entity page names the source, the version, and the license of what it
displays.

## The catalogue

The front page lists every source with its version, license, canonical
IRI, triple count, and the number of indexed entries. Each card links to
the source page and to the graph view.

## Source pages

A source page shows the catalogue record and the class hierarchy. The
hierarchy comes from `rdfs:subClassOf` for OWL ontologies and from
`skos:broader` for SKOS vocabularies. A class with children is a
collapsible section that folds and unfolds.

Three markers appear in the tree where they apply:

- A repeat marker on a class already shown under another parent. The
  class expands only at its first appearance.
- An external-parent marker on a class whose only parent is not in the
  store, for example a CHAMEO class below an EMMO class that is not yet
  loaded.
- An inferred marker on a placement contributed by the reasoner, visible
  when the inferred view is selected on a source that has one.

## Entity pages

An entity page opens with the attribution line, the identifier, and the
hierarchy: the chain of ancestors to the root, the entity in bold, other
parents on a separate line, and up to 25 direct children. The definition
section shows the text the source states and names the property it came
from. The axioms section renders OWL class expressions in a compact form,
for example `hasComponent some Metal` or `realizes exactly 1 Function`,
with every named term linked. Expressions the renderer does not cover are
counted above the raw-triples section, which always holds the complete
fetched data.

The mappings section lists `skos:exactMatch` and related links to other
vocabularies, and the referenced-by section lists entities that point at
this one.

## Search

Search matches whole words in labels and definitions, case-insensitively,
and groups results by source. A search for `sinter` finds sintering
concepts and does not match unrelated terms that merely contain the
letters.

## Graph view

The graph view draws one source as a diagram: classes as nodes, subclass
edges as arrows, and object properties as labelled dashed edges between
their domain and range classes. Clicking a node opens its entity page.
The filter box dims everything that does not match. A source with more
than 300 classes draws only the hierarchy, and the page says so.

## Running it locally

```bash
pnpm ingest    # build the store from the manifest (first time)
pnpm dev       # start the store and the application together
```

The application is then at `http://localhost:3100/` and the SPARQL
endpoint at `http://localhost:3031/matsci-ont/query`.
