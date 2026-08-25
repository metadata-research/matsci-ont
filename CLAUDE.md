# Working in this repository

MatSci-ONT holds versioned snapshots of published materials-science
ontologies in a Jena Fuseki TDB2 store and serves them over a read-only
SPARQL endpoint, a browse application, a grounding route and an MCP
endpoint. It consumes ontologies other groups publish; it does not author
them and it does not mint identifiers for their entities.

Read `README.md` for how to build and run it, and `docs/architecture.md`
for how the code is arranged and why. Read those before making a structural
change: the layering below is enforced, so a violation fails the build.

## The layering

```
pipeline/  builds the store        ─┐
                                    ├─→  shared/   what both need
app/       serves the store        ─┘
```

`app/` must not import `pipeline/`, and `shared/` must import neither.
ESLint enforces both. The reason is deployment: a host that serves the store
has no Jena, no ROBOT, no manifest and no build toolchain, so an import
reaching from `app/` into `pipeline/` would drag all of it into a process
whose only job is answering requests. `pipeline/` may import `app/`, and
verification does, because it checks the pages the application renders.

## The store is a pure function of the manifest

`manifest/*.json` is the input and `build/tdb2` is the output. Nothing is
edited in the store and nothing survives a rebuild, so it is disposable and
is never backed up. A fix belongs in the manifest or the pipeline, never in
the store. Two builds from one manifest must be isomorphic graph for graph,
which `pnpm verify:full` checks.

## Queries are files

Every SPARQL query is a `.rq` file — `app/queries/` for the application,
`pipeline/queries/` for verification — loaded by `shared/queries.mjs`, which
fills `@@TOKEN@@` placeholders in a single pass over the template.

The single pass is a security property. Substituting token by token let a
value inserted early be read as a template for a later token, which is how a
caller's search term once escaped its literal and became part of the query.
Caller input reaches a query only through the guards in `app/lib/terms.mjs`.

## Before you run anything

**Port 3030 belongs to another project.** It is a long-running Fuseki
serving the MatSci-SAM store, managed as a systemd `--user` unit. This
project uses 3031 for Fuseki and 3100 for the application.

**Never `pkill` by a Java or Fuseki pattern.** Both projects launch Fuseki
through the same entry point, so a pattern like `FusekiMainCmd --config`
matches both and has killed the other project's store before. Stop a server
by the PID of the child that was spawned, or match its port or config path.

**System Java is too old.** Jena 6.2.0 needs Java 21. The pipeline uses a
pinned Temurin JRE that `shared/tools.mjs` downloads and digest-verifies
into the git-ignored `tools/`, from the pins in `shared/tools.json`. A fresh
clone re-downloads several hundred megabytes before the first build.

**Cheap and expensive scripts.** `pnpm check:manifest`, `lint`,
`format:check` and `test:pure` need neither Java nor a store, and are what
CI runs on every push. `pnpm test` adds the suites needing the real Jena and
ROBOT jars. `pnpm verify` needs a built store; `pnpm ingest` needs Java and
network access.

## No network at build time

Sources are pinned by URL and SHA-256 and resolved from the cache. Nothing
resolves an `owl:imports` over the network: every import is either pinned in
the manifest or mapped to the empty ontology, ROBOT runs behind a dead-proxy
guard, and `SERVICE` is disabled on the endpoint. A build that cannot find a
pinned artifact fails rather than fetching a substitute.

## Planning and project state

The phase model, the decisions already closed, and the rolling record of
what is built are not in this repository. They live in the group's private
documentation tree, mirrored to `docs-internal/` for those who have it,
which is git-ignored. If that folder is present, read `docs-internal/`
first; if it is not, this file, `README.md` and `docs/architecture.md` are
the complete public picture.
