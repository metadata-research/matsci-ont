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

For sources with more than 5,000 indexed entries, including ChEBI, the
source page shows at most 100 non-deprecated root classes. Open a class to
follow its ancestors and children, or search for a term directly. This is
a starting view; it does not enumerate the entire ontology. Deprecated
entities remain in the source snapshot and may be found by search.

Three markers appear in the tree where they apply:

- A repeat marker on a class already shown under another parent. The
  class expands only at its first appearance.
- An external-parent marker on a class whose parent belongs to another
  source, for example a CHAMEO class below an EMMO class. Following the
  link shows the parent on its own source's terms.
- An inferred marker on a placement contributed by the reasoner, visible
  when the inferred view is selected on a source that has one.

## The inferred view

A source page and an entity page offer an inferred view where reasoning
found placements the source does not state. The link switches between the
two views, and it appears only for a source whose reasoning added
something.

In the inferred view the hierarchy holds both what the source states and
what the reasoner derived, and each derived step carries the inferred
marker. The other panels never change: the definition, the axioms, the
references and the raw triples state what the source says, so a reader can
always tell an assertion from a derivation.

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

If several sources describe the same publisher IRI, the page offers a
source selector. `?iri=...&source=chebi` selects ChEBI's definition,
annotations, axioms and hierarchy; `source=pmdco` selects PMD's description.
Search results, graph nodes and links within that source's hierarchy retain
this choice. Without a source, the first source key alphabetically is used.
These are descriptions of the same IRI, not assertions that similarly
named terms in other ontologies are equivalent. Reviewed mappings and SAM
visualization switching are separate planned work.

The mappings section lists `skos:exactMatch` and related links to other
vocabularies, and the referenced-by section lists entities that point at
this one.

## Mirrored sources

Some sources are mirrors of a dataset published elsewhere rather than
pinned snapshots. A mirrored source page shows a banner naming the publisher and the date it
was last projected, and an entity page from that source links to the
authoritative page for it. A mirror is a copy for reading, and the
publisher remains the source of record.

A mirror whose licence its publisher has not declared is marked as not
cleared for public serving. A build destined for a public host leaves it
out.

## Search

Search matches whole words in labels and definitions, case-insensitively,
and groups results by source. Exact label matches rank first before the
result cap, followed by label matches and then definition-only matches. A search for `sinter` finds sintering
concepts and does not match unrelated terms that merely contain the
letters.

## Graph view

The graph view draws one source as a diagram: classes as nodes, subclass
edges as arrows, and object properties as labelled dashed edges between
their domain and range classes. Clicking a node opens its entity page.
The filter box dims everything that does not match. Large overviews start
at a readable zoom around a connected node. Zoom controls and dragging let
you explore; filtering centers the first match, and Fit overview shows the
whole bounded diagram. For sources of up to
5,000 indexed entries, a graph with more than 300 nodes omits property
edges while retaining the hierarchy. For larger sources, the graph starts
with up to 100 non-deprecated roots and expands at most two hierarchy
levels, capped at 300 nodes and 1,200 edges. Every edge joins displayed
nodes; the note explicitly identifies this as an incomplete overview.
Open a node to continue browsing. A disconnected cycle with no root is not
represented in this overview; its entities remain searchable.

## Running it locally

```bash
pnpm ingest    # build the store from the manifest (first time)
pnpm dev       # start the store and the application together
```

The application is then at `http://localhost:3100/` and the SPARQL
endpoint at `http://localhost:3031/matsci-ont/query`.
