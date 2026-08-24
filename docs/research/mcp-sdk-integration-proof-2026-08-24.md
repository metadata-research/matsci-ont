Proof servers are down (the remaining `server.mjs` matches are unrelated Codex plugin processes; ports 3197–3199 are free). Final report follows.

# MCP endpoint for MatSci-ONT's plain `node:http` server — empirical report

Everything below marked **PROVEN** was executed on this machine (Node v24.19.0, pnpm 10.34.5) in `/tmp/claude-1000/-home-chris-dev/8d31cd45-6239-4260-8f1d-5068132225be/scratchpad/mcp-sdk-exp/`. Files: `server.mjs` (JSON-mode proof), `server2.mjs` (SSE-mode + structuredContent proof), `client.mjs`.

## 1. Package facts (PROVEN via `npm view`, 2026-08-24)

| Fact | Value |
|---|---|
| Package | `@modelcontextprotocol/sdk` |
| Latest version (`dist-tags.latest`) | **1.30.0** (registry last modified 2026-07-27) |
| License | MIT |
| Tarball | `https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz` |
| Integrity | `sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==` (identical string appears in the generated `pnpm-lock.yaml` — verified) |
| engines | `node >= 18` (Node 24.19.0 fine, zero warnings) |

**Dependency footprint (PROVEN by install):** `pnpm add @modelcontextprotocol/sdk@1.30.0 zod@latest` → **92 packages, 22 MB node_modules**. The SDK is *not* lean: hard deps include `express ^5.2.1`, `hono ^4.11.4`, `@hono/node-server`, `cors`, `jose ^6`, `ajv ^8` + `ajv-formats`, `eventsource` + `eventsource-parser`, `raw-body`, `cross-spawn`, `content-type`, `pkce-challenge`, `express-rate-limit`, `zod-to-json-schema`, `json-schema-typed`. The Node `StreamableHTTPServerTransport` is now (1.30.0) a thin wrapper over `WebStandardStreamableHTTPServerTransport` and uses `@hono/node-server` internally for the IncomingMessage↔Request conversion — hono is actually exercised at runtime, express is dead weight for us but installed regardless.

**Peer deps:** `zod: ^3.25 || ^4.0` (**required**, `optional: false`), `@cfworker/json-schema ^4.1.1` (optional — skippable). `zod@4.4.3` resolves to a **single** zod in the tree (`pnpm why zod`: 1 version, `zod-to-json-schema@3.25.2` dedupes onto it).

## 2. Minimal working proof (PROVEN end-to-end)

Commands:
```sh
pnpm init   # then set "type": "module"
pnpm add @modelcontextprotocol/sdk@1.30.0 zod@latest   # zod 4.4.3
node server.mjs &
node client.mjs
```

Exact server code that worked (`server.mjs`), structurally parallel to `mcp/app.mjs`:

```js
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const INSTRUCTIONS = "Read-only proof server. Use the echo tool to round-trip text.";

// Stateless: a fresh McpServer + transport PER REQUEST. 1.30.0 throws
// "Stateless transport cannot be reused across requests" if you reuse one.
function buildMcpServer() {
  const mcp = new McpServer(
    { name: "matsci-ont-proof", version: "0.0.1" },
    { instructions: INSTRUCTIONS },
  );
  mcp.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes back the given text.",
      inputSchema: { text: z.string().min(1).describe("Text to echo back") },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  return mcp;
}

async function handleMcp(request, response) {
  const mcp = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true,        // plain JSON bodies instead of SSE
  });
  response.on("close", () => { transport.close(); mcp.close(); });
  await mcp.connect(transport);
  await transport.handleRequest(request, response); // transport writes status+headers+body
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/mcp") {
    if (request.method !== "POST") {
      response
        .writeHead(405, { "Content-Type": "application/json", Allow: "POST" })
        .end(JSON.stringify({ jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." }, id: null }));
      return;
    }
    await handleMcp(request, response);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Content-Type": "text/plain" }).end("read-only");
    return;
  }
  // ...normal page routing unchanged...
});
server.listen(3199, "127.0.0.1");
```

Client (`client.mjs`) used `Client` + `StreamableHTTPClientTransport` (`.../client/index.js`, `.../client/streamableHttp.js`); `client.connect(transport)` performs initialize + `notifications/initialized`. **Actual output:**

```
serverInfo: {"name":"matsci-ont-proof","version":"0.0.1"}
instructions: "Read-only proof server. Use the echo tool to round-trip text."
capabilities: {"tools":{"listChanged":true}}
sessionId: undefined
tools/list: { "tools": [ { "name": "echo", "title": "Echo",
  "description": "Echoes back the given text.",
  "inputSchema": { "type": "object",
    "properties": { "text": { "type": "string", "minLength": 1, "description": "Text to echo back" } },
    "required": ["text"], "$schema": "http://json-schema.org/draft-07/schema#" },
  "execution": { "taskSupport": "forbidden" } } ] }
tools/call: { "content": [ { "type": "text", "text": "echo: hello matsci" } ] }
bad-args result: {"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool echo: Invalid input: expected string, received number at text"}],"isError":true}
```

Normal pages verified alongside: `GET /` → 200 HTML; `POST /` → 405 `read-only` (existing contract intact).

## 3. Precise answers

**Does the transport need POST+GET+DELETE routes?** The transport's `handleRequest` dispatches POST/GET/DELETE itself (anything else → its own 405). But **POST-only is sufficient and spec-conformant** (PROVEN): the full SDK-client handshake succeeded against a `/mcp` that answers 405 to everything but POST. Proven from the 1.30.0 client source: the client's standalone-SSE GET has an explicit branch "405 indicates that the server does not offer an SSE stream at GET endpoint" and treats it as valid; DELETE (`terminateSession`) is **only sent when a `sessionId` exists** — never in stateless mode — and 405 is tolerated there too.

**Coexistence with the GET/HEAD-only app:** intercept `url.pathname === "/mcp"` **before** the existing `method !== GET/HEAD → 405` guard in `startApp`'s `createServer` callback (exactly as above); leave `handle(url)` untouched. The transport writes its own status/headers/body — do not set `Content-Type`/`Cache-Control` on `/mcp` responses, and do not pre-read the request body (the transport parses it; `parsedBody` param exists if you ever do).

**Stateless mode:** `sessionIdGenerator: undefined` = stateless. PROVEN: no `Mcp-Session-Id` header ever emitted, client `transport.sessionId === undefined`, no server-side session map, and bare `tools/list`/`tools/call` via curl with **no prior initialize** succeed. **1.30.0-specific:** a stateless transport *throws* if reused across requests ("Create a new transport per request") — so build a fresh `McpServer` + transport per POST. Cost measured: **2.39 ms per full tools/call round trip** (sequential, loopback), negligible for this app.

**Accept-header requirements (PROVEN via curl):** POST must send `Accept: application/json, text/event-stream` (both), else 406 `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: ..."},"id":null}`. Requests work without an `MCP-Protocol-Version` header.

**Instructions string:** plain string, second constructor arg: `new McpServer({name, version}, { instructions: "..." })`. Returned verbatim in the initialize result's `instructions` field; client reads it via `client.getInstructions()` (PROVEN both on the wire and via SDK client).

**Tool results:** `{ content: [{ type: "text", text }] }` array. If the tool declares `outputSchema` (zod raw shape), also return `structuredContent` — PROVEN round trip: `{"content":[{"type":"text","text":"{...}"}],"structuredContent":{"key":"alumina","value":42,"truncated":false}}`. (When `outputSchema` is declared, `structuredContent` is required in results per the typings.)

**Error shapes (all PROVEN on the wire, all HTTP 200 with `isError: true` results — not JSON-RPC error frames):**
- handler `throw new Error("store did not answer")` → `{"result":{"content":[{"type":"text","text":"store did not answer"}],"isError":true},...}`
- invalid args → `isError` text `"MCP error -32602: Input validation error: ..."`
- unknown tool → `isError` text `"MCP error -32602: Tool nope not found"`

**Response mode:** `enableJsonResponse: true` → `content-type: application/json` plain bodies (recommended: curl-friendly, no stream bookkeeping). Default (omitted) → SSE framing `event: message\ndata: {...}` even for single request/response; the SDK client handles both (PROVEN both modes).

**Node/ESM gotchas:** none hit on Node 24.19.0. Pure-ESM `.mjs` with deep subpath imports (`@modelcontextprotocol/sdk/server/mcp.js`, `.../server/streamableHttp.js` — note the **`.js`** suffix is mandatory, the export map is `./*`) works cleanly; no experimental warnings. zod 4 is fine (peer `^3.25 || ^4.0`). The transport's built-in `allowedHosts`/`allowedOrigins` DNS-rebinding options are **deprecated** in 1.30.0 ("use external middleware"); irrelevant here since the app binds `127.0.0.1`.

## 4. Recommendation

**Pin:** `"@modelcontextprotocol/sdk": "1.30.0"` (exact) + direct dep `"zod": "4.4.3"`; lockfile integrity `sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==`. Accept the 92-package/22 MB footprint or note it as the price of the official SDK — there is no slimmer official transport package.

**Shape:** a `buildMcpServer()` factory in a new `mcp/mcp.mjs` registering all five tools; in `app.mjs`, the `/mcp` POST intercept exactly as proven above (fresh server+transport per request, `enableJsonResponse: true`, `response.on("close")` cleanup, own 405 with `Allow: POST` for GET/DELETE on `/mcp`).

**Tool mapping** (each via `mcp.registerTool(name, {title, description, inputSchema, outputSchema?}, handler)`; zod raw shapes, auto-converted to draft-07 JSON Schema in `tools/list`):
- `sparql_query`: `{ query: z.string().min(1), limit: z.number().int().min(1).max(CAP).optional() }` — handler enforces SELECT/ASK-only and the row cap server-side (zod can't).
- `get_entity`: `{ iri: z.string().min(1), inferred: z.boolean().optional() }` — reuse the entity-page data path.
- `find_entities`: `{ q: z.string().min(1), limit: z.number().int().min(1).max(CAP).optional() }`.
- `list_sources`: omit `inputSchema` (zero-arg proven fine for `echo`-style registration; zero-arg specifically UNCONFIRMED but the `ToolCallback` overload exists in typings).
- `get_source`: `{ id: z.string().regex(/^[a-z0-9-]{1,64}$/), inferred: z.boolean().optional() }` — mirrors the existing route's identifier pattern.

**Row-cap / error conventions (grounded in proven behavior):** give row-returning tools an `outputSchema` like `{ rows: z.array(...), truncated: z.boolean() }` and return both `content` (JSON text) and `structuredContent` — the `truncated: true` flag is the row-cap signal (structure round-trip PROVEN). For failures, `throw new Error("plain operator-facing message")` — the SDK converts it to an `isError` text result (PROVEN); map `RejectedInput` to a clean "no such entity/source" message rather than letting the raw message leak.

**UNCONFIRMED extras (not exercised):** `annotations: { readOnlyHint: true, idempotentHint: true }` on each tool (field exists in `registerTool` typings; serialization to `tools/list` untested); behavior of Claude Code / claude.ai as clients against this endpoint (only the SDK's own client + curl tested); zero-arg `registerTool` without `inputSchema`; the repo's `src/examples/server/simpleStatelessStreamableHttp.ts` referenced by the README as the canonical stateless example (docs/ not shipped in the tarball; not fetched).

Scratch artifacts: `/tmp/claude-1000/-home-chris-dev/8d31cd45-6239-4260-8f1d-5068132225be/scratchpad/mcp-sdk-exp/{server.mjs,server2.mjs,client.mjs,package.json,pnpm-lock.yaml}`.