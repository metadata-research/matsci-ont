// Serves the built store locally until interrupted.
//
//   node pipeline/serve.mjs [--port=3031]

import { join } from "node:path"
import { ROOT } from "../shared/paths.mjs"
import { startFuseki, stopFuseki, DEFAULT_PORT } from "../shared/fuseki.mjs"

const portArgument = process.argv.find((a) => a.startsWith("--port="))
const port = portArgument
  ? Number(portArgument.slice("--port=".length))
  : DEFAULT_PORT

const server = await startFuseki({
  storeLocation: join(ROOT, "build/tdb2"),
  port
})

console.log(`MatSci-ONT store at ${server.base}`)
console.log(`  query  ${server.base}/query`)
console.log(
  `  try    curl -s '${server.base}/query' --data-urlencode 'query=SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }'`
)
console.log("stop with ctrl-c")

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await stopFuseki(server)
    process.exit(0)
  })
}
