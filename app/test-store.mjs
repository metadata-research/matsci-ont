// The store client's guards, with a replaced fetch and no store: the
// deadline sent to Fuseki, the one budget a grounding lookup shares, a
// client that goes away, a store that refuses, the streamed TSV reader, how
// the lookup index's load tells a store that stopped from data it cannot
// hold, how it reads a source in pages and refuses pages that do not add
// up, what becomes of a load whose pages do not add up, in this thread and
// in the worker, and the lookup status route.
//
//   node app/test-store.mjs

import assert from "node:assert/strict"
import { createServer, request } from "node:http"
import {
  AnswerTooLarge,
  requestBudget,
  select,
  selectStream,
  storeQueryUrl
} from "./lib/store.mjs"
import { grounding, GROUNDING_TIMEOUT_MS } from "./data.mjs"
import { common } from "./lib/substitutions.mjs"
import {
  ENTRIES_PER_PAGE,
  loadIndex,
  LookupCountMismatch,
  pageRanges,
  pagesFor,
  readCatalogue
} from "./lib/lookup-load.mjs"
import {
  configureLookupIndex,
  loadLookupIndex,
  publicLookupStatus,
  resetLookupIndex,
  warmLookupIndex
} from "./lib/lookup-state.mjs"
import {
  definitionOf,
  iriOf,
  LookupIndexError,
  lowerLabel
} from "./lib/lookup-index.mjs"
import { entryIri, entryPrefix } from "../shared/vocabulary.mjs"

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

    // The lookup status answers from memory, with the store refusing
    // everything, and says only what may be public.
    const asked = []
    globalThis.fetch = async (url) => {
      asked.push(url)
      return new Response("no", { status: 503 })
    }
    const status = await get("/lookup-status")
    assert.equal(status.status, 200)
    assert.deepEqual(JSON.parse(status.body), {
      state: "off",
      entries: null,
      sources: [],
      loadedAt: null,
      loadMs: null,
      pages: null,
      slowestPageMs: null,
      lastError: null,
      nextAttemptAt: null
    })
    assert.equal(asked.length, 0, "no store call")
    const posted = await new Promise((resolve, reject) => {
      const outgoing = request(
        { port, path: "/lookup-status", host: "127.0.0.1", method: "POST" },
        (reply) => {
          let body = ""
          reply.on("data", (chunk) => (body += chunk))
          reply.on("end", () => resolve({ status: reply.statusCode, body }))
        }
      )
      outgoing.on("error", reject)
      outgoing.end()
    })
    assert.equal(posted.status, 405)
    assert.deepEqual(JSON.parse(posted.body), {
      error: "This endpoint is read-only."
    })
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
  // The store counts each source's descriptions first, as JSON, and the
  // pages stream as TSV. Retries are switched off unless a test is about
  // them, since a real pause would only slow the suite.
  const quick = { pauses: [] }
  const entriesHeader =
    "?iri\t?label\t?definition\t?version\t?license\t?typed\t?lower\t?end"
  const entryRow = (name, label, lower = "") =>
    `<https://example.org/${name}>\t"${label}"\t"defined"\t"1"\t"CC0-1.0"\ttrue\t${lower}\t`
  const end = "\t\t\t\t\t\t\ttrue"
  const catalogue = {
    fingerprint: "test",
    sources: [{ key: "alpha", graph: "https://example.org/graphs/alpha" }]
  }
  const counted = (entries) =>
    json([
      {
        entries: {
          type: "literal",
          datatype: "http://www.w3.org/2001/XMLSchema#integer",
          value: String(entries)
        }
      }
    ])
  const answering =
    (text, entries = 3) =>
    async (url, options) => {
      if (options.headers.Accept !== "text/tab-separated-values") {
        assert.match(options.body, /COUNT\(\*\)/)
        return counted(entries)
      }
      assert.doesNotMatch(
        options.body,
        /FILTER\(STR\(\?entry\)/,
        "a small source is whole"
      )
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
  const loaded = await loadIndex(catalogue, quick)
  assert.equal(loaded.size, 3)
  assert.equal(lowerLabel(loaded, loaded.labels.indexOf("Α1Σ")), "α1ς")
  assert.equal(typeof loaded.loadPeakBytes, "number")
  assert.deepEqual(
    loaded.loadPages.map(({ key, entries, pages, retries }) => ({
      key,
      entries,
      pages,
      retries
    })),
    [{ key: "alpha", entries: 3, pages: 1, retries: 0 }]
  )

  const transient = async (text, pattern, entries) => {
    globalThis.fetch = answering(text, entries)
    await assert.rejects(
      loadIndex(catalogue, quick),
      (error) =>
        !(error instanceof LookupIndexError) && pattern.test(error.message)
    )
  }
  // Stopped at its deadline, the answer cut inside a row or after one.
  await transient(
    `${entriesHeader}\n${rowsOk[0]}\n<https://example.org/cut>\t"cut"\n${trailer}`,
    /page 1 of 1 of alpha: query lookup-entries did not complete before the store stopped it/
  )
  await transient(
    `${entriesHeader}\n${rowsOk.join("\n")}\n${trailer}`,
    /did not complete before the store stopped it/
  )
  // Cut at a line boundary, without the row that ends the answer.
  await transient(
    `${entriesHeader}\n${rowsOk.join("\n")}\n`,
    /ended before its end row/
  )
  // Whole, but not the descriptions the store counts.
  await transient(
    `${entriesHeader}\n${rowsOk.join("\n")}\n${end}\n`,
    /the 1 pages of alpha held 3 descriptions and the store counts 4/,
    4
  )

  const refused = async (text, limits, pattern) => {
    globalThis.fetch = answering(text)
    await assert.rejects(
      loadIndex(catalogue, { ...quick, ...limits }),
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

  // Pages. Their size follows the store's count, and their ranges cut the
  // entry IRIs the build mints at evenly spaced hex digits, open at both
  // ends, so they cover every string once.
  assert.equal(pagesFor(0), 1)
  assert.equal(pagesFor(ENTRIES_PER_PAGE), 1)
  assert.equal(pagesFor(ENTRIES_PER_PAGE + 1), 2)
  assert.equal(pagesFor(218444), 14)
  assert.deepEqual(pageRanges("alpha", 1), [{ from: null, below: null }])
  const prefix = entryPrefix("alpha")
  assert.deepEqual(pageRanges("alpha", 3), [
    { from: null, below: `${prefix}5555` },
    { from: `${prefix}5555`, below: `${prefix}aaaa` },
    { from: `${prefix}aaaa`, below: null }
  ])
  assert.match(entryIri("alpha", "https://example.org/x"), /\/[0-9a-f]{64}$/)
  for (const pages of [2, 5, 14, 62]) {
    const ranges = pageRanges("chebi", pages)
    for (let page = 1; page < pages; page++)
      assert.equal(ranges[page].from, ranges[page - 1].below)
  }

  // A store of 40 descriptions under minted entry IRIs, one of them sent
  // as a page of its own range. `stops` makes pages stop at the deadline
  // the given number of times before answering whole.
  const names = Array.from({ length: 40 }, (_, n) => `thing-${n}`)
  const stored = names.map((name, n) => ({
    entry: entryIri("alpha", `https://example.org/${name}`),
    text: entryRow(name, n % 7 === 0 ? `Shared label` : `label ${n}`)
  }))
  const pagedStore = ({ stops = new Map(), count = stored.length } = {}) => {
    const seen = { counts: 0, pages: [] }
    const fetch = async (url, options) => {
      if (options.headers.Accept !== "text/tab-separated-values") {
        seen.counts++
        assert.match(options.body, /ont:sourceKey "alpha"/)
        return counted(count)
      }
      const from = options.body.match(/STR\(\?entry\) >= "([^"]*)"/)?.[1]
      const below = options.body.match(/STR\(\?entry\) < "([^"]*)"/)?.[1]
      const range = `${from ?? ""}..${below ?? ""}`
      seen.pages.push(range)
      const rows = stored
        .filter(
          ({ entry }) =>
            (from === undefined || entry >= from) &&
            (below === undefined || entry < below)
        )
        .map(({ text }) => text)
      const left = stops.get(range) ?? 0
      if (left > 0) {
        stops.set(range, left - 1)
        const cut = `${entriesHeader}\n${rows.slice(0, 1).join("\n")}\n${trailer}`
        return new Response(streamOf(new TextEncoder().encode(cut), [7]))
      }
      const text = `${entriesHeader}\n${[...rows, end].join("\n")}\n`
      return new Response(streamOf(new TextEncoder().encode(text), [11, 40]))
    }
    return { fetch, seen }
  }
  // What an index holds, by entry id, which is independent of the order
  // its descriptions arrived in.
  const contents = (index) =>
    Array.from({ length: index.size }, (_, id) => [
      iriOf(index, id),
      index.labels[id],
      definitionOf(index, id),
      index.flags[id],
      index.tags[id],
      index.values[index.versions[id]],
      index.values[index.licences[id]]
    ])

  const unpaged = pagedStore()
  globalThis.fetch = unpaged.fetch
  const wholeIndex = await loadIndex(catalogue, quick)
  assert.deepEqual(unpaged.seen, { counts: 1, pages: [".."] })
  assert.equal(wholeIndex.size, 40)

  const paged = pagedStore()
  globalThis.fetch = paged.fetch
  const pagedIndex = await loadIndex(catalogue, {
    ...quick,
    entriesPerPage: 6
  })
  assert.equal(paged.seen.counts, 1)
  assert.equal(paged.seen.pages.length, 7, "40 descriptions, 6 a page")
  assert.equal(new Set(paged.seen.pages).size, 7)
  assert.deepEqual(contents(pagedIndex), contents(wholeIndex))
  assert.equal(pagedIndex.loadPages[0].pages, 7)
  assert.equal(typeof pagedIndex.loadPages[0].slowestMs, "number")

  // The pages in reverse order build the same index.
  globalThis.fetch = pagedStore().fetch
  const reversed = await loadIndex(catalogue, {
    ...quick,
    entriesPerPage: 6,
    ranges: (key, pages) => pageRanges(key, pages).reverse()
  })
  assert.deepEqual(contents(reversed), contents(wholeIndex))

  // A page missed, or a page read twice, fails the load with the kind of
  // error that makes the application read the catalogue again: the pages
  // do not hold the descriptions the store counts.
  for (const [what, ranges] of [
    ["missed", (key, pages) => pageRanges(key, pages).slice(1)],
    [
      "read twice",
      (key, pages) => {
        const all = pageRanges(key, pages)
        return [...all, all[2]]
      }
    ]
  ]) {
    globalThis.fetch = pagedStore().fetch
    await assert.rejects(
      loadIndex(catalogue, { ...quick, entriesPerPage: 6, ranges }),
      (error) =>
        error instanceof LookupCountMismatch &&
        /pages of alpha held \d+ descriptions and the store counts 40/.test(
          error.message
        ),
      what
    )
  }

  // A page the store stops is asked for again after a pause, alone, and
  // added once. A page it keeps stopping fails the load, naming the page.
  const third = pageRanges("alpha", 7)[2]
  const thirdKey = `${third.from}..${third.below}`
  const slept = []
  const sleep = async (ms) => void slept.push(ms)
  const flaky = pagedStore({ stops: new Map([[thirdKey, 2]]) })
  globalThis.fetch = flaky.fetch
  const recovered = await loadIndex(catalogue, {
    entriesPerPage: 6,
    pauses: [5, 7],
    sleep
  })
  assert.deepEqual(slept, [5, 7])
  assert.equal(flaky.seen.pages.filter((key) => key === thirdKey).length, 3)
  assert.equal(flaky.seen.pages.length, 9, "only the stopped page again")
  assert.deepEqual(contents(recovered), contents(wholeIndex))
  assert.equal(recovered.loadPages[0].retries, 2)

  slept.length = 0
  globalThis.fetch = pagedStore({ stops: new Map([[thirdKey, 3]]) }).fetch
  await assert.rejects(
    loadIndex(catalogue, { entriesPerPage: 6, pauses: [5, 7], sleep }),
    (error) =>
      !(error instanceof LookupIndexError) &&
      /^page 3 of 7 of alpha: query lookup-entries did not complete before the store stopped it \(asked 3 times\)$/.test(
        error.message
      )
  )
  assert.deepEqual(slept, [5, 7])

  // What the application does with pages that do not add up. The lookup
  // index is on for these, with the loader and timers each case names.
  const indexSetting = process.env.MATSCI_ONT_LOOKUP_INDEX
  delete process.env.MATSCI_ONT_LOOKUP_INDEX
  const lines = []
  const literalOf = (value) => ({ type: "literal", value })
  const catalogueRow = (sha256) => ({
    key: literalOf("alpha"),
    graph: { type: "uri", value: "https://example.org/graphs/alpha" },
    republishable: literalOf("true"),
    sha256: literalOf(sha256)
  })
  const pageOf = (rows, body) => {
    const from = body.match(/STR\(\?entry\) >= "([^"]*)"/)?.[1]
    const below = body.match(/STR\(\?entry\) < "([^"]*)"/)?.[1]
    return rows
      .filter(
        ({ entry }) =>
          (from === undefined || entry >= from) &&
          (below === undefined || entry < below)
      )
      .map(({ text }) => text)
  }
  try {
    // A store replaced between two pages of a source by one holding a
    // description more, in a page read after the swap, as in review: the
    // pages do not add up to the count read before them, the catalogue read
    // after them has changed, and the new store is loaded at once.
    const lastRange = pageRanges("alpha", 7)[6]
    const added = Array.from(
      { length: 200 },
      (_, n) => `https://example.org/added-${n}`
    ).find((iri) => entryIri("alpha", iri) >= lastRange.from)
    const storeB = [
      ...stored,
      {
        entry: entryIri("alpha", added),
        text: entryRow(added.slice(20), "added")
      }
    ]
    let pagesServed = 0
    globalThis.fetch = async (url, options) => {
      const [rows, sha256] =
        pagesServed >= 3 ? [storeB, "bbb"] : [stored, "aaa"]
      if (/\?mirroredFrom/.test(options.body))
        return json([catalogueRow(sha256)])
      if (options.headers.Accept !== "text/tab-separated-values")
        return counted(rows.length)
      pagesServed++
      const text = `${entriesHeader}\n${[...pageOf(rows, options.body), end].join("\n")}\n`
      return new Response(streamOf(new TextEncoder().encode(text), [13]))
    }
    const loadErrors = []
    const timers = []
    resetLookupIndex()
    configureLookupIndex({
      loader: {
        catalogue: readCatalogue,
        load: (found) =>
          loadIndex(found, { ...quick, entriesPerPage: 6 }).catch((error) => {
            loadErrors.push(error)
            throw error
          })
      },
      setTimer: (callback, ms, kind) => {
        const timer = { callback, ms, kind }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer) => (timer.cleared = true),
      log: (line) => lines.push(line)
    })
    assert.equal(await warmLookupIndex(), null)
    assert.equal(loadErrors.length, 1)
    assert.ok(loadErrors[0] instanceof LookupCountMismatch)
    assert.equal(
      loadErrors[0].message,
      "the 7 pages of alpha held 41 descriptions and the store counts 40"
    )
    assert.deepEqual(lines, [
      "lookup index: the store changed while loading, loading it again"
    ])
    assert.equal(publicLookupStatus().state, "loading")
    const [again] = timers.filter((timer) => !timer.cleared)
    assert.deepEqual([again.kind, again.ms], ["retry", 0])
    again.callback()
    const fromB = await loadLookupIndex()
    assert.equal(fromB.size, 41)
    assert.equal(publicLookupStatus().state, "ready")

    // Through the worker, from a store over HTTP: a page that holds one
    // description twice, as a second label would, from a store that did
    // not change, is abandoned after one load, not read again in full.
    globalThis.fetch = originalFetch
    const served = { catalogues: 0, counts: 0, pages: 0 }
    const store = createServer(async (incoming, outgoing) => {
      let body = ""
      for await (const chunk of incoming) body += chunk
      if (/\?mirroredFrom/.test(body)) {
        served.catalogues++
        outgoing.writeHead(200, {
          "content-type": "application/sparql-results+json"
        })
        outgoing.end(
          JSON.stringify({
            head: { vars: [] },
            results: { bindings: [catalogueRow("aaa")] }
          })
        )
        return
      }
      if (/COUNT\(\*\)/.test(body)) {
        served.counts++
        outgoing.writeHead(200, {
          "content-type": "application/sparql-results+json"
        })
        outgoing.end(await counted(stored.length).text())
        return
      }
      served.pages++
      const rows = pageOf(stored, body)
      rows.splice(1, 0, rows[0])
      outgoing.writeHead(200, { "content-type": "text/tab-separated-values" })
      outgoing.end(`${entriesHeader}\n${[...rows, end].join("\n")}\n`)
    })
    await new Promise((resolve) => store.listen(0, "127.0.0.1", resolve))
    const queryUrl = process.env.MATSCI_ONT_QUERY_URL
    process.env.MATSCI_ONT_QUERY_URL = `http://127.0.0.1:${store.address().port}/matsci-ont/query`
    try {
      lines.length = 0
      resetLookupIndex()
      configureLookupIndex({ log: (line) => lines.push(line) })
      assert.equal(await warmLookupIndex(), null)
      assert.deepEqual(lines, [
        "lookup index: abandoned, lookups stay on SPARQL: the 1 pages of alpha held 41 descriptions and the store counts 40, and the store did not change while loading"
      ])
      assert.deepEqual(served, { catalogues: 2, counts: 1, pages: 1 })
      const status = publicLookupStatus()
      assert.equal(status.state, "abandoned")
      assert.equal(
        status.lastError,
        "the pages did not hold exactly the descriptions the store counts"
      )
      assert.equal(await loadLookupIndex(), null)
      assert.deepEqual(
        served,
        { catalogues: 3, counts: 1, pages: 1 },
        "the same store is not read in full again"
      )
    } finally {
      process.env.MATSCI_ONT_QUERY_URL = queryUrl
      store.close()
    }
  } finally {
    resetLookupIndex()
    if (indexSetting === undefined) delete process.env.MATSCI_ONT_LOOKUP_INDEX
    else process.env.MATSCI_ONT_LOOKUP_INDEX = indexSetting
  }
} finally {
  globalThis.fetch = originalFetch
}

console.log(
  "OK: store calls carry their deadline to Fuseki, stop with their client, stream TSV whole or not at all, a load reads pages that must add up and asks again for a stopped one while oversized data is refused, pages that do not add up are loaded again for a changed store and abandoned for an unchanged one, and the lookup status reads no store"
)
