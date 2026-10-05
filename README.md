# MatSci-ONT

MatSci-ONT is a reference ontology hub for materials science. It holds
versioned snapshots of published materials-science ontologies in a Jena
Fuseki TDB2 store and serves them through a read-only SPARQL endpoint, a
browse application, JSON routes for grounding, term lookup and hierarchy
previews, and a Model Context Protocol (MCP) endpoint. It consumes
ontologies that other groups publish. It does not author them, and it does
not mint identifiers for their entities.

The companion community metadata dictionary is
[MatSci-SAM](https://github.com/metadata-research/matsci-sam). Project
plans and state live in private documentation outside this repository, and
`CLAUDE.md` says where to find it.

## Layout

| Directory   | Content                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `manifest/` | One JSON file per source, the input the store is built from                                   |
| `pipeline/` | Ingestion, reasoning and verification, which build and check the store                        |
| `app/`      | The browse pages, JSON routes and MCP endpoint that serve the store                           |
| `shared/`   | Identifiers, paths, pinned tools and the query loader, which both layers use                  |
| `deploy/`   | The Fuseki configuration template for the local store                                         |
| `docs/`     | The architecture, user guides in `docs/guide/` and dated research records in `docs/research/` |

`app/` never imports `pipeline/`, `shared/` imports neither, and ESLint
enforces both rules. `docs/architecture.md` explains why and describes how
the code is arranged.

## Building the store

```bash
pnpm install           # Node dependencies
pnpm check:manifest    # check every manifest entry
pnpm ingest            # fetch, verify, validate, reason and load into build/tdb2
pnpm verify            # acceptance checks against the built store
pnpm verify:full       # the same, plus a second build compared with the first
pnpm test:pure         # the suites CI runs, needing neither Java nor a store
pnpm test              # those plus the suites needing Java, one of them a built store
pnpm serve             # serve the store alone on port 3031
pnpm dev               # serve the store and the application together
```

The first build downloads the pinned Java runtime, Jena tools and ROBOT
into `tools/`. The ingest fetches each pinned artifact into a
content-addressed cache in `cache/`, verifies its digest, validates it with
`riot --validate`, and loads it with `tdb2.tdbloader --graph=<graphIri>`.
It builds into `build/tdb2.new` and replaces `build/tdb2` only when every
source succeeds, so a failed run leaves the previous store in place.

`riot --validate` exits zero on a warning, so the ingest treats any warning
as a failure, and an ill-typed literal cannot enter the store unremarked. A
source that legitimately warns needs `"allowWarnings": true` in its
manifest entry, which records the decision next to the pin. No current
source needs it.

`pnpm ingest` takes the following options.

| Option           | Effect                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| `--publication`  | Leave out every source not cleared for public serving                                   |
| `--only=key,key` | Load only the named sources, without reasoning or derived graphs, into `build/tdb2.new` |
| `--no-reason`    | Skip reasoning                                                                          |
| `--keep-going`   | Continue past a failed source so that every failure is reported                         |
| `--no-swap`      | Build everything and leave the result in `build/tdb2.new`                               |
| `--reuse-mirror` | Load the mirrored documents an earlier run fetched                                      |

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

The rules live in `pipeline/lib/manifest.mjs`, and `pnpm check:manifest`
and `pnpm ingest` both apply them, so the check and the build accept the
same entries. Every entry names a licence. A pinned source names a version
and a digest, and a mirror names neither. `republishable` cannot be true
while the licence is `UNDECLARED`. Across entries, no two sources may share
a graph. Every `importsFrom` must name another pinned entry whose artifacts
all carry import IRIs, and a cleared source may not name one that a
publication build leaves out.

A mirror is the one kind of source declared to be moving. The ingest
fetches it on every build and validates the fetched document before it
replaces the cached copy. A failed fetch keeps the previous copy and the
build continues. When there is no previous copy, the build fails.

`republishable` records whether a source is cleared for public serving. A
source that is not cleared still loads on a workstation, where the operator
is the only reader. `pnpm ingest --publication` leaves it out and builds
the rest, which is the store a host receives. `build/ingest-report.json`
records which kind of store was built, and `pnpm verify` judges the store
against that report.

## The derived graphs

After the sources load, the ingest derives these graphs from the manifest
and the loaded content.

| Graph            | Content                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog`        | One resource per source with its title, canonical IRI, named graph, version, licence, download URL, digest, pinned modules and triple count                              |
| `definitions`    | One description record per source and labelled entity, with the chosen label and definition, the property each came from, and the key, version and licence of the source |
| `inferred/{key}` | The class placements reasoning added, for each reasoned source with a nonempty result                                                                                    |

The catalogue also records what reasoning did for each source, namely the
reasoner, the number of pairs it added, the number it entailed in total and
the inferred graph, or the reason the source was not reasoned.

Entities keep the IRI their publisher minted, and the derived index does
not re-license publisher content. MatSci-ONT mints IRIs only for what it
derives, under the base `MATSCI_ONT_BASE_URL`, namely the derived graphs,
the catalogue resources, the description records and a small vocabulary
under `{base}vocab#`. A description record is named
`{base}entries/{sourceKey}/{sha256(entityIri)}` and points to the publisher
IRI with `ont:entity`. When two sources describe one IRI, as ChEBI and
PMDco do, each source has its own record with its own label, definition,
version and licence, and `docs/architecture.md` explains why queries join
on the record. The application queries depend on this format, so an
application must be deployed with a store built from the same revision.

Label precedence is `skos:prefLabel`, then `rdfs:label`. Definition
precedence is `skos:definition`, then IAO 0000115, then the EMMO
elucidation property, then `rdfs:comment`. Within a property the index
prefers an `en` literal, then a regional English tag, then an untagged
literal, then any other language. An entity with no label is skipped,
because nothing could find it. An entity with a label and no definition is
kept, since the NIST vocabulary has no definitions at all and supplies 993
of the entries.

Nothing in the derived graphs reads the clock, because a timestamp would
make two builds of one manifest differ. The ingest time goes to
`build/ingest-report.json`, which is not part of the store.

## Reasoning

`pnpm ingest` reasons over every pinned source not marked `reason: false`,
with HermiT through ROBOT on the pinned Java runtime. Mirrors are never
reasoned. The reasoner runs on a workstation and never on a host.

The reasoner entails everything a source asserts, so most of its output
restates the source. An inferred graph keeps only the pairs that no loaded
source asserts, which lets a page mark a placement as inferred and be
right. PMDco entails 1,581 pairs, of which 1,466 are already asserted and
115 are new. CHAMEO, reasoned against the pinned EMMO closure, entails 2,137
and adds 86, where before the closure was pinned it added 2 of 211. EMMO
itself adds 82 of 1,924, and MDO adds none of 13. Each inferred graph stands
alone, and the inferred view of CHAMEO needs the derived EMMO placements its
ancestors sit on, so all 82 new EMMO pairs also appear among the 86 for
CHAMEO, which contributes 4 pairs of its own. `pipeline/fixtures.json`
records these counts, and `pnpm verify` checks them.

A source can also reason through the pins of another entry. `importsFrom`
adds the pinned files of the named entries to the reasoning catalog without
loading them into the graph of the referencing source. CHAMEO reasons over
the full EMMO closure this way while its own graph holds only `chameo.ttl`.

Imports are never fetched. A module the manifest pins is named by its
`importIri` and mapped to the pinned file. An import listed in
`importsToEmpty` is mapped to an empty ontology, which also drops the
import declaration from the reasoner output. Every reasoner run carries
proxy settings that point at a closed port, so any other import fails at
once and cannot become a dependency nobody recorded. A nonzero exit from
ROBOT, for an inconsistent ontology or an unresolvable import, fails the
build.

## The MatSci-SAM mirror

MatSci-ONT mirrors the five graph documents that
[MatSci-SAM](https://ego.cci.drexel.edu) publishes, so one query can reach a
community vocabulary term and a formal ontology class together.
`pnpm verify` counts the vocabulary terms whose label matches an entry in
another source.

MatSci-SAM is the source of record. Source pages, entity pages and graph
views of mirrored content carry a banner that says so and gives the date
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
MatSci-SAM term can carry rival definitions. The index takes the definition
with the most settled status (stable, then community-reviewed, then
proposed) and, among equals, the lowest revision number. It records how
many rivals there were, so the choice is visible.

## ChEBI CORE

The `chebi` source pins archived release 254 of ChEBI CORE, published under
[CC BY 4.0](https://www.ebi.ac.uk/chebi/about). CORE keeps definitions and
the hierarchy, LITE omits definitions, and FULL adds synonyms and curated
cross-references. The source contributes 3,382,033 triples and 218,444
description records with their publisher IRIs unchanged. It loads with its
asserted hierarchy and is not reasoned.

The browse views of a source this large start from its roots and a bounded
graph overview, and search, entity pages and SPARQL reach the full content.
The [browsing guide](docs/guide/browsing.md) describes these views, and the
[release record](docs/research/chebi-core-254-2026-09-19.md) holds the
evidence for the pin.

## Comparing two builds

`pnpm verify:full` builds the store a second time and compares the two in
three tiers. TDB2 directories are not byte-stable and blank node labels are
minted per parser run, so neither the bytes nor the labels can be compared.

| Tier | Check                              | Catches                                                 |
| ---- | ---------------------------------- | ------------------------------------------------------- |
| 1    | per-graph quad counts              | a graph that gained or lost content                     |
| 2    | blank-node-blinded sorted hash     | a changed value anywhere, including inside a blank node |
| 3    | per-graph `rdfcompare` isomorphism | everything above, plus blank node topology              |

The comparison spools each export to a temporary file, blinds it one line
at a time and sorts it on disk with GNU `sort` and a 64 MiB buffer, so no
database dump is held in memory. Tier 3 still needs memory for the Jena
graph comparison, and the run needs temporary disk space for several
exports. A publication store is rebuilt with the same exclusions.

The second build reuses the mirrored documents the first one fetched. When
the cache holds mirrored documents newer than the store, the comparison
also reports the store as stale, so the difference is not mistaken for
non-determinism.

Tier 3 is the gate. The weaker tiers localize a failure cheaply but cannot
settle it, because the axioms in these ontologies sit inside blank nodes.
An `owl:minCardinality` changed from 2 to 3 keeps every count identical,
and a swap of blank node topology keeps the blinded hash identical.
`pnpm test:compare` builds both cases and asserts which tier catches each,
so a regression in the comparison fails a test.

## Running the application

`pnpm dev` starts the store on port 3031 and the application on port 3100.
The store avoids port 3030, which the MatSci-SAM store uses on a
workstation that runs both. On a host the two stores are one Fuseki process
serving two datasets.

| Path                                                       | Serves                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/`, `/source/{key}`, `/entity`, `/search`, `/graph/{key}` | The browse pages, described in the [browsing guide](docs/guide/browsing.md)                                 |
| `/graph/{key}.json`                                        | The nodes and edges the graph view draws, as JSON                                                           |
| `/grounding`                                               | Definition text for a term, described in the [grounding guide](docs/guide/grounding.md)                     |
| `/candidates`, `/hierarchy`                                | Term lookup and direct parents, described in the [hierarchy preview guide](docs/guide/hierarchy-preview.md) |
| `/lookup-status`                                           | The state of the lookup index, described below                                                              |
| `/mcp`                                                     | The MCP endpoint, described in the [MCP guide](docs/guide/mcp.md)                                           |

The application listens on 127.0.0.1 and answers only GET and HEAD, apart
from POST on `/mcp`. Fuseki runs without its web UI and admin API, as on
the hosts, because the admin API takes no credential and will create a
dataset on request. Federated `SERVICE` queries are disabled. `pnpm verify`
checks the loopback binding, the closed admin API and the refused `SERVICE`
clause.

```bash
curl -G http://localhost:3031/matsci-ont/query \
  --data-urlencode 'query=SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }' \
  -H 'Accept: application/sparql-results+json'
```

## The lookup index

The `/grounding` and `/candidates` routes match a term against every label,
and grounding against every definition too. A regular expression cannot
use a TDB2 index, so in SPARQL each lookup reads every description. The
application holds the descriptions of the cleared sources in memory and
answers lookups from there. The SPARQL queries remain the reference, and
`pnpm verify` compares the two paths on the built store.

The application loads the index in a worker thread when it starts. While
the index is ready, the application reads the catalogue every 30 seconds
and loads the index again when the store has changed. A load takes some
seconds, and longer on a busy host. During a load, one lookup at a time
goes to SPARQL at once. The others wait for the index for at most a
quarter of the time left before their deadline and then use SPARQL in the
rest, so a load longer than a deadline does not make them fail. A term
containing a capital sigma (Σ) always goes to SPARQL, because Java
lowercases that letter by a rule the index does not reproduce.

A load that fails because the store stopped a query or could not be
reached is tried again by a timer after 30 seconds, then 60, then every 2
minutes, so the index recovers on a host that receives no lookups. A load
that meets data the index cannot hold, or that needs more than 192 MB, is
abandoned, and lookups stay on SPARQL until the store changes. The memory
budget limits the size of the index, since the load reads the store in
pages that keep each query short. The budget holds about 500,000
descriptions, a little over twice the current store, and a larger store
needs the budget and the memory limits of the service raised together.
Each load writes one line to standard error with the entries, the time
taken, the size of the index, the memory the load needed, and the number of
pages with the slowest of them.

`GET /lookup-status` reports the state of the index (`ready`, `loading`,
`failed`, `abandoned` or `off`) with its entries and sources, when it
loaded, how long the load took, and when a failed load is tried again. It
answers from memory without querying the store, so an installer or a health
check can poll it during a load. A failure appears as a fixed phrase for
its kind, and the answer holds no address, path or setting, so the route
may be served publicly.

Set `MATSCI_ONT_LOOKUP_INDEX=off` to answer every lookup with SPARQL.
`docs/architecture.md` describes how a load reads the store in pages and
checks them.

## Configuration

The build and the application read these environment variables.

| Variable                  | Default                                  | Effect                                                                                                 |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `MATSCI_ONT_BASE_URL`     | `https://ego.cci.drexel.edu/ont/`        | Base of the IRIs MatSci-ONT mints; the build and the application must agree                            |
| `MATSCI_ONT_FUSEKI_PORT`  | `3031`                                   | Port of the Fuseki that `pnpm serve`, `pnpm dev` and `pnpm verify` start, and of the default query URL |
| `MATSCI_ONT_QUERY_URL`    | `http://127.0.0.1:3031/matsci-ont/query` | SPARQL endpoint the application queries                                                                |
| `MATSCI_ONT_APP_PORT`     | `3100`                                   | Port of the application                                                                                |
| `MATSCI_ONT_BASE_PATH`    | empty                                    | Path prefix for links and asset URLs, when a proxy serves the application under a path and strips it   |
| `MATSCI_ONT_LOOKUP_INDEX` | on                                       | `off` answers every lookup with SPARQL                                                                 |

## Versions

Node and pnpm are pinned in `.nvmrc` and `package.json`, matching the
MatSci-SAM hosts. The Jena tools, Fuseki, ROBOT and a Java 21 runtime are
pinned in `shared/tools.json` and installed into `tools/` on first use,
each checked against its digest before use. Jena 6.2.0 requires Java 21.
The Jena version and the Fuseki tarball digest match the reviewed host pins
in `matsci-ops/deploy/runtime-versions.env`.
