// Reads the manifest. The store is a pure function of what this returns.

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ROOT } from "../../shared/paths.mjs"
import { basename } from "node:path"

export const MANIFEST_DIR = join(ROOT, "manifest")

// The shape of a manifest entry, in one place. It was in the command that
// checks it, so nothing could import it, no test covered it, and the
// ingest read the manifest with no validation at all: the gate was opt-in.

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

export function checkEntry(entry, file) {
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
  // The import IRI of the entry's own main file. Needed when anything can
  // import that file: another module of the same entry, or another entry
  // reasoning through importsFrom. Without it the catalog cannot name the
  // main file and the import fails at the dead proxy.
  if (entry.importIri !== undefined) {
    need("importIri", isAbsoluteIri(entry.importIri), "must be an absolute IRI")
  }
  // Entries whose pinned files join this entry's reasoning catalog. The
  // files are used for reasoning only and are never loaded into this
  // entry's graph, which is what keeps another publisher's content out of
  // this source's attribution. The referenced keys are checked across the
  // manifest, not here.
  if (entry.importsFrom !== undefined) {
    need("importsFrom", Array.isArray(entry.importsFrom), "must be a list")
    if (Array.isArray(entry.importsFrom)) {
      entry.importsFrom.forEach((key, i) => {
        need(
          `importsFrom[${i}]`,
          typeof key === "string" && key.length > 0,
          "must be an entry key"
        )
      })
      const onceEach = new Set(entry.importsFrom)
      need(
        "importsFrom",
        onceEach.size === entry.importsFrom.length,
        "must not name an entry twice"
      )
    }
    // The field only feeds the reasoning catalog, so on a source that is
    // never reasoned it is inert: it would read as protection while
    // providing none.
    need(
      "importsFrom",
      entry.reason !== false && entry.kind !== "matsci-sam-mirror",
      "has no effect on a source that is not reasoned"
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
  for (const iri of ownMappedIris(entry)) {
    if (mapped.has(iri)) twice.add(iri)
    mapped.add(iri)
  }
  for (const iri of twice) {
    errors.push(
      `${file}: ${iri} is mapped more than once in this entry's reasoning catalog`
    )
  }
  return errors
}

const EXTENSIONS = {
  ttl: "ttl",
  rdfxml: "rdf",
  ntriples: "nt",
  jsonld: "jsonld"
}

export function extensionFor(format) {
  const extension = EXTENSIONS[format]
  if (!extension) throw new Error(`unknown format ${format}`)
  return extension
}

// The import IRIs an entry maps in its own catalog: its main file, its
// modules, and its imports resolved to the empty ontology.
function ownMappedIris(entry) {
  return [
    ...(entry.importIri ? [entry.importIri] : []),
    ...(entry.modules ?? []).map((m) => m?.importIri).filter(Boolean),
    ...(entry.importsToEmpty ?? [])
  ]
}

// The pinned artifacts of an entry as catalog mappings, for an entry that
// reasons through importsFrom. Every artifact must carry an import IRI, so
// nothing the closure needs resolves nowhere; the cross-entry check below
// enforces that before a build starts.
export function catalogMappingsOf(entry) {
  const mappings = []
  if (entry.importIri) {
    mappings.push({
      iri: entry.importIri,
      sha256: entry.sha256,
      format: entry.format
    })
  }
  for (const module of entry.modules ?? []) {
    if (module.importIri) {
      mappings.push({
        iri: module.importIri,
        sha256: module.sha256,
        format: module.format ?? entry.format
      })
    }
  }
  return mappings
}

// Rules about the set rather than about one entry: two sources loading
// into one graph would overwrite each other's content in the store, and an
// importsFrom that names a missing or unusable entry would fail deep in
// the reasoning step rather than at the gate.
export function checkAcrossEntries(entries, files) {
  const problems = []
  const seen = new Map()
  const byKey = new Map(entries.map((entry) => [entry?.key, entry]))
  entries.forEach((entry, index) => {
    if (!entry?.graphIri) return
    const prior = seen.get(entry.graphIri)
    if (prior)
      problems.push(`${files[index]}: graphIri already used by ${prior}`)
    seen.set(entry.graphIri, files[index])
  })
  entries.forEach((entry, index) => {
    for (const key of entry?.importsFrom ?? []) {
      const referenced = byKey.get(key)
      if (!referenced) {
        problems.push(`${files[index]}: importsFrom names no entry ${key}`)
        continue
      }
      if (key === entry.key) {
        problems.push(`${files[index]}: importsFrom must not name itself`)
        continue
      }
      if (referenced.kind === "matsci-sam-mirror") {
        problems.push(
          `${files[index]}: importsFrom names the mirror ${key}, whose content is not a pinned artifact`
        )
        continue
      }
      // An artifact with no import IRI cannot be named in the catalog, so
      // part of the closure would resolve nowhere and reasoning would fail
      // at the dead proxy instead of here.
      const unnamed =
        (referenced.importIri ? 0 : 1) +
        (referenced.modules ?? []).filter((m) => !m?.importIri).length
      if (unnamed > 0) {
        problems.push(
          `${files[index]}: importsFrom ${key}, but ${unnamed} of its artifact(s) carry no import IRI for the catalog`
        )
      }
      // A cleared source reasoning through an uncleared one could never be
      // rebuilt from a publication build, which excludes the reference and
      // fails deep in reasoning after the whole fetch and load.
      if (entry.republishable && referenced.republishable === false) {
        problems.push(
          `${files[index]}: importsFrom ${key}, which a publication build excludes, so the publishable store could not be reasoned`
        )
      }
      // An IRI mapped by both entries would resolve to whichever the
      // catalog wrote last, so the collision is refused rather than raced.
      const inherited = new Set(
        catalogMappingsOf(referenced).map((mapping) => mapping.iri)
      )
      for (const iri of ownMappedIris(entry)) {
        if (inherited.has(iri)) {
          problems.push(
            `${files[index]}: ${iri} is mapped here and inherited from ${key}`
          )
        }
      }
    }
    // The same rule between the referenced entries: two of them mapping one
    // IRI would collide in the assembled catalog just as surely, and until
    // this check that collision surfaced only when reasoning threw.
    const inheritedFrom = new Map()
    for (const key of entry?.importsFrom ?? []) {
      const referenced = byKey.get(key)
      if (!referenced) continue
      for (const mapping of catalogMappingsOf(referenced)) {
        const prior = inheritedFrom.get(mapping.iri)
        if (prior && prior !== key) {
          problems.push(
            `${files[index]}: ${mapping.iri} is inherited from both ${prior} and ${key}`
          )
        }
        inheritedFrom.set(mapping.iri, key)
      }
    }
  })
  return problems
}

// Reads every entry and checks its shape, so the build gets the same gate
// as the command that checks the manifest. A caller that wants the problems
// rather than an exception passes {check: false}, which is what that
// command does so it can report all of them at once.
export async function loadManifest({ check = true } = {}) {
  const files = (await readdir(MANIFEST_DIR))
    .filter((f) => f.endsWith(".json"))
    .sort()
  const entries = []
  const problems = []
  for (const file of files) {
    let entry
    try {
      entry = JSON.parse(await readFile(join(MANIFEST_DIR, file), "utf8"))
    } catch (error) {
      problems.push(`${file}: not valid JSON (${error.message})`)
      continue
    }
    problems.push(...checkEntry(entry, file))
    entries.push(entry)
  }
  problems.push(...checkAcrossEntries(entries, files))
  if (check && problems.length > 0) {
    throw new Error(`the manifest is not valid:\n  ${problems.join("\n  ")}`)
  }
  return check ? entries : { entries, problems }
}

export const isMirror = (entry) => entry.kind === "matsci-sam-mirror"

// Every artifact an entry loads: the main file first, then its pinned
// modules. All of them land in the one named graph of the entry.
export function artifactsOf(entry) {
  if (isMirror(entry))
    return [{ url: entry.fetchUrl, format: entry.format, mirror: true }]
  const artifacts = [
    { url: entry.downloadUrl, sha256: entry.sha256, format: entry.format }
  ]
  for (const module of entry.modules ?? []) {
    artifacts.push({
      url: module.url,
      sha256: module.sha256,
      format: module.format ?? entry.format
    })
  }
  return artifacts
}
