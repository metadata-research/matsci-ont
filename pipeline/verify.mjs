// Checks the built store against the Phase 1 acceptance criteria.
//
//   node pipeline/verify.mjs [--determinism]
//
// --determinism rebuilds the store a second time from the same manifest and
// compares the exports. It is off by default because it doubles the build.

import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ROOT, jenaEnvironment, runJena } from "./lib/tools.mjs";
import { loadManifest } from "./lib/manifest.mjs";
import { startFuseki, stopFuseki, query } from "./lib/fuseki.mjs";

const STORE = join(ROOT, "build/tdb2");
const SECOND_STORE = join(ROOT, "build/tdb2.verify");
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

let server;
try {
  server = await startFuseki({ storeLocation: STORE });

  // Every manifest source holds triples, under the graph the manifest names.
  const counts = await query(
    server.base,
    "SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g",
  );
  const byGraph = new Map();
  if (counts.ok) {
    for (const binding of JSON.parse(counts.text).results.bindings) {
      byGraph.set(binding.g.value, Number(binding.n.value));
    }
  }
  const missing = manifest.filter((entry) => !(byGraph.get(entry.graphIri) > 0));
  record(
    "every source loaded a nonempty graph",
    counts.ok && missing.length === 0,
    missing.length > 0
      ? `empty or absent: ${missing.map((e) => e.key).join(", ")}`
      : manifest
          .map((e) => `${e.key} ${byGraph.get(e.graphIri).toLocaleString()} triples`)
          .join("\n"),
  );

  // Known entities still resolve under their pins.
  const unresolved = [];
  for (const fixture of fixtures.entities) {
    const answer = await query(
      server.base,
      `SELECT ?label WHERE { GRAPH ?g { <${fixture.iri}> ?p ?o
         OPTIONAL { <${fixture.iri}> <http://www.w3.org/2004/02/skos/core#prefLabel>|<http://www.w3.org/2000/01/rdf-schema#label> ?label } } }
       LIMIT 50`,
    );
    const labels = answer.ok
      ? JSON.parse(answer.text).results.bindings.map((b) => b.label?.value).filter(Boolean)
      : [];
    const found = answer.ok && JSON.parse(answer.text).results.bindings.length > 0;
    const labelled = labels.some((l) => l.toLowerCase() === fixture.expectLabel.toLowerCase());
    if (!found || !labelled) {
      unresolved.push(`${fixture.iri} (found=${found}, expected label ${fixture.expectLabel})`);
    }
  }
  record(
    "known entities resolve with their labels",
    unresolved.length === 0,
    unresolved.length > 0 ? unresolved.join("\n") : `${fixtures.entities.length} fixtures`,
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
} finally {
  await stopFuseki(server);
}

// Two runs of the same manifest describe the same graph. TDB2 directories are
// not byte-stable, so the comparison is over exported quads: ground quads
// must hash identically, and quads carrying a blank node must match in count
// per graph. Blank node labels are minted per load and are not compared.
function exportQuads(location) {
  const dump = runJena(environment, "tdb2.tdbdump", [`--loc=${location}`]);
  if (dump.status !== 0) throw new Error(`tdbdump failed for ${location}\n${dump.stderr}`);
  const ground = [];
  const blank = new Map();
  for (const line of dump.stdout.split("\n")) {
    if (line.trim() === "") continue;
    if (line.includes("_:")) {
      const graph = line.slice(line.lastIndexOf("<"), line.lastIndexOf(">") + 1);
      blank.set(graph, (blank.get(graph) ?? 0) + 1);
    } else {
      ground.push(line);
    }
  }
  ground.sort();
  return {
    groundHash: createHash("sha256").update(ground.join("\n")).digest("hex"),
    groundCount: ground.length,
    blank: Object.fromEntries([...blank.entries()].sort()),
  };
}

if (withDeterminism) {
  await rm(SECOND_STORE, { recursive: true, force: true });
  const rebuild = spawnSync(
    process.execPath,
    [join(ROOT, "pipeline/ingest.mjs"), "--only=" + manifest.map((e) => e.key).join(",")],
    { cwd: ROOT, encoding: "utf8", env: process.env, maxBuffer: 1024 * 1024 * 64 },
  );
  // --only builds into build/tdb2.new without swapping, which is what a
  // comparison run wants.
  const staging = join(ROOT, "build/tdb2.new");
  if (rebuild.status !== 0) {
    record("a second run describes the same graph", false, `rebuild failed\n${rebuild.stderr}`);
  } else {
    const first = exportQuads(STORE);
    const second = exportQuads(staging);
    const same =
      first.groundHash === second.groundHash &&
      JSON.stringify(first.blank) === JSON.stringify(second.blank);
    record(
      "a second run describes the same graph",
      same,
      same
        ? `${first.groundCount.toLocaleString()} ground quads, hash ${first.groundHash.slice(0, 16)}; ` +
            `blank-node quads per graph equal`
        : `ground ${first.groundHash.slice(0, 16)} vs ${second.groundHash.slice(0, 16)}\n` +
            `blank ${JSON.stringify(first.blank)} vs ${JSON.stringify(second.blank)}`,
    );
    await rm(staging, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.pass);
await writeFile(
  join(ROOT, "build/verify-report.json"),
  `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length} of ${results.length} checks`);
  process.exit(1);
}
console.log(`\nOK: ${results.length} checks`);
