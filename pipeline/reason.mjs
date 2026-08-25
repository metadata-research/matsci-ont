// Materializes the inferred class hierarchy, one graph per source.
//
//   source files -> ROBOT (HermiT) -> inferred direct subClassOf between
//   named classes -> sorted N-Triples -> named graph
//
// Reasoning runs here, on a workstation, never on a host. Every ROBOT
// invocation carries the closed-port proxy guard from robotEnvironment, so
// an import this pipeline did not pin cannot be fetched: the attempt fails
// at once instead of becoming a dependency nobody recorded.
//
// A nonzero ROBOT exit fails the build. That is the behavior for both an
// inconsistent ontology and an unresolvable import, and neither should
// reach the store.

import { writeFile, mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { robotEnvironment, runRobot, runJena } from "../shared/tools.mjs"
import { ROOT } from "../shared/paths.mjs"
import { artifactsOf, extensionFor } from "./lib/manifest.mjs"
import { inferredGraphFor } from "../shared/vocabulary.mjs"

const CATALOG_DIR = join(ROOT, "manifest/catalogs")
const CONSTRUCT = join(CATALOG_DIR, "inferred-subclassof.rq")
const EMPTY = join(CATALOG_DIR, "empty.ttl")

// Fixed for every source. --create-new-ontology leaves only the inferences,
// and excluding owl:Thing and structural tautologies keeps the graph to
// what a reader would call a hierarchy.
const REASON_FLAGS = [
  "--reasoner",
  "hermit",
  "--axiom-generators",
  "SubClass",
  "--create-new-ontology",
  "true",
  "--exclude-owl-thing",
  "true",
  "--exclude-tautologies",
  "structural"
]

export const REASONER = "HermiT 1.4.5.456 (ROBOT 1.9.10)"

const xmlEscape = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")

// An OASIS catalog telling the loader where each imported ontology is. It is
// generated from the manifest rather than kept as a file of its own, so the
// pinned digest and the import mapping cannot drift apart.
function catalogXml(mappings) {
  const entries = mappings
    .map(
      ({ iri, path }) =>
        `  <uri name="${xmlEscape(iri)}" uri="${xmlEscape(path)}"/>`
    )
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<catalog prefer="public" xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">
${entries}
</catalog>
`
}

function cachePath(artifact) {
  return join(
    ROOT,
    "cache",
    `${artifact.sha256}.${extensionFor(artifact.format)}`
  )
}

// Every format the manifest accepts can carry OWL, so the only reasons not
// to reason over a source are the two a manifest states.
export function shouldReason(entry) {
  if (entry.reason === false) return false
  if (entry.kind === "matsci-sam-mirror") return false
  return true
}

// Returns {key, graphIri, path, pairs} for a reasoned source, or throws with
// the operator-facing reason.
export async function reasonSource(environment, entry, workDirectory) {
  await mkdir(workDirectory, { recursive: true })
  const artifacts = artifactsOf(entry)
  const main = cachePath(artifacts[0])

  // Modules are pinned files with the import IRI the main file names.
  // Imports with no pinned file resolve to an empty ontology, which both
  // satisfies the loader and drops the owl:imports declaration from the
  // output, so nothing downstream retries the resolution.
  // A module with no import IRI would be loaded into the store but left out
  // of the reasoning input, so the reasoner would see a smaller ontology
  // than the store holds and say so nowhere.
  const unmapped = (entry.modules ?? []).filter((module) => !module.importIri)
  if (unmapped.length > 0) {
    throw new Error(
      `${entry.key} has ${unmapped.length} module(s) without importIri, which reasoning would silently omit`
    )
  }
  const mappings = [
    ...(entry.modules ?? []).map((module) => ({
      iri: module.importIri,
      path: cachePath({
        sha256: module.sha256,
        format: module.format ?? entry.format
      })
    })),
    ...(entry.importsToEmpty ?? []).map((iri) => ({ iri, path: EMPTY }))
  ]
  const seen = new Set()
  for (const mapping of mappings) {
    if (seen.has(mapping.iri)) {
      throw new Error(
        `${entry.key} maps ${mapping.iri} twice, and the later mapping would win`
      )
    }
    seen.add(mapping.iri)
  }

  const args = []
  let catalogPath
  if (mappings.length > 0) {
    catalogPath = join(workDirectory, `${entry.key}-catalog.xml`)
    await writeFile(catalogPath, catalogXml(mappings))
  }

  // A source with pinned modules is merged with them first, so the
  // reasoner sees the closure the publisher intended.
  if ((entry.modules ?? []).length > 0) {
    args.push("merge", "--catalog", catalogPath, "--input", main, "reason")
  } else {
    args.push("reason", "--input", main)
    if (catalogPath) args.push("--catalog", catalogPath)
  }

  const output = join(workDirectory, `${entry.key}-inferred.nt`)
  args.push(
    ...REASON_FLAGS,
    "query",
    "--format",
    "nt",
    "--construct",
    CONSTRUCT,
    output
  )

  const result = runRobot(environment, args)
  if (result.status !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .filter((line) =>
        /ERROR|Exception|inconsistent|Could not load/i.test(line)
      )
      .slice(0, 4)
      .join("\n")
    throw new Error(
      `reasoning failed for ${entry.key}\n${detail || result.stderr.slice(0, 400)}`
    )
  }

  // N-Triples is line oriented, so sorting gives one canonical form
  // independent of the order the writer happened to emit.
  const lines = (await readFile(output, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
  lines.sort()
  await writeFile(output, lines.length > 0 ? `${lines.join("\n")}\n` : "")

  return {
    key: entry.key,
    graphIri: inferredGraphFor(entry.key),
    path: output,
    pairs: lines.length
  }
}

const PAIR = /^<([^>]+)>\s+<[^>]+>\s+<([^>]+)>\s*\.\s*$/

// The reasoner entails everything the source asserts, so most of what it
// emits is a restatement. An inferred graph is worth keeping only for what
// reasoning added: the pairs the source does not already state. Subtracting
// them is what lets a page mark a placement "inferred" and be right.
export function subtractAsserted(lines, assertedPairs) {
  return lines.filter((line) => {
    const match = PAIR.exec(line)
    if (!match) return true
    return !assertedPairs.has(`${match[1]} ${match[2]}`)
  })
}

// Jena writes CSV with CRLF line endings, so a naive split on newline
// leaves a carriage return on every value and no key ever matches. Parsed
// here and tested in test-reason.mjs, because the failure is silent: the
// inferred graph would fill with restatements and pages would mark
// asserted placements as inferred.
// Reads the two-column result, honoring the quoting Jena applies to any
// value holding a comma, a quote or a newline. Splitting on the first comma
// instead would mangle such a value into a key that matches nothing, and the
// pair it stands for would be published as inferred although its source
// asserts it.
export function parsePairCsv(text) {
  const pairs = new Set()
  for (const raw of text.split(/\r?\n/).slice(1)) {
    const line = raw.replace(/\r$/, "")
    if (line.trim() === "") continue
    const fields = []
    let field = ""
    let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const character = line[i]
      if (quoted) {
        if (character === '"') {
          if (line[i + 1] === '"') {
            field += '"'
            i += 1
          } else {
            quoted = false
          }
        } else {
          field += character
        }
      } else if (character === '"') {
        quoted = true
      } else if (character === ",") {
        fields.push(field)
        field = ""
      } else {
        field += character
      }
    }
    fields.push(field)
    if (fields.length >= 2) pairs.add(`${fields[0]} ${fields[1]}`)
  }
  return pairs
}

function assertedPairsOf(jenaEnvironment, storeLocation, entry, queryPath) {
  const result = runJena(jenaEnvironment, "tdb2.tdbquery", [
    `--loc=${storeLocation}`,
    "--results=CSV",
    `--query=${queryPath}`
  ])
  if (result.status !== 0) {
    throw new Error(
      `reading the asserted hierarchy of ${entry.key} failed\n${result.stderr}`
    )
  }
  return parsePairCsv(result.stdout)
}

// Reasons over every eligible source and loads the results. Returns the
// record the catalog graph publishes, one row per source, reasoned or not.
export async function reasonAll(
  jenaEnvironment,
  entries,
  storeLocation,
  workDirectory
) {
  const robot = await robotEnvironment()
  const records = []

  try {
    return await reasonEach(
      robot,
      jenaEnvironment,
      entries,
      storeLocation,
      workDirectory,
      records
    )
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}

async function reasonEach(
  robot,
  jenaEnvironment,
  entries,
  storeLocation,
  workDirectory,
  records
) {
  for (const entry of entries) {
    if (!shouldReason(entry)) {
      records.push({
        key: entry.key,
        reasoned: false,
        skipped: skipReason(entry)
      })
      continue
    }
    process.stderr.write(`reasoning ${entry.key}\n`)
    const result = await reasonSource(robot, entry, workDirectory)

    // Keep only what reasoning added.
    // Across every source graph, not only this one. An inferred pair can
    // hold between two third-party IRIs, and another loaded source may
    // already assert it; publishing that as inferred would be wrong.
    const queryPath = join(workDirectory, `${entry.key}-asserted.rq`)
    await writeFile(
      queryPath,
      `SELECT ?s ?o WHERE { GRAPH ?g {
         ?s <http://www.w3.org/2000/01/rdf-schema#subClassOf>|<http://www.w3.org/2004/02/skos/core#broader> ?o }
       FILTER(isIRI(?s) && isIRI(?o))
       FILTER(!STRSTARTS(STR(?g), "${inferredGraphFor("")}")) }\n`
    )
    const asserted = assertedPairsOf(
      jenaEnvironment,
      storeLocation,
      entry,
      queryPath
    )
    const entailed = result.pairs
    const kept = subtractAsserted(
      (await readFile(result.path, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== ""),
      asserted
    )
    await writeFile(result.path, kept.length > 0 ? `${kept.join("\n")}\n` : "")
    result.pairs = kept.length
    result.entailed = entailed

    if (result.pairs > 0) {
      const load = runJena(jenaEnvironment, "tdb2.tdbloader", [
        `--loc=${storeLocation}`,
        `--graph=${result.graphIri}`,
        result.path
      ])
      if (load.status !== 0) {
        throw new Error(
          `the inferred graph of ${entry.key} did not load\n${load.stderr}`
        )
      }
    }
    process.stderr.write(
      `  ${result.pairs} new pair(s) of ${result.entailed} entailed\n`
    )
    records.push({
      key: entry.key,
      reasoned: true,
      reasoner: REASONER,
      pairs: result.pairs,
      entailed: result.entailed,
      graphIri: result.graphIri
    })
  }
  return records
}

function skipReason(entry) {
  if (entry.kind === "matsci-sam-mirror")
    return "a mirror of published data, not an ontology"
  return "declared not to be reasoned in the manifest"
}
