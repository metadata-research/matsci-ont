# The grounding route

MatSci-ONT serves definition text for a term, with what a caller needs to
credit it. The route exists so a service drafting a definition can show a
reader what published ontologies already say.

```
GET /grounding?q=energy
```

| Parameter       | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `q`             | The term to look up. Required.                                    |
| `limit`         | Most results to return, 10 by default and 50 at most.             |
| `sources`       | Comma-separated source keys to search within, from the catalogue. |
| `includeMirror` | Set to 1 to include mirrored sources.                             |

The answer is JSON:

```json
{
  "query": "energy",
  "truncated": true,
  "results": [
    {
      "term": "energy",
      "definition": "A physical quantity that is conserved ...",
      "source": "PMD Core Ontology (PMDco)",
      "sourceIri": "https://w3id.org/pmd/co/PMD_0000021",
      "sourceKey": "pmdco",
      "version": "3.1.0",
      "license": "CC-BY-4.0"
    }
  ]
}
```

Every result names its source, version and licence, because a caller
showing the definition to a reader has to pass those on. `truncated` is
true when the answer was cut at the limit.

## What is returned, and in what order

Only an entry that has a definition can ground anything, so a label-only
entry is left out. The whole NIST Materials Data Vocabulary is label-only
and contributes nothing here, while remaining searchable in the browse
application.

Matching is on whole words, as in the search page. Results come back in
three tiers, and within a tier by source key and then label, so the same
question returns the same order:

1. The label is the term.
2. The label contains the term as a whole word.
3. Only the definition contains it.

## What is never returned

A source that is not cleared for public serving never grounds anything.
Clearance records that a licence permits the content to be passed on, and
no parameter lifts it.

Mirrored sources are left out by default for a second reason. The route
exists to serve MatSci-SAM, and returning its own vocabulary to it would be
circular. `includeMirror=1` lifts that, but it cannot lift the clearance
rule, so while the MatSci-SAM licence is undeclared the option adds
nothing and the answer says so in a `note`.

## ChEBI and source provenance

ChEBI CORE release 254 supplies chemical definitions under CC BY 4.0.
`/grounding?q=water&sources=chebi&limit=1` returns the publisher's definition
of `CHEBI:15377`. Each result is a single source's description: its text,
IRI, source key, version and licence remain together even when PMD describes
the same IRI. Never borrow another result's version or licence.

Credit the source and version and link the entity and the
[CC BY 4.0 licence](https://creativecommons.org/licenses/by/4.0/) when
presenting a ChEBI definition. Definitions are selected from the source
snapshot without rewriting their text. Synonym search is outside this CORE
integration; the publisher's LITE distribution cannot replace CORE because
it omits definitions.
