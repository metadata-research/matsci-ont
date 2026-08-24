All verification complete. Final report follows.

# EMMO 1.0.3 Pinned Import Closure — MatSci-ONT Phase 7

Working area: `/tmp/claude-1000/-home-chris-dev/8d31cd45-6239-4260-8f1d-5068132225be/scratchpad/emmo-exp/` (script `closure.sh`, downloads in `files/`, ntriples in `nt/`, validate logs in `logs/`, manifest `manifest.tsv`, squashed builds in `extra/`).

## 1. Resolution pattern (verified)

- `https://w3id.org/emmo/1.0.3/<path>` → **HTTP 303 See Other** (single hop) → `https://raw.githubusercontent.com/emmo-repo/EMMO/1.0.3/<path>.ttl` → 200, `content-type: text/plain; charset=utf-8` (RIOT infers Turtle from the `.ttl` extension; don't rely on content-type).
- Pinned raw URL pattern: `https://raw.githubusercontent.com/emmo-repo/EMMO/1.0.3/<path>.ttl`
- Tag `1.0.3` exists on `emmo-repo/EMMO`, commit **`b85a0803c47819fc4b53b9c9fd6c61878f714c5b`** (GitHub git-refs API). Tags are mutable; the immutable pin is `https://raw.githubusercontent.com/emmo-repo/EMMO/b85a0803c47819fc4b53b9c9fd6c61878f714c5b/<path>.ttl` — verified byte-identical to the tag URL on `disciplines/isq.ttl` (same sha256).
- One quirk: `foundation/mereocausality` imports `https://w3id.org/emmo/1.0.3/contributors`, a **top-level** file (`contributors.ttl`) — the pattern still holds.
- Every module's `owl:versionIRI` is exactly `https://w3id.org/emmo/1.0.3/<path>` (all 25 checked; ontology IRIs themselves are version-less `https://w3id.org/emmo/<path>`). Catalog mapping must map the **version IRI** to the file.

## 2. Closure (fixpoint reached, no anomalies)

12 seeds + 13 transitive = **25 modules, 14,800 triples, 1,790,693 bytes**. Zero foreign imports (nothing outside `w3id.org/emmo`), zero non-1.0.3 version references, zero download failures. Tool: Apache Jena RIOT 6.2.0, `JAVA_HOME=/home/chris/dev/systemada/matsci-ont/tools/jdk-21.0.12.1+1-jre`.

Manifest (module IRI = `https://w3id.org/emmo/1.0.3/` + path; raw URL = `https://raw.githubusercontent.com/emmo-repo/EMMO/1.0.3/` + path + `.ttl`):

| # | path (IRI & raw-URL suffix) | sha256 | bytes | triples | role |
|---|---|---|---|---|---|
| 1 | `disciplines/computerscience` | `56e3a2ba0ed96ebf95d5f493ce8521f76151009404bac69e4d91451bff303c9f` | 48466 | 411 | seed |
| 2 | `disciplines/isq` | `d92c0f4e6ea419149b0015f19177d48f7b7d4639efd57d5a1c515ac0a4213e70` | 671719 | 5517 | seed |
| 3 | `disciplines/manufacturing` | `e70a9d5516f87c52c298cc7567049f425253a2a7054f0fdb08b4011fc0b796bd` | 124281 | 1159 | seed |
| 4 | `disciplines/math` | `8125580d0b9996b0b842e73bdd1151c5357c0ddbe9a67a36fcaa1484e23b4dc8` | 37273 | 318 | seed |
| 5 | `disciplines/metrology` | `669bd5f36f1af6a1316d345dec2ab09af4d908d0ae87472f2a11e1ec4b4e10d2` | 85859 | 635 | seed |
| 6 | `disciplines/models` | `cdb1288e75af33d383017c8dbe594c59d5894d73252d3ae326cb57e91493c913` | 34242 | 277 | seed |
| 7 | `perspectives/holistic` | `7fe47313c13ca49d68a7015b7d13db49eb6ae393bf93a913bf72eef4fe672435` | 18361 | 117 | seed |
| 8 | `perspectives/persistence` | `b5ea97c22226bb340a8903a4d6b66d2df8485da5aa7009216a6f03b71bff021e` | 62157 | 511 | seed |
| 9 | `perspectives/semiotics` | `93313258730c6f203529638ba5b547eb503a72bbae5811af141fdce198d40865` | 105044 | 837 | seed |
| 10 | `reference/data` | `6e2cc83cd69075e76d97a54d5600c3ad25103ebd9337de2fddce8a1922095476` | 11187 | 79 | seed |
| 11 | `reference/persholistic` | `1c130ebaf791d765e92df08e5669b61225333218b5236d2a55037b74997bdb08` | 11023 | 86 | seed |
| 12 | `reference/workflow` | `7e158bd1b5fa6164e969994aaf0296ca9e9a1f495d18585d4d688ba22c6f27d1` | 22356 | 171 | seed |
| 13 | `contributors` | `24fba83f75f62a332beeae5f5fbcdfb2bb64c3c04f8abe296d102ca12428d0e8` | 4245 | 63 | via `foundation/mereocausality` |
| 14 | `disciplines/materials` | `ac8ca61d745ffc2166328c6d49aff4729d8307445e2b041537b248c23040cbd8` | 55530 | 449 | via `isq`, `manufacturing` |
| 15 | `disciplines/properties` | `e8c02893115ef8068499c07c9760be3e858114eead10ee224ea7255e4dd8421e` | 5530 | 39 | via `metrology` |
| 16 | `disciplines/units/sidimensionalunits` | `0ca065b56e0ecbacac479945741d742ac8f036a2672bb7e85386c4bdc118f961` | 179420 | 1651 | via `isq` |
| 17 | `foundation/mereocausality` | `0491d6c6bf372ed26a3a05fdc447b821d36db4a834feea27489d7fd74abee0d0` | 123502 | 1041 | via `perspectives/perspective`, `reference/standardmodel` |
| 18 | `perspectives/contrast` | `59b9b2462699ca1c411f992cd69033d28ca215a38aa519fd1f685f9340913c41` | 10038 | 61 | via `reference/data`, `persholistic` |
| 19 | `perspectives/perspective` | `58d66ebd04820722bd553dc3934966140f3e263b65b47719947cfb5c13aa3f13` | 4031 | 25 | via every `perspectives/*` module |
| 20 | `perspectives/reductionistic` | `d49fe5fdaac9fa3c678370a4c217ef8f60e0ca9e6404eed0b37374d803ca1d8d` | 32893 | 242 | via `math`, `reference/workflow` |
| 21 | `perspectives/structural` | `00e1ac96c4cf1494f64afb7289c4ec9f0c024f5a514c8041cf804d7767ead40e` | 13846 | 97 | via `persholistic` |
| 22 | `reference/agency` | `590f46b8b9269590326ef9347959f2744f41fdb950d5cb7c987f0ab5e886f668` | 25138 | 184 | via `manufacturing`, `reference/workflow` |
| 23 | `reference/physicalistic` | `f21d7d382ee6630fb56f4e9f4c80b6d3c5c80d64a165e55f0564c01fefb53fb4` | 44835 | 335 | via `materials` |
| 24 | `reference/standardmodel` | `9389cb5abc010004c8c3dda75deae07fe9ed1df65c13d491f831a16b92f89611` | 15777 | 111 | via `physicalistic` |
| 25 | `reference/symbolic` | `032e22b0308debfca23dd2a712e94d9583e48b030ccd69a70953f36c7f0bfa49` | 43940 | 384 | via `computerscience`, `isq`, `math`, `metrology` |

**Totals: 25 modules, 14,800 triples, 1,790,693 bytes.** (Full EMMO at the tag is 58 .ttl modules; the CHAMEO seed set pulls in only 25 — notably *excluding* chemistry, periodictable, sisystem, all `units/*` except `sidimensionalunits`, perceptual, geometrical, dataset, conformityassessment.)

Full `owl:imports` edge list (47 edges, deterministic seed→extra attribution):

```
disciplines/computerscience -> perspectives/semiotics, reference/symbolic, reference/workflow
disciplines/isq             -> disciplines/materials, disciplines/units/sidimensionalunits, reference/symbolic
disciplines/manufacturing   -> disciplines/materials, reference/agency
disciplines/math            -> perspectives/reductionistic, perspectives/semiotics, reference/data, reference/symbolic
disciplines/metrology       -> disciplines/math, disciplines/properties, reference/persholistic, reference/symbolic, reference/workflow
disciplines/models          -> disciplines/computerscience, disciplines/math, disciplines/metrology, perspectives/persistence, reference/data, reference/workflow
disciplines/materials       -> reference/physicalistic
disciplines/properties      -> perspectives/semiotics
disciplines/units/sidimensionalunits -> disciplines/metrology
foundation/mereocausality   -> contributors
perspectives/{contrast,holistic,persistence,reductionistic,semiotics,structural} -> perspectives/perspective
perspectives/perspective    -> foundation/mereocausality
reference/agency            -> perspectives/semiotics, reference/persholistic
reference/data              -> perspectives/contrast
reference/persholistic      -> perspectives/{contrast,holistic,persistence,semiotics,structural}
reference/physicalistic     -> reference/standardmodel
reference/standardmodel     -> foundation/mereocausality
reference/symbolic          -> reference/data
reference/workflow          -> perspectives/reductionistic, reference/agency
```

## 3. Validation (riot --validate, Jena 6.2.0)

All 25 files: exit code 0, **0 warnings, 0 errors** — every validate log is empty. Warning-free ingest is safe for the whole closure. Command used per file:

```
JAVA_HOME=/home/chris/dev/systemada/matsci-ont/tools/jdk-21.0.12.1+1-jre \
/home/chris/dev/systemada/matsci-ont/tools/apache-jena-6.2.0/bin/riot --validate <file>.ttl
```

Triple counts were taken as `riot --output=ntriples <file> | wc -l` (equivalent to `--count` for these files, and it doubles as the imports-extraction source: `grep '<http://www.w3.org/2002/07/owl#imports>'`).

## 4. License

- Repo `LICENSE` at tag 1.0.3: Creative Commons **Attribution 4.0 International** → SPDX **`CC-BY-4.0`**.
- In-file: all 25 modules carry `dcterms:license "https://creativecommons.org/licenses/by/4.0/legalcode"` (25/25; note it is a **string literal**, not an IRI — harmless, but a literal, if any tooling cares).

## 5. Squashed full-EMMO artifact — exists, with caveats

- **At the git tag: no squash.** The 1.0.3 GitHub release has **zero binary assets**. `emmo.ttl` at the tag is an importer stub (50 triples, imports `disciplines` + `contributors-mappings`); the `*-full.ttl` files (`reference/reference-full`, `foundation/mereocausality-full`) are also stubs with imports, not squashes.
- **On GitHub Pages: yes.** `https://emmo-repo.github.io/versions/1.0.3/emmo.ttl` — squashed, **0 owl:imports, 61,530 triples, 4,154,870 bytes, riot --validate rc=0 / 0 warnings**, sha256 `3bdb683ca4d285a286e23affa96b60f55ab60af7e1443a50f76be3444492ae48`. Also `emmo-inferred.ttl` (61,632 triples, 4,048,089 bytes, 0 imports, 0 warnings, sha256 `e8a7bff057f1b25c91f2e8cbe3ff3c6f2e0b83e260476d21fb7eb6ba977b8acd`). Pinnable form: `https://raw.githubusercontent.com/emmo-repo/emmo-repo.github.io/e7f9624a5c91b7ef49f8d64678d1ac85db6d3eaf/versions/1.0.3/emmo.ttl` — verified byte-identical to the Pages copy.
- **Would one file replace the closure?** Technically it could, but I recommend against: (a) it is *full* EMMO — 61,530 triples vs the closure's 14,800 (4.2x), dragging in chemistry, all units modules, periodictable, etc.; (b) its ontology/version IRI is `https://w3id.org/emmo` / `https://w3id.org/emmo/1.0.3`, so CHAMEO's 12 `owl:imports` of individual module version-IRIs would **not** resolve against it without 12 catalog aliases all pointing at one file (duplicating the graph 12x under naive resolvers, or requiring importer-side dedup); (c) the Pages path is **CI-regenerated on a mutable branch** — last rewritten 2026-08-20 ("Updated pages"), i.e. version-named path ≠ frozen bytes; only the raw-at-commit form above is a real pin. Coverage sanity check passed: every `https://w3id.org/emmo#`-namespace subject in the 25-module closure appears in the squash (0 missing).

## Anomalies / UNCONFIRMED

- No anomalies: no foreign imports, no non-1.0.3 versions, no validation failures/warnings, no download failures.
- UNCONFIRMED: that the 12-IRI seed list exactly matches CHAMEO 1.0.3's imports — taken as given from the task, not re-derived from a CHAMEO 1.0.3 file.
- UNCONFIRMED: whether the 2026-08-20 Pages rebuild changed `versions/1.0.3/emmo.ttl` bytes vs earlier builds (only the current bytes were hashed; the commit-pinned URL above freezes them).

Reproduction script: `/tmp/claude-1000/-home-chris-dev/8d31cd45-6239-4260-8f1d-5068132225be/scratchpad/emmo-exp/closure.sh`; machine-readable manifest (`module<TAB>rawURL<TAB>sha256<TAB>bytes<TAB>triples<TAB>warns<TAB>errs<TAB>first-importer`): `/tmp/claude-1000/-home-chris-dev/8d31cd45-6239-4260-8f1d-5068132225be/scratchpad/emmo-exp/manifest.tsv`.