// The MatSci-ONT application server: browse pages now, the MCP endpoint and
// grounding route in their phases. Loopback only, read-only, one process.
//
//   node mcp/app.mjs            (expects Fuseki per MATSCI_ONT_QUERY_URL)
//   pnpm dev                    (starts Fuseki and this together)

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import {
  cataloguePage,
  sourcePage,
  entityPage,
  searchPage,
  graphJson,
  graphPage
} from "./pages.mjs"
import { errorPage } from "./lib/html.mjs"
import { grounding } from "./data.mjs"
import { RejectedInput } from "./lib/sparql.mjs"
import { handleMcpRequest, MAX_REQUEST_BYTES } from "./mcp.mjs"

const require = createRequire(import.meta.url)

export const DEFAULT_APP_PORT = Number(process.env.MATSCI_ONT_APP_PORT ?? 3100)

// Assets are the pinned pnpm packages served from node_modules plus the one
// stylesheet. Nothing is fetched from a CDN.
const ASSETS = {
  "/assets/style.css": [
    new URL("./static/style.css", import.meta.url).pathname,
    "text/css"
  ],
  "/assets/cytoscape.min.js": [
    require.resolve("cytoscape/dist/cytoscape.min.js"),
    "text/javascript"
  ],
  "/assets/dagre.min.js": [
    require.resolve("dagre/dist/dagre.min.js"),
    "text/javascript"
  ],
  "/assets/cytoscape-dagre.min.js": [
    require
      .resolve("cytoscape-dagre")
      .replace(/cytoscape-dagre\.js$/, "cytoscape-dagre.min.js"),
    "text/javascript"
  ]
}

async function handle(url) {
  if (url.pathname === "/") {
    return { status: 200, type: "text/html", body: await cataloguePage() }
  }
  // The grounding route: definition text for a term, as JSON, for a
  // service that will show it to a reader. Every entry names its source
  // and licence because the caller has to pass those on.
  if (url.pathname === "/grounding") {
    const sources = url.searchParams.get("sources")
    const limit = url.searchParams.get("limit")
    const answer = await grounding(url.searchParams.get("q"), {
      sources: sources ? sources.split(",").filter(Boolean) : undefined,
      limit: limit === null ? undefined : Number(limit),
      includeMirror: url.searchParams.get("includeMirror") === "1"
    })
    return {
      status: 200,
      type: "application/json",
      body: JSON.stringify(answer, null, 2)
    }
  }
  if (url.pathname === "/search") {
    return {
      status: 200,
      type: "text/html",
      body: await searchPage(url.searchParams.get("q"))
    }
  }
  if (url.pathname === "/entity") {
    const iri = url.searchParams.get("iri") ?? ""
    const page = await entityPage(iri, url.searchParams.get("inferred") === "1")
    return { status: page.status, type: "text/html", body: page.html }
  }
  const sourceMatch = url.pathname.match(/^\/source\/([a-z0-9-]{1,64})$/)
  if (sourceMatch) {
    const page = await sourcePage(
      sourceMatch[1],
      url.searchParams.get("inferred") === "1"
    )
    return { status: page.status, type: "text/html", body: page.html }
  }
  const jsonMatch = url.pathname.match(/^\/graph\/([a-z0-9-]{1,64})\.json$/)
  if (jsonMatch) {
    const result = await graphJson(jsonMatch[1])
    return {
      status: result.status,
      type: "application/json",
      body: JSON.stringify(result.body)
    }
  }
  const graphMatch = url.pathname.match(/^\/graph\/([a-z0-9-]{1,64})$/)
  if (graphMatch) {
    const page = await graphPage(graphMatch[1])
    return { status: page.status, type: "text/html", body: page.html }
  }
  const asset = ASSETS[url.pathname]
  if (asset) {
    return { status: 200, type: asset[1], body: await readFile(asset[0]) }
  }
  return {
    status: 404,
    type: "text/html",
    body: errorPage(404, "No such page.")
  }
}

export function startApp(port = DEFAULT_APP_PORT) {
  const server = createServer(async (request, response) => {
    // The MCP endpoint is the one path that takes a POST, so it is matched
    // before the read-only guard below. The transport writes its own
    // status, headers and body, and the body must not be read first.
    if (request.url?.split("?")[0] === "/mcp") {
      if (request.method !== "POST") {
        response
          .writeHead(405, { "Content-Type": "application/json", Allow: "POST" })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "This endpoint takes POST." },
              id: null
            })
          )
        return
      }
      // A request body is read into memory by the transport, and this
      // process also serves the pages, so an oversized one is refused
      // before it is read rather than after.
      const declared = Number(request.headers["content-length"] ?? 0)
      if (declared > MAX_REQUEST_BYTES) {
        response.writeHead(413, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `A request may be at most ${MAX_REQUEST_BYTES / 1024} KB.`
            },
            id: null
          })
        )
        return
      }
      try {
        await handleMcpRequest(request, response)
      } catch (error) {
        process.stderr.write(`/mcp: ${error.message}\n`)
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "The server could not answer." },
              id: null
            })
          )
        }
      }
      return
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Content-Type": "text/plain" }).end("read-only")
      return
    }
    // Everything that can throw, including parsing a malformed request
    // target, is inside the try, so no single request can take the process
    // down. A rejected identifier is the client's error and answers 404; a
    // failure to reach the store is the server's and answers 502.
    let pathname = request.url
    try {
      const url = new URL(request.url, "http://localhost")
      pathname = url.pathname
      const result = await handle(url)
      response
        .writeHead(result.status, {
          "Content-Type": `${result.type}; charset=utf-8`,
          "Cache-Control": url.pathname.startsWith("/assets/")
            ? "max-age=86400"
            : "no-cache"
        })
        .end(result.body)
    } catch (error) {
      if (error instanceof RejectedInput) {
        response
          .writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
          .end(errorPage(404, "No such page."))
        return
      }
      process.stderr.write(`${pathname}: ${error.message}\n`)
      response
        .writeHead(502, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          errorPage(
            502,
            "The store did not answer. Is Fuseki running (pnpm serve or pnpm dev)?"
          )
        )
    }
  })
  // Rejects rather than emitting an unhandled error event, so a caller that
  // started other processes can stop them. A port already in use would
  // otherwise kill the process where it stands.
  return new Promise((resolve, reject) => {
    const failed = (error) => reject(error)
    server.once("error", failed)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", failed)
      resolve(server)
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startApp()
  console.log(
    `MatSci-ONT browse application at http://localhost:${DEFAULT_APP_PORT}/`
  )
}
