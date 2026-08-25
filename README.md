# MatSci-ONT

Reference ontology hub for materials science. MatSci-ONT holds versioned
snapshots of published materials-science ontologies in a Jena Fuseki TDB2
dataset and serves them through one read-only SPARQL endpoint and one MCP
server. It consumes ontologies that other groups publish. It does not
author them, and it does not mint identifiers for their entities.

The companion community metadata dictionary is
[MatSci-SAM](https://github.com/metadata-research/matsci-sam). The plan and
tracking document for this project is `MATSCI-ONT-PLAN.md` in the MatSci-SAM
internal documentation tree. Read it before working here. Decisions
recorded there are closed unless listed as open.

## Layout

| Directory | Content |
| --- | --- |
| `manifest/` | One JSON file per source, the record the store is built from |
| `pipeline/` | Ingestion and check scripts |
| `mcp/` | The application: browse pages, the MCP endpoint, and their queries |
| `deploy/` | Drafts of host material, reviewed copies land in the private ops repository |
| `docs/` | Project documentation |

## The manifest

The store is a pure function of the manifest. The store is disposable, is
never backed up, and is rebuilt from the manifest at any time. Each source
is one JSON file in `manifest/` with these fields:

| Field | Meaning |
| --- | --- |
| `key` | Short stable identifier, matches the file name |
| `kind` | `external-snapshot` or `matsci-sam-mirror` |
| `title` | Human-readable source name |
| `ontologyIri` | Canonical ontology IRI minted by the publisher |
| `graphIri` | Named graph the source loads into, normally the ontology IRI |
| `version` | Version label of the pinned release |
| `downloadUrl` | Immutable URL to a released artifact, never a branch |
| `sha256` | SHA-256 of the artifact bytes |
| `format` | `ttl`, `rdfxml`, `ntriples`, or `jsonld` |
| `license` | SPDX identifier |
| `republishable` | Whether serving the content publicly is permitted |
| `modules` | Optional list of pinned module URLs with their own hashes, each naming the `importIri` the main file imports |
| `reason` | Optional, false to skip OWL reasoning over the source |
| `importsToEmpty` | Optional list of import IRIs resolved to an empty ontology, for ontologies this manifest does not pin |
| `notes` | Optional free text |

Two rules are enforced, and the check script refuses an entry that breaks
either: every entry names a license and a hash, and content whose license
forbids republication never enters the public store.

## Building the store

```bash
pnpm check:manifest    # shape of every manifest entry
pnpm ingest            # fetch, verify, validate, load into build/tdb2
pnpm verify            # acceptance checks against the built store
pnpm verify:full       # the same, plus a second build compared to the first
pnpm test              # index precedence, comparison tiers, reasoning guards
pnpm serve             # serve the store locally on port 3031
```

The ingest fetches each pinned artifact into a content-addressed cache,
verifies its digest, validates it with `riot --validate`, and loads it with
`tdb2.tdbloader --graph=<graphIri>`. The build goes to `build/tdb2.new` and
is swapped into `build/tdb2` only when every source succeeds, so a failed
run leaves the previous store in place. `tools/`, `cache/`, and `build/` are
not tracked: the store is a function of the manifest and is rebuilt, never
backed up.

`riot --validate` exits zero on a warning, so an ill-typed literal would
otherwise enter the store unremarked. The ingest treats any warning as a
failure. A source that legitimately warns needs `"allowWarnings": true` in
its manifest entry, which records the decision next to the pin. None of the
current sources warn.

## The derived graphs

The ingest emits its own graphs after the sources load, all functions of
the manifest and the loaded content:

- **catalog**, one resource per source: title, canonical IRI, named graph,
  version, licence, download URL, digest, pinned modules, and triple count.
- **definitions**, one entry per named class, property or concept that
  carries a label: the chosen label and definition, which property each came
  from, and the source key, version and licence.
- **inferred/{key}**, one per reasoned source with a nonempty result: the
  class placements reasoning added. See below.

The catalogue also records what reasoning did for each source: the reasoner,
the number of pairs it added, the number it entailed in total, the inferred
graph, or the reason the source was not reasoned.

Entities keep the IRI their publisher minted. This index states its own
properties about them and never restates or re-licenses another publisher's
vocabulary. Only the catalogue resources and the small vocabulary under
`{base}vocab#` are minted here, where the base is `MATSCI_ONT_BASE_URL`.

Label precedence is `skos:prefLabel` then `rdfs:label`. Definition
precedence is `skos:definition`, then IAO 0000115, then the EMMO
elucidation property, then `rdfs:comment`. Within a property, English is
preferred, then any tagged language, then an untagged literal. An entity
with no label is skipped, because nothing could find it. An entity with a
label and no definition is kept: the NIST vocabulary is a term list with no
definitions at all, and it is 993 of the entries.

Nothing in either graph reads the clock. A wall-clock stamp would make two
builds of one manifest differ, so the ingest time is recorded in
`build/ingest-report.json`, which is not part of the store.

## Reasoning

`pnpm ingest` reasons over every source the manifest does not exclude, using
ROBOT with HermiT on the pinned Java. Reasoning runs here, on a workstation,
and never on a host.

The reasoner entails everything a source asserts, so most of what it returns
is a restatement. An inferred graph keeps only what reasoning added: pairs
the sources do not already state. That is what lets a page mark a placement
as inferred and be right. Of the 1,581 pairs PMDco entails, 1,466 are
already asserted and 115 are new. CHAMEO adds 2, and would add far more
with the EMMO ontologies it imports, which this manifest does not yet pin.
MDO adds none.

Imports are never fetched. A module the manifest pins is named by its
`importIri` and mapped to the pinned file. An import to an ontology this
manifest does not hold is mapped to an empty one, which also drops the
import declaration from the reasoner output. Every reasoner run carries
proxy settings pointing at a closed port, so an attempt to resolve anything
else fails at once rather than becoming a dependency nobody recorded. An
inconsistent ontology fails the build.

## Comparing two builds

`pnpm verify:full` builds the store a second time and compares the two in
three tiers, because TDB2 directories are not byte-stable and blank node
labels are minted per parser run:

| Tier | Check | Catches |
| --- | --- | --- |
| 1 | per-graph quad counts | a graph that gained or lost content |
| 2 | blank-node-blinded sorted hash | a changed value anywhere, including inside a blank node |
| 3 | per-graph `rdfcompare` isomorphism | everything above, plus blank node topology |

Tier 3 is the gate. The weaker tiers are kept because they localize a
failure cheaply, not because they are sufficient: in these ontologies the
axioms are inside blank nodes, so an `owl:minCardinality` that changed from
2 to 3 keeps every count identical, and a blank node topology swap keeps the
blinded hash identical. `pnpm test:compare` builds both of those cases and
asserts which tier catches each, so a regression in the comparison shows up
as a failing test rather than as checks that pass on everything.

Port 3031 is the default because port 3030 is the local MatSci-SAM store on
a workstation that runs both. In production the two are one Fuseki process
serving two datasets.

`pnpm dev` starts the store and the application together. The application
is at `http://localhost:3100/`: catalogue, class hierarchies,
entity pages with verbalized OWL axioms, word-boundary search, and a
Cytoscape graph view. [The browsing guide](docs/guide/browsing.md)
describes the pages. The same process answers the Model Context Protocol at
`/mcp`, described in [the MCP guide](docs/guide/mcp.md), so an AI client can
query the ontologies directly. The web UI and the admin API of Fuseki are both
closed, as they are on the hosts, because the admin API takes no
credential and will create a dataset on request. `pnpm verify` asserts
they stay closed.

```bash
curl -G http://localhost:3031/matsci-ont/query \
  --data-urlencode 'query=SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }' \
  -H 'Accept: application/sparql-results+json'
```

## Versions

Node and pnpm are pinned in `.nvmrc` and `package.json`, matching the
MatSci-SAM hosts. The Jena tools and a Java 21 runtime are pinned in
`pipeline/tools.json` and installed into `tools/` on first use, with the
digest verified before extraction. Jena 6.2.0 requires Java 21. The Jena
version matches, and the Fuseki tarball digest equals, the reviewed host
pins in `matsci-ops/deploy/runtime-versions.env`.
