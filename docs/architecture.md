# Architecture

How the code is arranged and why, for someone about to change it.
`README.md` covers getting it running, [Building the store](build.md) and
[Sources and the manifest](sources.md) cover the pipeline and its input,
and `docs/guide/` covers using it.

## Three layers

```
pipeline/  builds the store        ─┐
                                    ├─→  shared/   what both need
app/       serves the store        ─┘
```

`eslint.config.mjs` enforces the layering. It forbids `app/**` from
importing `pipeline/**` and forbids `shared/**` from importing either. The
reason is deployment. A host runs `app/` against a store built elsewhere,
with no Jena, no ROBOT and no manifest. An import from `app/` into
`pipeline/` would drag the build toolchain into a process whose job is to
answer HTTP requests, and the mistake would stay silent until a host was
built without the tools.

`pipeline/` may import `app/`. Verification does, because it checks the
rendered pages and the input guards, and refusing the import would mean
keeping a second copy of the escaping rules to check the first against.

`shared/` holds what both layers use, namely the identifiers this project
mints (`vocabulary.mjs`), the locations on disk (`paths.mjs`), the address
of the store (`endpoint.mjs`), the pinned tools and the local Fuseki
(`tools.json`, `tools.mjs`, `fuseki.mjs`), and the SPARQL loader
(`queries.mjs`). `vocabulary.mjs` exists because the build once minted the
graph IRIs and the application re-derived them by string concatenation, an
agreement that holds until it does not.

## The store is a function of the manifest

`manifest/*.json` is the input and `build/tdb2` is the output. Nothing is
edited in the store and nothing carries over from a previous build, so a
wrong store is rebuilt and never repaired. Two builds from one manifest
must therefore be isomorphic graph for graph, which is what the determinism
check tests, and every fix belongs in the manifest or the pipeline.

`pipeline/lib/manifest.mjs` holds the rules that decide what may enter, and
both `pnpm ingest` and `pnpm check:manifest` apply them. The rules once
lived in the checking script alone, and the build did not enforce them.

## Queries are files

Every SPARQL query is a `.rq` file, in `app/queries/` for the application
and `pipeline/queries/` for verification. `shared/queries.mjs` loads them
and fills `@@TOKEN@@` placeholders in a single pass over the template.

A query in a file can be read on its own, contains the comment that explains
its shape, and can be pasted into an endpoint unchanged when it misbehaves.
The single pass is a security property. Substitution token by token let a
value inserted early, such as the search text of a caller, be read as a
template for a later token, and that is how a search term once escaped its
literal and became part of the query.

Caller input reaches a query only through the guards in `app/lib/terms.mjs`,
which produce quoted literals, checked IRIs and bounded keys, and refuse
anything else.

## Checks are per concern

`pipeline/verify.mjs` starts what the checks need, runs them and reports.
The checks are one module per concern under `pipeline/lib/checks/`. Each
receives the same context object and calls `record(name, pass, detail)`. A
module that throws is recorded as a failed group and the run continues, so
one broken query cannot hide the state of the checks after it.

The values each check is measured against, such as pair counts, children or
versions, are in `pipeline/fixtures.json`. A source that changes shape under
its pin then shows up as an edit to data.

## Tests

`pnpm test:pure` needs neither Java nor a built store, so continuous
integration runs it on every push. A rule that can be tested without Java
belongs in that set. The manifest rules had no test at all while they sat
inside the command that ran them, and `literal()` had none while every
suite that depended on it stayed green with its escaping removed.

## Description identity

The definitions graph holds one record per source key and publisher entity
IRI. `ont:entity` links the record to the entity, and the label, the
definition, the properties they came from, the version and the licence
belong to the record. An entity that several sources describe therefore has
several independent descriptions. A query that joins these fields on the
entity mixes releases and licences, so application queries join on the
record and follow `ont:entity`.

Entity pages and the MCP tools accept a source selection. The asserted
panels read only the graph of the selected source, so neither the index nor
an inferred graph can pass as a publisher assertion.
`pipeline/test-source-context.mjs` builds two source snapshots that disagree
and checks search, grounding, selection and rendered navigation against a
real temporary store, including a deployment under a path prefix.

## Bounded views of large sources

ChEBI is large enough that the browse views bound their work before
rendering. A LIMIT on an unbounded transitive query does not bound the work
of the query, so the graph overview expands a small frontier one level at a
time and then fetches only the edges between displayed nodes. The full
snapshot remains queryable.

## The lookup index is a cache of the store

`/grounding` and `/candidates` match a term against every label of the
cleared sources, and grounding against every definition as well. In SPARQL
that is a pass over some 220,000 descriptions per request, because no TDB2
index can serve a case-insensitive word match. `app/lib/lookup-index.mjs`
holds the same descriptions in memory and answers in milliseconds.

The index is derived and never authoritative. `app/lib/lookup-load.mjs`
streams it from the running store with `lookup-entries.rq`, in a worker
thread (`app/lib/lookup-worker.mjs`) that starts with the application, and
`app/lib/lookup-state.mjs` loads it again when the catalogue fingerprint
changes, which a timer reads every 30 seconds while the index is ready.
Nothing is written back and nothing ships beside the store, so the store
remains the single source of truth and the index on a host always describes
the store that host serves.

A large source is read in pages, because Fuseki stops any query at 30
seconds and a host with slow disks and little memory read ChEBI in one
query at about that limit. `app/lib/lookup-load.mjs` asks the store how
many descriptions the source has (`lookup-count.rq`) and splits the source
into pages of about 16,000 descriptions, as ranges of the entry IRIs. The
build mints those IRIs as the source key and a SHA-256 in hex under one
prefix, and both layers read that rule from `shared/vocabulary.mjs`. Jena
filters the entries of the source by the range before it reads anything
else about them, so a page costs its share of the source plus one pass over
the entry IRIs of the source. The first range is open below and the last
open above, so the ranges cover every string exactly once whatever the IRIs
look like, and the minting decides only how evenly the pages fill.

A page counts only once it has arrived whole, and a page the store stops is
asked for again after 2 seconds and again after 8. A load is kept only when
its pages held exactly the descriptions the store counts, so a page missed
or read twice fails the load and leaves the index unchanged. The count is
one read of an index and stays fast. Pages that do not add up to it mean
that the store changed during the load or that its own descriptions do not
add up, such as one with two labels, and only the catalogue can tell which,
so the catalogue is read again after every load. A store that changed during
the load is loaded again at once. A store that did not change holds
descriptions the index cannot account for, and the index is abandoned until
the store changes.

A load that fails for a reason the store may not repeat, such as a stopped
query or a store out of reach, is tried again by a timer after 30 seconds,
then 60, then every 2 minutes, and by a lookup that arrives when an attempt
is due, so a host that receives no lookups still recovers.

`GET /lookup-status` reports the state of the index (`ready`, `loading`,
`failed`, `abandoned` or `off`) with its entries and sources, when it
loaded, how long the load took, and when a failed load is tried again. It
answers from memory, so an installer or a health check can wait for the
index without starting the SPARQL lookups that would compete with the load.
A failure appears as a fixed phrase for its kind, and the answer holds no
address, path or setting, so the route may be served publicly. Each
successful load writes one line to standard error with the entries, the time
taken, the size of the index, the memory the load needed and the heap in
use, and the number of pages with the slowest of them. A failed or abandoned
load writes one line with the reason.

While a load runs, lookups are held back from SPARQL, since each is a scan
that slows the load, but only for part of their deadline. One lookup at a
time goes to SPARQL at once, and the others wait for at most a quarter of
the time left before their deadline. A paged load on a slow host can
outlast the deadline of a lookup, and a lookup that waited for the whole
load would fail where SPARQL would have answered.

Pages bound the time of each query, and memory bounds the index. The load
peaks at about 92 MB for the current 222,925 descriptions and grows with
them. It is abandoned past 192 MB, about 500,000 descriptions, which keeps
the process below the 384 MB at which the host service unit, defined in
`matsci-ops`, starts to reclaim memory. A larger store needs the budget in
`lookup-load.mjs`, the heap of the worker and the `MemoryHigh` and
`MemoryMax` limits of the unit raised together, on a host with the memory to
spare.

The index reproduces the matching rules of Jena in JavaScript, namely its
ASCII-only `\b`, its case-insensitive comparison, `LCASE` and the `ORDER BY`
order of literals. The SPARQL queries remain the reference. `pnpm verify`
compares both paths on the real store and requires identical answers, and
`app/test-preview.mjs` runs its suite with the index off and on. The same
queries answer at run time while the index loads, when
`MATSCI_ONT_LOOKUP_INDEX=off`, and for a request the index does not cover,
such as a term containing a capital sigma.
