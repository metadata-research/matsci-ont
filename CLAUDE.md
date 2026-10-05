# Working in this repository

MatSci-ONT holds versioned snapshots of published materials-science
ontologies in a Jena Fuseki TDB2 store and serves them over a read-only
SPARQL endpoint, a browse application, JSON lookup routes and an MCP
endpoint. It consumes ontologies other groups publish. It does not author
them and it does not mint identifiers for their entities.

Read `README.md` for how to build and run it, `docs/architecture.md` for
how the code is arranged and why, and `docs/build.md` and `docs/sources.md`
for the pipeline and the manifest. Read the README and the architecture
before a structural change, because the build enforces the layering below.

## The layering

```
pipeline/  builds the store        ─┐
                                    ├─→  shared/   what both need
app/       serves the store        ─┘
```

`app/` must not import `pipeline/`, and `shared/` must import neither.
ESLint enforces both. A host that serves the store has no Jena, no ROBOT,
no manifest and no build toolchain, so an import from `app/` into
`pipeline/` would drag all of it into a process whose only job is answering
requests. `pipeline/` may import `app/`, and verification does so to check
the pages the application renders.

## The store is a pure function of the manifest

`manifest/*.json` is the input and `build/tdb2` is the output. Nothing
edits the store, nothing survives a rebuild and nothing backs it up, so a
fix belongs in the manifest or the pipeline. Two builds from one manifest
must be isomorphic graph for graph, which `pnpm verify:full` checks.

## Queries are files

Every SPARQL query is a `.rq` file, in `app/queries/` for the application
and `pipeline/queries/` for verification. `shared/queries.mjs` loads them
and fills `@@TOKEN@@` placeholders in a single pass over the template.

Keep it a single pass, which is a security property. Substitution token by
token once let a search term inserted early be read as a template for a
later token, and the term escaped its literal into the query. Caller input
reaches a query only through the guards in `app/lib/terms.mjs`.

## Before you run anything

### Port 3030 belongs to another project

A long-running Fuseki serving the MatSci-SAM store listens on 3030, managed
as a systemd `--user` unit. This project uses 3031 for Fuseki and 3100 for
the application, and verification and the integration tests start further
servers on ports 3195 to 3199.

### Never `pkill` by a Java or Fuseki pattern

Both projects launch Fuseki through the same entry point, so a pattern like
`FusekiMainCmd --config` matches both and has killed the MatSci-SAM store
before. Stop a server by the PID of the child that was spawned, or match
its port or config path.

### System Java is too old

Jena 6.2.0 needs Java 21. `shared/tools.mjs` downloads a pinned Temurin
JRE, the Jena tools, Fuseki and ROBOT from the pins in `shared/tools.json`,
verifies their digests and installs them into the git-ignored `tools/`. A
fresh clone downloads several hundred megabytes of tools before the first
build, and the first build fetches the pinned sources, of which ChEBI CORE
alone is about 363 MB.

### Cheap and expensive scripts

`pnpm check:manifest`, `lint`, `format:check` and `test:pure` need neither
Java nor a store, and CI runs them on every push and pull request.
`pnpm test` adds the suites that need the pinned Java tools, and its MCP
suite (`app/test-mcp.mjs`) also needs a built store. `pnpm ingest` needs
Java, and network access for the first fetch of each pinned file and for
the mirrors. `pnpm verify` needs Java and a built store.

## What a build may fetch

Sources are pinned by URL and SHA-256 and fetched once into a
content-addressed cache. The MatSci-SAM mirrors are the one declared
exception, fetched fresh on each build. A pinned file whose digest does not
match fails the build, and nothing fetches a substitute.

Nothing resolves an `owl:imports` over the network. Every import is either
pinned in the manifest or mapped to the empty ontology, and ROBOT runs
behind a dead-proxy guard. `SERVICE` is disabled on the endpoint.

## Planning and project state

The phase model, the decisions already closed and the rolling record of
what is built are in private documentation of the research group, mirrored
to the git-ignored `docs-internal/` for those who have it. If that folder
is present, read `docs-internal/` first. If it is not, this file,
`README.md` and `docs/` are the complete public picture.
