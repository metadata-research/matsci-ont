// The MatSci-ONT application server: browse pages now, the MCP endpoint and
// grounding route in their phases. Loopback only, read-only, one process.
//
//   node mcp/app.mjs            (expects Fuseki per MATSCI_ONT_QUERY_URL)
//   pnpm dev                    (starts Fuseki and this together)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  cataloguePage,
  sourcePage,
  entityPage,
  searchPage,
  graphJson,
  graphPage,
} from "./pages.mjs";
import { errorPage } from "./lib/html.mjs";
import { RejectedInput } from "./lib/sparql.mjs";

const require = createRequire(import.meta.url);

export const DEFAULT_APP_PORT = Number(process.env.MATSCI_ONT_APP_PORT ?? 3100);

// Assets are the pinned pnpm packages served from node_modules plus the one
// stylesheet. Nothing is fetched from a CDN.
const ASSETS = {
  "/assets/style.css": [new URL("./static/style.css", import.meta.url).pathname, "text/css"],
  "/assets/cytoscape.min.js": [require.resolve("cytoscape/dist/cytoscape.min.js"), "text/javascript"],
  "/assets/dagre.min.js": [require.resolve("dagre/dist/dagre.min.js"), "text/javascript"],
  "/assets/cytoscape-dagre.min.js": [
    require.resolve("cytoscape-dagre").replace(/cytoscape-dagre\.js$/, "cytoscape-dagre.min.js"),
    "text/javascript",
  ],
};

async function handle(url) {
  if (url.pathname === "/") {
    return { status: 200, type: "text/html", body: await cataloguePage() };
  }
  if (url.pathname === "/search") {
    return { status: 200, type: "text/html", body: await searchPage(url.searchParams.get("q")) };
  }
  if (url.pathname === "/entity") {
    const iri = url.searchParams.get("iri") ?? "";
    const page = await entityPage(iri, url.searchParams.get("inferred") === "1");
    return { status: page.status, type: "text/html", body: page.html };
  }
  const sourceMatch = url.pathname.match(/^\/source\/([a-z0-9-]{1,64})$/);
  if (sourceMatch) {
    const page = await sourcePage(sourceMatch[1], url.searchParams.get("inferred") === "1");
    return { status: page.status, type: "text/html", body: page.html };
  }
  const jsonMatch = url.pathname.match(/^\/graph\/([a-z0-9-]{1,64})\.json$/);
  if (jsonMatch) {
    const result = await graphJson(jsonMatch[1]);
    return { status: result.status, type: "application/json", body: JSON.stringify(result.body) };
  }
  const graphMatch = url.pathname.match(/^\/graph\/([a-z0-9-]{1,64})$/);
  if (graphMatch) {
    const page = await graphPage(graphMatch[1]);
    return { status: page.status, type: "text/html", body: page.html };
  }
  const asset = ASSETS[url.pathname];
  if (asset) {
    return { status: 200, type: asset[1], body: await readFile(asset[0]) };
  }
  return { status: 404, type: "text/html", body: errorPage(404, "No such page.") };
}

export function startApp(port = DEFAULT_APP_PORT) {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Content-Type": "text/plain" }).end("read-only");
      return;
    }
    // Everything that can throw, including parsing a malformed request
    // target, is inside the try, so no single request can take the process
    // down. A rejected identifier is the client's error and answers 404; a
    // failure to reach the store is the server's and answers 502.
    let pathname = request.url;
    try {
      const url = new URL(request.url, "http://localhost");
      pathname = url.pathname;
      const result = await handle(url);
      response
        .writeHead(result.status, {
          "Content-Type": `${result.type}; charset=utf-8`,
          "Cache-Control": url.pathname.startsWith("/assets/") ? "max-age=86400" : "no-cache",
        })
        .end(result.body);
    } catch (error) {
      if (error instanceof RejectedInput) {
        response
          .writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
          .end(errorPage(404, "No such page."));
        return;
      }
      process.stderr.write(`${pathname}: ${error.message}\n`);
      response
        .writeHead(502, { "Content-Type": "text/html; charset=utf-8" })
        .end(errorPage(502, "The store did not answer. Is Fuseki running (pnpm serve or pnpm dev)?"));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startApp();
  console.log(`MatSci-ONT browse application at http://localhost:${DEFAULT_APP_PORT}/`);
}
