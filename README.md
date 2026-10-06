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
plans and state are in private documentation outside this repository, and
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
enforces both rules.

## Building the store

```bash
pnpm install           # Node dependencies
pnpm check:manifest    # check every manifest entry
pnpm ingest            # fetch, verify, validate, reason and load into build/tdb2
pnpm verify            # acceptance checks against the built store
pnpm verify:full       # the same, plus a second build compared with the first
pnpm test:pure         # the suites CI runs, needing neither Java nor a store
pnpm test              # those plus the suites needing Java, one of them a built store
```

The first build downloads the pinned Java runtime, Jena tools and ROBOT
into `tools/`, several hundred megabytes, and fetches every pinned source
into `cache/`, of which ChEBI CORE alone is about 363 MB. Later builds work
from the cache, apart from the MatSci-SAM mirror, which is fetched on every
build. A build replaces `build/tdb2` only when every source succeeds.

Each source is one JSON file in `manifest/`, pinned by URL and SHA-256
unless it is a mirror.
[Sources and the manifest](docs/sources.md) describes the entry format and
its rules, and [Building the store](docs/build.md) describes the ingest
options, the derived graphs, reasoning and the comparison of two builds.

## Running the application

```bash
pnpm serve             # serve the store alone on port 3031
pnpm dev               # serve the store on 3031 and the application on 3100
```

The store avoids port 3030, which the MatSci-SAM store uses on a
workstation that runs both. On a host the two stores are one Fuseki process
serving two datasets.

| Path                                                       | Serves                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/`, `/source/{key}`, `/entity`, `/search`, `/graph/{key}` | The browse pages, described in the [browsing guide](docs/guide/browsing.md)                                 |
| `/graph/{key}.json`                                        | The nodes and edges the graph view draws, as JSON                                                           |
| `/grounding`                                               | Definition text for a term, described in the [grounding guide](docs/guide/grounding.md)                     |
| `/candidates`, `/hierarchy`                                | Term lookup and direct parents, described in the [hierarchy preview guide](docs/guide/hierarchy-preview.md) |
| `/lookup-status`                                           | The state of the in-memory lookup index                                                                     |
| `/mcp`                                                     | The MCP endpoint, described in the [MCP guide](docs/guide/mcp.md)                                           |

The application listens on 127.0.0.1 and answers only GET and HEAD, apart
from POST on `/mcp`. Fuseki runs without its web UI and admin API, as on
the hosts, because the admin API takes no credential and will create a
dataset on request. Federated `SERVICE` queries are disabled. `pnpm verify`
checks the loopback binding, the closed admin API and the refused `SERVICE`
clause.

The grounding and lookup routes answer from an index of labels and
definitions that the application loads from the store into memory at
start. While the index loads, and always when
`MATSCI_ONT_LOOKUP_INDEX=off`, they fall back to SPARQL. The
[architecture](docs/architecture.md#the-lookup-index-is-a-cache-of-the-store)
describes how the index loads, recovers and reports its state.

The SPARQL endpoint answers directly.

```bash
curl -G http://localhost:3031/matsci-ont/query \
  --data-urlencode 'query=SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }' \
  -H 'Accept: application/sparql-results+json'
```

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
MatSci-SAM hosts. The Jena tools,
Fuseki, ROBOT and a Java 21 runtime are pinned in `shared/tools.json` and
installed into `tools/` on first use, each checked against its digest.
Jena 6.2.0 requires Java 21. The
Jena version and the Fuseki digest match the reviewed host pins in
`matsci-ops/deploy/runtime-versions.env`.

## Documentation

| Document                                                   | For                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)                       | How the code is arranged and why, including the lookup index           |
| [Sources and the manifest](docs/sources.md)                | Adding or changing a source, cleared sources, notes on current sources |
| [Building the store](docs/build.md)                        | The ingest, the derived graphs, reasoning and the build comparison     |
| [Browsing guide](docs/guide/browsing.md)                   | Using the browse pages and the graph view                              |
| [Grounding guide](docs/guide/grounding.md)                 | Fetching definition text for a term                                    |
| [Hierarchy preview guide](docs/guide/hierarchy-preview.md) | Term lookup and direct parents                                         |
| [MCP guide](docs/guide/mcp.md)                             | Connecting an MCP client                                               |
| `docs/research/`                                           | Dated studies kept as evidence for decisions                           |
