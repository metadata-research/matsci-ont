# Hierarchy preview API

These read-only JSON routes serve a compact term picker and a panel of
direct parents and named mappings. Only sources that are cleared for
publication and are not mirrors qualify. The routes read the description
index and the asserted source graphs, so they need no extra build or
reasoning step.

## Find candidates

`GET /candidates?q=iron%20atom&limitPerSource=5`

The response is `{query, mode, sources}`, with one group for each source
that matches.

```json
{
  "query": "iron atom",
  "mode": "exact",
  "sources": [
    {
      "source": {
        "key": "chebi",
        "title": "ChEBI, Chemical Entities of Biological Interest (CORE)",
        "version": "254",
        "license": "CC-BY-4.0",
        "kind": "ontology"
      },
      "candidates": [
        {
          "iri": "http://purl.obolibrary.org/obo/CHEBI_18248",
          "label": "iron atom",
          "match": "exact"
        }
      ],
      "truncated": false
    }
  ]
}
```

The example shows the shape of a response, and a real search can return
more groups and candidates. The default `mode=exact` returns labels equal
to the term, ignoring case and surrounding whitespace, marked
`match: "exact"`. Words and chemical punctuation count, so `water` does not
select `water absorption`, and `Fe(III)` selects neither `FeIII` nor
`Fe(II)`.

`mode=similar` returns the other labels that contain the term as a whole
word, marked `match: "label"`. For example, `/candidates?q=water&mode=similar`
may return `water absorption` and leaves out the exact label `water`. The
term must stand as a whole word at both ends, so `iron` can match
`iron atom` and not `ironic`. A similar name carries no claim of synonymy,
nearness or an asserted SKOS mapping. No alternative-label or synonym index
is consulted, and definitions are neither searched nor required.

Only indexed OWL and RDFS classes and SKOS concepts qualify, so properties
never appear. The mode filter applies before the cap of each source, which
is 5 by default and 20 at most. A group sets `truncated` when it has further
matches in that mode, and a source with no matches is absent. An empty
result is `{query, mode, sources: []}`, and any other mode is rejected.

The search term must be nonblank text of at most 200 characters with no
control characters once surrounding whitespace is trimmed. A selection is
identified by the pair of source key and entity IRI, and similar labels in
different sources do not assert equivalence.

`kind` states what the graph of the source declares itself to be. A graph
holding an `owl:Ontology` is an `ontology`, one holding a
`skos:ConceptScheme` and no `owl:Ontology` is a `vocabulary`, and one
holding neither is `other`. An OWL ontology that also declares a concept
scheme is an ontology. The same `source` object, with `kind`, appears in
the hierarchy answer.

## Read direct parents

`GET /hierarchy?source=chebi&iri=http%3A%2F%2Fpurl.obolibrary.org%2Fobo%2FCHEBI_18248`

| Field                      | Content                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `source`                   | The same `{key, title, version?, license, kind}` object as a candidate group |
| `entity`                   | `{iri, label}`, taken from the index record of the selected source           |
| `parents`                  | An array of `{iri, label?, predicate, direction}`                            |
| `truncated`                | Whether more than 50 parent relationships exist                              |
| `hasAnonymousSuperclasses` | Whether an asserted `rdfs:subClassOf` object is a blank node                 |
| `mappings`                 | An array of `{iri, label?, predicate, direction}`, at most 20                |

Both parameters are required. The source must qualify and must index the
entity as a class or concept. A source key consists of lowercase letters,
digits and hyphens, starts with a letter or digit, and has at most 64
characters. An entity IRI must be an absolute HTTP or HTTPS IRI of at most
2,048 characters that a SPARQL query can hold between angle brackets.

Parents are the named relationships the source asserts directly.

| Predicate                                         | Direction  | Assertion                                  |
| ------------------------------------------------- | ---------- | ------------------------------------------ |
| `http://www.w3.org/2000/01/rdf-schema#subClassOf` | `outgoing` | entity is a subclass of parent             |
| `http://www.w3.org/2004/02/skos/core#broader`     | `outgoing` | parent is a broader concept                |
| `http://www.w3.org/2004/02/skos/core#narrower`    | `incoming` | parent explicitly names entity as narrower |

Labels come only from the selected source, and a parent without its own
indexed label is returned with its IRI alone. Different predicates or
directions to the same parent remain distinct relationships. The answer
leaves out transitive ancestors, inferred placements, equivalence axioms
and anonymous class expressions. An empty parent list means the source
asserts no named parent, which does not make the entity a root of the
ontology.

Mappings are the named mapping assertions the source makes about the
entity. `direction` is `outgoing` when the entity is the subject of the
assertion and `incoming` when it is the object.

| Predicate                                        | Assertion                               |
| ------------------------------------------------ | --------------------------------------- |
| `http://www.w3.org/2004/02/skos/core#exactMatch` | the two concepts are an exact match     |
| `http://www.w3.org/2004/02/skos/core#closeMatch` | the two concepts are a close match      |
| `http://www.w3.org/2002/07/owl#equivalentClass`  | the two classes are declared equivalent |

Only a named IRI at the other end qualifies, so an `owl:equivalentClass`
whose object is a class expression, which is a blank node, is not returned.
Every equivalence axiom in the current OWL sources has that form, so the
usable mappings are the SKOS links. Mappings come from the graph of the
selected source, and a label is present only when that source indexes the
mapped entity. The array holds at most 20 mappings, ordered by predicate
and then IRI, and reports no truncation.

NIST models a synonym as a bare concept, typed and labelled but in no
scheme and under no broader concept, which the real concept names by
`skos:exactMatch`. The synonym therefore has no parent and one incoming
mapping, and the concept lists each synonym as an outgoing mapping. A
mapping is what the source asserts. It does not make the mapped entity a
candidate.

## Bounds and errors

Each request shares a 12-second deadline across its store queries. The
store receives the deadline and stops a query when it passes, and the
application stops waiting as soon as the caller disconnects. Query results
and the final JSON response are capped at 128 KiB. More than 32 qualifying
sources is an error, so the source list is never silently incomplete. The
candidate and parent caps each fetch one extra row to detect truncation,
and the mapping cap keeps the first 20 mappings in their fixed order
without reporting truncation.

Candidate searches are answered from an index of the descriptions that the
application holds in memory. The index loads when the application starts
and again after the store is replaced, which takes some seconds, and longer
on a busy host. During a load, one search at a time runs as a SPARQL query
against the store, which gives the same answer in seconds where the index
takes milliseconds. The others wait for the index for at most a quarter of
the time left before the deadline, then run as SPARQL queries in the time
that remains. A search that the deadline overtakes fails with HTTP 502, as
any other store failure does.

Every response is JSON, errors included. Invalid input or a selection
outside the permitted scope returns HTTP 400 with `{error}`. Store failures,
timeouts and responses over the size cap return HTTP 502, and methods other
than GET or HEAD return HTTP 405. An empty successful answer is distinct
from an error.
