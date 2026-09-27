// The machine-facing surface: the grounding route, the hierarchy preview,
// the MCP endpoint, and the interface the application is bound to.

export async function checkApi(context) {
  await checkGrounding(context)
  await checkHierarchy(context)
  await checkMcp(context)
  checkBinding(context)
}

// The hierarchy preview's named mappings, read in both directions from the
// source's own graph, and the kind each source's graph declares. NIST
// models a synonym as a bare concept that the real concept names by
// skos:exactMatch, so the synonym reads one incoming mapping and the
// concept reads each synonym as an outgoing one.
async function checkHierarchy({ record, page, fixtures }) {
  const {
    source,
    synonym,
    concept,
    expectConceptLabel,
    expectOutgoing,
    term,
    kinds
  } = fixtures.hierarchy
  const exactMatch = "http://www.w3.org/2004/02/skos/core#exactMatch"
  const read = async (iri) =>
    JSON.parse(
      (await page(`/hierarchy?source=${source}&iri=${encodeURIComponent(iri)}`))
        .text
    )

  const bare = await read(synonym)
  const incoming = bare.mappings ?? []
  record(
    "a bare synonym concept reads the concept that names it as an incoming exact match",
    bare.parents?.length === 0 &&
      incoming.length === 1 &&
      incoming[0].iri === concept &&
      incoming[0].label === expectConceptLabel &&
      incoming[0].predicate === exactMatch &&
      incoming[0].direction === "incoming",
    JSON.stringify(bare.mappings ?? bare.error)
  )

  const named = await read(concept)
  const outgoing = named.mappings ?? []
  record(
    "the concept reads each synonym as an outgoing exact match with its label",
    outgoing.length === expectOutgoing &&
      outgoing.every(
        (mapping) =>
          mapping.predicate === exactMatch &&
          mapping.direction === "outgoing" &&
          typeof mapping.label === "string"
      ),
    `${outgoing.length} mappings: ${outgoing.map((mapping) => mapping.label).join(", ")}`
  )

  // The kind comes with every source object, in candidate groups and in the
  // hierarchy answer alike.
  const candidates = JSON.parse(
    (await page(`/candidates?q=${encodeURIComponent(term)}`)).text
  )
  const found = Object.fromEntries(
    (candidates.sources ?? []).map((group) => [
      group.source.key,
      group.source.kind
    ])
  )
  record(
    "each source states the kind its graph declares",
    Object.entries(kinds).every(([key, kind]) => found[key] === kind) &&
      named.source?.kind === kinds[source],
    JSON.stringify(found)
  )
}

// Definition text a caller can put in front of a reader, with what it needs
// to credit the source.
async function checkGrounding({ record, page, fixtures, manifest }) {
  const { term, limit, expectFirst, mirrorTerm } = fixtures.grounding
  const ground = async (search) =>
    JSON.parse((await page(`/grounding?${search}`)).text)

  const answer = await ground(`q=${encodeURIComponent(term)}&limit=${limit}`)
  const sources = new Set(answer.results.map((row) => row.sourceKey))
  record(
    "grounding answers from more than one source, with licences",
    sources.size > 1 &&
      answer.results.every(
        (row) => row.license && row.definition && row.sourceIri
      ),
    `${answer.results.length} results from ${[...sources].join(", ")}`
  )
  record(
    "an exact label match is ranked first",
    answer.results[0]?.term.toLowerCase() === expectFirst,
    answer.results[0]?.term
  )
  const smaller = await ground(`q=${encodeURIComponent(term)}&limit=2`)
  record(
    "the limit is honored and truncation is reported",
    answer.results.length === limit &&
      answer.truncated === true &&
      smaller.results.length === 2,
    `${answer.results.length} results, truncated ${answer.truncated}`
  )

  // Two runs return the same order, so a caller quoting a result can rely
  // on it.
  const repeat = await ground(`q=${encodeURIComponent(term)}&limit=${limit}`)
  record(
    "grounding returns the same order twice",
    JSON.stringify(repeat.results) === JSON.stringify(answer.results)
  )

  // A source not cleared for publication never grounds anything, and asking
  // for mirrors cannot lift that.
  const asked = await ground(
    `q=${encodeURIComponent(mirrorTerm)}&includeMirror=1`
  )
  const uncleared = manifest
    .filter((entry) => !entry.republishable)
    .map((entry) => entry.key)
  record(
    "no source that is not cleared grounds anything, even when asked for",
    asked.results.every((row) => !uncleared.includes(row.sourceKey)) &&
      typeof asked.note === "string",
    asked.note ?? "no note explaining the empty addition"
  )
}

// That the endpoint answers at all. The tool surface itself is exercised by
// app/test-mcp.mjs with the client from the same SDK.
const TOOLS = "find_entities,get_entity,get_source,list_sources,sparql_query"

async function checkMcp({ record, appBase }) {
  const response = await fetch(`${appBase}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    })
  })
  const listed = response.ok ? JSON.parse(await response.text()) : undefined
  const names = (listed?.result?.tools ?? []).map((tool) => tool.name).sort()
  record(
    "the MCP endpoint lists its five tools",
    names.join(",") === TOOLS,
    names.join(",") || `HTTP ${response.status}`
  )
}

// The bound address, not a probe: connecting to 0.0.0.0 from this machine
// reaches a loopback listener anyway, so a probe proves nothing about the
// binding.
function checkBinding({ record, app }) {
  const bound = app.address()
  record(
    "the application is bound to the loopback interface",
    bound?.address === "127.0.0.1",
    `${bound?.address}:${bound?.port}`
  )
}
