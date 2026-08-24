# OWL Reasoning Toolchain for MatSci-ONT — Empirical Report

All experiments run in `/tmp/claude-1000/-home-chris-dev/8d31cd45-6239-4260-8f1d-5068132225be/scratchpad/reasoner-exp/` (artifacts retained there: `src/`, `out/`, `catalog-*.xml`, `*.rq`). Java: `JAVA_HOME=/home/chris/dev/systemada/matsci-ont/tools/jdk-21.0.12.1+1-jre`, invoked as `$JAVA_HOME/bin/java -jar robot.jar …`. Everything below marked with numbers was measured on this machine today; anything not measured is tagged UNCONFIRMED.

## 0. Pinned artifact

- **Tool**: ROBOT v1.9.10 (latest release, published 2026-02-18)
- **URL**: `https://github.com/ontodev/robot/releases/download/v1.9.10/robot.jar`
- **Size**: 82,604,728 bytes; **sha256**: `16a73c074f3df359a7338a84b4e0788785fe06117f931bb9796e9619ea776105` (computed locally; the release publishes **no** checksum asset — this hash is the pin)
- **License**: BSD-3-Clause (verified via GitHub API license endpoint)
- Runs clean on the pinned Temurin 21.0.12.1 JRE (`robot --version` → `ROBOT version 1.9.10`)
- Bundled engines (from jar's maven metadata): OWL API 4.5.29, HermiT **1.4.5.456** (owlcs fork), ELK **0.6.0**, JFact 4.0.4, EMR 0.1.3, whelk (org.geneontology, version UNCONFIRMED). `--reasoner` help lists ELK/HermiT/JFact, but `--reasoner whelk` is accepted (verified, exit 0).

## 1. reason on PMDco and MDO — time, counts, determinism

PMDco input: `cache/6a2eaee….ttl` (1.4 MB Turtle, ~1354 named classes, no owl:imports). MDO merged first (see §2b). Command shape: `robot reason --input X --reasoner {hermit|ELK} --annotate-inferred-axioms true --output Y`.

| Run | Wall | MaxRSS | inferred (`is_inferred` count) | Deterministic (2 runs)? |
|---|---|---|---|---|
| PMDco HermiT | 8.8 s / 9.0 s | ~535 MB | 1606 | YES — identical sha256 `b96553305430…` |
| PMDco ELK | 1.45 s / 1.37 s | ~350 MB | 1565 | YES — identical sha256 `90788e9f1ab5…` |
| MDO(merged) HermiT | 0.63 s | ~156 MB | 39 | YES |
| MDO(merged) ELK | 0.72 s | ~166 MB | 39 | YES (and byte-identical to HermiT output) |

- Inferred-axiom annotation shape: reified `owl:Axiom` blocks with `oboInOwl:is_inferred "true"` (`http://www.geneontology.org/formats/oboInOwl#is_inferred`).
- **ELK vs HermiT on PMDco is NOT equivalent**: with identical flags (`--axiom-generators "SubClass" --create-new-ontology true --exclude-owl-thing true --exclude-tautologies structural`), HermiT emits 1581 named-named direct subClassOf pairs, ELK 1540. HermiT-only: **65 pairs** (e.g. many `X ⊑ obo:BFO_0000023` (role) where ELK only reaches `obo:BFO_0000017` (realizable entity)); ELK-only: 24 pairs that are merely less-specific parents. Cause (via `robot validate-profile --profile EL`): PMDco has **276 EL violation lines** — 110 ObjectAllValuesFrom, 78 ObjectUnionOf, 9 ObjectComplementOf, 5 ObjectExactCardinality, 1 ObjectMinCardinality, 1 DataMinCardinality, 1 inverse property, 2 data ranges. **Use HermiT for PMDco.**
- MDO is EL-safe class-expression-wise (only datatype-level violations); HermiT ≡ ELK byte-identical there. HermiT is sub-second anyway.

MDO merge: `robot merge --catalog catalog-mdo.xml --input src/mdo-wrapper.rdf --output mdo-merged.ttl` — 0.5 s, works with network hard-disabled, collapses closure (0 `owl:imports` in output), all 4 module namespaces present. **Gotcha**: the wrapper imports *versioned* IRIs (`https://w3id.org/mdo/{core,structure,calculation,provenance}/1.1/`) while the module files declare *unversioned* ontology IRIs — the catalog must map the versioned IRIs:

```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<catalog prefer="public" xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">
  <uri name="https://w3id.org/mdo/core/1.1/"        uri="src/mdo-1.rdf"/>  <!-- e26b6838… -->
  <uri name="https://w3id.org/mdo/structure/1.1/"   uri="src/mdo-2.rdf"/>  <!-- 451c9522… -->
  <uri name="https://w3id.org/mdo/calculation/1.1/" uri="src/mdo-3.rdf"/>  <!-- 55e3818e… -->
  <uri name="https://w3id.org/mdo/provenance/1.1/"  uri="src/mdo-4.rdf"/>  <!-- 71555fc8… -->
</catalog>
```
(module→hash mapping verified by ontology IRI inside each file; `uri` values are file paths relative to the catalog file.)

## 2. CHAMEO unresolvable imports (12 EMMO modules)

- **(a) Default behavior: it FETCHES over the network.** `strace -f -e trace=connect` on `robot reason --input chameo.ttl` shows outbound connects to 23.253.20.182 (w3id.org) and 185.199.108–111.133/.153 (GitHub Pages hosting EMMO); it downloaded all 12 modules, reasoned the full closure (2140 inferred axioms) in 57.8 s, exit 0. **Forbidden for the pipeline.**
- **Default with network unavailable**: exit **1**, stdout `org.semanticweb.owlapi.model.UnloadableImportException: Could not load imported ontology: <https://w3id.org/emmo/1.0.3/disciplines/computerscience> Cause: Connection refused`, no output file. Loud failure — good invariant.
- **There is no `--strict false` / offline flag.** `--strict` in ROBOT is strict *parsing* only; the only import-control mechanism is `--catalog`.
- **(b) Catalog → empty file: WORKS, and this is the recipe.** Map each of the 12 EMMO import IRIs to a single **0-byte** `empty.ttl` (parses fine as an anonymous empty ontology). Exit 0, 0.9 s, zero network (verified under dead-proxy JVM flags), byte-identical across two runs, 244 inferred axioms (default generator). **Side effect (verified with both `reason` and plain `convert`): the output has the `owl:imports` declarations stripped entirely** — the OWL API drops the declarations when they resolve to an anonymous ontology — so downstream loads never re-attempt resolution.
- **(c) `remove --select imports`**: `robot remove --catalog catalog-chameo-empty.xml --input chameo.ttl --select imports --trim false --output chameo-noimports.ttl` then `reason` — works, but note **remove still needs the catalog** (loading happens before removing). Final reasoned output is **byte-identical** to recipe (b). Two JVM invocations for the same bytes → use (b).

**Exact no-network CHAMEO recipe** (catalog at `catalog-chameo-empty.xml`; 12 `<uri name="https://w3id.org/emmo/1.0.3/{disciplines/{computerscience,isq,manufacturing,math,metrology,models},perspectives/{holistic,persistence,semiotics},reference/{data,persholistic,workflow}}" uri="src/empty.ttl"/>` entries):

```
$JAVA_HOME/bin/java -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=1 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=1 \
  -jar robot.jar reason --catalog catalog-chameo-empty.xml --input chameo.ttl --reasoner hermit \
  --axiom-generators "SubClass" --create-new-ontology true --exclude-owl-thing true --exclude-tautologies structural \
  query --format nt --construct inferred-subclassof.rq chameo-inferred.nt
```
The dead-proxy `-D` flags are a verified belt-and-braces guard: any accidental fetch becomes an immediate exit-1 `Connection refused` instead of a silent network dependency.
- Semantics note for the plan: without the EMMO TBox, CHAMEO yields 211 inferred subClassOf triples vs 2137 (HermiT) when the closure is present. That loss is the documented consequence of the no-EMMO policy, not a tooling defect.

## 3. Inconsistency handling — verified loud failure

Tiny ontology (`A owl:disjointWith B; x a A, B`): both HermiT and ELK → **exit code 1**, stderr-style log line `ERROR org.obolibrary.robot.ReasonerHelper - The ontology is inconsistent. TIP: use a tool like Protege to find explanations`, **no output file written**. Safe to gate the pipeline on exit code. (`--dump-unsatisfiable FILE` exists for incoherency debugging.)

## 4. NIST SKOS

File is pure SKOS (993 `skos:Concept`, 1 ConceptScheme; zero OWL constructs, not even an `owl:Ontology` header). `robot reason` runs fine (0.7 s, exit 0) but "infers" only 4 tautologies (`skos:Concept ⊑ owl:Thing` etc., from classes implied by typing). With the recommended flags (`-n true -T true -t structural`, SubClass generator) the inferred graph is **exactly empty** (verified). **Recommendation: skip via manifest flag** (`reason: false`) — running it is harmless but produces an empty graph while re-serializing 6000 lines of RDF/XML for nothing; a manifest flag also documents intent. If uniformity is preferred, running it is safe and deterministic.

## 5. Alternatives (brief)

| Option | Status | CLI | License | Verdict |
|---|---|---|---|---|
| Openllet (Galigator/openllet) | Last release **2.6.5, 2019-09**; repo alive-ish (pushes to 2025-08) but no releases in 6+ years; OWL API 4 era | has a CLI module (UNCONFIRMED, not installed) | GitHub says NOASSERTION; Pellet heritage = **AGPL-3.0**/commercial dual | Reject: AGPL + stale |
| Standalone HermiT jar | Upstream hermit-reasoner.com last release ~2013; the maintained artifact is the maven fork ROBOT already bundles (1.4.5.456, 2020) | yes (old jar) | LGPL-3.0 (UNCONFIRMED via API; well-known) | Pointless — ROBOT bundles a newer HermiT |
| ELK 0.6.0 | Active (repo pushed 2026-06) | via ROBOT | Apache-2.0 (verified) | Keep as fallback only; measured completeness loss on PMDco (65 pairs) and EMMO closure (16 pairs + 188 redundant non-direct pairs) |
| whelk (INCATools/whelk) | pushed 2025-03 | via ROBOT (`--reasoner whelk`, verified working) | BSD-3-Clause (verified) | EL-family; same completeness caveat class as ELK |
| Jena builtin (apache-jena-6.2.0, **already in tools/**) | current | `bin/infer` is **RDFS-only** (verified: `infer --rdfs=vocab FILE` is the entire surface); OWL rule reasoners are API-only and incomplete for DL | Apache-2.0 | Not a substitute: measured — Jena RDFS closure of PMDco (0.55 s, 17,277 triples) contains **0 of the 1581** new direct pairs HermiT derives (expected: new *direct* pairs require DL reasoning, never bare transitivity) |

## 6. Recommendation

**Toolchain: ROBOT v1.9.10 (pin above) + bundled HermiT 1.4.5.456, on the existing Temurin 21 JRE. One jar, BSD-3, no new runtime deps.** ELK stays available inside the same jar as an escape hatch with documented loss.

**Output contract** (verified): per source, an N-Triples file containing **only inferred direct `rdfs:subClassOf` triples between named classes** — no ontology header, no declarations, no annotations, zero overlap with asserted axioms (PMDco: 1581 inferred vs 1485 asserted pairs, intersection = 0). Shape: `<sub> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <super> .` Directly loadable into a named graph (e.g. `tdb2.tdbloader --graph <g> file.nt`, or wrapped in TriG). Byte-deterministic across runs as produced; for a canonical form independent of writer ordering, post-process with `LC_ALL=C sort` (N-Triples is line-oriented; verified stable hash `30c48a83…` for PMDco).

Shared query `inferred-subclassof.rq`:
```sparql
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
CONSTRUCT { ?s rdfs:subClassOf ?o }
WHERE { ?s rdfs:subClassOf ?o . FILTER(isIRI(?s) && isIRI(?o)) }
```
(The `reason→query` chain runs in one JVM; `--create-new-ontology true` means the only subClassOf axioms present are the inferences, so the FILTER's only job is excluding bnode class expressions.)

Per-source commands (`J="$JAVA_HOME/bin/java -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=1 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=1 -jar robot.jar"`; `FLAGS='--reasoner hermit --axiom-generators SubClass --create-new-ontology true --exclude-owl-thing true --exclude-tautologies structural'`):

1. **PMDco**: `$J reason --input 6a2eaee….ttl $FLAGS query --format nt --construct inferred-subclassof.rq pmdco-inferred.nt` → 1581 triples, ~9 s, ~550 MB heap headroom needed.
2. **MDO**: `$J merge --catalog catalog-mdo.xml --input f5de8751….rdf reason $FLAGS query --format nt --construct inferred-subclassof.rq mdo-inferred.nt` → 13 triples, <1 s. (Single chained invocation, verified.)
3. **CHAMEO**: `$J reason --catalog catalog-chameo-empty.xml --input bdbe2e28….ttl $FLAGS query --format nt --construct inferred-subclassof.rq chameo-inferred.nt` → 211 triples, ~1 s.
4. **NIST**: skip (manifest `reason: false`); if run anyway, same command yields an empty graph, exit 0.

All three commands verified twice each under network-disabled JVM flags: exit 0, byte-identical outputs. Pipeline gate: nonzero exit = inconsistent ontology or unresolvable import — both fail loudly (§2, §3).

**EMMO-scale expectations**: Measured on the real thing — CHAMEO + full EMMO 1.0.3 12-module closure (23,151-line Turtle, 1,634 named classes, 366 EL violations incl. 50 inverse-property uses): **HermiT classified it in 4.4 s / 587 MB RSS; ELK 1.6 s / 424 MB**. HermiT found 16 direct pairs ELK missed and avoided 188 redundant pairs ELK emitted. So EMMO 1.0.x-scale is comfortably inside HermiT's envelope; the "~1M+ triples" figure is dominated by multilingual annotations, which are irrelevant to classification cost (logical axiom/class count is what scales). Historical reports of EMMO-beta choking tableau reasoners predate the 1.0 redesign — UNCONFIRMED/anecdotal. OBO community practice (ROBOT docs recommend ELK for large ontologies; GO/Uberon-scale pipelines use ELK, smaller DL-heavy ontologies use HermiT) supports the same split — UNCONFIRMED beyond docs. Policy: **HermiT everywhere; if a future source (e.g. full EMMO import graph at 10×) blows a timeout, drop to `--reasoner ELK` (or whelk) for that source only and record the measured completeness delta in the manifest**, using exactly the pair-diff method in `subclass-pairs.rq` + `comm` demonstrated here.

Key experiment files: `reasoner-exp/robot.jar`, `reasoner-exp/catalog-mdo.xml`, `reasoner-exp/catalog-chameo-empty.xml`, `reasoner-exp/src/empty.ttl` (0 bytes), `reasoner-exp/inferred-subclassof.rq`, `reasoner-exp/subclass-pairs.rq`, outputs and timings under `reasoner-exp/out/` (notably `final-{pmdco,mdo,chameo}-{1,2}.ttl`, `final-pmdco.nt`, `chameo-default.strace`, `pmdco-el-violations.txt`, `emmo-el-violations.txt`).