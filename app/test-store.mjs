// The store client's guards, with a replaced fetch and no store: the
// deadline sent to Fuseki, the one budget a grounding lookup shares, a
// client that goes away, a store that refuses, the streamed TSV reader, and
// how the lookup index's load tells a store that stopped from data it
// cannot hold.
//
//   node app/test-store.mjs

import assert from "node:assert/strict"
import { request } from "node:http"
import {
  AnswerTooLarge,
  requestBudget,
  select,
  selectStream,
  storeQueryUrl
} from "./lib/store.mjs"
import { grounding, GROUNDING_TIMEOUT_MS } from "./data.mjs"
import { common } from "./lib/substitutions.mjs"
import { loadIndex } from "./lib/lookup-load.mjs"
import { LookupIndexError, lowerLabel } from "./lib/lookup-index.mjs"

process.env.MATSCI_ONT_QUERY_URL = "http://127.0.0.1:9/matsci-ont/query"
// The application below must not load an index from a real store.
process.env.MATSCI_ONT_LOOKUP_INDEX = "off"

const originalFetch = globalThis.fetch
const json = (bindings) =>
  new Response(JSON.stringify({ head: { vars: [] }, results: { bindings } }))
const timeoutOf = (url) => new URL(url).searchParams.get("timeout")

try {
  // No deadline, no parameter: the named queries of the pages are unchanged.
  assert.equal(storeQueryUrl(undefined), process.env.MATSCI_ONT_QUERY_URL)
  // Whole seconds, never beyond the deadline, and at least one.
  assert.ok(["11", "12"].includes(timeoutOf(storeQueryUrl(Date.now() + 12000))))
  assert.equal(timeoutOf(storeQueryUrl(Date.now() + 12999)), "12")
  assert.equal(timeoutOf(storeQueryUrl(Date.now() + 400)), "1")

  const seen = []
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options })
    return json([])
  }
  await select("preview-sources", common, requestBudget(12000))
  await select("preview-sources", common, requestBudget(12000))
  assert.equal(seen.length, 2)
  for (const { url } of seen) {
    const seconds = Number(timeoutOf(url))
    assert.ok(seconds >= 11 && seconds <= 12, `timeout=${seconds}`)
  }

  // A parent signal aborts the budget, and so the fetch.
  const parent = new AbortController()
  const child = requestBudget(12000, parent.signal)
  parent.abort()
  assert.equal(child.signal.aborted, true)

  // Grounding shares one budget across both of its store calls, and never
  // asks the store to count every description.
  seen.length = 0
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options })
    if (options.body.includes("?republishable ?mirrorOf"))
      return json([
        {
          key: { type: "literal", value: "alpha" },
          title: { type: "literal", value: "Alpha" },
          republishable: { type: "literal", value: "true" }
        }
      ])
    return json([])
  }
  const started = Date.now()
  const answer = await grounding("water", { lookup: "sparql" })
  assert.deepEqual(answer, { query: "water", results: [], truncated: false })
  assert.equal(seen.length, 2)
  assert.equal(seen[0].options.signal, seen[1].options.signal, "one budget")
  const limit = Math.ceil(GROUNDING_TIMEOUT_MS / 1000)
  const [first, second] = seen.map(({ url }) => Number(timeoutOf(url)))
  assert.ok(first <= limit && second <= first, `${first}, ${second}`)
  assert.ok(Date.now() - started < 1000)
  for (const { options } of seen) assert.ok(!options.body.includes("COUNT("))

  // A caller's signal reaches the store call and stops it.
  const caller = new AbortController()
  globalThis.fetch = (url, options) =>
    new Promise((resolve, reject) => {
      seen.push({ url, options })
      options.signal.addEventListener("abort", () =>
        reject(options.signal.reason)
      )
      caller.abort()
    })
  await assert.rejects(
    grounding("water", { signal: caller.signal, lookup: "sparql" }),
    /was cancelled before the store answered/
  )

  // Through the application: a client that goes away aborts the store
  // call, and a store that refuses answers the JSON route with 502.
  const { startApp } = await import("./app.mjs")
  const app = await startApp(0)
  const port = app.address().port
  const get = (path) =>
    new Promise((resolve, reject) => {
      const outgoing = request({ port, path, host: "127.0.0.1" }, (reply) => {
        let body = ""
        reply.on("data", (chunk) => (body += chunk))
        reply.on("end", () => resolve({ status: reply.statusCode, body }))
      })
      outgoing.on("error", reject)
      outgoing.end()
    })
  const logged = []
  const writeError = process.stderr.write
  process.stderr.write = (chunk, ...rest) => {
    logged.push(String(chunk))
    return writeError.call(process.stderr, chunk, ...rest)
  }
  try {
    const waiting = []
    globalThis.fetch = (url, options) =>
      new Promise((resolve, reject) => {
        waiting.push(options.signal)
        options.signal.addEventListener("abort", () =>
          reject(options.signal.reason)
        )
      })
    const client = request({
      port,
      path: "/grounding?q=water",
      host: "127.0.0.1"
    })
    client.on("error", () => {})
    client.end()
    for (let tries = 0; waiting.length === 0 && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(waiting.length, 1, "the store call started")
    client.destroy()
    for (let tries = 0; !waiting[0].aborted && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(waiting[0].aborted, true, "the disconnect aborted it")
    // It is logged as the client leaving, not as the store failing.
    for (let tries = 0; logged.length === 0 && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(logged, [
      "/grounding: the client closed the connection before the answer was ready\n"
    ])

    globalThis.fetch = async () =>
      new Response("Query timed out", { status: 503 })
    for (const path of [
      "/grounding?q=water",
      "/candidates?q=water",
      "/hierarchy?source=alpha&iri=https%3A%2F%2Fexample.org%2Fa"
    ]) {
      const reply = await get(path)
      assert.equal(reply.status, 502, path)
      assert.deepEqual(JSON.parse(reply.body), {
        error: "The store did not answer."
      })
    }
    assert.ok(
      logged.slice(1).every((line) => line.includes("HTTP 503")),
      "a store that refuses is still logged as a store failure"
    )
  } finally {
    process.stderr.write = writeError
    app.close()
  }

  // The streamed TSV reader, fed in chunks cut anywhere, including inside
  // a UTF-8 sequence and between a line and its newline.
  const tsv = [
    "?iri\t?label\t?definition\t?typed\t?n\t?b",
    '<https://example.org/a>\t"tab\\there \\"q\\" back\\\\slash é \\u00e9 \\U0001F600"@en-US\t\ttrue\t12\t_:b0',
    '<https://example.org/b>\t"plain"\t"typed"^^<http://example.org/dt>\tfalse\t-1.5\t',
    '<https://example.org/c>\t"ünïcödé ſ \u{1d400}"\t"line\\nbreak\\r\\fx"\ttrue\t1e3\t'
  ].join("\n")
  const bytes = new TextEncoder().encode(`${tsv}\n`)
  const streamOf = (data, cuts) =>
    new ReadableStream({
      start(controller) {
        let from = 0
        for (const cut of [...cuts, data.length]) {
          if (cut > from) controller.enqueue(data.slice(from, cut))
          from = Math.max(from, cut)
        }
        controller.close()
      }
    })
  const expected = [
    {
      iri: { type: "uri", value: "https://example.org/a" },
      label: {
        type: "literal",
        value: 'tab\there "q" back\\slash é é 😀',
        "xml:lang": "en-US"
      },
      typed: {
        type: "literal",
        value: "true",
        datatype: "http://www.w3.org/2001/XMLSchema#boolean"
      },
      n: {
        type: "literal",
        value: "12",
        datatype: "http://www.w3.org/2001/XMLSchema#integer"
      },
      b: { type: "bnode", value: "b0" }
    },
    {
      iri: { type: "uri", value: "https://example.org/b" },
      label: { type: "literal", value: "plain" },
      definition: {
        type: "literal",
        value: "typed",
        datatype: "http://example.org/dt"
      },
      typed: {
        type: "literal",
        value: "false",
        datatype: "http://www.w3.org/2001/XMLSchema#boolean"
      },
      n: {
        type: "literal",
        value: "-1.5",
        datatype: "http://www.w3.org/2001/XMLSchema#decimal"
      }
    },
    {
      iri: { type: "uri", value: "https://example.org/c" },
      label: { type: "literal", value: "ünïcödé ſ \u{1d400}" },
      definition: { type: "literal", value: "line\nbreak\r\fx" },
      typed: {
        type: "literal",
        value: "true",
        datatype: "http://www.w3.org/2001/XMLSchema#boolean"
      },
      n: {
        type: "literal",
        value: "1e3",
        datatype: "http://www.w3.org/2001/XMLSchema#double"
      }
    }
  ]
  const cutSets = [[], [1], [bytes.indexOf(10)], [bytes.indexOf(10) + 1]]
  for (let cut = 1; cut < bytes.length; cut += 7) cutSets.push([cut, cut + 3])
  const inside = bytes.indexOf(0xc3) + 1 // inside the two bytes of ü or é
  cutSets.push([inside])
  for (const cuts of cutSets) {
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers.Accept, "text/tab-separated-values")
      return new Response(streamOf(bytes, cuts))
    }
    const rows = []
    const result = await selectStream("preview-sources", common, (row) =>
      rows.push(row)
    )
    assert.deepEqual(rows, expected, `cut at ${cuts}`)
    assert.deepEqual(result, { rows: 3, bytes: bytes.length })
  }

  // Caps, a truncated answer, and a refusal all fail the read, and only
  // the caps say the answer itself is too large.
  globalThis.fetch = async () => new Response(streamOf(bytes, [10, 20]))
  await assert.rejects(
    selectStream("preview-sources", common, () => {}, { maxBytes: 50 }),
    (error) =>
      error instanceof AnswerTooLarge &&
      /more than this service will assemble/.test(error.message)
  )
  await assert.rejects(
    selectStream("preview-sources", common, () => {}, { maxRows: 2 }),
    (error) =>
      error instanceof AnswerTooLarge && /more than 2 rows/.test(error.message)
  )

  // A query the store stopped at its deadline. Fuseki 6.2.0 cuts the row it
  // was writing after a term, then writes an empty line and two lines of ##
  // (captured from Fuseki with ?timeout=1), and ends the answer cleanly.
  // No part of the trailer, and not the cut row, reaches the caller.
  const trailer =
    "\n##  Query cancelled due to timeout during execution   ##\n" +
    "##  ****          Incomplete results           ****   ##\n"
  const header = "?iri\t?label\t?definition"
  const whole = '<https://example.org/a>\t"a"\t"defined"'
  for (const [what, text] of [
    ["after a whole row", `${header}\n${whole}\n${trailer}`],
    [
      "inside a row",
      `${header}\n${whole}\n<https://example.org/b>\t"b"\n${trailer}`
    ],
    ["before any row", `${header}\n${trailer}`],
    ["before the header", trailer.slice(1)],
    ["with no ## lines", `${header}\n${whole}\n<https://example.org/b>\n`]
  ]) {
    const seen = []
    globalThis.fetch = async () =>
      new Response(streamOf(new TextEncoder().encode(text), [7]))
    await assert.rejects(
      selectStream("preview-sources", common, (row) => seen.push(row)),
      (error) =>
        !(error instanceof AnswerTooLarge) &&
        /did not complete before the store stopped it/.test(error.message),
      what
    )
    assert.ok(seen.length <= 1, what)
    for (const row of seen) assert.equal(row.definition.value, "defined")
  }
  // A single variable left unbound is an empty line, and a whole row.
  globalThis.fetch = async () => new Response("?x\n\n<https://example.org/x>\n")
  const single = []
  await selectStream("preview-sources", common, (row) => single.push(row))
  assert.deepEqual(single, [
    {},
    { x: { type: "uri", value: "https://example.org/x" } }
  ])
  globalThis.fetch = async () =>
    new Response(streamOf(bytes.slice(0, bytes.length - 5), []))
  await assert.rejects(
    selectStream("preview-sources", common, () => {}),
    /did not complete/
  )
  globalThis.fetch = async () => new Response("", { status: 200 })
  await assert.rejects(
    selectStream("preview-sources", common, () => {}),
    /did not complete/
  )
  globalThis.fetch = async () => new Response("no", { status: 503 })
  await assert.rejects(
    selectStream("preview-sources", common, () => {}),
    /HTTP 503/
  )
  // The lookup index's load. A store that stops fails the load for now, and
  // only data the index cannot hold, by content or by size, refuses it.
  const entriesHeader =
    "?iri\t?label\t?definition\t?version\t?license\t?typed\t?lower\t?end"
  const entryRow = (name, label, lower = "") =>
    `<https://example.org/${name}>\t"${label}"\t"defined"\t"1"\t"CC0-1.0"\ttrue\t${lower}\t`
  const end = "\t\t\t\t\t\t\ttrue"
  const catalogue = {
    fingerprint: "test",
    sources: [{ key: "alpha", graph: "https://example.org/graphs/alpha" }]
  }
  const answering = (text) => async (url, options) => {
    assert.equal(options.headers.Accept, "text/tab-separated-values")
    return new Response(streamOf(new TextEncoder().encode(text), [9, 50]))
  }
  const rowsOk = [
    entryRow("water", "water"),
    entryRow("sigma", "Α1Σ", '"α1ς"'),
    entryRow("ice", "ice")
  ]

  globalThis.fetch = answering(
    `${entriesHeader}\n${rowsOk.join("\n")}\n${end}\n`
  )
  const loaded = await loadIndex(catalogue)
  assert.equal(loaded.size, 3)
  assert.equal(lowerLabel(loaded, loaded.labels.indexOf("Α1Σ")), "α1ς")
  assert.equal(typeof loaded.loadPeakBytes, "number")

  const transient = async (text, pattern) => {
    globalThis.fetch = answering(text)
    await assert.rejects(
      loadIndex(catalogue),
      (error) =>
        !(error instanceof LookupIndexError) && pattern.test(error.message)
    )
  }
  // Stopped at its deadline, the answer cut inside a row or after one.
  await transient(
    `${entriesHeader}\n${rowsOk[0]}\n<https://example.org/cut>\t"cut"\n${trailer}`,
    /did not complete before the store stopped it/
  )
  await transient(
    `${entriesHeader}\n${rowsOk.join("\n")}\n${trailer}`,
    /did not complete before the store stopped it/
  )
  // Cut at a line boundary, without the row that ends the answer.
  await transient(
    `${entriesHeader}\n${rowsOk.join("\n")}\n`,
    /ended before their end/
  )

  const refused = async (text, limits, pattern) => {
    globalThis.fetch = answering(text)
    await assert.rejects(
      loadIndex(catalogue, limits),
      (error) =>
        error instanceof LookupIndexError && pattern.test(error.message)
    )
  }
  const complete = `${entriesHeader}\n${rowsOk.join("\n")}\n${end}\n`
  await refused(
    complete,
    { maxSourceBytes: 100 },
    /larger than the index accepts/
  )
  await refused(complete, { maxRows: 2 }, /more than 2/)
  await refused(
    complete,
    { memoryBudget: 0 },
    /needed more than 0 MB while loading/
  )
  await refused(
    `${entriesHeader}\n${entryRow("sigma", "Α1Σ")}\n${end}\n`,
    {},
    /capital sigma/
  )
} finally {
  globalThis.fetch = originalFetch
}

console.log(
  "OK: store calls carry their deadline to Fuseki, stop with their client, stream TSV whole or not at all, and a stopped load is retried while oversized data is refused"
)
