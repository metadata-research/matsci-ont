# Architecture

How the code is arranged and why. This is for someone about to change it;
`README.md` covers running it, and `docs/guide/` covers using it.

## Three layers

```
pipeline/  builds the store        ─┐
                                    ├─→  shared/   what both need
app/       serves the store        ─┘
```

The layering is a rule, not a convention: `eslint.config.mjs` forbids
`app/**` from importing `pipeline/**`, and forbids `shared/**` from
importing either. The reason is deployment. A host that serves the store
runs `app/` against a store built somewhere else, and it has no Jena, no ROBOT,
no manifest and no network policy to enforce. An import reaching from `app/`
into `pipeline/` would drag the whole build toolchain into a process whose
job is to answer HTTP requests, and it would do so silently until the host
was built without the tools.

`pipeline/` may import `app/`, and verification does, because it checks the
rendered pages, and because refusing it would mean maintaining a second copy
of the escaping rules to check the first one against.

`shared/` holds what genuinely belongs to both: the identifiers this project
mints (`vocabulary.mjs`), where things are on disk (`paths.mjs`), how to
reach the store (`endpoint.mjs`), the external tools (`tools.mjs`,
`fuseki.mjs`), and the SPARQL loader (`queries.mjs`). It imports from
neither side. `vocabulary.mjs` exists because the graph IRIs were being
minted in the build and re-derived by string concatenation in the
application, which is the kind of agreement that holds until it does not.

## The store is a function of the manifest

`manifest/*.json` is the input and `build/tdb2` is the output. Nothing is
edited in the store and nothing is preserved from a previous build, so the
store is disposable and is never backed up: if it is wrong, it is rebuilt.
This is what makes the determinism check meaningful, because two builds from
one manifest must be isomorphic graph for graph, and it is why a fix belongs
in the manifest or the pipeline, never in the store.

The rules that decide what may enter live in `pipeline/lib/manifest.mjs`,
which both `pnpm ingest` and `pnpm check:manifest` apply. They were once
inside the checking script alone, which meant the build did not enforce
them.

## Queries are files

Every SPARQL query is a `.rq` file: `app/queries/` for the application,
`pipeline/queries/` for verification. `shared/queries.mjs` loads them and
fills `@@TOKEN@@` placeholders in a single pass over the template.

Two reasons. A query in a file can be read on its own, can carry the comment
explaining its shape, and can be pasted into an endpoint unchanged when it
misbehaves. And the single pass is a security property, not a tidiness one:
substituting token by token let a value inserted early, a caller's search
text among them, be read as a template for a later token, which is how a
search term once escaped its literal and became part of the query.

Caller input reaches a query only through the guards in `app/lib/terms.mjs`,
which produce quoted literals, checked IRIs and bounded keys, and refuse
anything else.

## Checks are per concern

`pipeline/verify.mjs` starts what the checks need and reports, and the checks
themselves are one module per concern under `pipeline/lib/checks/`. Each
receives the same context object and calls `record(name, pass, detail)`. A
module that throws is recorded as a failed group rather than ending the run,
so one broken query cannot hide the state of everything after it.

What each check is measured against, whether pair counts, children or
versions, is in `pipeline/fixtures.json` rather than in the check, so a
source changing shape under its pin shows up as an edit to data.

## Tests

`pnpm test:pure` needs no Java and no built store, so it runs in continuous
integration on every push. `pnpm test` adds the suites that need the real
Jena and ROBOT jars, and `pnpm verify` needs a built store. When a rule can
be tested without Java, it belongs in the pure set: the manifest rules had
no test at all for as long as they were unreachable, and `literal()` had
none while every suite that depended on it stayed green with its escaping
removed.

## Description identity

The definitions graph uses one derived record per `(source key, publisher
entity IRI)`. `ont:entity` links that record to the entity; the label,
definition, their source properties, licence and version are properties of
the record. A shared entity therefore has multiple atomic descriptions.
Joining metadata directly on the entity mixes releases and licences.

Application queries follow `ont:entity`, and entity pages and MCP accept a
source selection. The asserted panels read only the selected source graph;
the index and inferred graphs cannot masquerade as publisher assertions.
`pipeline/test-source-context.mjs` builds two disagreeing source snapshots
and verifies search, grounding, selection and rendered navigation against
a real temporary store, including a deployment path prefix.

ChEBI's size requires bounding work before rendering. Large-source graph
queries expand a small frontier one level at a time, then fetch only edges
between displayed nodes. A LIMIT on an unbounded transitive query does not
bound the query's work. The full snapshot remains queryable.
