# The grounding route

The grounding route serves definition text for a term together with what a
caller needs to credit it. A service drafting a definition uses it to show
a reader what published ontologies already say.

```
GET /grounding?q=energy
```

| Parameter       | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `q`             | The term to look up. Required.                                    |
| `limit`         | Most results to return, 10 by default and 50 at most.             |
| `sources`       | Comma-separated source keys to search within, from the catalogue. |
| `includeMirror` | Set to 1 to include mirrored sources.                             |

The answer is JSON.

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

Every result names its source, version and licence, because a caller who
shows the definition to a reader has to pass those on. `truncated` is true
when the answer was cut at the limit.

## What is returned, and in what order

An entry without a definition cannot ground anything and is left out. The
NIST Materials Data Vocabulary has labels only, so it contributes nothing
here and remains searchable in the browse application.

The route ignores case and looks for the term where a word starts, as the
search page does. `sinter` finds `sintering` but not `presintering`.

The store decides where a word starts by the rule of Java regular
expressions, in which only the ASCII letters, the digits and the underscore
are word characters. A term that begins with one of them matches at the
start of the text or after any other character. So `water` matches in
`sea water` and `(water)`, and also inside `Äwater`, but not in `_water` or
`2water`. A term that begins with any other character, such as `α`, matches
only directly after an ASCII letter, a digit or an underscore, as in
`10α-amino acid`, and never at the start of the text or after a space. So
`α-amino acid` does not find a definition that mentions "an α-amino acid".
Spell such a term out, as in `alpha-amino acid`. A label that is exactly
the term is found whatever it begins with.

Results come back in three tiers, and within a tier by source key, then
label, then entity IRI, so the same question returns the same order.

1. The label is the term.
2. The label contains the term at the start of a word.
3. Only the definition contains it at the start of a word.

## What is never returned

A source that is not cleared for public serving never grounds anything.
Clearance records that a licence permits the content to be passed on, and
no parameter lifts it.

Mirrored sources are left out by default for a second reason. The route
exists to serve MatSci-SAM, and returning its own vocabulary to it would be
circular. `includeMirror=1` lifts that exclusion but cannot lift the
clearance rule, so while the MatSci-SAM licence is undeclared the option
adds nothing, and the answer says so in a `note`.

## Errors

Every answer is JSON, errors included. A missing term, or a `limit` or
source key that is not valid, returns HTTP 400 with `{error}`. A store that
fails or misses the 12-second deadline returns HTTP 502, and a method other
than GET or HEAD returns HTTP 405.

## ChEBI and source provenance

ChEBI CORE release 254 supplies chemical definitions under CC BY 4.0.
`/grounding?q=water&sources=chebi&limit=1` returns the definition the
publisher gives for `CHEBI:15377`. Each result is the description from one
source, so its text, IRI, source key, version and licence stay together
even when PMDco describes the same IRI. Never combine the text of one
result with the version or licence of another.

To present a ChEBI definition, credit the source and version, and link the
entity and the [CC BY 4.0 licence](https://creativecommons.org/licenses/by/4.0/).
Definitions come from the snapshot with their text unchanged. The route
searches labels and definitions only, never synonyms.
