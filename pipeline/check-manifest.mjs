// Validates every manifest entry. Exits nonzero on the first pass over all
// files if any entry fails, listing every failure. Shape checks only: the
// ingest pipeline verifies hashes against downloaded bytes.

import { readdir, readFile } from "node:fs/promises"
import { join, basename } from "node:path"

const MANIFEST_DIR = new URL("../manifest/", import.meta.url).pathname

const KINDS = new Set(["external-snapshot", "matsci-sam-mirror"])
const FORMATS = new Set(["ttl", "rdfxml", "ntriples", "jsonld"])
const SHA256 = /^[a-f0-9]{64}$/
// The value a source uses when its publisher has stated no licence.
export const UNDECLARED = "UNDECLARED"

function isAbsoluteIri(value) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function isPinnedHttps(value) {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

function checkEntry(entry, file) {
  const errors = []
  const need = (field, ok, why) => {
    if (!ok) errors.push(`${file}: ${field} ${why}`)
  }

  need(
    "key",
    typeof entry.key === "string" && entry.key.length > 0,
    "is required"
  )
  need("key", entry.key === basename(file, ".json"), "must match the file name")
  need("kind", KINDS.has(entry.kind), `must be one of ${[...KINDS].join(", ")}`)
  need(
    "title",
    typeof entry.title === "string" && entry.title.length > 0,
    "is required"
  )
  need("graphIri", isAbsoluteIri(entry.graphIri), "must be an absolute IRI")
  need(
    "format",
    FORMATS.has(entry.format),
    `must be one of ${[...FORMATS].join(", ")}`
  )
  need(
    "license",
    typeof entry.license === "string" && entry.license.length > 0,
    "is required (SPDX identifier)"
  )
  need(
    "republishable",
    typeof entry.republishable === "boolean",
    "is required and boolean"
  )
  // Clearing a source for publication is a claim that its licence permits
  // it. UNDECLARED says the publisher has not made that claim, so the two
  // are coupled here rather than left to an editor to keep consistent.
  need(
    "republishable",
    !(entry.license === UNDECLARED && entry.republishable === true),
    `cannot be true while the licence is ${UNDECLARED}`
  )

  // A mirror is the one thing this manifest declares to be moving. It is
  // fetched fresh from a living dataset rather than pinned, so it has a
  // fetch URL and no digest or version. Every other source is pinned, and
  // the two rules are kept apart so neither can be relaxed by accident.
  if (entry.kind === "matsci-sam-mirror") {
    need(
      "fetchUrl",
      isPinnedHttps(entry.fetchUrl),
      "must be an https URL on a mirror"
    )
    need(
      "sha256",
      entry.sha256 === undefined,
      "must be absent on a mirror, which is not pinned"
    )
    need(
      "version",
      entry.version === undefined,
      "must be absent on a mirror, which is not pinned"
    )
    need(
      "sourceDataset",
      isAbsoluteIri(entry.sourceDataset),
      "must be the IRI of the dataset being mirrored"
    )
    need(
      "authorityBase",
      isPinnedHttps(entry.authorityBase),
      "must be the https base a mirrored entity resolves under"
    )
  } else {
    need(
      "ontologyIri",
      isAbsoluteIri(entry.ontologyIri),
      "must be an absolute IRI"
    )
    need(
      "version",
      typeof entry.version === "string" && entry.version.length > 0,
      "is required"
    )
    need(
      "downloadUrl",
      isPinnedHttps(entry.downloadUrl),
      "must be an https URL"
    )
    need(
      "sha256",
      SHA256.test(entry.sha256 ?? ""),
      "must be 64 lowercase hex characters"
    )
    need(
      "fetchUrl",
      entry.fetchUrl === undefined,
      "belongs to a mirror, not a pinned source"
    )
  }

  if (entry.allowWarnings !== undefined) {
    need(
      "allowWarnings",
      typeof entry.allowWarnings === "boolean",
      "must be boolean when present"
    )
  }
  if (entry.reason !== undefined) {
    need(
      "reason",
      typeof entry.reason === "boolean",
      "must be boolean when present"
    )
  }
  if (entry.modules !== undefined) {
    need("modules", Array.isArray(entry.modules), "must be a list")
    if (Array.isArray(entry.modules)) {
      entry.modules.forEach((m, i) => {
        need(`modules[${i}].url`, isPinnedHttps(m?.url), "must be an https URL")
        need(
          `modules[${i}].sha256`,
          SHA256.test(m?.sha256 ?? ""),
          "must be 64 lowercase hex characters"
        )
        // Required whenever the source is reasoned: a module the reasoning
        // catalog cannot name is loaded into the store but left out of the
        // reasoning input.
        if (entry.reason !== false) {
          need(
            `modules[${i}].importIri`,
            isAbsoluteIri(m?.importIri),
            "must be an absolute IRI on a source that is reasoned"
          )
        } else if (m?.importIri !== undefined) {
          need(
            `modules[${i}].importIri`,
            isAbsoluteIri(m.importIri),
            "must be an absolute IRI"
          )
        }
      })
    }
  }
  // Imports resolved to an empty ontology, which is how a source loads
  // without the ontologies it names until those are pinned themselves.
  if (entry.importsToEmpty !== undefined) {
    need(
      "importsToEmpty",
      Array.isArray(entry.importsToEmpty),
      "must be a list"
    )
    if (Array.isArray(entry.importsToEmpty)) {
      entry.importsToEmpty.forEach((iri, i) => {
        need(
          `importsToEmpty[${i}]`,
          isAbsoluteIri(iri),
          "must be an absolute IRI"
        )
      })
    }
  }

  // One import, one mapping. An IRI named in both lists would resolve to
  // whichever the catalog wrote last, quietly reasoning over an empty
  // ontology in place of a pinned module.
  const mapped = new Set()
  const twice = new Set()
  for (const iri of [
    ...(entry.modules ?? []).map((m) => m?.importIri).filter(Boolean),
    ...(entry.importsToEmpty ?? [])
  ]) {
    if (mapped.has(iri)) twice.add(iri)
    mapped.add(iri)
  }
  for (const iri of twice) {
    errors.push(
      `${file}: ${iri} is mapped both to a module and to the empty ontology`
    )
  }
  return errors
}

const files = (await readdir(MANIFEST_DIR)).filter((f) => f.endsWith(".json"))
if (files.length === 0) {
  console.error("manifest/ holds no entries")
  process.exit(1)
}

let failures = []
const seenGraphs = new Map()
for (const file of files.sort()) {
  let entry
  try {
    entry = JSON.parse(await readFile(join(MANIFEST_DIR, file), "utf8"))
  } catch (e) {
    failures.push(`${file}: not valid JSON (${e.message})`)
    continue
  }
  failures = failures.concat(checkEntry(entry, file))
  if (entry.graphIri) {
    const prior = seenGraphs.get(entry.graphIri)
    if (prior) failures.push(`${file}: graphIri already used by ${prior}`)
    seenGraphs.set(entry.graphIri, file)
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} problem(s)`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}

for (const file of files.sort()) {
  const entry = JSON.parse(await readFile(join(MANIFEST_DIR, file), "utf8"))
  console.log(
    `${entry.key.padEnd(16)} ${(entry.version ?? "mirror").padEnd(10)} ${entry.license.padEnd(14)} ` +
      `republishable=${entry.republishable} ${entry.format}`
  )
}
console.log(`OK: ${files.length} entries`)
