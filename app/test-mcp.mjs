// Exercises the MCP endpoint with the client from the same SDK, which is
// the only way to know a real client can use it.
//
//   node app/test-mcp.mjs
//
// Starts the store and the application, so it needs a built store.

import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ROOT } from "../shared/paths.mjs"
import { startFuseki, stopFuseki } from "../shared/fuseki.mjs"

const PORT = 3198
const failures = []
function expect(label, condition, detail) {
  process.stdout.write(`${condition ? "pass" : "FAIL"}  ${label}\n`)
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`)
}

// Everything that starts a process is inside the try, so a failure between
// starting the store and starting the application cannot orphan a Fuseki
// holding the store lock, which would then block every later run.
let fuseki
let app
let client
const payload = (result) =>
  result.structuredContent ?? JSON.parse(result.content[0].text)

try {
  fuseki = await startFuseki({
    storeLocation: join(ROOT, "build/tdb2"),
    port: 3197
  })
  process.env.MATSCI_ONT_QUERY_URL = `${fuseki.base}/query`
  const { startApp } = await import("./app.mjs")
  app = await startApp(PORT)

  client = new Client({ name: "matsci-ont-test", version: "0.1.0" })
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PORT}/mcp`)
  )
  await client.connect(transport)

  expect(
    "the server names itself and states its scope",
    client.getServerVersion()?.name === "matsci-ont" &&
      (client.getInstructions() ?? "").includes("credit that source"),
    client.getServerVersion()?.name
  )
  expect("the session is stateless", transport.sessionId === undefined)

  const { tools } = await client.listTools()
  const names = tools.map((tool) => tool.name).sort()
  expect(
    "the five tools are listed",
    names.join(",") ===
      "find_entities,get_entity,get_source,list_sources,sparql_query",
    names.join(",")
  )
  expect(
    "every tool declares itself read-only",
    tools.every((tool) => tool.annotations?.readOnlyHint === true),
    tools
      .filter((tool) => !tool.annotations?.readOnlyHint)
      .map((tool) => tool.name)
      .join(",")
  )

  const sources = payload(
    await client.callTool({ name: "list_sources", arguments: {} })
  )
  expect(
    "list_sources returns every source with its licence",
    sources.sources.length === 9 &&
      sources.sources.every((source) => source.license),
    sources.sources
      .map((source) => `${source.key} ${source.license}`)
      .join(", ")
  )

  // A mirror says whose it is and whether it may be served publicly, so a
  // client passing its content on can say the same.
  const mirrors = sources.sources.filter((source) => source.mirrorOf)
  expect(
    "a mirrored source names what it mirrors and is marked uncleared",
    mirrors.length === 5 &&
      mirrors.every(
        (source) =>
          source.mirrorOf.includes("ego.cci.drexel.edu") &&
          source.clearedForPublication === false &&
          source.version === undefined
      ),
    mirrors
      .map((source) => `${source.key} cleared=${source.clearedForPublication}`)
      .join(", ")
  )

  // A mirrored vocabulary term has the definition its publisher states,
  // which is behind a revision node rather than on the term.
  const samTerm = payload(
    await client.callTool({
      name: "get_entity",
      arguments: { iri: "https://ego.cci.drexel.edu/vocabulary/sintering" }
    })
  )
  expect(
    "a mirrored term has its definition and its undeclared licence",
    samTerm.label === "sintering" &&
      /powder/.test(samTerm.definition ?? "") &&
      samTerm.source?.license === "UNDECLARED",
    `${samTerm.label} / ${samTerm.source?.license}`
  )

  // The cross-source lookup this hub exists to answer.
  const found = payload(
    await client.callTool({
      name: "find_entities",
      arguments: { q: "sintering" }
    })
  )
  const bySource = new Set(found.results.map((row) => row.source))
  expect(
    "find_entities answers one term from more than one source",
    bySource.size > 1 &&
      // Every hit names its licence. A version is named where the source
      // has one, and a mirror does not.
      found.results.every((row) => row.license) &&
      found.results.every((row) =>
        row.mirrorOf ? !row.version : Boolean(row.version)
      ),
    [...bySource].join(", ")
  )
  expect(
    "a mirrored hit is marked as one rather than given a pseudo-version",
    found.results.some(
      (row) => row.mirrorOf && row.clearedForPublication === false
    ),
    found.results
      .filter((row) => row.source.startsWith("sam-"))
      .map(
        (row) =>
          `${row.source} version=${row.version} mirrorOf=${Boolean(row.mirrorOf)}`
      )
      .join(", ")
  )
  expect(
    "a source filter narrows the search",
    payload(
      await client.callTool({
        name: "find_entities",
        arguments: { q: "sintering", sources: ["pmdco"] }
      })
    ).results.every((row) => row.source === "pmdco")
  )

  const entity = payload(
    await client.callTool({
      name: "get_entity",
      arguments: { iri: "https://w3id.org/pmd/co/PMD_0000934" }
    })
  )
  expect(
    "get_entity returns the definition with its source and licence",
    entity.label === "sintering" &&
      entity.definition &&
      entity.source?.license === "CC-BY-4.0",
    `${entity.label} / ${entity.source?.license}`
  )

  // The entity whose inferred parent the browse application shows.
  const inferred = payload(
    await client.callTool({
      name: "get_entity",
      arguments: { iri: "https://w3id.org/pmd/co/PMD_0000506" }
    })
  )
  expect(
    "get_entity separates a reasoner-derived parent from the asserted triples",
    inferred.inferredParents.includes(
      "http://purl.obolibrary.org/obo/BFO_0000017"
    ) &&
      !inferred.triples.some(
        (triple) =>
          triple.object === "http://purl.obolibrary.org/obo/BFO_0000017"
      ),
    inferred.inferredParents.join(", ")
  )

  const source = payload(
    await client.callTool({ name: "get_source", arguments: { key: "pmdco" } })
  )
  expect(
    "get_source reports what reasoning added",
    Number(source.inferredPairs) === 115 &&
      Number(source.entailedPairs) === 1581,
    `${source.inferredPairs} of ${source.entailedPairs}`
  )

  const query = payload(
    await client.callTool({
      name: "sparql_query",
      arguments: { query: "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }" }
    })
  )
  expect(
    "sparql_query answers a SELECT",
    Number(query.rows[0].n) > 40000,
    query.rows?.[0]?.n
  )

  const capped = payload(
    await client.callTool({
      name: "sparql_query",
      arguments: { query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 5 }
    })
  )
  expect(
    "a row cap is applied and reported",
    capped.rows.length === 5 && capped.truncated === true,
    `${capped.rows.length} rows, truncated ${capped.truncated}`
  )

  const update = await client.callTool({
    name: "sparql_query",
    arguments: {
      query: "INSERT DATA { <http://x/a> <http://x/b> <http://x/c> }"
    }
  })
  expect(
    "an update is refused with a message that says what to use",
    update.isError === true &&
      /SELECT, ASK, CONSTRUCT or DESCRIBE/.test(update.content[0].text),
    update.content?.[0]?.text?.slice(0, 100)
  )

  const missing = await client.callTool({
    name: "get_entity",
    arguments: { iri: "https://example.org/nothing" }
  })
  expect(
    "an unknown entity answers a clean message, not an internal one",
    missing.isError === true &&
      /nothing in the store mentions/.test(missing.content[0].text),
    missing.content?.[0]?.text?.slice(0, 100)
  )

  // Every tool that can cut its answer says so in its schema, so a client
  // does not have to discover the cap.
  const capable = tools.filter((tool) =>
    ["get_entity", "find_entities", "sparql_query"].includes(tool.name)
  )
  expect(
    "tools that cut their answer declare truncated in an output schema",
    capable.length === 3 &&
      capable.every((tool) => tool.outputSchema?.properties?.truncated),
    capable
      .map((tool) => `${tool.name}:${Boolean(tool.outputSchema)}`)
      .join(", ")
  )

  // An IRI the store holds only as an object is described honestly rather
  // than reported missing.
  const objectOnly = payload(
    await client.callTool({
      name: "get_entity",
      arguments: { iri: "http://www.w3.org/2002/07/owl#Ontology" }
    })
  )
  expect(
    "an entity present only as an object is reported, not denied",
    objectOnly.describedHere === false && objectOnly.referencedBy.length > 0,
    `describedHere ${objectOnly.describedHere}, ${objectOnly.referencedBy?.length} references`
  )

  // An unlabelled entity is skipped by the definitions index, but its
  // triples still come from a licensed source.
  const unlabelled = payload(
    await client.callTool({
      name: "get_entity",
      arguments: { iri: "http://purl.org/dc/terms/title" }
    })
  )
  expect(
    "an entity with no index entry still names the source of its triples",
    unlabelled.source?.license !== undefined,
    JSON.stringify(unlabelled.source)
  )

  // A query whose answer would be assembled whole in this process is
  // refused. Before this check the process grew past a gigabyte and
  // returned an internal string-length error.
  const huge = await client.callTool({
    name: "sparql_query",
    arguments: { query: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }" }
  })
  expect(
    "an oversized answer is refused with guidance",
    huge.isError === true && /LIMIT|MB/.test(huge.content[0].text),
    huge.content?.[0]?.text?.slice(0, 120)
  )

  // A query whose result set is larger than the store: the cap goes into
  // the query, so the store returns the rows asked for instead of this
  // process assembling a cartesian product. Before the cap was pushed
  // down, this call grew the application past a gigabyte and came back
  // with an internal string-length error.
  const before = process.memoryUsage().rss
  const started = Date.now()
  const cartesian = payload(
    await client.callTool({
      name: "sparql_query",
      arguments: {
        query: "SELECT * WHERE { ?a ?b ?c . ?d ?e ?f . ?g ?h ?i }",
        limit: 10
      }
    })
  )
  const grewMb = (process.memoryUsage().rss - before) / (1024 * 1024)
  expect(
    "a result set larger than the store is bounded by the store, not by this process",
    cartesian.rows.length === 10 &&
      cartesian.truncated === true &&
      Date.now() - started < 20000 &&
      grewMb < 200,
    `${cartesian.rows?.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s, grew ${grewMb.toFixed(0)} MB`
  )

  // A SELECT containing the word INSERT inside a literal is a query, not
  // an update, and must not be refused.
  const literalInsert = await client.callTool({
    name: "sparql_query",
    arguments: {
      query:
        'SELECT ?s WHERE { ?s ?p "INSERT DATA is not an update here" } LIMIT 1'
    }
  })
  expect(
    "an update keyword inside a literal is not mistaken for an update",
    literalInsert.isError !== true,
    literalInsert.content?.[0]?.text?.slice(0, 120)
  )

  const commentedUpdate = await client.callTool({
    name: "sparql_query",
    arguments: {
      query: "# SELECT\nINSERT DATA { <http://x/a> <http://x/b> <http://x/c> }"
    }
  })
  expect(
    "an update hidden behind a comment is still refused",
    commentedUpdate.isError === true,
    commentedUpdate.content?.[0]?.text?.slice(0, 120)
  )

  const sourceDetail = payload(
    await client.callTool({ name: "get_source", arguments: { key: "mdo" } })
  )
  expect(
    "get_source returns its modules as a list and its counts as numbers",
    Array.isArray(sourceDetail.modules) &&
      sourceDetail.modules.length === 4 &&
      typeof sourceDetail.triples === "number",
    `${sourceDetail.modules?.length} modules`
  )

  // A search term that looks like a substitution token must be searched
  // for, not expanded. Replacing token by token let a value inserted early
  // be read as a template for a later one, which carried unescaped quotes
  // into the query and changed the term the caller asked for.
  const tokenish = payload(
    await client.callTool({
      name: "find_entities",
      arguments: { q: "@@SOURCEFILTER@@" }
    })
  )
  expect(
    "a search term that looks like a token is searched for, not expanded",
    tokenish.results.length === 0,
    `${tokenish.results.length} results for a term nothing contains`
  )
  const tokenishFiltered = await client.callTool({
    name: "find_entities",
    arguments: { q: "a@@SOURCEFILTER@@b", sources: ["pmdco"] }
  })
  expect(
    "the same term with a source filter does not break out of its literal",
    tokenishFiltered.isError !== true &&
      payload(tokenishFiltered).results.length === 0,
    tokenishFiltered.content?.[0]?.text?.slice(0, 120)
  )

  // An argument cannot be made large enough to burden the store.
  const longIri = await client.callTool({
    name: "get_entity",
    arguments: { iri: `http://example.org/${"a".repeat(5000)}` }
  })
  expect(
    "an overlong IRI is refused before it reaches the store",
    longIri.isError === true && /2048 characters/.test(longIri.content[0].text),
    longIri.content?.[0]?.text?.slice(0, 100)
  )

  // A comment inside a long literal is part of the data, not a comment.
  const literalHash = payload(
    await client.callTool({
      name: "sparql_query",
      arguments: { query: 'SELECT ?v WHERE { BIND("""a\n#b\nc""" AS ?v) }' }
    })
  )
  expect(
    "a hash inside a literal survives into the answer",
    literalHash.rows?.[0]?.v === "a\n#b\nc",
    JSON.stringify(literalHash.rows?.[0]?.v)
  )

  // A query ending in a comment keeps working once the rewrite puts its
  // closing braces on their own line.
  const trailingComment = await client.callTool({
    name: "sparql_query",
    arguments: { query: "SELECT ?s WHERE { ?s ?p ?o } # a note" }
  })
  expect(
    "a query ending in a comment still runs",
    trailingComment.isError !== true &&
      payload(trailingComment).rows.length > 0,
    trailingComment.content?.[0]?.text?.slice(0, 120)
  )

  // The word FROM inside a variable name is not a dataset clause, so the
  // row cap still reaches the store.
  const fromish = payload(
    await client.callTool({
      name: "sparql_query",
      arguments: { query: "SELECT ?from WHERE { ?from ?p ?o }", limit: 3 }
    })
  )
  expect(
    "a variable named from does not disable the row cap",
    fromish.rows.length === 3 && fromish.truncated === true,
    `${fromish.rows?.length} rows`
  )

  // An oversized request is refused rather than read into this process.
  const oversized = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "sparql_query",
        arguments: { query: `#${"x".repeat(2 * 1024 * 1024)}` }
      }
    })
  })
  expect(
    "an oversized request body is refused",
    oversized.status === 413,
    `HTTP ${oversized.status}`
  )

  // The endpoint is not a second way in for anything but MCP.
  const wrongMethod = await fetch(`http://127.0.0.1:${PORT}/mcp`)
  expect(
    "a GET on the endpoint is refused with Allow: POST",
    wrongMethod.status === 405 && wrongMethod.headers.get("allow") === "POST",
    `${wrongMethod.status} ${wrongMethod.headers.get("allow")}`
  )
} finally {
  await client?.close().catch(() => {})
  app?.close()
  if (fuseki) await stopFuseki(fuseki)
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log("\nOK: the MCP endpoint answers a real client")
