// Starts Fuseki over the built store and the application together, for
// working in a browser with one command.
//
//   pnpm dev

import { join } from "node:path"
import { ROOT } from "../pipeline/lib/tools.mjs"
import {
  startFuseki,
  stopFuseki,
  DEFAULT_PORT
} from "../pipeline/lib/fuseki.mjs"
import { startApp, DEFAULT_APP_PORT } from "./app.mjs"

const fuseki = await startFuseki({ storeLocation: join(ROOT, "build/tdb2") })
const app = await startApp()

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
