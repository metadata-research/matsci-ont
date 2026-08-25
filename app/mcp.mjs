// The MCP surface over the store. Five read-only tools, no state.
//
// A fresh server and transport are built per request: the 1.30.0 transport
// refuses reuse in stateless mode, and stateless is what suits a service
// that holds no session state of its own.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { RejectedInput } from "./lib/terms.mjs"
import {
  listSources,
  getSource,
  getEntity,
  findEntities,
  sparqlQuery,
  ROW_CAP
} from "./data.mjs"

export const INSTRUCTIONS = `MatSci-ONT serves versioned snapshots of published materials-science
ontologies: PMD Core Ontology, CHAMEO, the Materials Design Ontology, and
the NIST Materials Data Vocabulary. Every entity keeps the identifier its
publisher minted, and this service never edits or republishes an ontology
beyond serving what its publisher released.

Call list_sources first to see what is loaded. An answer drawn from a
source must credit that source by name, and by version where it has one.
list_sources, get_source, get_entity and find_entities return the source
and its licence with the content. sparql_query does not: a query chooses
its own columns, so name the graph a result came from if the answer needs
crediting.

Some sources are mirrors of a living dataset published elsewhere, marked
with mirrorOf and the date its publisher last projected it. A mirror is
not the source of record. One whose clearedForPublication is false holds
content with no declared licence, so cite where it came from and do not
present it as free to reuse.

A hierarchy placement marked inferred was derived by an OWL reasoner
(HermiT) at build time and is not asserted by the source. Say so when
passing one on.`

// A tool result carries both the readable text and the structured payload,
// so a client that reads either sees the same thing.
function result(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  }
}

// A rejected input is the caller's mistake and says what to do instead. Any
// other failure is this service's and is passed on as its message.
async function answering(work) {
  try {
    return result(await work())
  } catch (error) {
    if (error instanceof RejectedInput) throw new Error(error.message)
    throw error
  }
}

const sourceShape = {
  key: z.string(),
  title: z.string(),
  license: z.string(),
  graphIri: z.string(),
  triples: z.number(),
  entries: z.number(),
  clearedForPublication: z.boolean(),
  // A mirror has neither, and states what it mirrors instead.
  version: z.string().optional(),
  ontologyIri: z.string().optional(),
  mirrorOf: z.string().optional(),
  mirroredFrom: z.string().optional(),
  authorityBase: z.string().optional()
}

// Declared on every tool that can cut its answer, so a client reads the
// cap signal from the schema rather than discovering it.
const findShape = {
  results: z.array(
    z.object({
      iri: z.string(),
      label: z.string(),
      definition: z.string().optional(),
      source: z.string(),
      version: z.string().optional(),
      license: z.string(),
      clearedForPublication: z.boolean().optional(),
      mirrorOf: z.string().optional(),
      mirroredFrom: z.string().optional()
    })
  ),
  truncated: z.boolean()
}

const entityShape = {
  iri: z.string(),
  describedHere: z.boolean(),
  label: z.string().optional(),
  definition: z.string().optional(),
  definitionProperty: z.string().optional(),
  note: z.string().optional(),
  source: z
    .object({
      key: z.string(),
      version: z.string().optional(),
      license: z.string(),
      clearedForPublication: z.boolean().optional(),
      mirrorOf: z.string().optional(),
      mirroredFrom: z.string().optional()
    })
    .optional(),
  triples: z
    .array(
      z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        objectKind: z.string(),
        language: z.string().optional(),
        graph: z.string()
      })
    )
    .optional(),
  referencedBy: z
    .array(
      z.object({
        iri: z.string(),
        label: z.string().optional(),
        predicate: z.string()
      })
    )
    .optional(),
  inferredParents: z.array(z.string()).optional(),
  truncated: z.boolean()
}

const queryShape = {
  form: z.string(),
  variables: z.array(z.string()).optional(),
  rows: z.array(z.record(z.string(), z.string())).optional(),
  boolean: z.boolean().optional(),
  turtle: z.string().optional(),
  truncated: z.boolean()
}

export function buildMcpServer() {
  const server = new McpServer(
    { name: "matsci-ont", version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  )

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "The ontologies this hub holds, with version, licence, size, and how many entries are indexed from each.",
      inputSchema: {},
      outputSchema: { sources: z.array(z.object(sourceShape)) },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => answering(async () => ({ sources: await listSources() }))
  )

  server.registerTool(
    "get_source",
    {
      title: "Get source",
      description:
        "One source in full: its catalogue record, the pinned download and digest, and what reasoning added.",
      inputSchema: {
        key: z
          .string()
          .describe(
            "Source key, as returned by list_sources, for example pmdco"
          )
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ key }) => answering(() => getSource(key))
  )

  server.registerTool(
    "get_entity",
    {
      title: "Get entity",
      description:
        "Everything the store holds about one entity IRI: its label and definition with the source that states them, the triples the source asserts, and any parent an OWL reasoner derived.",
      inputSchema: {
        iri: z
          .string()
          .describe(
            "Absolute http or https IRI of a class, property or concept"
          )
      },
      outputSchema: entityShape,
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ iri }) => answering(() => getEntity(iri))
  )

  server.registerTool(
    "find_entities",
    {
      title: "Find entities",
      description:
        "Search labels and definitions across every source, matching whole words. Returns each hit with its source, version and licence.",
      inputSchema: {
        q: z
          .string()
          .min(1)
          .describe("Term to search for, matched on word boundaries"),
        sources: z
          .array(z.string())
          .optional()
          .describe("Optional source keys to search within, from list_sources"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum hits, default 20")
      },
      outputSchema: findShape,
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ q, sources, limit }) =>
      answering(() => findEntities(q, { sources, limit }))
  )

  server.registerTool(
    "sparql_query",
    {
      title: "SPARQL query",
      description: `Run a read-only SPARQL 1.1 query over the whole store. SELECT, ASK, CONSTRUCT and DESCRIBE only. A query without GRAPH sees every source at once. SELECT rows are capped, at ${ROW_CAP} at most, and a cut answer says so in its truncated field. A CONSTRUCT or DESCRIBE is returned whole, so give it a LIMIT: an answer that passes 2 MB is refused rather than assembled. Named graphs are listed by list_sources.`,
      inputSchema: {
        query: z.string().min(1).describe("SPARQL query text"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(ROW_CAP)
          .optional()
          .describe(`Maximum rows, default 200, at most ${ROW_CAP}`)
      },
      outputSchema: queryShape,
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query, limit }) => answering(() => sparqlQuery(query, { limit }))
  )

  return server
}

// A request body is held in memory while it is parsed, and this process
// serves the browse pages too, so the body is read here under a ceiling
// rather than by the transport without one. A declared length over the
// ceiling is refused in app.mjs before any of it is read; this bounds the
// rest, chunked bodies included.
export const MAX_REQUEST_BYTES = 1024 * 1024

class BodyTooLarge extends Error {}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) {
      request.destroy()
      throw new BodyTooLarge()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// Answers one MCP request. The transport writes the status, headers and
// body itself, so the caller must not have touched the response.
export async function handleMcpRequest(request, response) {
  let parsed
  try {
    const raw = await readBody(request)
    parsed = raw === "" ? undefined : JSON.parse(raw)
  } catch (error) {
    const tooLarge = error instanceof BodyTooLarge
    if (!response.headersSent) {
      response
        .writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: tooLarge ? -32000 : -32700,
              message: tooLarge
                ? `A request may be at most ${MAX_REQUEST_BYTES / 1024} KB.`
                : "The request body is not JSON."
            },
            id: null
          })
        )
    }
    return
  }

  const server = buildMcpServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  response.on("close", () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(request, response, parsed)
}
