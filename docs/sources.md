# Sources and the manifest

How a source enters the store, for someone adding a source or changing a
pin. [Building the store](build.md) covers what the ingest does with an
entry once it is accepted.

## The manifest

The store is a pure function of the manifest. Nothing is edited in the
store and nothing survives a rebuild, so `build/`, like `cache/` and
`tools/`, is untracked and never backed up. Each source is one JSON file in
`manifest/`.

| Field            | Presence    | Meaning                                                                                                    |
| ---------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `key`            | every entry | Short stable identifier, the file name without `.json`                                                     |
| `kind`           | every entry | `external-snapshot` for a pinned ontology, `matsci-sam-mirror` for a mirrored dataset                      |
| `title`          | every entry | Human-readable name                                                                                        |
| `graphIri`       | every entry | Named graph the source loads into, normally the ontology IRI                                               |
| `format`         | every entry | `ttl`, `rdfxml`, `ntriples` or `jsonld`                                                                    |
| `license`        | every entry | SPDX identifier, or `UNDECLARED` when the publisher has stated none                                        |
| `republishable`  | every entry | Whether the content may be served publicly                                                                 |
| `ontologyIri`    | pinned only | Canonical ontology IRI minted by the publisher                                                             |
| `version`        | pinned only | Version label of the pinned release                                                                        |
| `downloadUrl`    | pinned only | https URL of the released artifact at a release, tag or commit, never a branch                             |
| `sha256`         | pinned only | SHA-256 of the artifact bytes                                                                              |
| `fetchUrl`       | mirror only | https URL fetched on every build                                                                           |
| `sourceDataset`  | mirror only | IRI of the mirrored dataset                                                                                |
| `authorityBase`  | mirror only | https base under which a mirrored entity resolves at its publisher                                         |
| `modules`        | optional    | Further pinned files, each with `url`, `sha256` and the `importIri` the reasoning catalog maps to it       |
| `importIri`      | optional    | Import IRI of the main file, for when another module or entry imports it                                   |
| `importsFrom`    | optional    | Keys of entries whose pinned files join the reasoning catalog of this entry without loading into its graph |
| `importsToEmpty` | optional    | Import IRIs resolved to the empty ontology, for ontologies the manifest does not pin                       |
| `reason`         | optional    | `false` skips OWL reasoning                                                                                |
| `allowWarnings`  | optional    | `true` accepts warnings from `riot --validate`                                                             |
| `notes`          | optional    | Free text                                                                                                  |

The rules are in `pipeline/lib/manifest.mjs`, and `pnpm check:manifest` and
`pnpm ingest` both apply them, so the check and the build accept the same
entries. Every entry names a licence. A pinned source names a version and a
digest, and a mirror names neither. `republishable` cannot be true while
the licence is `UNDECLARED`. Across entries, no two sources may share a
graph. Every `importsFrom` must name another pinned entry whose artifacts
all have import IRIs, and a cleared source may not name one that a
publication build leaves out.

A mirror is the one kind of source declared to be moving. The ingest
fetches it on every build and validates the fetched document before it
replaces the cached copy. A failed fetch keeps the previous copy and the
build continues. When there is no previous copy, the build fails.

## Cleared sources and publication builds

`republishable` records whether a source is cleared for public serving. A
source that is not cleared still loads on a workstation, where the operator
is the only reader. `pnpm ingest --publication` leaves it out and builds
the rest, which is the store a host receives. `build/ingest-report.json`
records which kind of store was built, and `pnpm verify` judges the store
against that report.

## The MatSci-SAM mirror

MatSci-ONT mirrors the five graph documents that
[MatSci-SAM](https://ego.cci.drexel.edu) publishes, so one query can reach a
community vocabulary term and a formal ontology class together.
`pnpm verify` counts the vocabulary terms whose label matches an entry in
another source.

MatSci-SAM is the source of record. Source pages, entity pages and graph
views of mirrored content show a banner that says so and gives the date
MatSci-SAM last projected the dataset. An entity page links to the
authoritative page, and search results name the mirrored source and its
licence.

MatSci-SAM has not chosen a licence for its content and records the choice
as open until public launch. The mirror therefore states its licence as
`UNDECLARED` and is not cleared for public serving. It loads on a
workstation, and a publication build leaves it out. When MatSci-SAM
publishes a licence, each mirror entry needs only its `license` and
`republishable` fields changed.

A mirrored term keeps each definition behind a revision node, and a
MatSci-SAM term can have rival definitions. The index takes the definition
with the most settled status, in the order stable, community-reviewed and
proposed, and among equals the lowest revision number. It records how many
rivals there were, so the choice is visible.

## ChEBI CORE

The `chebi` source pins archived release 254 of ChEBI CORE, published under
[CC BY 4.0](https://www.ebi.ac.uk/chebi/about). CORE keeps definitions and
the hierarchy, LITE omits definitions, and FULL adds synonyms and curated
cross-references. The source contributes 3,382,033 triples and 218,444
description records with their publisher IRIs unchanged. It loads with its
asserted hierarchy and is not reasoned.

The browse views of a source this large start from its roots and a bounded
graph overview, and search, entity pages and SPARQL reach the full content.
The [browsing guide](guide/browsing.md) describes these views, and the
[release record](research/chebi-core-254-2026-09-19.md) holds the evidence
for the pin.
