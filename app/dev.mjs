// Starts Fuseki over the built store and the application together, for
// working in a browser with one command.
//
//   pnpm dev

import { join } from "node:path"
import { ROOT } from "../shared/paths.mjs"
import { startFuseki, stopFuseki, DEFAULT_PORT } from "../shared/fuseki.mjs"
import { startApp, DEFAULT_APP_PORT } from "./app.mjs"

// The application can fail to start, a port already in use being the
// common way, and a store left running holds the TDB2 lock against every
// later build.
let fuseki
let app
try {
  fuseki = await startFuseki({ storeLocation: join(ROOT, "build/tdb2") })
  app = await startApp()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  app?.close()
  if (fuseki) await stopFuseki(fuseki)
  process.exit(1)
}

console.log(`store  ${fuseki.base}/query (port ${DEFAULT_PORT})`)
console.log(`browse http://localhost:${DEFAULT_APP_PORT}/`)
console.log("stop with ctrl-c")

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    app.close()
    await stopFuseki(fuseki)
    process.exit(0)
  })
}
