// Keeps the lookup index loaded, current and optional.
//
// The index is loaded from the live store after the application starts
// listening. A fingerprint of the catalogue, read at most every 30 seconds,
// says whether the store has been replaced since, and a changed store drops
// the index and loads it again. Until an index is ready and current, and
// whenever it cannot answer a request, the routes use their SPARQL queries,
// which stay the reference. MATSCI_ONT_LOOKUP_INDEX=off turns the index off.
//
// While a load runs, one lookup at a time uses SPARQL and the others wait
// for the load within their deadline (lookupIndexFor). Each SPARQL lookup
// scans every description, as the load does, and letting every request
// start one stretched a six second load past the store's 30 second limit.
//
// A load that trips a guard, on rows, bytes or memory, or that meets a
// description the index cannot reproduce, is abandoned: the application
// logs it and stays on SPARQL until the store changes. A load that fails
// because the store stopped or could not be reached is tried again once
// the interval has passed.

import { Worker } from "node:worker_threads"
import { indexBytes, LookupIndexError } from "./lookup-index.mjs"
import {
  loadIndex,
  readCatalogue,
  unpackIndex,
  WORKER_HEAP_MB,
  WORKER_YOUNG_MB
} from "./lookup-load.mjs"

export const CHECK_INTERVAL_MS = 30000
// SPARQL lookups that may run alongside a load.
export const STORE_LOOKUPS_WHILE_LOADING = 1

export function lookupIndexSwitchedOff(env = process.env) {
  return (
    String(env.MATSCI_ONT_LOOKUP_INDEX ?? "")
      .trim()
      .toLowerCase() === "off"
  )
}

// Builds the index in a worker thread. Loading parses some 40 MB of rows
// and building sorts and indexes them, which would otherwise hold this
// thread for seconds while it serves requests, and would leave the garbage
// of the build in this heap, where V8 keeps it until the next full
// collection. A worker's heap goes when the worker does, the finished
// arrays move here without a copy, and its heap limit is a hard memory
// guard: a build that exceeds it is abandoned.
function loadInWorker(catalogue) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./lookup-worker.mjs", import.meta.url), {
      workerData: catalogue,
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_HEAP_MB,
        maxYoungGenerationSizeMb: WORKER_YOUNG_MB
      }
    })
    let settled = false
    worker.once("message", (message) => {
      settled = true
      if (message.index) resolve(unpackIndex(message.index))
      else if (message.refused) reject(new LookupIndexError(message.error))
      else reject(new Error(message.error))
    })
    worker.once("error", (error) => {
      if (settled) return
      settled = true
      reject(
        error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new LookupIndexError(
              `building the index needed more than ${WORKER_HEAP_MB} MB`
            )
          : error
      )
    })
    worker.once("exit", (code) => {
      if (settled) return
      settled = true
      reject(new Error(`the index worker stopped with code ${code}`))
    })
  })
}

const storeLoader = { catalogue: readCatalogue, load: loadInWorker }

// The same load in this thread, for tests whose store is a replaced fetch
// that a worker would not see.
export const inThreadLoader = { catalogue: readCatalogue, load: loadIndex }

// ---------------------------------------------------------------------------

const defaults = () => ({
  loader: storeLoader,
  now: () => Date.now(),
  checkIntervalMs: CHECK_INTERVAL_MS,
  log: (line) => process.stderr.write(`${line}\n`)
})

let settings = defaults()
let generation = 0

function freshState() {
  return {
    // Set by warmLookupIndex: the index may load and reload by itself.
    armed: false,
    index: null,
    checkedAt: 0,
    attemptedAt: -Infinity,
    loading: null,
    checking: null,
    // The fingerprint of a store whose index was abandoned.
    refused: null,
    // SPARQL lookups running alongside the current load.
    storeLookups: 0,
    loadMs: undefined,
    indexBytes: undefined,
    loadPeakBytes: undefined,
    heapUsed: undefined,
    answered: 0,
    fallbacks: 0
  }
}

let state = freshState()

const megabytes = (bytes) => Math.round(bytes / 1048576)

async function runLoad(run) {
  const started = performance.now()
  let catalogue
  try {
    catalogue = await settings.loader.catalogue()
    if (run !== generation || catalogue.fingerprint === state.refused)
      return null
    const index = await settings.loader.load(catalogue)
    if (run !== generation) return null
    // A store replaced while it was being read gives a mixed index.
    const after = await settings.loader.catalogue()
    return adopt(
      run,
      index,
      after.fingerprint === catalogue.fingerprint,
      started
    )
  } catch (error) {
    return abandon(run, error, catalogue?.fingerprint)
  }
}

function adopt(run, index, unchanged, started) {
  if (run !== generation) return null
  if (!unchanged) {
    settings.log("lookup index: the store changed while loading; loading again")
    state.attemptedAt = -Infinity
    return null
  }
  state.index = index
  state.checkedAt = settings.now()
  state.loadMs = Math.round(performance.now() - started)
  state.indexBytes = indexBytes(index)
  state.loadPeakBytes = index.loadPeakBytes
  state.heapUsed = process.memoryUsage().heapUsed
  // Most of the index is outside the JavaScript heap, so its own size is
  // reported beside heapUsed, with the most the load needed while building.
  const peak =
    state.loadPeakBytes === undefined
      ? ""
      : ` (${megabytes(state.loadPeakBytes)} MB while loading)`
  settings.log(
    `lookup index: loaded ${index.size} entries from ${index.sources.length} sources in ${state.loadMs} ms, index ${megabytes(state.indexBytes)} MB${peak}, heapUsed ${megabytes(state.heapUsed)} MB`
  )
  return index
}

function abandon(run, error, fingerprint) {
  if (run !== generation) return null
  state.index = null
  if (error instanceof LookupIndexError) {
    state.refused = fingerprint ?? null
    settings.log(
      `lookup index: abandoned, lookups stay on SPARQL: ${error.message}`
    )
  } else {
    settings.log(
      `lookup index: not loaded, lookups use SPARQL and it is tried again in ${Math.round(settings.checkIntervalMs / 1000)} s: ${error.message}`
    )
  }
  return null
}

// Loads the index unless a load is already running, whose promise is then
// returned. Resolves to the index, or null when it could not be loaded.
export function loadLookupIndex() {
  if (!state.loading) {
    const run = generation
    state.attemptedAt = settings.now()
    state.loading = runLoad(run).finally(() => {
      if (run === generation) state.loading = null
    })
  }
  return state.loading
}

// Called once the application listens. Returns the load's promise, or null
// when the index is switched off.
export function warmLookupIndex() {
  if (lookupIndexSwitchedOff()) {
    settings.log(
      "lookup index: off (MATSCI_ONT_LOOKUP_INDEX=off), lookups use SPARQL"
    )
    return null
  }
  state.armed = true
  return loadLookupIndex()
}

function confirmFingerprint() {
  if (!state.checking) {
    const run = generation
    state.checking = (async () => {
      try {
        const { fingerprint } = await settings.loader.catalogue()
        if (run !== generation || state.index === null) return false
        if (fingerprint === state.index.fingerprint) {
          state.checkedAt = settings.now()
          return true
        }
        state.index = null
        settings.log("lookup index: the store changed, loading it again")
        if (state.armed) {
          state.attemptedAt = -Infinity
          loadLookupIndex()
        }
        return false
      } catch {
        // A store that cannot say what it holds cannot confirm the index.
        return false
      } finally {
        if (run === generation) state.checking = null
      }
    })()
  }
  return state.checking
}

// The index when it is ready and current, else null. Confirms the store's
// fingerprint first when the last confirmation is older than the interval,
// and restarts a failed load once an interval has passed.
export async function usableLookupIndex() {
  if (state.index === null) {
    if (
      state.armed &&
      !state.loading &&
      settings.now() - state.attemptedAt >= settings.checkIntervalMs
    )
      loadLookupIndex()
    return null
  }
  if (settings.now() - state.checkedAt >= settings.checkIntervalMs) {
    if (!(await confirmFingerprint())) return null
  }
  return state.index
}

const nothing = () => {}

// Resolves when the load settles or the signal fires, whichever is first.
function settledOrAborted(loading, signal) {
  if (!signal) return loading
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done)
    loading.then(done, done)
  })
}

// How a lookup is answered, as { index, release }: the index when it is
// ready and current, or null for SPARQL. While a load runs, a lookup takes
// SPARQL's one place if it is free, and otherwise waits for the load until
// `signal` fires, then has the index if the load produced one. A lookup
// given null calls release once its SPARQL query ends.
export async function lookupIndexFor(signal) {
  const index = await usableLookupIndex()
  if (index || !state.loading) return { index, release: nothing }
  const owner = state
  if (owner.storeLookups < STORE_LOOKUPS_WHILE_LOADING) {
    owner.storeLookups++
    let released = false
    const release = () => {
      if (released) return
      released = true
      owner.storeLookups--
    }
    return { index: null, release }
  }
  await settledOrAborted(owner.loading, signal)
  return { index: owner === state ? state.index : null, release: nothing }
}

// Counts which path answered, for the status and for tests.
export function noteLookup(answeredByIndex) {
  if (answeredByIndex) state.answered++
  else state.fallbacks++
}

export function lookupIndexStatus() {
  return {
    state: state.index
      ? "ready"
      : state.loading
        ? "loading"
        : state.refused
          ? "abandoned"
          : state.armed
            ? "waiting"
            : "idle",
    entries: state.index?.size,
    sources: state.index?.sources.map((source) => source.key),
    loadMs: state.loadMs,
    indexBytes: state.indexBytes,
    loadPeakBytes: state.loadPeakBytes,
    heapUsed: state.heapUsed,
    storeLookups: state.storeLookups,
    answered: state.answered,
    fallbacks: state.fallbacks
  }
}

// The loaded index, for diagnostics and verification only.
export function currentLookupIndex() {
  return state.index
}

// Test hooks: replace the loader, the clock, the interval or the log.
export function configureLookupIndex(options = {}) {
  settings = { ...settings, ...options }
}

// Forgets the index and every setting. A load or check still running
// belongs to the previous generation and is ignored when it finishes.
export function resetLookupIndex() {
  generation++
  settings = defaults()
  state = freshState()
}
