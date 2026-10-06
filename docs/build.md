# Building the store

What `pnpm ingest` does and how a build is checked, for someone changing
the pipeline or diagnosing a build. [Sources and the manifest](sources.md)
covers the input.

## The ingest

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
version and licence, and the
[architecture](architecture.md#description-identity) explains why queries
join on the record. The application queries depend on this format, so an
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
alone. The inferred view of CHAMEO needs the derived EMMO placements above
its classes, so all 82 new EMMO pairs also appear among the 86 for CHAMEO,
which contributes 4 pairs of its own. `pipeline/fixtures.json` records
these counts, and `pnpm verify` checks them.

A source can also reason through the pins of another entry. `importsFrom`
adds the pinned files of the named entries to the reasoning catalog without
loading them into the graph of the referencing source. CHAMEO reasons over
the full EMMO closure this way while its own graph holds only `chameo.ttl`.

Imports are never fetched. A module the manifest pins is named by its
`importIri` and mapped to the pinned file. An import listed in
`importsToEmpty` is mapped to an empty ontology, which also drops the
import declaration from the reasoner output. Every reasoner run has proxy
settings that point at a closed port, so any other import fails at once and
cannot become a dependency nobody recorded. A nonzero exit from ROBOT, for
an inconsistent ontology or an unresolvable import, fails the build.

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
settle it, because the axioms in these ontologies are inside blank nodes.
An `owl:minCardinality` changed from 2 to 3 keeps every count identical,
and a swap of blank node topology keeps the blinded hash identical.
`pnpm test:compare` builds both cases and asserts which tier catches each,
so a regression in the comparison fails a test.
