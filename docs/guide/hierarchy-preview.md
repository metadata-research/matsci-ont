# Hierarchy preview API

These read-only JSON routes serve a compact term picker and parent panel.
Only sources cleared for publication and not marked as mirrors are eligible.
They read the existing description index and asserted source graphs; no
additional ontology build or reasoning step is needed.

## Find candidates

`GET /candidates?q=iron%20atom&limitPerSource=5`

The response is `{query, mode, sources}`, with one group for each matching source:

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
        "license": "CC-BY-4.0"
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

This illustrates the response shape, not a complete set of search results.
The default `mode=exact` returns only case-insensitive exact labels, marked
`match: "exact"`. Surrounding whitespace on the query and label is ignored;
words and chemical punctuation are preserved. Thus `water` does not select
`water absorption`, and `Fe(III)` does not select `FeIII` or `Fe(II)`.

Explicit `mode=similar` returns only non-exact whole-word label matches,
marked `match: "label"`. For example, `/candidates?q=water&mode=similar`
may return `water absorption` but excludes the exact label `water`.
Both word boundaries are required, so `iron` can match `iron atom` but
not `ironic`. These are similar names, not inferred synonyms, nearest
concepts, or asserted SKOS mappings. No alternative-label or synonym index
is consulted. Definitions are not searched and need not exist.

Only indexed OWL/RDFS classes and SKOS concepts qualify; properties are
excluded. Mode filtering happens before each source's independent cap,
default 5 and at most 20. A group sets `truncated` when it has further
matches in that mode. Sources with no matches are absent. An empty result
is `{query, mode, sources: []}`. Other mode values are rejected.

The search term must be nonblank text of at most 200 characters, without
control characters after trimming surrounding whitespace. Selection identity is the pair of source key and entity
IRI; similar labels in different sources do not assert equivalence.

## Read direct parents

`GET /hierarchy?source=chebi&iri=http%3A%2F%2Fpurl.obolibrary.org%2Fobo%2FCHEBI_18248`

The response has these fields:

- `source`: the same `{key, title, version?, license}` metadata as a search group.
- `entity`: `{iri, label}`, taken from the selected source's index record.
- `parents`: an array of `{iri, label?, predicate, direction}`.
- `truncated`: whether more than 50 parent relationships exist.
- `hasAnonymousSuperclasses`: whether an asserted `rdfs:subClassOf` object is a blank node.

Both parameters are required. The source must be eligible and must index the
selected entity as a class or concept. Source keys use lowercase letters,
digits and hyphens, starting with a letter or digit, up to 64 characters.
Entity IRIs must be substitutable absolute HTTP(S) IRIs of at most 2,048
characters.

Parents are only directly asserted named relationships in that source:

| Predicate                                         | Direction  | Assertion                                  |
| ------------------------------------------------- | ---------- | ------------------------------------------ |
| `http://www.w3.org/2000/01/rdf-schema#subClassOf` | `outgoing` | entity is a subclass of parent             |
| `http://www.w3.org/2004/02/skos/core#broader`     | `outgoing` | parent is a broader concept                |
| `http://www.w3.org/2004/02/skos/core#narrower`    | `incoming` | parent explicitly names entity as narrower |

Labels come only from the selected source. A parent without its own indexed
label remains present with its IRI. Different predicates or directions to
the same parent remain distinct relationships. Transitive ancestors,
inferred placements, equivalence axioms and anonymous class expressions are
not returned as named parents. An empty parent list means no named parent
was asserted; it does not establish that the entity is an ontology root.

## Bounds and errors

Each request shares a 12-second deadline across its store queries. Query
results and final JSON responses are capped at 128 KiB. More than 32 eligible
sources is an error rather than a silently incomplete source list. Per-source
candidate caps and the parent cap use an extra result row to detect truncation.

Responses, including errors, are JSON. Invalid input or a selection outside
the permitted scope returns HTTP 400 with `{error}`. Store failures,
timeouts and response-limit failures return HTTP 502. Methods other than GET
or HEAD return HTTP 405. An empty successful answer is distinct from an error.
