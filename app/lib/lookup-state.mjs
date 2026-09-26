// Keeps the lookup index loaded, current and optional.
//
// The index is loaded from the live store after the application starts
// listening. A fingerprint of the catalogue says whether the store has been
// replaced since, and a changed store drops the index and loads it again.
// It is read at most every 30 seconds: by a timer while the index is ready,
// and first by a lookup that finds the last reading older than that, so a
// store replaced under a running application is loaded again whether or
// not lookups arrive. Until an index is ready and current, and whenever it
// cannot answer a request, the routes use their SPARQL queries, which stay
// the reference. MATSCI_ONT_LOOKUP_INDEX=off turns the index off.
//
// While a load runs, one lookup at a time uses SPARQL at once. The others
// wait for the load for at most a quarter of the time their deadline
// leaves, and then use SPARQL with the rest (lookupIndexFor). Each SPARQL
// lookup scans every description, as the load does, so holding the others
// back keeps the load short. A load on a slow host can outlast a whole
// deadline, so no lookup waits for all of it.
//
// A load that trips a guard, on rows, bytes or memory, that meets a
// description the index cannot reproduce, or whose pages do not add up to
// the store's count while the store stays the same, is abandoned: the
// application logs it and stays on SPARQL until the store changes. A load
// whose pages do not add up because the store changed during it is loaded
// again at once. A load that fails
// because the store stopped or could not be reached is tried again after
// 30 seconds, then 60, then every 2 minutes, by a timer, so the index
// recovers on a host that receives no lookups. A lookup that arrives when
// an attempt is due starts it itself, and either way there is one load at
// a time.

import { Worker } from "node:worker_threads"
import { indexBytes, LookupIndexError } from "./lookup-index.mjs"
import {
  loadIndex,
  LookupCountMismatch,
  readCatalogue,
  unpackIndex,
  WORKER_HEAP_MB,
  WORKER_YOUNG_MB
} from "./lookup-load.mjs"

export const CHECK_INTERVAL_MS = 30000
// The pauses before loading again after a load that failed: after the
// first failure, the second, and every one after that.
export const RETRY_DELAYS_MS = [30000, 60000, 120000]
// SPARQL lookups that may start at once alongside a load.
export const STORE_LOOKUPS_WHILE_LOADING = 1
// The share of the time left before its deadline that a lookup finding
// that place taken waits for the load, before it uses SPARQL with the rest.
// A quarter of a 12 second lookup is 3 seconds of waiting and leaves 9 for
// SPARQL, which here answered in under 5 seconds while a load ran.
export const LOAD_WAIT_SHARE = 0.25

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
      else if (message.mismatch) reject(new LookupCountMismatch(message.error))
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
  retryDelaysMs: RETRY_DELAYS_MS,
  // Neither timer, a retry or a check, keeps a process alive by itself, so
  // a test or a verification run that is done can exit while one is
  // pending. The third argument says which it is, for tests.
  setTimer: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimer: (timer) => clearTimeout(timer),
  log: (line) => process.stderr.write(`${line}\n`)
})

let settings = defaults()
let generation = 0

function freshState() {
  return {
    // Set by warmLookupIndex: the index may load and reload by itself.
    armed: false,
    // Set by warmLookupIndex under MATSCI_ONT_LOOKUP_INDEX=off.
    switchedOff: false,
    index: null,
    checkedAt: 0,
    // The earliest a load may start after one that gave no index, and the
    // timer that starts it then.
    nextAttemptAt: -Infinity,
    retryTimer: null,
    // The timer that confirms the fingerprint while the index is ready.
    checkTimer: null,
    // Loads that failed in a row, which set the pause before the next.
    failures: 0,
    // Why the last load gave no index: the logged message, and the fixed
    // phrase /lookup-status shows for it.
    lastError: null,
    loading: null,
    checking: null,
    // The fingerprint of a store whose index was abandoned.
    refused: null,
    // SPARQL lookups running alongside the current load.
    storeLookups: 0,
    loadedAt: undefined,
    loadMs: undefined,
    loadPages: undefined,
    indexBytes: undefined,
    loadPeakBytes: undefined,
    heapUsed: undefined,
    answered: 0,
    fallbacks: 0
  }
}

let state = freshState()

const megabytes = (bytes) => Math.round(bytes / 1048576)

function clearRetry() {
  if (state.retryTimer === null) return
  settings.clearTimer(state.retryTimer)
  state.retryTimer = null
}

function clearCheck() {
  if (state.checkTimer === null) return
  settings.clearTimer(state.checkTimer)
  state.checkTimer = null
}

// While the index is ready and may reload by itself, confirms the store's
// fingerprint an interval after the last confirmation, so a store replaced
// under a running application is loaded again with no lookup to notice
// it. A lookup that confirmed it in the meantime moves the check later, and
// a check the store could not answer is made again a whole interval later,
// so the store is asked at most once an interval.
function scheduleCheck(delay = settings.checkIntervalMs) {
  clearCheck()
  if (!state.armed || state.index === null) return
  const owner = state
  const timer = settings.setTimer(
    () => {
      if (owner !== state || state.checkTimer !== timer) return
      state.checkTimer = null
      if (state.index === null) return
      const since = settings.now() - state.checkedAt
      if (since < settings.checkIntervalMs) {
        scheduleCheck(settings.checkIntervalMs - since)
        return
      }
      confirmFingerprint().then(() => {
        if (owner === state) scheduleCheck()
      })
    },
    delay,
    "check"
  )
  state.checkTimer = timer
}

// Lets a load start after `delay`, and when the index may load by itself,
// starts it then with a timer. A request that finds the attempt due starts
// it first, and starting a load clears the timer, so the two never stack.
function scheduleLoad(delay) {
  clearRetry()
  state.nextAttemptAt = settings.now() + delay
  if (!state.armed) return
  const owner = state
  const timer = settings.setTimer(
    () => {
      if (owner !== state || state.retryTimer !== timer) return
      state.retryTimer = null
      if (state.index === null && !state.loading) loadLookupIndex()
    },
    delay,
    "retry"
  )
  state.retryTimer = timer
}

async function runLoad(run) {
  const started = performance.now()
  let catalogue
  try {
    catalogue = await settings.loader.catalogue()
    if (run !== generation) return null
    // The store whose index was abandoned: nothing to do until it changes,
    // which only the catalogue can tell, so it is read again later.
    if (catalogue.fingerprint === state.refused) {
      scheduleLoad(longestDelay())
      return null
    }
    state.refused = null
    let index = null
    let mismatch = null
    try {
      index = await settings.loader.load(catalogue)
    } catch (error) {
      if (!(error instanceof LookupCountMismatch)) throw error
      mismatch = error
    }
    if (run !== generation) return null
    // A store replaced while it was being read gives a mixed index, or
    // pages that do not add up to the count read before them.
    const after = await settings.loader.catalogue()
    if (run !== generation) return null
    if (after.fingerprint !== catalogue.fingerprint) {
      settings.log(
        "lookup index: the store changed while loading, loading it again"
      )
      scheduleLoad(0)
      return null
    }
    // The same store before and after, so its descriptions do not add up
    // to its own count, and will not until it changes.
    if (mismatch)
      throw new LookupIndexError(
        `${mismatch.message}, and the store did not change while loading`
      )
    return adopt(index, started)
  } catch (error) {
    if (run !== generation) return null
    return fail(error, catalogue?.fingerprint)
  }
}

const longestDelay = () => settings.retryDelaysMs.at(-1)

// How the page reads of a load went, for its log line: the pages, the
// slowest of them, and the pages the store had to be asked for again.
function pagesSummary(loadPages) {
  if (!loadPages?.length) return ""
  const pages = loadPages.reduce((sum, source) => sum + source.pages, 0)
  const slowest = loadPages.reduce((a, b) =>
    b.slowestMs > a.slowestMs ? b : a
  )
  const retries = loadPages.reduce((sum, source) => sum + source.retries, 0)
  return (
    `, ${pages} pages with the slowest ${slowest.slowestMs} ms (${slowest.key})` +
    (retries ? `, ${retries} asked again` : "")
  )
}

function adopt(index, started) {
  clearRetry()
  state.index = index
  state.failures = 0
  state.lastError = null
  state.checkedAt = settings.now()
  state.loadedAt = settings.now()
  state.loadMs = Math.round(performance.now() - started)
  state.loadPages = index.loadPages
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
    `lookup index: loaded ${index.size} entries from ${index.sources.length} sources in ${state.loadMs} ms, index ${megabytes(state.indexBytes)} MB${peak}, heapUsed ${megabytes(state.heapUsed)} MB${pagesSummary(index.loadPages)}`
  )
  scheduleCheck()
  return index
}

// What /lookup-status says about a failure: a fixed phrase for each kind,
// never the message, which can carry the store's address, the start of a
// Fuseki error page or a file path. A refusal gives only its status code,
// and a message of no known kind a general phrase.
const COUNT_MISMATCH = /held \d+ descriptions and the store counts \d+/
const REASONS = [
  [
    /did not complete before the store stopped it|ran longer than the store allows/,
    "the store stopped a query at its time limit"
  ],
  [/could not reach the store/, "the store could not be reached"],
  [/was cancelled before the store answered/, "a query was cancelled"],
  [
    /ended before its end row|rows followed the end/,
    "an answer ended before its end row"
  ],
  [/gave no count/, "the store gave no count of a source"],
  [/the index worker stopped/, "the loader stopped"]
]

function publicReason(error) {
  if (COUNT_MISMATCH.test(String(error?.message ?? "")))
    return "the pages did not hold exactly the descriptions the store counts"
  if (error instanceof LookupIndexError)
    return /more than|larger than/.test(error.message)
      ? "the descriptions are more than the index accepts"
      : "a description is one the index cannot reproduce"
  const message = String(error?.message ?? "")
  const status = message.match(/answered HTTP (\d{3})/)
  if (status) return `the store answered HTTP ${status[1]}`
  for (const [pattern, phrase] of REASONS)
    if (pattern.test(message)) return phrase
  return "the load failed"
}

function fail(error, fingerprint) {
  state.index = null
  state.lastError = {
    message: error.message,
    reason: publicReason(error),
    at: settings.now()
  }
  if (error instanceof LookupIndexError) {
    state.refused = fingerprint ?? null
    settings.log(
      `lookup index: abandoned, lookups stay on SPARQL: ${error.message}`
    )
    scheduleLoad(longestDelay())
    return null
  }
  state.failures++
  const delays = settings.retryDelaysMs
  const delay = delays[Math.min(state.failures, delays.length) - 1]
  settings.log(
    `lookup index: not loaded, lookups use SPARQL and it is tried again in ${Math.round(delay / 1000)} s: ${error.message}`
  )
  scheduleLoad(delay)
  return null
}

// Loads the index unless a load is already running, whose promise is then
// returned. Resolves to the index, or null when it could not be loaded.
export function loadLookupIndex() {
  if (!state.loading) {
    const run = generation
    clearRetry()
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
    state.switchedOff = true
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
        clearCheck()
        settings.log("lookup index: the store changed, loading it again")
        if (state.armed) loadLookupIndex()
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
// and starts a load that is due, if the timer has not started it yet.
export async function usableLookupIndex() {
  if (state.index === null) {
    if (state.armed && !state.loading && settings.now() >= state.nextAttemptAt)
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

// Counts a SPARQL lookup running alongside a load, until it is released.
function storePlace(owner) {
  owner.storeLookups++
  let released = false
  return () => {
    if (released) return
    released = true
    owner.storeLookups--
  }
}

// How a lookup is answered, as { index, release }: the index when it is
// ready and current, or null for SPARQL. While a load runs, a lookup takes
// SPARQL's one place if it is free. Otherwise it waits for the load until
// `signal` fires or LOAD_WAIT_SHARE of the time to `deadline` has passed,
// and has the index if the load produced one by then, or else SPARQL with
// the time that is left. Without a deadline it waits for the load to end.
// A lookup given null calls release once its SPARQL query ends.
export async function lookupIndexFor({ signal, deadline } = {}) {
  const index = await usableLookupIndex()
  if (index || !state.loading) return { index, release: nothing }
  const owner = state
  if (owner.storeLookups < STORE_LOOKUPS_WHILE_LOADING)
    return { index: null, release: storePlace(owner) }
  const signals = signal ? [signal] : []
  if (deadline !== undefined)
    signals.push(
      AbortSignal.timeout(
        Math.max(0, Math.floor((deadline - Date.now()) * LOAD_WAIT_SHARE))
      )
    )
  await settledOrAborted(
    owner.loading,
    signals.length ? AbortSignal.any(signals) : undefined
  )
  if (owner !== state || signal?.aborted)
    return { index: null, release: nothing }
  if (state.index) return { index: state.index, release: nothing }
  // Still loading at the end of the wait: SPARQL, counted beside the place.
  return {
    index: null,
    release: state.loading ? storePlace(owner) : nothing
  }
}

// Counts which path answered, for the status and for tests.
export function noteLookup(answeredByIndex) {
  if (answeredByIndex) state.answered++
  else state.fallbacks++
}

// ready: lookups answer from the index. loading: a load runs or is about
// to. failed: the last load failed, and another is scheduled when the
// index loads by itself. abandoned: the store holds what the index cannot,
// until it changes. off: nothing loads the index, because it is switched
// off or was never started.
function stateName() {
  if (state.index) return "ready"
  if (state.loading) return "loading"
  if (state.switchedOff) return "off"
  if (state.refused !== null) return "abandoned"
  if (state.lastError !== null) return "failed"
  return state.armed ? "loading" : "off"
}

export function lookupIndexStatus() {
  return {
    state: stateName(),
    entries: state.index?.size,
    sources: state.index?.sources.map((source) => source.key),
    loadedAt: state.loadedAt,
    loadMs: state.loadMs,
    loadPages: state.loadPages,
    indexBytes: state.indexBytes,
    loadPeakBytes: state.loadPeakBytes,
    heapUsed: state.heapUsed,
    failures: state.failures,
    lastError: state.lastError?.message,
    nextAttemptAt: state.retryTimer === null ? undefined : state.nextAttemptAt,
    storeLookups: state.storeLookups,
    answered: state.answered,
    fallbacks: state.fallbacks
  }
}

const isoTime = (ms) =>
  Number.isFinite(ms) ? new Date(ms).toISOString() : null

// What GET /lookup-status answers. It reads nothing from the store, so a
// health check can poll it while the index loads without slowing the load,
// and it is safe to serve publicly: the state, the size and the source
// keys the catalogue page already lists, times, and for a failure a fixed
// phrase rather than the error, with no address, path or setting.
export function publicLookupStatus() {
  const ready = state.index !== null
  const pages = ready ? state.loadPages : undefined
  return {
    state: stateName(),
    entries: ready ? state.index.size : null,
    sources: ready ? state.index.sources.map((source) => source.key) : [],
    loadedAt: ready ? isoTime(state.loadedAt) : null,
    loadMs: ready ? state.loadMs : null,
    pages: pages ? pages.reduce((sum, source) => sum + source.pages, 0) : null,
    slowestPageMs: pages?.length
      ? Math.max(...pages.map((source) => source.slowestMs))
      : null,
    lastError: state.lastError?.reason ?? null,
    nextAttemptAt:
      state.retryTimer === null ? null : isoTime(state.nextAttemptAt)
  }
}

// The loaded index, for diagnostics and verification only.
export function currentLookupIndex() {
  return state.index
}

// Test hooks: replace the loader, the clock, the interval, the retry
// delays, the timers or the log.
export function configureLookupIndex(options = {}) {
  settings = { ...settings, ...options }
}

// Forgets the index and every setting, and stops a pending retry or check.
// A load or check still running belongs to the previous generation and is
// ignored when it finishes.
export function resetLookupIndex() {
  clearRetry()
  clearCheck()
  generation++
  settings = defaults()
  state = freshState()
}
