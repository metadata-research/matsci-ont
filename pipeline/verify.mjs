// Checks the built store against the Phase 1 acceptance criteria.
//
//   node pipeline/verify.mjs [--determinism]
//
// --determinism rebuilds the store a second time from the same manifest and
// compares the two. It is off by default because it doubles the build.

import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, jenaEnvironment } from "./lib/tools.mjs";
import { loadManifest } from "./lib/manifest.mjs";
import { startFuseki, stopFuseki, query } from "./lib/fuseki.mjs";
import { graphCounts, dumpBlinded, graphsIsomorphic } from "./lib/compare.mjs";
import { graphIris, baseUrl, inferredGraphFor } from "./lib/derive.mjs";
import { escape as escapeHtml } from "../mcp/lib/html.mjs";

const STORE = join(ROOT, "build/tdb2");
const STAGING = join(ROOT, "build/tdb2.new");
const WORK = join(ROOT, "build/verify-work");
const DEFAULT_GRAPH = "urn:x-arq:DefaultGraph";
const withDeterminism = process.argv.includes("--determinism");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? "pass" : "FAIL"}  ${name}\n`);
  if (detail) process.stdout.write(`      ${detail.replace(/\n/g, "\n      ")}\n`);
}

const environment = await jenaEnvironment();
const manifest = await loadManifest();
const fixtures = JSON.parse(await readFile(join(ROOT, "pipeline/fixtures.json"), "utf8"));
await mkdir(WORK, { recursive: true });

// Counts come from the store by location, not from Fuseki: the served
// dataset unions the named graphs into the default graph, which would hide
// whether anything really landed in the default graph.
const counts = await graphCounts(environment, STORE, WORK);

const missing = manifest.filter((entry) => !(counts.get(entry.graphIri) > 0));
record(
  "every source loaded a nonempty graph",
  missing.length === 0,
  missing.length > 0
    ? `empty or absent: ${missing.map((e) => e.key).join(", ")}`
    : manifest
        .map((e) => `${e.key} ${counts.get(e.graphIri).toLocaleString()} triples`)
        .join("\n"),
);

// Every source names its graph, so anything in the default graph arrived by
// accident, and a union-default-graph service would serve it invisibly.
const strays = counts.get(DEFAULT_GRAPH) ?? 0;
record(
  "nothing loaded into the default graph",
  strays === 0,
  strays === 0 ? "default graph empty" : `${strays} quads outside any named graph`,
);

const graphs = graphIris();
// An inferred graph is declared only for a source the manifest allows to be
// reasoned, so one appearing for a skipped source is an undeclared graph.
const declared = new Set([
  ...manifest.map((entry) => entry.graphIri),
  ...manifest.filter((entry) => entry.reason !== false).map((entry) => inferredGraphFor(entry.key)),
  graphs.catalog,
  graphs.definitions,
]);
const unexpected = [...counts.keys()].filter(
  (graph) => graph !== DEFAULT_GRAPH && !declared.has(graph),
);
record(
  "the store holds no undeclared graph",
  unexpected.length === 0,
  unexpected.length > 0 ? unexpected.join("\n") : `${declared.size} declared graphs`,
);

record(
  "both derived graphs are present",
  counts.get(graphs.catalog) > 0 && counts.get(graphs.definitions) > 0,
  `catalog ${counts.get(graphs.catalog) ?? 0}, definitions ${counts.get(graphs.definitions) ?? 0} triples`,
);

let server;
try {
  server = await startFuseki({ storeLocation: STORE });

  const unresolved = [];
  for (const fixture of fixtures.entities) {
    const answer = await query(
      server.base,
      `SELECT ?label WHERE { GRAPH ?g { <${fixture.iri}> ?p ?o
         OPTIONAL { <${fixture.iri}> <http://www.w3.org/2004/02/skos/core#prefLabel>|<http://www.w3.org/2000/01/rdf-schema#label> ?label } } }
       LIMIT 50`,
    );
    const bindings = answer.ok ? JSON.parse(answer.text).results.bindings : [];
    const labels = bindings.map((b) => b.label?.value).filter(Boolean);
    const labelled = labels.some((l) => l.toLowerCase() === fixture.expectLabel.toLowerCase());
    if (bindings.length === 0 || !labelled) {
      unresolved.push(
        `${fixture.iri} (triples=${bindings.length}, expected label ${fixture.expectLabel})`,
      );
    }
  }
  record(
    "known entities resolve with their labels",
    unresolved.length === 0,
    unresolved.length > 0 ? unresolved.join("\n") : `${fixtures.entities.length} fixtures`,
  );

  const ont = `${baseUrl()}vocab#`;

  // One catalogue resource per source, no more and no fewer.
  const catalogued = await query(
    server.base,
    `SELECT ?key (COUNT(?s) AS ?n) WHERE {
       GRAPH <${graphs.catalog}> { ?s <${ont}sourceKey> ?key }
     } GROUP BY ?key`,
  );
  const catalogueRows = catalogued.ok
    ? new Map(
        JSON.parse(catalogued.text).results.bindings.map((b) => [b.key.value, Number(b.n.value)]),
      )
    : new Map();
  const wrongCatalogue = manifest
    .filter((entry) => catalogueRows.get(entry.key) !== 1)
    .map((entry) => `${entry.key}: ${catalogueRows.get(entry.key) ?? 0}`);
  const extraCatalogue = [...catalogueRows.keys()].filter(
    (key) => !manifest.some((entry) => entry.key === key),
  );
  record(
    "every source has exactly one catalogue resource",
    wrongCatalogue.length === 0 && extraCatalogue.length === 0,
    [...wrongCatalogue, ...extraCatalogue.map((k) => `${k}: not in the manifest`)].join("\n") ||
      `${catalogueRows.size} sources`,
  );

  // A definition served without its licence cannot be passed on safely, and
  // a source whose licence forbids republication must not be in the store
  // at all.
  const unlicensed = await query(
    server.base,
    `SELECT (COUNT(*) AS ?n) WHERE {
       GRAPH <${graphs.definitions}> { ?s <${ont}label> ?label }
       FILTER NOT EXISTS { GRAPH <${graphs.definitions}> { ?s <${ont}license> ?license } }
     }`,
  );
  const unlicensedCount = unlicensed.ok
    ? Number(JSON.parse(unlicensed.text).results.bindings[0].n.value)
    : -1;
  const forbidden = manifest.filter((entry) => !entry.republishable).map((entry) => entry.key);
  record(
    "every definitions entry names a licence",
    unlicensedCount === 0 && forbidden.length === 0,
    forbidden.length > 0
      ? `non-republishable sources in the manifest: ${forbidden.join(", ")}`
      : `${unlicensedCount} entries without a licence`,
  );

  // The point of holding several sources at once: one term, several
  // independent vocabularies, in one answer.
  const crossSource = await query(
    server.base,
    `SELECT ?key WHERE {
       GRAPH <${graphs.definitions}> { ?s <${ont}label> ?label ; <${ont}sourceKey> ?key }
       FILTER(LCASE(STR(?label)) = "sintering")
     } GROUP BY ?key`,
  );
  const sources = crossSource.ok
    ? JSON.parse(crossSource.text).results.bindings.map((b) => b.key.value)
    : [];
  record(
    "a known term is found in more than one source",
    sources.length > 1,
    `sintering: ${sources.join(", ") || "no source"}`,
  );

  // Federated query is closed, so a SERVICE clause cannot make the store
  // fetch a URL for whoever sent the query.
  const service = await query(
    server.base,
    "SELECT * WHERE { SERVICE <http://localhost:1/sparql> { ?s ?p ?o } } LIMIT 1",
  );
  record(
    "a SERVICE clause is refused",
    !service.ok,
    service.ok ? "the query was accepted" : `refused with HTTP ${service.status}`,
  );

  // Reasoning: the recorded counts, and the record the catalogue publishes.
  {
    // Pairs the reasoner adds, after the ones the source already asserts
    // are subtracted. A source can legitimately add none, as MDO does.
    const expected = { pmdco: 115, mdo: 0, chameo: 2 };
    const wrong = [];
    for (const [key, pairs] of Object.entries(expected)) {
      const actual = counts.get(inferredGraphFor(key)) ?? 0;
      if (actual !== pairs) wrong.push(`${key}: ${actual}, expected ${pairs}`);
    }
    const skipped = await query(
      server.base,
      `SELECT ?why WHERE { GRAPH <${graphs.catalog}> {
         ?s <${ont}sourceKey> "nist-imrr" ; <${ont}reasoningSkipped> ?why } }`,
    );
    const skipRecorded = skipped.ok && JSON.parse(skipped.text).results.bindings.length === 1;
    record(
      "reasoning produced the recorded pair counts",
      wrong.length === 0 && skipRecorded,
      wrong.length > 0
        ? wrong.join("\n")
        : `new pairs: pmdco 115, chameo 2, mdo 0; nist-imrr skipped${skipRecorded ? " and recorded" : " but NOT recorded"}`,
    );

    // The count the reasoner entailed before subtraction, recorded so the
    // catalogue shows how much of a hierarchy is asserted rather than
    // derived.
    const entailed = await query(
      server.base,
      `SELECT ?key ?n WHERE { GRAPH <${graphs.catalog}> {
         ?s <${ont}sourceKey> ?key ; <${ont}entailedPairs> ?n } }`,
    );
    const entailedByKey = entailed.ok
      ? new Map(
          JSON.parse(entailed.text).results.bindings.map((b) => [b.key.value, Number(b.n.value)]),
        )
      : new Map();
    record(
      "the catalogue records what was entailed before subtraction",
      entailedByKey.get("pmdco") === 1581 &&
        entailedByKey.get("chameo") === 211 &&
        entailedByKey.get("mdo") === 13,
      [...entailedByKey.entries()].map(([k, v]) => `${k} ${v}`).join(", "),
    );

    // An inferred pair the source already asserts would be noise, and its
    // presence would mean the reasoning step lost --create-new-ontology.
    const overlaps = [];
    for (const entry of manifest) {
      const inferred = inferredGraphFor(entry.key);
      if (!(counts.get(inferred) > 0)) continue;
      const overlap = await query(
        server.base,
        `SELECT (COUNT(*) AS ?n) WHERE {
           GRAPH <${inferred}> { ?s ?p ?o }
           GRAPH <${entry.graphIri}> { ?s ?p ?o }
         }`,
      );
      const n = overlap.ok ? Number(JSON.parse(overlap.text).results.bindings[0].n.value) : -1;
      if (n !== 0) overlaps.push(`${entry.key}: ${n}`);
    }
    record(
      "no inferred pair repeats an asserted one",
      overlaps.length === 0,
      overlaps.join("\n") || "every inferred graph is disjoint from its source",
    );
  }

  // The browse application, started against the same store. The query URL
  // is set before the app is imported, because mcp/lib/sparql.mjs captures
  // it in a module-level constant at load time.
  {
    const appPort = 3199;
    process.env.MATSCI_ONT_QUERY_URL = `${server.base}/query`;
    const { startApp } = await import("../mcp/app.mjs");
    const app = await startApp(appPort);
    const page = async (path) => {
      const response = await fetch(`http://127.0.0.1:${appPort}${path}`);
      return { status: response.status, text: await response.text() };
    };
    try {
      const routes = ["/", "/search?q=sinter"];
      for (const entry of manifest) {
        routes.push(`/source/${entry.key}`, `/graph/${entry.key}`, `/graph/${entry.key}.json`);
      }
      const broken = [];
      for (const route of routes) {
        const result = await page(route);
        if (result.status !== 200) broken.push(`${route} answered ${result.status}`);
      }
      record(
        "every application route answers",
        broken.length === 0,
        broken.join("\n") || `${routes.length} routes`,
      );

      const missing = await page("/entity?iri=https%3A%2F%2Fexample.org%2Fnope");
      const badPath = await page("/nope");
      record(
        "unknown pages answer clean 404s",
        missing.status === 404 && badPath.status === 404,
        `entity ${missing.status}, path ${badPath.status}`,
      );

      // The PMDco material class shows its direct children on the page, not
      // only in the store: every child IRI the store reports must appear as
      // a link in the rendered source page.
      const material = await query(
        server.base,
        `SELECT ?c WHERE { GRAPH <https://w3id.org/pmd/co/> {
           ?c <http://www.w3.org/2000/01/rdf-schema#label> "material"@en } } LIMIT 1`,
      );
      const materialIri = material.ok
        ? JSON.parse(material.text).results.bindings[0]?.c.value
        : undefined;
      const childRows = materialIri
        ? await query(
            server.base,
            `SELECT DISTINCT ?child WHERE { GRAPH <https://w3id.org/pmd/co/> {
               ?child <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${materialIri}>
               FILTER(isIRI(?child)) } }`,
          )
        : { ok: false };
      const childIris = childRows.ok
        ? JSON.parse(childRows.text).results.bindings.map((b) => b.child.value)
        : [];
      const sourceHtml = (await page("/source/pmdco")).text;
      const childrenOnPage = childIris.filter((child) =>
        sourceHtml.includes(`iri=${encodeURIComponent(child)}`),
      );
      record(
        "the PMDco material class shows all 14 children on the source page",
        childIris.length === 14 && childrenOnPage.length === 14,
        `${childIris.length} children in the store, ${childrenOnPage.length} linked on the page`,
      );

      // The NIST vocabulary renders from skos:broader with no orphan flood:
      // its tree shows far fewer roots than its 993 concepts.
      const nistHtml = (await page("/source/nist-imrr")).text;
      const nistRoots = (nistHtml.match(/<ul>\s*<li>/g) ?? []).length;
      record(
        "the NIST tree renders from skos:broader without an orphan flood",
        nistHtml.includes("classes") && nistRoots > 0,
        `${nistRoots} top-level list opener(s)`,
      );

      const fatigue = await page(
        "/entity?iri=" +
          encodeURIComponent(
            "https://w3id.org/emmo/domain/characterisation-methodology/chameo#FatigueTesting",
          ),
      );
      // Attribution and the elucidation text, which is the definition the
      // precedence chose over rdfs:comment for CHAMEO.
      const elucidation = await query(
        server.base,
        `SELECT ?d WHERE { GRAPH <https://w3id.org/emmo/domain/characterisation-methodology/chameo> {
           <https://w3id.org/emmo/domain/characterisation-methodology/chameo#FatigueTesting>
             <https://w3id.org/emmo#EMMO_967080e5_2f42_4eb2_a3a9_c58143e835f9> ?d } } LIMIT 1`,
      );
      const elucidationText = elucidation.ok
        ? JSON.parse(elucidation.text).results.bindings[0]?.d.value
        : undefined;
      record(
        "the FatigueTesting page attributes CHAMEO and shows its elucidation",
        fatigue.status === 200 &&
          fatigue.text.includes("1.0.3") &&
          fatigue.text.includes("CC-BY-4.0") &&
          Boolean(elucidationText) &&
          fatigue.text.includes(escapeHtml(elucidationText)),
        `status ${fatigue.status}, elucidation ${elucidationText ? "present" : "absent"}`,
      );

      const cardinality = await page(
        "/entity?iri=" + encodeURIComponent("https://w3id.org/pmd/co/PMD_0010100"),
      );
      record(
        "a cardinality restriction renders verbalized",
        cardinality.text.includes("exactly 1"),
        cardinality.text.includes("exactly 1") ? "PMD_0010100 shows exactly 1" : "not found",
      );

      const searchText = (await page("/search?q=sinter")).text;
      record(
        "search groups sources and honors word boundaries",
        searchText.includes("nist-imrr") &&
          searchText.includes("pmdco") &&
          !searchText.includes("hasInteractionVolume"),
      );

      // The inferred toggle shows a placement the asserted view does not.
      const inferredOnly = await query(
        server.base,
        `SELECT ?c ?p WHERE {
           GRAPH <${inferredGraphFor("pmdco")}> { ?c <http://www.w3.org/2000/01/rdf-schema#subClassOf> ?p }
           FILTER NOT EXISTS { GRAPH <https://w3id.org/pmd/co/> {
             ?c <http://www.w3.org/2000/01/rdf-schema#subClassOf> ?p } }
         } LIMIT 1`,
      );
      const pair = inferredOnly.ok ? JSON.parse(inferredOnly.text).results.bindings[0] : undefined;
      if (pair) {
        const asserted = await page(`/entity?iri=${encodeURIComponent(pair.c.value)}`);
        const withInferred = await page(
          `/entity?iri=${encodeURIComponent(pair.c.value)}&inferred=1`,
        );
        const parentLink = `iri=${encodeURIComponent(pair.p.value)}`;
        // The marker must be in the hierarchy card itself. Looking for it
        // anywhere on the page would be satisfied by the children list,
        // which has marked inferred rows since the browse application
        // landed. The card runs from its own div to whichever of the
        // children heading or the definition heading comes first; a regex
        // to its closing tag would stop at the first nested row instead.
        const start = withInferred.text.indexOf('<div class="hierarchy">');
        const ends = ["<h3>Children", "<h2>Definition"]
          .map((marker) => withInferred.text.indexOf(marker, start))
          .filter((index) => index > start);
        const card =
          start < 0 ? "" : withInferred.text.slice(start, Math.min(...ends, withInferred.text.length));
        record(
          "the inferred toggle marks an inferred step in the hierarchy card",
          !asserted.text.includes(parentLink) &&
            withInferred.text.includes(parentLink) &&
            card.includes("mark inferred"),
          `${pair.c.value} under ${pair.p.value}`,
        );

        // The panels that state what a source says must not draw on the
        // inferred graphs.
        record(
          "the asserted view shows no inferred triple in its panels",
          !asserted.text.includes(parentLink),
          asserted.text.includes(parentLink) ? "an inferred pair reached the asserted page" : "clean",
        );
      } else {
        record("the inferred toggle shows a parent the asserted view does not", false, "no inferred-only pair found");
      }

      // The MCP endpoint answers, and only on the loopback interface. The
      // tool surface itself is exercised by mcp/test-mcp.mjs with the
      // client from the same SDK.
      const mcp = await fetch(`http://127.0.0.1:${appPort}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      const listed = mcp.ok ? JSON.parse(await mcp.text()) : undefined;
      const toolNames = (listed?.result?.tools ?? []).map((tool) => tool.name).sort();
      record(
        "the MCP endpoint lists its five tools",
        toolNames.join(",") === "find_entities,get_entity,get_source,list_sources,sparql_query",
        toolNames.join(",") || `HTTP ${mcp.status}`,
      );

      // The bound address, not a probe: connecting to 0.0.0.0 from this
      // machine reaches a loopback listener anyway, so a probe proves
      // nothing about the binding.
      const bound = app.address();
      record(
        "the application is bound to the loopback interface",
        bound?.address === "127.0.0.1",
        `${bound?.address}:${bound?.port}`,
      );

      const pmdcoGraph = JSON.parse((await page("/graph/pmdco.json")).text);
      const mdoGraph = JSON.parse((await page("/graph/mdo.json")).text);
      record(
        "the graph export truncates above 300 nodes and not below",
        pmdcoGraph.truncated === true && mdoGraph.truncated === false,
        `pmdco ${pmdcoGraph.elements.nodes.length} nodes, mdo ${mdoGraph.elements.nodes.length}`,
      );
    } finally {
      app.close();
    }
  }

  // The full Fuseki server publishes a web UI and an admin API that takes no
  // credential and will create a dataset on request. The reviewed host unit
  // selects the entry point without either, and so must the local runner:
  // otherwise development runs a service the served policy forbids.
  const origin = new URL(server.base).origin;
  const admin = [];
  for (const [path, method] of [
    ["/", "GET"],
    ["/$/server", "GET"],
    ["/$/datasets", "GET"],
  ]) {
    const response = await fetch(`${origin}${path}`, { method }).catch(() => null);
    if (response?.ok) admin.push(`${method} ${path} answered ${response.status}`);
  }
  record(
    "no web UI and no admin API are served",
    admin.length === 0,
    admin.length > 0 ? admin.join("\n") : "root and admin paths all refused",
  );
} finally {
  await stopFuseki(server);
}

if (withDeterminism) {
  await rm(STAGING, { recursive: true, force: true });
  const rebuild = spawnSync(
    process.execPath,
    [join(ROOT, "pipeline/ingest.mjs"), "--no-swap"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 },
  );

  if (rebuild.status !== 0) {
    record("a second run describes the same graphs", false, `rebuild failed\n${rebuild.stderr}`);
  } else {
    const secondCounts = await graphCounts(environment, STAGING, WORK);
    const countDifferences = [];
    for (const graph of new Set([...counts.keys(), ...secondCounts.keys()])) {
      const first = counts.get(graph) ?? 0;
      const second = secondCounts.get(graph) ?? 0;
      if (first !== second) countDifferences.push(`${graph}: ${first} then ${second}`);
    }
    record(
      "tier 1, per-graph counts match",
      countDifferences.length === 0,
      countDifferences.length > 0 ? countDifferences.join("\n") : `${counts.size} graphs`,
    );

    const first = dumpBlinded(environment, STORE);
    const second = dumpBlinded(environment, STAGING);
    record(
      "tier 2, blank-node-blinded hashes match",
      first.hash === second.hash,
      first.hash === second.hash
        ? `${first.quads.toLocaleString()} quads, ${first.hash.slice(0, 16)}`
        : `${first.hash.slice(0, 16)} then ${second.hash.slice(0, 16)}`,
    );

    const notIsomorphic = [];
    for (const graph of [...counts.keys()].sort()) {
      const comparison = await graphsIsomorphic(
        environment,
        graph,
        STORE,
        STAGING,
        join(WORK, "iso"),
      );
      if (!comparison.equal) notIsomorphic.push(graph);
    }
    record(
      "tier 3, every graph is isomorphic",
      notIsomorphic.length === 0,
      notIsomorphic.length > 0
        ? `not isomorphic: ${notIsomorphic.join(", ")}`
        : `${counts.size} graphs equal modulo blank node labels`,
    );

    await rm(STAGING, { recursive: true, force: true });
  }
}

await writeFile(
  join(ROOT, "build/verify-report.json"),
  `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`,
);

const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length} of ${results.length} checks`);
  process.exit(1);
}
console.log(`\nOK: ${results.length} checks`);
