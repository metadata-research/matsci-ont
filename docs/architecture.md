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

## The lookup index is a cache of the store

`/grounding` and `/candidates` match a term against every label of the
cleared sources, and grounding against every definition as well. In SPARQL
that is a pass over some 220,000 entries per request, because no TDB2 index
can serve a case-insensitive word match. `app/lib/lookup-index.mjs` holds the
same entries in memory and answers in milliseconds.

The index is derived and never authoritative. `app/lib/lookup-worker.mjs`
streams it from the running store with `lookup-entries.rq` when the
application starts, in a worker thread, and `app/lib/lookup-state.mjs`
reloads it when the catalogue fingerprint changes, which a timer reads every
30 seconds while the index is ready. Nothing is written back
and nothing is shipped beside the store, so the store remains the single
source of truth and a host's index always describes the store that host
serves.

A large source is read in pages, because Fuseki stops any query at 30
seconds and a host with slow disks and little memory read ChEBI in one query
at about that limit. `app/lib/lookup-load.mjs` asks the store how many
descriptions the source has (`lookup-count.rq`), and splits it into ranges
of the entry IRIs, which the build mints as the source key and a SHA-256 in
hex under one prefix (`shared/vocabulary.mjs`, where both layers read the
rule). Jena filters the source's entries by the range before it reads
anything else about them, so a page costs its share of the source plus one
pass over the source's entry IRIs. The first range is open below and the
last open above, so the ranges cover every string once whatever the IRIs
look like, and the minting only decides how evenly the pages fill. A page
is added only once it has arrived whole, and a load is kept only when its
pages held exactly the descriptions the store counts, so a page missed or
read twice fails the load instead of changing the index. The count is one
read of an index, so it does not grow into a slow query, but it counts
descriptions with or without a label, which the pages do not. So pages
that do not add up are settled by the catalogue, read again: a store that
changed during the load is loaded again at once, and one that did not holds
descriptions the index cannot account for, and is abandoned until it
changes.

A load that fails for a reason the store may not repeat, a query stopped
or a store out of reach, is tried again by a timer rather than by the next
lookup, so a host that receives no lookups still recovers. `/lookup-status`
reports the state from memory, which lets an installer wait for the index
without starting the SPARQL lookups that would compete with the load.

While a load runs, lookups are held back from SPARQL, since each is a scan
that slows the load, but only for part of their deadline. One at a time
goes to SPARQL at once, and the others wait for at most a quarter of the
time their deadline leaves. Paging made a load longer than a lookup's
deadline on a slow host, so a lookup that waited for the whole of it would
fail where SPARQL would have answered.

Paging bounds the time of each query, not the memory of the index. The
load peaks at about 92 MB for the current 222,925 descriptions and grows
with them, and it is abandoned past 192 MB, about 500,000 descriptions,
which keeps the process under the service's memory limit. A larger store
needs the budget in `lookup-load.mjs`, the worker's heap and the unit's
limits raised together, on a host with the memory to spare.

The matching rules are Jena's, reproduced in JavaScript: its ASCII-only
`\b`, its case-insensitive comparison, `LCASE` and the `ORDER BY` order of
literals. The SPARQL queries remain the reference. `pnpm verify` compares
both paths on the real store and requires identical answers, and
`app/test-preview.mjs` runs its suite with the index off and on. The same
queries answer at run time while the index loads, when
`MATSCI_ONT_LOOKUP_INDEX=off`, and for a request the index does not cover.
