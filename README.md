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
| `mcp/` | The MCP server (Phase 3) |
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
| `modules` | Optional list of pinned module URLs with their own hashes |
| `notes` | Optional free text |

Two rules are enforced, and the check script refuses an entry that breaks
either: every entry names a license and a hash, and content whose license
forbids republication never enters the public store.

## Checks

```bash
pnpm check:manifest
```

Node and pnpm versions are pinned in `.nvmrc` and `package.json`, matching
the MatSci-SAM hosts. The Jena tools used by the pipeline are pinned in
`matsci-ops/deploy/runtime-versions.env`.
