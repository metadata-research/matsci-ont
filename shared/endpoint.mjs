// Where the store answers.
//
// The build starts Fuseki here and the application queries it here. Written
// out on both sides, a changed default would start a store the application
// could not reach, and the application would report that nothing was
// running rather than that the two disagreed.

// Port 3031 rather than the Fuseki default: a workstation running this
// alongside the MatSci-SAM store has 3030 taken. In production the two are
// one process serving two datasets, and neither takes a second port.
export const DEFAULT_STORE_PORT = Number(
  process.env.MATSCI_ONT_FUSEKI_PORT ?? 3031
)

export const DATASET = "matsci-ont"

export function datasetUrl(port = DEFAULT_STORE_PORT, host = "127.0.0.1") {
  return `http://${host}:${port}/${DATASET}`
}

// Resolved per call rather than at module load. Reading it once when the
// module first loads made the answer depend on import order, which a
// caller cannot see and which the verification harness had to work around.
export function queryUrl() {
  return process.env.MATSCI_ONT_QUERY_URL ?? `${datasetUrl()}/query`
}
