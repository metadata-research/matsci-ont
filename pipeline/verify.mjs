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
import { graphIris, baseUrl } from "./lib/derive.mjs";

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
const declared = new Set([
  ...manifest.map((entry) => entry.graphIri),
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
