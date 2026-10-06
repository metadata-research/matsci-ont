# OntServe Ontology-Browsing UI — Replication Study

All paths are relative to the root of the OntServe repository, as read on 2026-08-24. Stack at the time: Flask + SQLAlchemy + PostgreSQL (+pgvector), Jinja2, Bootstrap 5.3, rdflib at request time. Entities are pre-extracted from TTL into a DB table; pages are built from that table plus per-request rdflib parses of the current TTL version.

## 0. The backing data structure (everything hangs off this)

`web/models.py:258` — `OntologyEntity` (table `ontology_entities`):
`id, ontology_id(FK), entity_type('class'|'property'|'individual'|'concept'), uri(Text), label(255), comment(Text), parent_uri(Text), domain(JSON), range(JSON), properties(JSON), embedding vector(384), content_hash`. Indexes on `entity_type`, `label`, `(ontology_id, entity_type)`.

Key conventions:
- `parent_uri` is **single-valued**: for a class, its primary `rdfs:subClassOf`; for an individual, its materialized `rdf:type`.
- Multi-parent classes store extra parents in `properties.rdf_superclasses` (JSON list, written at extraction only when multi-parent); multi-typed individuals store `properties.rdf_types`.
- Full TTL of each version lives in `ontology_versions.content`; blank-node axioms (restrictions, AllDisjointClasses, equivalentClass intersections) are **not** in the entity table and are re-parsed from TTL per request.
- Extraction TTL→rows: `web/entity_extraction.py` (683 lines) — anonymous class expressions (`owl:Restriction`, unions) are deliberately skipped as entities.

## 1. Class hierarchy display

**There is no ontology-wide recursive class tree.** Two distinct displays:

### 1a. Ontology page class list — flat
`web/ontology_routes/detail_routes.py:34-308` (`/ontology/<name>`) fetches ALL entities for the ontology, splits into classes/properties/individuals, and `web/templates/ontology_detail.html` (1480 lines) renders flat Bootstrap-tab lists (tabs: Schema, Properties, Concepts, Individuals, Axioms, Versions, Reasoning, Enrichment, Metadata). Classes are ordered by D-tuple component order then supporting classes — no nesting, no collapse. The Axioms tab shows a subsumption table (`stats.axioms.subclass`, one row per subclass with parents joined) built by `web/ontology_stats.py:312` (`compute_axioms`, rdflib over raw TTL, blank nodes skipped).

### 1b. Entity page "Class Hierarchy" card — ancestry chain + one child level (the good one)
Builder: `web/ontology_routes/helpers/hierarchy.py:178` `class_hierarchy(entity, child_cap=25)`. Returns:

```python
{'chain':    [ {uri, label, ontology, fragment, is_bfo, purl, is_current, linkable(, is_individual)} , ...],  # owl:Thing first → entity last
 'children': [ {uri, label, fragment, ontology, archetype_axis, specialization_axis, *_concept} , ...],       # direct subclasses, ≤25
 'children_overflow': bool}
```

- **Chain**: `_class_ancestor_uris` (line 62) walks `parent_uri` hop by hop **across ontologies** (one SELECT per hop, cap 16, cycle-guarded). Per hop it prefers the *definitional* row when the same URI exists in many ontologies (sort key: non-`proethica-case-*` first, then name) — this dedup-by-preference is a load-bearing idea.
- **Roots**: not chosen — the chain simply terminates at `owl:Thing` (special-cased, unlinkable) or when no parent row exists. BFO IRIs get an Ontobee external link (`purl`).
- **Multi-parent**: breadcrumb shows only the primary chain; secondary parents render as an "Also subclass of" row (`entity_secondary_parents`, line 281, reads `properties.rdf_superclasses`). Children include secondary-parent children via SQL `properties->>'rdf_superclasses' LIKE '%"<uri>"%'` (line 43 — text match over serialized JSON).
- **Individuals**: chain routes through the most-specific `rdf_types` candidate (drop candidates that are ancestors of other candidates, take deepest chain), individual hangs off with an ∈ glyph, not ↳.
- **Depth/render**: full ancestor chain (typically 5–10 levels for BFO-rooted), plus exactly **one** level of children. Rendering is `class_hierarchy_card` in `web/templates/macros/component_sections.html:227-259`: a plain `<ul>` with `padding-left: {{ loop.index0 * 1.5 }}rem`, monospace, `↳` glyphs, current node bold red, `(ontology)` suffix on foreign nodes. **Not collapsible — zero JS.** Children carry SKOS-concept axis badges and are grouped by axis rank then alphabetized.
- Deprecated subclasses filtered by `properties->>'deprecated' IS DISTINCT FROM 'true'`.

## 2. Entity pages

Route: `/entity/<ontology_name>/<fragment>` (`detail_routes.py:322-393`). Lookup: exact `base_uri#fragment`, then `uri LIKE '%#frag' OR '%/frag'` within the ontology, then **cross-ontology fallback** preferring non-case ontologies (`find_entity_by_fragment` + `uri_ends_with_fragment` in `helpers/links.py:133-159`). Also `/entity/<ont>/version/<tag>/<fragment>` re-extracts the entity from a historical TTL.

Panels, top to bottom (`web/templates/entity_detail.html`, 535 lines; macros in `macros/component_sections.html`, 409 lines):

| Panel | Data builder | Source |
|---|---|---|
| Class Hierarchy card | `class_hierarchy` | DB walk (§1b) |
| "Also classified as" (multi-typed individuals) | inline template over `properties.rdf_types` | DB |
| Definition card (skos:definition / IAO_0000115 primary; rdfs:comment gloss; scopeNote "inherited from X"; IAO_0000116 editor note; IAO_0000119 sources) | `categorize_entity_properties` (`helpers/display.py:97-198`) | DB properties JSON |
| Declared Fields (SHACL NodeShape pages only) | `shape_attr_schema` (`helpers/shapes.py:42`) | shapes TTL file, mtime-cached |
| Case Provenance ("discovered in Case N") | `entity_case_provenance` (`links.py:245`) | DB |
| **Defined as** (equivalentClass verbalization) | `entity_equivalent_class` (`links.py:343-397`) | per-request TTL parse |
| Mappings & provenance (skos exact/close/broad/relatedMatch, seeAlso, dcterms:source; internal-vs-external link resolution, DOI labeling) | `entity_semantic_links` (`links.py:27-98`) | per-request TTL parse |
| Properties card: domain/range (for properties), literal attributes, **Relationships** (IRI-valued property JSON → linked edges), Also-subclass-of, **Disjoint with** (incl. AllDisjointClasses co-members: `entity_disjoint_classes`, `links.py:195`), **Referenced by** for individuals (`entity_incoming_edges`, `links.py:297` — reverse triples, prov/time predicates skipped) | mixed | DB + TTL parse |
| **Property Structure** (4 groups: domain props w/ union ranges; SHACL definitional attrs; SHACL bearer attrs; Referenced-By in-degree via `rdfs:range` on class-or-ancestor) | `class_property_schema` (`helpers/shapes.py:140-324`) | DB + shapes TTL; chrome from `component_page_rulebook.py` (113 lines) |
| Source Evidence (verbatim quotes) | prop_groups.evidence | DB |
| Subclasses / Instances (split by kind) | `get_entity_children` | DB |
| Used in cases (subclass-closure → case ontologies typing individuals to any descendant: `entity_using_cases` + `_base_subclass_closure`, loads **all base class rows** into Python per call) | `links.py:104` | DB |
| TTL card (collapsed; actual source triples + 1-level bnode closure + targeting SHACL shapes appended) | `generate_entity_ttl_display` (`display.py:212`) | per-request TTL parse |
| Sidebar: Metadata, Extraction details (collapsed provenance), Formats (TTL/JSON/embedding via `/resolve?uri=`) | — | — |

**Restriction verbalization** (the code you asked for): `entity_equivalent_class` (`links.py:343-397`) parses `owl:equivalentClass → owl:intersectionOf` lists; named members become linked class terms, blank-node members are read as restrictions via `OWL.onProperty` + `OWL.someValuesFrom`/`OWL.allValuesFrom` → `{"kind":"restriction","quantifier":"some"|"only","property":term,"filler":term}`. Rendered by `defined_as_card` (`component_sections.html:159-182`) as `ClassA and (property some Filler)` in monospace with each term linked. **Cardinality restrictions are NOT verbalized anywhere** — they surface only as raw Turtle in the TTL card (the 1-level blank-node closure at `display.py:236-238`). `rdfs:subClassOf`-of-restriction axioms are likewise not verbalized (skipped at extraction, invisible outside the TTL card).

## 3. Cytoscape visualization

Server: `editor/visualization_service.py` (350 lines), routes in `editor/routes.py:627-673` (`/editor/api/enhanced/visualization/<name>`, `/editor/api/hierarchy/visualization/<name>`, POST `/editor/api/simple/reasoning/<name>`). Page: `/editor/ontology/<name>/visualize` — public via an app-level allowlist (`web/app.py:177-186`), everything else under `/editor` requires login.

**Node/edge JSON shape** (`build_basic_visualization`, lines 97-209):

```json
{"success": true,
 "visualization": {
   "nodes": [{"group":"nodes","data":{"id":"<uri>","label","name","uri","type","entity_type","description","comment","is_inferred":false,"restrictions":0,"namespace"},"classes":"class-node entity-class"}],
   "edges": [
     {"group":"edges","data":{"id":"subClassOf_0","source":"<child uri>","target":"<parent uri>","type":"subClassOf","is_inferred":false},"classes":"explicit subClassOf-edge"},
     {"group":"edges","data":{"id":"property_1","source":"<domain>","target":"<range>","label":"<prop label>","uri","type":"objectProperty","description","is_inferred":false},"classes":"explicit property-edge"}]},
 "statistics": {"total_entities","entity_type_counts","object_property_edges","omitted_datatype_properties","deprecated_excluded","inferred_count":0,"consistency_check":true}}
```

Relationship semantics: subClassOf from `parent_uri`; **object properties become labeled domain→range edges** (cartesian over union domains × non-datatype ranges), datatype/annotation properties omitted (UML "associations not attributes" convention); deprecated entities excluded; parents/endpoints outside the ontology become placeholder "external" nodes color-coded BFO `#E3F2FD` / IAO `#E8F5E8` / RO `#FFF3E0` / other `#F5F5F5` (`_make_external_node`). A second builder (`build_hierarchy_visualization`) round-trips TTL → rdflib → RDF/XML → temp file → **owlready2** to emit pure class hierarchy; used by default only when the ontology name contains `prov-o` or `bfo` (client-side heuristic, `visualize.js:9`).

**Client** (`web/templates/editor/visualize.html` 548 lines + `web/static/js/editor/visualize.js` 1179 lines):
- **Cytoscape 3.21.0 + dagre 0.8.5 + cytoscape-dagre 2.4.0, loaded from unpkg CDN** (visualize.html:11-15). Not vendored.
- Layouts: dropdown of `dagre` (default; `rankDir:'TB', nodeSep:50, rankSep:100, spacingFactor:1.2`), `breadthfirst`, `cose` (`nodeRepulsion: 400000 (<100 nodes) else 800000, idealEdgeLength:80`), `circle`, `grid`, `concentric`; all animated (1000 ms).
- Styling: 60×60 circular nodes, 10 px wrapped labels; namespace classes `ns-bfo/ns-prov/ns-proethica` recolor nodes; property edges purple dashed with autorotated labels; inferred edges green dashed.
- Interactions: tap node → details sidebar (description, parents/children derived from edge direction, relations, **"Open entity page" link** to `/entity/<ont>/<frag>` in new tab), neighbor highlight + dim rest; hover tooltip; client substring search + server **pgvector semantic search** (`/editor/api/entities/search?query=&ontology_id=&limit=10`, cosine over 384-dim MiniLM embeddings, `editor/routes.py:379-416`); filters (type / show-inferred / hide-unconnected) re-add all elements + re-layout; PNG export (`cy.png scale:2`); "Run Inference" POSTs read-only Pellet, overlays inferred subclass/type edges as green dashed.
- No expand-on-demand, no clustering, no viewport culling.

**Weaknesses at large node counts** (from code; runtime numbers UNCONFIRMED):
- The whole ontology is always sent: `limit=1000` appears in the client URL (`visualize.js:359`) but `build_basic_visualization` **never passes limit** to `_load_ontology_entities` — the parameter is dead.
- `DOMContentLoaded` is registered twice (`visualize.js:161` and `:1175`), so `loadOntologyData()` runs twice → double fetch + double layout on load.
- Every filter toggle removes and re-adds all elements and re-runs an animated layout; dagre on hundreds of nodes with 1 s animation is the pain point; cose repulsion is only two-tier.
- Hierarchy endpoint re-parses TTL through owlready2 per request (temp-file round trip, no cache).
- `convertHierarchyToCytoscape` (`visualize.js:412-464`, nested `children[]` consumer) is dead code — both endpoints already emit Cytoscape format.
- Cytoscape 3.21.0 is a 2021 release; `alert()`-based UX for errors/results.

## 4. Search

- **Public** (`web/main_routes.py:140-182`): navbar GET form → `/search?q=&type=all|ontologies|entities`, server-rendered `search.html`. Ontologies: `ILIKE '%q%'` over `name/description/base_uri`, no limit. Entities: `ILIKE` over `label/comment/uri`, deprecated excluded, `LIMIT 50`, no pagination, no ranking.
- **Semantic** (editor only): `/editor/api/entities/search` — pgvector similarity, returns `{label, entity_type, comment, similarity_score, uri, ...}`; used by the visualize page's search box alongside client substring match.

## 5. Judgment

### (a) Five things most worth replicating
1. **The entity-page Class Hierarchy card** (chain-to-Thing + one child level, indented monospace, current node highlighted, cross-ontology attribution, external Ontobee links, "∈" for individuals, secondary parents as a separate "Also subclass of" row). It answers "where does this sit" without any tree UI, JS, or depth explosion — ideal for plain server-rendered HTML.
2. **The data-driven section macro system + view rulebook split** (`component_sections.html` + `component_page_rulebook.py`): structure comes from data, chrome (labels/badges/tooltips/colors) from one spec table; empty groups vanish. Trivially portable to any template engine or static generator.
3. **The Cytoscape data convention** of `build_basic_visualization`: object properties as labeled domain→range edges, datatype props omitted and counted, deprecated filtered, out-of-graph parents as color-coded external placeholder nodes, plus the node-click → entity-page link. The JSON shape is directly reusable.
4. **The Property Structure / Referenced-By tables** (outgoing props via `rdfs:domain` on class-or-ancestor with inherited-italics, union domains/ranges fanned out per member, and the in-degree "Referenced By" view via `rdfs:range`) plus the **"Defined as"** equivalentClass verbalizer — together they make a class page read as schema, not a triple dump.
5. **Fragment-pretty URLs with definitional-row preference** (`/entity/<ont>/<fragment>`, cross-ontology fallback, canonical-store ranking in `definitional_entity_for_uri`) and content negotiation on `/ontology/<name>` (browser → HTML, Accept: turtle/rdf+xml/json-ld → data). For a static site: same URL scheme, formats pre-serialized at build time.

### (b) Three things to deliberately NOT copy
1. **Per-request full-TTL rdflib parsing.** One entity page parses the ontology's entire current TTL up to ~5 separate times (`entity_semantic_links`, `entity_disjoint_classes`, `entity_incoming_edges`, `entity_equivalent_class`, `generate_entity_ttl_display`), each building a fresh `rdflib.Graph`; case TTLs are 300–500 KB. Tolerable behind nginx's 10-min proxy cache in prod, disastrous without it. A no-Flask project should precompute all of these (restrictions, disjointness, incoming edges, crosswalks) into the pages at build time — parse each TTL exactly once.
2. **The N+1 / scan-heavy query patterns**: per-hop SELECTs in the ancestor walk, per-URI label lookups inside disjoint/equivalent/secondary-parent builders, `_base_subclass_closure` loading every base class row per "Used in cases" call, `class_property_schema` loading **every property row in the DB** per class page, and multi-parent matching via `properties->>'rdf_superclasses' LIKE '%"uri"%'` (unindexable text match on serialized JSON). Replicate the *outputs*; compute them once from a proper parent-edge table/closure, not row-at-a-time.
3. **The visualize page as-is**: double-initialization double fetch, dead `limit` param (full graph always shipped), destroy-and-relayout on every filter change with 1 s animations, owlready2 temp-file round trip for the hierarchy endpoint, dead `convertHierarchyToCytoscape`, `alert()` UX, and 2021 Cytoscape from unpkg. Keep its JSON shape and interactions; rebuild loading as: pinned recent Cytoscape (vendored), pre-generated static JSON per ontology, `cy.batch` + non-animated layout above a node threshold, element show/hide instead of remove/re-add, and neighborhood-expand or a size cap for graphs >~300 nodes.

Also skip: the Flask-specific auth allowlist plumbing, the ProEthica-specific chrome (D-tuple badges, case-display machinery in `web/case_display.py`/`entity_display.py`), and the ILIKE search without ranking (fine to start, but add a limit + ordering; the pgvector semantic search needs a server so it's out of scope for static HTML).

### (c) Approximate sizes (lines) for effort estimation

| Piece | File(s) | Lines |
|---|---|---|
| Hierarchy builders | `web/ontology_routes/helpers/hierarchy.py` | 308 |
| Entity-page data builders | `helpers/links.py` 397, `helpers/display.py` 319, `helpers/shapes.py` 355, `helpers/__init__.py` 62 | 1133 |
| Routes (detail + entity pages) | `web/ontology_routes/detail_routes.py` | 528 |
| View rulebook | `web/ontology_routes/component_page_rulebook.py` | 113 |
| Section macros | `templates/macros/component_sections.html` 409, `macros/entity_display.html` 157 | 566 |
| Entity page template | `templates/entity_detail.html` 535 + `static/js/entity_detail.js` 127 | 662 |
| Ontology page | `templates/ontology_detail.html` 1480 + `ontology_detail.js` 337 + `web/ontology_stats.py` 628 | 2445 |
| TTL→entity extraction | `web/entity_extraction.py` | 683 |
| Visualization server | `editor/visualization_service.py` 350 + ~50 route lines | ~400 |
| Visualization client | `static/js/editor/visualize.js` 1179 + `templates/editor/visualize.html` 548 | 1727 |
| Search (public) | in `web/main_routes.py` (~45 of 195) + `templates/search.html` 116 | ~160 |
| Data model | `web/models.py` (OntologyEntity ~50 of 512) | 512 |

Rough replication estimate for a static/server-rendered + Cytoscape rewrite: the durable logic worth porting is ~1,500–2,000 lines of builders (hierarchy, entity panels, restriction verbalization, viz JSON) + ~600 lines of templates/macros + ~400–600 lines of a cleaned-up Cytoscape client; the remaining ~5,000 lines are Flask/ProEthica/editor scaffolding you should not carry over.

UNCONFIRMED: actual render-time profiling (all performance claims derive from code reading, not measurement); `web/entity_display.py` (229 lines) and case-page macros were not read in full (case-view specific, out of scope); the claim that the visualize page is linked from the ProEthica homepage comes from a code comment in `web/app.py`.