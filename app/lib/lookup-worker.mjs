// The lookup index's loader, run in a worker thread by lookup-state.mjs.
// It posts either the packed index or why there is none, then ends, and
// its heap, with all the garbage of the build, goes with it.

import { parentPort, workerData } from "node:worker_threads"
import { LookupIndexError } from "./lookup-index.mjs"
import { loadIndex, packIndex } from "./lookup-load.mjs"

try {
  const { packed, transfer } = packIndex(await loadIndex(workerData))
  parentPort.postMessage({ index: packed }, transfer)
} catch (error) {
  parentPort.postMessage({
    error: error.message,
    refused: error instanceof LookupIndexError
  })
}
