// The lookup index against the SPARQL queries it replaces on the request
// path, on the real store.
//
// The application answers candidate and grounding lookups from an index in
// memory, which reproduces grounding.rq and candidate-source.rq in
// JavaScript. This checks that it holds every description, that it reads
// every character those descriptions use as Jena does, that it lowercases
// every label that is not ASCII as Jena does, that a corpus of lookups gets
// byte-identical answers from both paths, and that the index stays within
// its memory and latency budgets.

import { rows } from "../../../shared/fuseki.mjs"
import { grounding, listSources } from "../../../app/data.mjs"
import { findCandidates } from "../../../app/preview.mjs"
import { literal, regexLiteral } from "../../../app/lib/terms.mjs"
import {
  compileTerm,
  indexBytes,
  indexReadsTerm,
  isWordCodePoint,
  javaWordBoundary,
  lowerLabel,
  trimmedLowerLabel
} from "../../../app/lib/lookup-index.mjs"
import {
  currentLookupIndex,
  loadLookupIndex,
  lookupIndexStatus
} from "../../../app/lib/lookup-state.mjs"

export async function checkLookup(context) {
  const index = await checkLoaded(context)
  if (!index) return
  await checkCharacters(context, index)
  await checkLowercase(context, index)
  await checkParity(context, index)
  await checkServed(context)
}

const megabytes = (bytes) => Math.round(bytes / 1048576)

// The index the application loaded when it started, waiting for that load
// if it is still running, holding exactly the descriptions the catalogue
// counts.
async function checkLoaded({ record }) {
  const index = currentLookupIndex() ?? (await loadLookupIndex())
  const catalogue = await listSources()
  const counted = new Map(
    catalogue.map((source) => [source.key, source.entries])
  )
  const cleared = catalogue
    .filter((source) => source.clearedForPublication)
    .map((source) => source.key)
    .sort()
  const held = index
    ? index.sources.map(
        (source) => `${source.key} ${source.end - source.start}`
      )
    : []
  const expected = cleared.map((key) => `${key} ${counted.get(key)}`)
  const status = lookupIndexStatus()
  record(
    "the lookup index loads every cleared source's descriptions from the store",
    index !== null && held.join(", ") === expected.join(", "),
    index
      ? `${index.size} entries in ${status.loadMs} ms: ${held.join(", ")}`
      : `not loaded (${status.state})`
  )
  return index
}

const literalOf = (point) =>
  `"\\U${point.toString(16).toUpperCase().padStart(8, "0")}"`

// Every printable character the index's labels and definitions use.
function characters(index) {
  const points = []
  for (const members of index.alphabet.values())
    for (const point of members)
      if (point >= 32 && point !== 127) points.push(point)
  return points.sort((a, b) => a - b)
}

// Jena's answer for each character against the index's rules: LCASE, the
// candidate word class, Java's \b on either side, and case-insensitive
// matching for every pair, as one character and as the start of a slice.
async function checkCharacters({ record, ask }, index) {
  const points = characters(index)
  const values = points
    .map(
      (point) =>
        `(${literalOf(point)} ${regexLiteral(String.fromCodePoint(point))})`
    )
    .join(" ")
  const texts = points.map(literalOf).join(" ")
  const differences = []
  const truth = (term) => term?.value === "true"

  for (const row of rows(
    await ask("lookup-characters", { CHARACTERS: values })
  )) {
    const c = row.c.value
    const point = c.codePointAt(0)
    const expected = {
      lower: c.toLowerCase(),
      nonWord: !isWordCodePoint(point),
      beforeA: javaWordBoundary(`${c}a`, c.length),
      afterBase: javaWordBoundary(`b${c}a`, 1 + c.length),
      afterA: javaWordBoundary(`a${c}`, 1),
      afterSpace: javaWordBoundary(` ${c}`, 1)
    }
    const actual = {
      lower: row.lower.value,
      nonWord: truth(row.nonWord),
      beforeA: truth(row.beforeA),
      afterBase: truth(row.afterBase),
      afterA: truth(row.afterA),
      afterSpace: truth(row.afterSpace)
    }
    for (const [name, value] of Object.entries(expected))
      if (actual[name] !== value)
        differences.push(
          `U+${point.toString(16)} ${name}: Jena ${actual[name]}`
        )
  }

  const jena = new Set(
    rows(await ask("lookup-case", { CHARACTERS: values, TEXTS: texts })).map(
      (row) =>
        `${row.t.value}|${row.c.value}|${truth(row.single)}|${truth(row.slice)}`
    )
  )
  const ours = new Set()
  for (const t of points) {
    const term = String.fromCodePoint(t)
    const single = new RegExp(
      `^(?:${compileTerm(term, index.alphabet).pattern.source})$`,
      "u"
    )
    const slice = new RegExp(
      `^(?:${compileTerm(`${term}x`, index.alphabet).pattern.source})$`,
      "u"
    )
    for (const c of points) {
      const text = String.fromCodePoint(c)
      const one = single.test(text)
      const two = slice.test(`${text}x`)
      if (one || two) ours.add(`${term}|${text}|${one}|${two}`)
    }
  }
  for (const pair of jena)
    if (!ours.has(pair)) differences.push(`Jena only: ${pair}`)
  for (const pair of ours)
    if (!jena.has(pair)) differences.push(`index only: ${pair}`)
  record(
    "the lookup index reads every character of the descriptions as Jena does",
    differences.length === 0,
    differences.length
      ? differences.slice(0, 10).join("\n")
      : `${points.length} characters, ${jena.size} case-insensitive pairs`
  )
}

// Jena's LCASE of every label that is not ASCII, whole and trimmed, against
// the index. Lowercasing is where a label's context matters: Java decides
// between σ and ς by the word around a capital sigma, which the character
// check above cannot see, and the index takes those labels' lowercase from
// the store when it loads. An ASCII label lowercases alike in both.
async function checkLowercase({ record, ask }, index) {
  const ids = []
  for (let id = 0; id < index.size; id++)
    if (!/^\p{ASCII}*$/u.test(index.labels[id])) ids.push(id)
  const differences = []
  let compared = 0
  for (let from = 0; from < ids.length; from += 1000) {
    const batch = ids.slice(from, from + 1000)
    const values = batch
      .map((id, position) => `(${position} ${literal(index.labels[id])})`)
      .join(" ")
    for (const row of rows(await ask("lookup-labels", { LABELS: values }))) {
      const id = batch[Number(row.i.value)]
      compared++
      if (row.lower.value !== lowerLabel(index, id))
        differences.push(
          `${JSON.stringify(index.labels[id])}: Jena ${JSON.stringify(row.lower.value)}`
        )
      if (row.trimmedLower.value !== trimmedLowerLabel(index, id))
        differences.push(
          `${JSON.stringify(index.labels[id])} trimmed: Jena ${JSON.stringify(row.trimmedLower.value)}`
        )
    }
  }
  record(
    "the lookup index lowercases every label that is not ASCII as Jena does",
    compared === ids.length && differences.length === 0,
    differences.length
      ? differences.slice(0, 10).join("\n")
      : `${compared} of ${ids.length} labels, ${index.lowered.size} with a capital sigma lowercased by the store`
  )
}

// A small generator with a fixed seed, so a failing sample repeats.
function generator(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

// The fixed terms, labels drawn from every part of the index, and words
// from every band of frequency, from the rarest to the most common.
function corpus(index, fixture) {
  const random = generator(fixture.seed)
  const terms = new Set(fixture.terms)
  for (let drawn = 0; drawn < fixture.sampledLabels; drawn++)
    terms.add(index.labels[Math.floor(random() * index.size)])
  const words = index.labelWords
  const byCount = words.tokens
    .map((_, position) => position)
    .sort(
      (a, b) =>
        words.offsets[a + 1] -
        words.offsets[a] -
        (words.offsets[b + 1] - words.offsets[b])
    )
  for (let drawn = 0; drawn < fixture.sampledWords; drawn++) {
    const band = 1 - 0.5 ** (drawn + 1 + random())
    terms.add(words.tokens[byCount[Math.floor(band * (byCount.length - 1))]])
  }
  // A term with a capital sigma is answered by SPARQL on both paths.
  return [...terms].filter(indexReadsTerm)
}

// An answer, or the error that stood in for one, as text to compare.
async function outcome(run) {
  try {
    const answer = await run()
    return JSON.stringify(answer)
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`
  }
}

async function pool(items, width, work) {
  let next = 0
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) await work(items[next++])
    })
  )
}

// Byte-identical answers from both paths for the corpus, in the shapes the
// routes serve, and the in-process latency of the index path.
async function checkParity({ record, fixtures }, index) {
  const fixture = fixtures.lookup
  const chebi = index.sourceByKey.has("chebi")
  const requests = []
  for (const term of corpus(index, fixture)) {
    if (chebi)
      requests.push({
        name: `grounding ${JSON.stringify(term)} chebi 5`,
        run: (lookup) =>
          grounding(term, { sources: ["chebi"], limit: 5, lookup })
      })
    requests.push({
      name: `grounding ${JSON.stringify(term)} 10`,
      run: (lookup) => grounding(term, { limit: 10, lookup })
    })
    for (const [mode, limitPerSource] of [
      ["exact", 5],
      ["similar", 5],
      ["similar", 20]
    ])
      requests.push({
        name: `candidates ${JSON.stringify(term)} ${mode} ${limitPerSource}`,
        run: (lookup) => findCandidates(term, { mode, limitPerSource, lookup })
      })
  }

  const timings = []
  for (const request of requests) {
    const started = performance.now()
    request.index = await outcome(() => request.run("index"))
    timings.push(performance.now() - started)
  }
  // SPARQL takes seconds a lookup on this store, so a few run at once.
  await pool(requests, 4, async (request) => {
    request.sparql = await outcome(() => request.run("sparql"))
  })
  const differing = requests.filter(
    (request) => request.index !== request.sparql
  )
  record(
    "the lookup index answers the corpus exactly as the SPARQL queries do",
    differing.length === 0,
    `${requests.length - differing.length} of ${requests.length} identical (${Math.round((100 * (requests.length - differing.length)) / requests.length)}% parity)` +
      differing
        .slice(0, 5)
        .map(
          (request) =>
            `\n${request.name}\n  index  ${request.index.slice(0, 300)}\n  sparql ${request.sparql.slice(0, 300)}`
        )
        .join("")
  )

  timings.sort((a, b) => a - b)
  const quantile = (q) =>
    timings[Math.min(timings.length - 1, Math.floor(q * timings.length))]
  const size = indexBytes(index) / 1048576
  const memory = process.memoryUsage()
  record(
    "the lookup index stays within its memory and latency budgets",
    size <= fixture.maxIndexMegabytes &&
      quantile(0.95) <= fixture.maxP95Milliseconds,
    `index about ${Math.round(size)} MB (at most ${fixture.maxIndexMegabytes}), ` +
      `loaded in ${lookupIndexStatus().loadMs} ms, needing at most ${megabytes(index.loadPeakBytes ?? 0)} MB while loading; ` +
      `in-process p50 ${quantile(0.5).toFixed(1)} ms, p95 ${quantile(0.95).toFixed(1)} ms (at most ${fixture.maxP95Milliseconds}); ` +
      `this process heapUsed ${megabytes(memory.heapUsed)} MB, rss ${megabytes(memory.rss)} MB`
  )
}

// The served routes answer from the index, in the shapes of the SPARQL path.
async function checkServed({ record, page }) {
  const before = lookupIndexStatus().answered
  const served = await page("/grounding?q=water&sources=chebi&limit=5")
  const candidates = await page("/candidates?q=water&mode=similar")
  const expected = [
    JSON.stringify(
      await grounding("water", {
        sources: ["chebi"],
        limit: 5,
        lookup: "sparql"
      }),
      null,
      2
    ),
    JSON.stringify(
      await findCandidates("water", { mode: "similar", lookup: "sparql" })
    )
  ]
  record(
    "the grounding and candidate routes answer from the lookup index",
    lookupIndexStatus().answered - before === 2 &&
      served.text === expected[0] &&
      candidates.text === expected[1],
    `${lookupIndexStatus().answered - before} of 2 answered by the index`
  )
}
