// Builds the TDB2 store from the manifest.
//
//   fetch (content-addressed cache) -> verify sha256 -> riot --validate
//   -> tdb2.tdbloader --graph=<graphIri>
//
// The build goes to build/tdb2.new and is swapped into place only when every
// source succeeds, so a failed run never leaves a half-built store.
//
//   node pipeline/ingest.mjs [--only=key,key] [--keep-going]

import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, jenaEnvironment, runJena, hashFile, download } from "./lib/tools.mjs";
import { loadManifest, artifactsOf, extensionFor } from "./lib/manifest.mjs";

const CACHE_DIR = join(ROOT, "cache");
const BUILD_DIR = join(ROOT, "build");
const STORE = join(BUILD_DIR, "tdb2");
const STAGING = join(BUILD_DIR, "tdb2.new");

const options = {
  only: null,
  keepGoing: false,
};
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--only=")) {
    options.only = new Set(argument.slice("--only=".length).split(","));
  } else if (argument === "--keep-going") {
    options.keepGoing = true;
  } else {
    console.error(`unknown option ${argument}`);
    process.exit(2);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// The cache is keyed by content digest, so a cached file is a verified file
// and a changed pin can never collide with the artifact it replaced.
async function fetchArtifact(artifact) {
  const path = join(CACHE_DIR, `${artifact.sha256}.${extensionFor(artifact.format)}`);
  if (await exists(path)) return path;

  await mkdir(CACHE_DIR, { recursive: true });
  process.stderr.write(`  fetching ${artifact.url}\n`);
  await download(artifact.url, path);

  const actual = await hashFile(path, "sha256");
  if (actual !== artifact.sha256) {
    await rm(path, { force: true });
    throw new Error(
      `digest mismatch for ${artifact.url}\n    manifest ${artifact.sha256}\n    fetched  ${actual}`,
    );
  }
  return path;
}

const environment = await jenaEnvironment();
const entries = (await loadManifest()).filter(
  (entry) => !options.only || options.only.has(entry.key),
);
if (entries.length === 0) {
  console.error("no manifest entries selected");
  process.exit(2);
}

await mkdir(BUILD_DIR, { recursive: true });
await rm(STAGING, { recursive: true, force: true });

const failures = [];
const loaded = [];

for (const entry of entries) {
  process.stderr.write(`${entry.key} ${entry.version}\n`);
  try {
    if (!entry.republishable) {
      throw new Error("entry is not republishable and must not enter the store");
    }

    const paths = [];
    for (const artifact of artifactsOf(entry)) {
      const path = await fetchArtifact(artifact);
      const validation = runJena(environment, "riot", ["--validate", path]);
      if (validation.status !== 0) {
        throw new Error(
          `riot rejected ${artifact.url}\n${validation.stderr.trim().split("\n").slice(0, 5).join("\n")}`,
        );
      }
      // riot exits 0 on warnings, so an ill-typed literal would otherwise
      // enter the store unremarked. A source that legitimately warns needs
      // "allowWarnings": true in its manifest entry, which records the
      // decision where the pin is.
      const warnings = validation.stderr
        .split("\n")
        .filter((line) => line.includes("WARN"));
      if (warnings.length > 0 && !entry.allowWarnings) {
        throw new Error(
          `riot warned on ${artifact.url}\n${warnings.slice(0, 5).join("\n")}` +
            (warnings.length > 5 ? `\n  and ${warnings.length - 5} more` : "") +
            `\n  set "allowWarnings": true in the manifest entry to accept these`,
        );
      }
      if (warnings.length > 0) {
        process.stderr.write(`  ${warnings.length} warning(s) accepted by manifest\n`);
      }
      paths.push(path);
    }

    const load = runJena(environment, "tdb2.tdbloader", [
      `--loc=${STAGING}`,
      `--graph=${entry.graphIri}`,
      ...paths,
    ]);
    if (load.status !== 0) {
      throw new Error(`tdbloader failed\n${load.stderr.trim().split("\n").slice(-5).join("\n")}`);
    }
    loaded.push({ key: entry.key, graphIri: entry.graphIri, files: paths.length });
    process.stderr.write(`  loaded ${paths.length} file(s)\n`);
  } catch (error) {
    failures.push({ key: entry.key, message: error.message });
    process.stderr.write(`  FAILED ${error.message}\n`);
    if (!options.keepGoing) break;
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} source(s) did not load`);
  for (const failure of failures) console.error(`  ${failure.key}: ${failure.message}`);
  console.error("the previous store is unchanged");
  process.exit(1);
}

// A partial selection would otherwise publish a store missing every source it
// did not build.
if (options.only) {
  process.stderr.write(`\nbuilt ${STAGING} (partial selection, not swapped into place)\n`);
  process.exit(0);
}

await rm(STORE, { recursive: true, force: true });
await rename(STAGING, STORE);

const report = {
  builtAt: new Date().toISOString(),
  jena: environment.pins.jena.version,
  sources: loaded,
};
await writeFile(join(BUILD_DIR, "ingest-report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`OK: ${loaded.length} sources loaded into ${STORE}`);
