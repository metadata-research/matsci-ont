// Checks the built store against the acceptance criteria of every phase.
//
//   node pipeline/verify.mjs [--determinism]
//
// --determinism rebuilds the store a second time from the same manifest and
// compares the two. It is off by default because it doubles the build.
//
// This file starts what the checks need, hands each group the same context,
// and reports. The checks themselves are in lib/checks, one module per
// concern, and their queries are named files in queries/ so that a query
// can be read, and pasted into an endpoint, without the code around it. A
// group that throws is recorded as a failure rather than ending the run, so
// one broken query cannot hide the state of everything after it.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { jenaEnvironment } from "../shared/tools.mjs"
import { ROOT, STORE } from "../shared/paths.mjs"
import { loadManifest } from "./lib/manifest.mjs"
import { startFuseki, stopFuseki, query } from "../shared/fuseki.mjs"
import { queryLoader } from "../shared/queries.mjs"
import { graphCounts } from "./lib/compare.mjs"
import { graphIris, vocabularyIri } from "../shared/vocabulary.mjs"
import { checkStore } from "./lib/checks/store.mjs"
import { checkCatalogue, checkLicences } from "./lib/checks/catalogue.mjs"
import { checkPublication } from "./lib/checks/publication.mjs"
import { checkMirror } from "./lib/checks/mirror.mjs"
import { checkReasoning } from "./lib/checks/reasoning.mjs"
import { checkEndpoint } from "./lib/checks/endpoint.mjs"
import { checkBrowse } from "./lib/checks/browse.mjs"
import { checkChebi } from "./lib/checks/chebi.mjs"
import { checkApi } from "./lib/checks/api.mjs"
import { checkDeterminism } from "./lib/checks/determinism.mjs"

const WORK = join(ROOT, "build/verify-work")
const APP_PORT = 3199
const withDeterminism = process.argv.includes("--determinism")

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  process.stdout.write(`${pass ? "pass" : "FAIL"}  ${name}\n`)
  if (detail)
    process.stdout.write(`      ${detail.replace(/\n/g, "\n      ")}\n`)
}

// A group that throws has failed, and saying which group and why is more
// use than a stack trace that ends the run with everything after it
// unreported.
async function group(name, check, context) {
  try {
    await check(context)
  } catch (error) {
    record(`the ${name} checks ran`, false, error.message)
  }
}

const environment = await jenaEnvironment()
const manifest = await loadManifest()
const fixtures = JSON.parse(
  await readFile(join(ROOT, "pipeline/fixtures.json"), "utf8")
)

// The report the build wrote beside the store names the sources it left
// out. A publication build excludes what is not cleared for serving, and the
// store is judged against what it was built to hold, not against the whole
// manifest; the publication checks then prove the exclusions held.
const report = JSON.parse(
  await readFile(join(ROOT, "build/ingest-report.json"), "utf8")
)
const excluded = new Set(report.excludedFromPublication ?? [])
const loaded = manifest.filter((entry) => !excluded.has(entry.key))
await mkdir(WORK, { recursive: true })

// Counts come from the store by location, not from Fuseki: the served
// dataset unions the named graphs into the default graph, which would hide
// whether anything really landed in the default graph.
const counts = await graphCounts(environment, STORE, WORK)

const context = {
  record,
  environment,
  manifest: loaded,
  fullManifest: manifest,
  excluded,
  publication: Boolean(report.publication),
  counts,
  fixtures,
  work: WORK,
  graphs: graphIris(),
  ont: vocabularyIri(),
  graphIriFor: (key) => manifest.find((entry) => entry.key === key)?.graphIri
}

await group("store", checkStore, context)

const namedQuery = queryLoader(new URL("queries/", import.meta.url).pathname)

let server
try {
  server = await startFuseki({ storeLocation: STORE })
  context.server = server
  context.ask = async (name, substitutions) =>
    query(server.base, await namedQuery(name, substitutions))

  await group("catalogue", checkCatalogue, context)
  await group("licence", checkLicences, context)
  await group("publication", checkPublication, context)
  await group("mirror", checkMirror, context)
  await group("reasoning", checkReasoning, context)
  await group("endpoint", checkEndpoint, context)

  // The browse application, started against the same store.
  process.env.MATSCI_ONT_QUERY_URL = `${server.base}/query`
  const { startApp } = await import("../app/app.mjs")
  const app = await startApp(APP_PORT)
  context.app = app
  context.appBase = `http://127.0.0.1:${APP_PORT}`
  context.page = async (path) => {
    const response = await fetch(`${context.appBase}${path}`)
    return { status: response.status, text: await response.text() }
  }
  try {
    await group("browse", checkBrowse, context)
    await group("api", checkApi, context)
    await group("ChEBI", checkChebi, context)
  } finally {
    app.close()
  }
} finally {
  await stopFuseki(server)
}

if (withDeterminism) await group("determinism", checkDeterminism, context)

await writeFile(
  join(ROOT, "build/verify-report.json"),
  `${JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      publication: Boolean(report.publication),
      excluded: [...excluded],
      results
    },
    null,
    2
  )}\n`
)

const failed = results.filter((r) => !r.pass)
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length} of ${results.length} checks`)
  process.exit(1)
}
console.log(`\nOK: ${results.length} checks`)
