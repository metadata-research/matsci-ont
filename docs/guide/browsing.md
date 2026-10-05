# Browsing the hub

The browse application shows what the store holds. It is read-only, since
the ontologies belong to their publishers, and every source and entity page
names the source, version and licence of what it displays.

## The catalogue

The front page lists every source with its version, licence, ontology IRI,
triple count and number of indexed entries. A mirrored source shows its
kind in place of a version. Each card links to the source page and the
graph view.

## Source pages

A source page shows the catalogue record and the class hierarchy. The
hierarchy follows `rdfs:subClassOf` in OWL ontologies and `skos:broader` in
SKOS vocabularies, and a class with children is a section that folds and
unfolds.

A source with more than 5,000 indexed entries, such as ChEBI, starts with
at most 100 non-deprecated root classes. Open a class to follow its
ancestors and children, or search for a term directly. Deprecated entities
remain in the snapshot, and search finds them.

Three markers appear in the tree where they apply.

- `also above` marks a class already shown under another parent. The class
  expands only where it first appears.
- `external parent` marks a class with a parent that is not an indexed
  class of this source, usually a class from another source, such as a
  CHAMEO class below an EMMO class. The marker shows the IRIs of those
  parents on hover.
- `inferred` marks a placement the reasoner contributed, and appears only
  in the inferred view.

## The inferred view

A source page or an entity page offers an inferred view when reasoning
found placements the source does not state. The link switches between the
two views and appears only for a source whose reasoning added something.

In the inferred view the hierarchy holds both what the source states and
what the reasoner derived, and each derived step carries the `inferred`
marker. The root list of a large source and the graph view always show the
asserted hierarchy. The other panels stay the same in both views. The
definition, the axioms, the references and the raw triples state what the
source says, so a reader can always tell an assertion from a derivation.

## Entity pages

An entity page opens with the attribution line, the identifier with a link
to the publisher record, and the hierarchy. The hierarchy shows the chain
of ancestors up to the root with the entity in bold, other parents on a
separate line, and up to 25 direct children. An ancestor from another
source carries an `external` marker and links to its own entity page.

The definition section shows the text the source states and names the
property it came from, and an annotations table lists the literal
properties the source states for the entity. The axioms section renders OWL
class expressions compactly, for example `subclass of hasComponent some
Metal` or `equivalent to realizes exactly 1 Function`, and lists disjoint
classes. Each named term in an axiom is shown by the local name of its IRI
and linked to its entity page, so the axioms of a source with opaque IRIs,
such as EMMO, appear as identifiers. The page counts the expressions it
cannot render, and the raw-triples section holds every triple the selected
source states about the entity, blank-node structures included to depth
five.

When several sources describe the same publisher IRI, the page offers a
source selector. `?iri=...&source=chebi` selects the ChEBI definition,
annotations, axioms, hierarchy, mappings and raw triples, and `source=pmdco`
selects the PMDco description. Links from search results, graph nodes and
the hierarchy carry the source they belong to. Without a source, the page
uses the alphabetically first source key. The selector chooses between
descriptions of one IRI and asserts no equivalence between similarly named
terms in different ontologies.

The mappings section lists the SKOS mapping links (`skos:exactMatch`,
`closeMatch`, `broadMatch`, `narrowMatch` and `relatedMatch`) and
`rdfs:seeAlso`. The referenced-by section lists up to 50 entities that point
at this one, from any source, whichever source is selected.

## Mirrored sources

A mirrored source copies a dataset published elsewhere, and its publisher
remains the source of record. Its source page, entity pages and graph view
carry a banner that names the publisher and the date the dataset was last
projected, and an entity page links to the authoritative page for the
entity. A mirror whose publisher has declared no licence is marked as not
cleared for public serving, and a build for a public host leaves it out.

## Search

Search looks for the term where a word starts in labels and definitions,
ignoring case, and groups the results by source with the licence of each. A
term that begins with punctuation, such as `(III)`, matches only directly
after a letter, digit or underscore, as in `Fe(III)`. Search uses the first
200 characters of the term. Exact label matches come first, then other label
matches, then matches in a definition only, and the page shows at most 200
results. `sinter` finds `sintering` and skips terms that merely contain the
letters, such as `hasInteractionVolume`.

## Graph view

The graph view draws one source as a diagram, with classes as nodes,
subclass edges as arrows and object properties as labelled dashed edges
between their named domain and range classes. A click on a node opens its
entity page, and the filter box dims everything that does not match. The
zoom buttons, dragging and the Fit overview button move around the diagram.

A source of up to 5,000 indexed entries is drawn whole, except that a graph
of more than 300 nodes omits the property edges and keeps the hierarchy. A
larger source starts with up to 100 non-deprecated roots and expands at most
two hierarchy levels, capped at 300 nodes and 1,200 edges, and the page
labels the result an incomplete overview. Every edge joins displayed nodes.
The overview opens at a readable zoom around its most connected node, and in
the overview the filter also centers the first match. A cycle with no root
does not appear in the overview, and its entities remain searchable.

## Running it locally

```bash
pnpm ingest    # build the store from the manifest, the first time
pnpm dev       # start the store and the application together
```

The application is then at `http://localhost:3100/` and the SPARQL
endpoint at `http://localhost:3031/matsci-ont/query`.
