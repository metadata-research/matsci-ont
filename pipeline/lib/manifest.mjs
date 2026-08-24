// Reads the manifest. The store is a pure function of what this returns.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./tools.mjs";

export const MANIFEST_DIR = join(ROOT, "manifest");

const EXTENSIONS = {
  ttl: "ttl",
  rdfxml: "rdf",
  ntriples: "nt",
  jsonld: "jsonld",
};

export function extensionFor(format) {
  const extension = EXTENSIONS[format];
  if (!extension) throw new Error(`unknown format ${format}`);
  return extension;
}

export async function loadManifest() {
  const files = (await readdir(MANIFEST_DIR)).filter((f) => f.endsWith(".json"));
  const entries = [];
  for (const file of files.sort()) {
    entries.push(JSON.parse(await readFile(join(MANIFEST_DIR, file), "utf8")));
  }
  return entries;
}

// Every artifact an entry loads: the main file first, then its pinned
// modules. All of them land in the one named graph of the entry.
export function artifactsOf(entry) {
  const artifacts = [
    { url: entry.downloadUrl, sha256: entry.sha256, format: entry.format },
  ];
  for (const module of entry.modules ?? []) {
    artifacts.push({
      url: module.url,
      sha256: module.sha256,
      format: module.format ?? entry.format,
    });
  }
  return artifacts;
}
