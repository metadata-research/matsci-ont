// Validates every manifest entry. Exits nonzero on the first pass over all
// files if any entry fails, listing every failure. Shape checks only: the
// ingest pipeline verifies hashes against downloaded bytes.

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

const MANIFEST_DIR = new URL("../manifest/", import.meta.url).pathname;

const KINDS = new Set(["external-snapshot", "matsci-sam-mirror"]);
const FORMATS = new Set(["ttl", "rdfxml", "ntriples", "jsonld"]);
const SHA256 = /^[a-f0-9]{64}$/;

function isAbsoluteIri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPinnedHttps(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function checkEntry(entry, file) {
  const errors = [];
  const need = (field, ok, why) => {
    if (!ok) errors.push(`${file}: ${field} ${why}`);
  };

  need("key", typeof entry.key === "string" && entry.key.length > 0, "is required");
  need(
    "key",
    entry.key === basename(file, ".json"),
    "must match the file name",
  );
  need("kind", KINDS.has(entry.kind), `must be one of ${[...KINDS].join(", ")}`);
  need("title", typeof entry.title === "string" && entry.title.length > 0, "is required");
  need("ontologyIri", isAbsoluteIri(entry.ontologyIri), "must be an absolute IRI");
  need("graphIri", isAbsoluteIri(entry.graphIri), "must be an absolute IRI");
  need("version", typeof entry.version === "string" && entry.version.length > 0, "is required");
  need("downloadUrl", isPinnedHttps(entry.downloadUrl), "must be an https URL");
  need("sha256", SHA256.test(entry.sha256 ?? ""), "must be 64 lowercase hex characters");
  need("format", FORMATS.has(entry.format), `must be one of ${[...FORMATS].join(", ")}`);
  need("license", typeof entry.license === "string" && entry.license.length > 0, "is required (SPDX identifier)");
  need("republishable", typeof entry.republishable === "boolean", "is required and boolean");

  if (entry.allowWarnings !== undefined) {
    need("allowWarnings", typeof entry.allowWarnings === "boolean", "must be boolean when present");
  }
  if (entry.modules !== undefined) {
    need("modules", Array.isArray(entry.modules), "must be a list");
    if (Array.isArray(entry.modules)) {
      entry.modules.forEach((m, i) => {
        need(`modules[${i}].url`, isPinnedHttps(m?.url), "must be an https URL");
        need(`modules[${i}].sha256`, SHA256.test(m?.sha256 ?? ""), "must be 64 lowercase hex characters");
      });
    }
  }
  return errors;
}

const files = (await readdir(MANIFEST_DIR)).filter((f) => f.endsWith(".json"));
if (files.length === 0) {
  console.error("manifest/ holds no entries");
  process.exit(1);
}

let failures = [];
const seenGraphs = new Map();
for (const file of files.sort()) {
  let entry;
  try {
    entry = JSON.parse(await readFile(join(MANIFEST_DIR, file), "utf8"));
  } catch (e) {
    failures.push(`${file}: not valid JSON (${e.message})`);
    continue;
  }
  failures = failures.concat(checkEntry(entry, file));
  if (entry.graphIri) {
    const prior = seenGraphs.get(entry.graphIri);
    if (prior) failures.push(`${file}: graphIri already used by ${prior}`);
    seenGraphs.set(entry.graphIri, file);
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

for (const file of files.sort()) {
  const entry = JSON.parse(await readFile(join(MANIFEST_DIR, file), "utf8"));
  console.log(
    `${entry.key.padEnd(16)} ${entry.version.padEnd(10)} ${entry.license.padEnd(14)} ` +
      `republishable=${entry.republishable} ${entry.format}`,
  );
}
console.log(`OK: ${files.length} entries`);
