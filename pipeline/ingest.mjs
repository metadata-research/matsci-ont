// Builds the TDB2 store from the manifest.
//
//   fetch (content-addressed cache) -> verify sha256 -> riot --validate
//   -> tdb2.tdbloader --graph=<graphIri>
//
// A mirror source is the exception: it is declared to be moving, so it is
// fetched fresh under its key rather than pinned by digest.
//
// The build goes to build/tdb2.new and is swapped into place only when every
// source succeeds, so a failed run never leaves a half-built store.
//
//   node pipeline/ingest.mjs [--only=key,key] [--keep-going]
//                            [--no-swap] [--no-reason] [--publication]
//                            [--reuse-mirror]
//
// --publication refuses any source not cleared for public serving. A build
// destined for a host uses it; a workstation build does not.

import { mkdir, rm, rename, writeFile } from "node:fs/promises"
import { access } from "node:fs/promises"
import { join } from "node:path"
import {
  jenaEnvironment,
  runJena,
  hashFile,
  download
} from "../shared/tools.mjs"
import { ROOT } from "../shared/paths.mjs"
import {
  loadManifest,
  artifactsOf,
  extensionFor,
  isMirror
} from "./lib/manifest.mjs"
import { graphCounts } from "./lib/compare.mjs"
import {
  catalogTurtle,
  definitionsTurtle,
  readEntities,
  readMirrorDefinitions
} from "./lib/derive.mjs"
import { graphIris } from "../shared/vocabulary.mjs"
import { reasonAll } from "./reason.mjs"

const CACHE_DIR = join(ROOT, "cache")
const MIRROR_DIR = join(CACHE_DIR, "mirror")
// One fetch per key per run, so a determinism rebuild compares the same
// bytes instead of whatever the publisher served a minute later.
const fetchedThisRun = new Set()
const BUILD_DIR = join(ROOT, "build")
const STORE = join(BUILD_DIR, "tdb2")
const STAGING = join(BUILD_DIR, "tdb2.new")

const options = {
  only: null,
  keepGoing: false,
  // A full build, derived graphs included, left in the staging location.
  // This is what a comparison run wants: --only skips deriving, so a store
  // built that way is not comparable with a complete one.
  noSwap: false
}
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--only=")) {
    options.only = new Set(argument.slice("--only=".length).split(","))
  } else if (argument === "--keep-going") {
    options.keepGoing = true
  } else if (argument === "--no-swap") {
    options.noSwap = true
  } else if (argument === "--no-reason") {
    options.noReason = true
  } else if (argument === "--publication") {
    options.publication = true
  } else if (argument === "--reuse-mirror") {
    options.reuseMirror = true
  } else {
    console.error(`unknown option ${argument}`)
    process.exit(2)
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// A mirrored document is not pinned, so it cannot be keyed by digest. It is
// fetched once per build and kept under its key, which is what lets the
// determinism rebuild compare against the same bytes rather than race the
// publisher. A failed fetch leaves the previous copy in place, and the
// build goes on with it.
async function fetchMirror(entry, artifact) {
  await mkdir(MIRROR_DIR, { recursive: true })
  const path = join(MIRROR_DIR, `${entry.key}.${extensionFor(artifact.format)}`)
  if (fetchedThisRun.has(entry.key)) return path

  // A comparison run reuses what the previous run fetched. The publisher
  // re-projects its dataset on its own schedule, so fetching again would
  // compare this pipeline against somebody else's clock and report a
  // difference that says nothing about this pipeline.
  if (options.reuseMirror) {
    if (!(await exists(path))) {
      throw new Error(`${entry.key} has no fetched copy to reuse`)
    }
    fetchedThisRun.add(entry.key)
    return path
  }

  const hasPrevious = await exists(path)
  process.stderr.write(`  fetching ${artifact.url}\n`)
  // The fetched bytes are validated before they replace the copy on disk.
  // A portal or proxy answering 200 with an HTML error page is a
  // successful fetch as far as HTTP is concerned, and writing it first
  // would destroy the good copy this failure path exists to preserve.
  const incoming = `${path}.incoming`
  try {
    const response = await fetch(artifact.url, {
      signal: AbortSignal.timeout(60000)
    })
    if (!response.ok) throw new Error(`answered HTTP ${response.status}`)
    const body = await response.text()
    if (body.trim() === "") throw new Error("answered an empty document")
    await writeFile(incoming, body)
    const check = runJena(environment, "riot", ["--validate", incoming])
    if (check.status !== 0) {
      throw new Error(
        `answered something that is not ${artifact.format}: ${check.stderr.trim().split("\n")[0] ?? ""}`
      )
    }
    await rename(incoming, path)
  } catch (error) {
    await rm(incoming, { force: true })
    if (!hasPrevious) {
      throw new Error(
        `${artifact.url} could not be fetched and there is no earlier copy: ${error.message}`
      )
    }
    process.stderr.write(`  WARNING kept the earlier copy: ${error.message}\n`)
  }
  fetchedThisRun.add(entry.key)
  return path
}

// The publisher states when it last projected the dataset. That is the date
// a reader needs to judge a mirror, and it is the publisher's own, not the
// time this build happened to run.
async function readMirrorModified(environment, location, entry, work) {
  const queryPath = join(work, "mirror-modified.rq")
  // The date of the dataset the manifest names, not of whatever else in
  // the graph happens to state one. A concept scheme with its own
  // modification date would otherwise become the date shown for every
  // mirrored source.
  await writeFile(
    queryPath,
    `SELECT ?when WHERE { GRAPH <${entry.graphIri}> {
       <${entry.sourceDataset}> <http://purl.org/dc/terms/modified> ?when } } LIMIT 1\n`
  )
  const result = runJena(environment, "tdb2.tdbquery", [
    `--loc=${location}`,
    "--results=JSON",
    `--query=${queryPath}`
  ])
  if (result.status !== 0) {
    throw new Error(
      `reading the mirror date of ${entry.key} failed\n${result.stderr}`
    )
  }
  return JSON.parse(result.stdout).results.bindings[0]?.when?.value
}

// The cache is keyed by content digest, so a cached file is a verified file
// and a changed pin can never collide with the artifact it replaced.
async function fetchArtifact(artifact) {
  const path = join(
    CACHE_DIR,
    `${artifact.sha256}.${extensionFor(artifact.format)}`
  )
  if (await exists(path)) return path

  await mkdir(CACHE_DIR, { recursive: true })
  process.stderr.write(`  fetching ${artifact.url}\n`)
  await download(artifact.url, path)

  const actual = await hashFile(path, "sha256")
  if (actual !== artifact.sha256) {
    await rm(path, { force: true })
    throw new Error(
      `digest mismatch for ${artifact.url}\n    manifest ${artifact.sha256}\n    fetched  ${actual}`
    )
  }
  return path
}

const environment = await jenaEnvironment()
const entries = (await loadManifest()).filter(
  (entry) => !options.only || options.only.has(entry.key)
)
if (entries.length === 0) {
  console.error("no manifest entries selected")
  process.exit(2)
}

await mkdir(BUILD_DIR, { recursive: true })
await rm(STAGING, { recursive: true, force: true })

const failures = []
const loaded = []
const notCleared = []
const excluded = []

for (const entry of entries) {
  process.stderr.write(`${entry.key} ${entry.version ?? "mirror"}\n`)
  try {
    // A source not cleared for publication still loads on a workstation,
    // where the operator is the only reader. A publication build leaves it
    // out and builds the rest, which is what gives a host a store holding
    // only what may be served. Refusing to build at all would leave the
    // operator with no publishable store and a manual exclusion to
    // remember.
    if (!entry.republishable) {
      if (options.publication) {
        excluded.push(entry.key)
        process.stderr.write(
          `  excluded from a publication build (licence ${entry.license})\n`
        )
        continue
      }
      notCleared.push(entry.key)
    }

    const paths = []
    for (const artifact of artifactsOf(entry)) {
      const path = artifact.mirror
        ? await fetchMirror(entry, artifact)
        : await fetchArtifact(artifact)
      const validation = runJena(environment, "riot", ["--validate", path])
      if (validation.status !== 0) {
        throw new Error(
          `riot rejected ${artifact.url}\n${validation.stderr.trim().split("\n").slice(0, 5).join("\n")}`
        )
      }
      // riot exits 0 on warnings, so an ill-typed literal would otherwise
      // enter the store unremarked. A source that legitimately warns needs
      // "allowWarnings": true in its manifest entry, which records the
      // decision where the pin is.
      const warnings = validation.stderr
        .split("\n")
        .filter((line) => line.includes("WARN"))
      if (warnings.length > 0 && !entry.allowWarnings) {
        throw new Error(
          `riot warned on ${artifact.url}\n${warnings.slice(0, 5).join("\n")}` +
            (warnings.length > 5 ? `\n  and ${warnings.length - 5} more` : "") +
            `\n  set "allowWarnings": true in the manifest entry to accept these`
        )
      }
      if (warnings.length > 0) {
        process.stderr.write(
          `  ${warnings.length} warning(s) accepted by manifest\n`
        )
      }
      paths.push(path)
    }

    const load = runJena(environment, "tdb2.tdbloader", [
      `--loc=${STAGING}`,
      `--graph=${entry.graphIri}`,
      ...paths
    ])
    if (load.status !== 0) {
      throw new Error(
        `tdbloader failed\n${load.stderr.trim().split("\n").slice(-5).join("\n")}`
      )
    }
    loaded.push({
      key: entry.key,
      graphIri: entry.graphIri,
      files: paths.length
    })
    process.stderr.write(`  loaded ${paths.length} file(s)\n`)
  } catch (error) {
    failures.push({ key: entry.key, message: error.message })
    process.stderr.write(`  FAILED ${error.message}\n`)
    if (!options.keepGoing) break
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} source(s) did not load`)
  for (const failure of failures)
    console.error(`  ${failure.key}: ${failure.message}`)
  console.error("the previous store is unchanged")
  process.exit(1)
}

// The two graphs MatSci-ONT derives from what it just loaded. A partial
// selection would describe only the sources it built, so they are emitted
// only for a full run.
const derived = []
if (!options.only) {
  const work = join(BUILD_DIR, "derive-work")
  await mkdir(work, { recursive: true })
  // A publication build describes what it holds, not what the manifest
  // lists, so an excluded source leaves no trace in the catalogue.
  const described = entries.filter((entry) => !excluded.includes(entry.key))

  // Reasoning comes before the catalogue, which publishes what it did. A
  // failure here reports like every other failure in this file, rather than
  // as an unhandled rejection, and leaves the previous store in place.
  let reasoning = []
  if (!options.noReason) {
    try {
      reasoning = await reasonAll(
        environment,
        described,
        STAGING,
        join(BUILD_DIR, "reason-work")
      )
    } catch (error) {
      console.error(`\nFAIL: reasoning did not complete\n  ${error.message}`)
      console.error("the previous store is unchanged")
      process.exit(1)
    }
  }
  for (const record of reasoning.filter((r) => r.reasoned && r.pairs > 0)) {
    derived.push({ name: `inferred/${record.key}`, graphIri: record.graphIri })
  }

  const counts = await graphCounts(environment, STAGING, work)
  const graphs = graphIris()

  // A mirrored term keeps its definition text behind a revision node, so
  // the index reads those separately from the literal-valued properties
  // every other source uses.
  const mirrorDefinitions = new Map()
  let mirrorModified
  for (const entry of described.filter(isMirror)) {
    mirrorDefinitions.set(
      entry.key,
      await readMirrorDefinitions(
        environment,
        STAGING,
        entry.graphIri,
        join(work, "mirror.rq")
      )
    )
    mirrorModified ??= await readMirrorModified(
      environment,
      STAGING,
      entry,
      work
    )
  }

  const catalog = catalogTurtle(described, counts, reasoning, mirrorModified)
  const definitions = definitionsTurtle(
    described,
    await readEntities(environment, STAGING, join(work, "entities.rq")),
    mirrorDefinitions
  )

  for (const [name, graphIri, turtle] of [
    ["catalog", graphs.catalog, catalog],
    ["definitions", graphs.definitions, definitions.turtle]
  ]) {
    const path = join(work, `${name}.ttl`)
    await writeFile(path, turtle)
    // The derived graphs pass the same validation gate as a source.
    const validation = runJena(environment, "riot", ["--validate", path])
    if (validation.status !== 0 || validation.stderr.includes("WARN")) {
      console.error(
        `FAIL: the ${name} graph did not validate\n${validation.stderr}`
      )
      console.error("the previous store is unchanged")
      process.exit(1)
    }
    const load = runJena(environment, "tdb2.tdbloader", [
      `--loc=${STAGING}`,
      `--graph=${graphIri}`,
      path
    ])
    if (load.status !== 0) {
      console.error(`FAIL: the ${name} graph did not load\n${load.stderr}`)
      process.exit(1)
    }
    derived.push({ name, graphIri })
  }
  process.stderr.write(
    `derived catalog and ${definitions.entries} definition entries\n`
  )
}

// A partial selection would otherwise publish a store missing every source it
// did not build.
if (options.only || options.noSwap) {
  process.stderr.write(
    `\nbuilt ${STAGING} (${options.only ? "partial selection" : "no swap requested"})\n`
  )
  process.exit(0)
}

await rm(STORE, { recursive: true, force: true })
await rename(STAGING, STORE)

// The mirrored bytes this build used. A later comparison can tell a store
// that is merely older than the cache from a pipeline that is not
// deterministic, which otherwise look identical and read as the latter.
const mirrorDigests = {}
for (const entry of entries.filter(isMirror)) {
  const path = join(MIRROR_DIR, `${entry.key}.${extensionFor(entry.format)}`)
  if (await exists(path))
    mirrorDigests[entry.key] = await hashFile(path, "sha256")
}

const report = {
  builtAt: new Date().toISOString(),
  // What kind of store this is, so a later step can tell a workstation
  // store from one that may be served. A console line does not survive the
  // terminal it was printed in.
  publication: Boolean(options.publication),
  notClearedForPublication: notCleared,
  excludedFromPublication: excluded,
  mirrorDigests,
  jena: environment.pins.jena.version,
  sources: loaded,
  derived
}
await writeFile(
  join(BUILD_DIR, "ingest-report.json"),
  `${JSON.stringify(report, null, 2)}\n`
)

if (excluded.length > 0) {
  console.log(`EXCLUDED FROM THIS PUBLICATION BUILD: ${excluded.join(", ")}`)
}
if (notCleared.length > 0) {
  console.log(
    `NOT CLEARED FOR PUBLICATION: ${notCleared.join(", ")}\n` +
      "  This store must not be served publicly. Build with --publication for one that may be."
  )
}
console.log(`OK: ${loaded.length} sources loaded into ${STORE}`)
