// The in-memory lookup index against the rules it reproduces.
//
// The expectations marked "arq" were read from Jena 6.2.0 on Java 21, the
// store's own engine, by running the same REGEX, LCASE and ORDER BY over the
// same strings. The randomized part compares the index with a plain scan
// written from the query text, so the word index, its anchors and its early
// stops can only change how fast an answer comes, never which answer.
//
//   node app/test-lookup-index.mjs

import assert from "node:assert/strict"
import {
  candidateRows,
  compareLabels,
  compileTerm,
  createIndexBuilder,
  definitionOf,
  foldCodePoint,
  groundingRows,
  indexBytes,
  indexReadsTerm,
  iriOf,
  javaTrim,
  javaWordBoundary,
  LookupIndexError,
  lowerLabel,
  lowerSimple,
  matchesWholeWord,
  trimmedLowerLabel,
  upperSimple
} from "./lib/lookup-index.mjs"
import {
  configureLookupIndex,
  LOAD_WAIT_SHARE,
  loadLookupIndex,
  lookupIndexFor,
  lookupIndexStatus,
  lookupIndexSwitchedOff,
  publicLookupStatus,
  RETRY_DELAYS_MS,
  resetLookupIndex,
  usableLookupIndex,
  warmLookupIndex
} from "./lib/lookup-state.mjs"
import {
  LookupCountMismatch,
  packIndex,
  unpackIndex
} from "./lib/lookup-load.mjs"

const base = "https://example.org/lookup/"

// arq's LCASE of every label below with a capital sigma. The store sends
// the index these when it loads (lookup-entries.rq), because Java lowercases
// a capital sigma by a rule JavaScript does not share.
const ARQ_LCASE = {
  "ΣWATER x": "σwater x",
  ΌΣΟΣ: "όσος",
  "AΣ.": "aς.",
  Α1Σ: "α1ς",
  ΑΣ1Β: "ασ1β",
  Α_Σ: "α_ς",
  ΑΣ_Β: "ασ_β",
  "Α:Σ": "α:σ",
  "Α-Σ": "α-ς",
  "ΑΣ1Β zz": "ασ1β zz",
  " ΑΣ ": " ας "
}

// Sources as lists of rows; every row is a typed class with a definition,
// version and licence unless it says otherwise.
function buildIndex(sources, fingerprint = "test") {
  const builder = createIndexBuilder({ fingerprint })
  for (const [key, rows] of Object.entries(sources).sort()) {
    builder.beginSource(key, `${base}graphs/${key}`)
    for (const row of rows) {
      builder.addRow({
        version: "1",
        license: "CC0-1.0",
        typed: true,
        tag: "",
        lower: ARQ_LCASE[row.label],
        ...row,
        definition: "definition" in row ? row.definition : "described"
      })
    }
  }
  return builder.build()
}

let serial = 0
const entry = (label, extra = {}) => ({
  iri: `${base}${++serial}`,
  label,
  ...extra
})

const grounded = (index, text, { keys, cap = 50 } = {}) =>
  groundingRows(index, {
    text,
    keys: keys ?? index.sources.map((source) => source.key),
    cap
  })
const candidates = (index, text, mode, { keys, limit = 20 } = {}) =>
  candidateRows(index, {
    text,
    mode,
    limit,
    keys: keys ?? index.sources.map((source) => source.key)
  })
const labels = (rows) => rows.map((row) => row.label)

// ---------------------------------------------------------------------------
// Java's word boundary, from REGEX(label, "\\bwater", "i") in arq.
{
  const cases = {
    water: true,
    Äwater: true,
    ΣWATER: true,
    ſwater: true,
    "(water)": true,
    _water: false,
    "2water": false,
    // A non-spacing mark after a letter or digit is part of the word...
    "e\u0301water": false,
    "Ä\u0301water": false,
    // ...but not without one, and a supplementary mark never finds one.
    "\u0301water": true,
    "x\u{1d167}water": true,
    "\u{1d400}water": true,
    "a\u00adwater": true
  }
  const index = buildIndex({
    alpha: Object.keys(cases).map((label) => entry(`${label} x`))
  })
  const found = new Set(labels(grounded(index, "water")))
  for (const [label, expected] of Object.entries(cases))
    assert.equal(found.has(`${label} x`), expected, `\\bwater in ${label}`)

  // arq: \bÅngström matches only after an ASCII word character, because Å
  // is not one and so cannot start a word by itself.
  const angstrom = buildIndex({
    alpha: ["xÅngström", "Ångström unit", " Ångström"].map((label) =>
      entry(label)
    )
  })
  assert.deepEqual(labels(grounded(angstrom, "Ångström")), ["xÅngström"])
  assert.equal(javaWordBoundary("xÅ", 1), true)
  assert.equal(javaWordBoundary("Å", 0), false)
}

// Case-insensitive matching, from REGEX(text, pattern, "i") in arq.
{
  const pairs = [
    // [text, pattern, matches]
    ["İ", "i", true],
    ["ı", "i", true],
    ["i", "İ", true],
    ["i", "ı", true],
    ["ẞ", "ß", false], // one character: ß has no simple uppercase
    ["ß", "ẞ", true],
    ["ẞx", "ßx", true], // several: compared by fold
    ["ßx", "ẞx", true],
    ["\u212a", "k", true],
    ["k", "\u212a", true],
    ["ſ", "s", true],
    ["s", "ſ", true],
    ["ſx", "sx", true],
    ["İx", "ix", true],
    ["ıx", "ix", true],
    ["ς", "Σ", true],
    ["σ", "ς", true],
    ["ǅ", "ǆ", true],
    ["\u0345", "ι", true],
    ["ᾀ", "ᾈ", true],
    ["ϑ", "θ", true],
    ["ﬀ", "ff", false],
    ["µ", "μ", true],
    ["Å", "å", true]
  ]
  const index = buildIndex({
    alpha: pairs.map(([text]) => entry(`- ${text} -`))
  })
  for (const [text, pattern, expected] of pairs) {
    // A capital sigma in the term leaves the lookup to SPARQL, so its
    // matching is checked on the matcher itself.
    const found = indexReadsTerm(pattern)
      ? candidates(index, pattern, "similar").some(
          (row) => row.label === `- ${text} -`
        )
      : matchesWholeWord(`- ${text} -`, compileTerm(pattern, index.alphabet))
    assert.equal(found, expected, `${pattern} against ${text}`)
  }
  assert.equal(upperSimple(0xdf), 0xdf, "ß has no simple uppercase")
  assert.equal(lowerSimple(0x130), 0x69, "İ lowers to i by simple mapping")
  assert.equal(foldCodePoint(0x17f), 0x73)
}

// LCASE uses the full mappings, so İ becomes i with a dot above, and a
// capital sigma lowercases as Java decides from the word around it. arq
// gives ς for Α1Σ, Α_Σ and Α-Σ and σ for ΑΣ1Β and Α:Σ, where JavaScript
// gives the other letter in each case, so the index uses the store's
// lowercase for such labels and leaves a term with a capital sigma to
// SPARQL.
{
  const sigma = (label, name) => entry(label, { iri: `${base}sigma/${name}` })
  const index = buildIndex({
    alpha: [
      entry("ΌΣΟΣ"),
      entry("İ"),
      entry("AΣ."),
      entry("Α1Σ"),
      entry("ΑΣ1Β"),
      entry("Α_Σ"),
      entry("ΑΣ_Β"),
      entry("Α:Σ"),
      entry("Α-Σ"),
      entry(" ΑΣ "),
      // Equal under JavaScript's lowercase, so only the IRI would order
      // them, but arq's ας1β zz sorts before ασ1β zz.
      sigma("ΑΣ1Β zz", "a"),
      sigma("ας1β zz", "b")
    ]
  })
  const exact = (text) => labels(candidates(index, text, "exact"))
  assert.deepEqual(labels(grounded(index, "όσος")), ["ΌΣΟΣ"])
  assert.equal(grounded(index, "όσος")[0].tier, 0)
  assert.deepEqual(labels(grounded(index, "i̇")), ["İ"])
  assert.equal(grounded(index, "i̇")[0].tier, 0)
  assert.equal(grounded(index, "aς.")[0]?.tier, 0)
  for (const [text, label] of [
    ["α1ς", "Α1Σ"],
    ["ασ1β", "ΑΣ1Β"],
    ["α_ς", "Α_Σ"],
    ["ασ_β", "ΑΣ_Β"],
    ["α:σ", "Α:Σ"],
    ["α-ς", "Α-Σ"],
    ["ας", " ΑΣ "]
  ]) {
    assert.deepEqual(exact(text), [label], `exact ${text}`)
    const tierZero = grounded(index, text).filter((row) => row.tier === 0)
    // Grounding does not trim, so " ΑΣ " is not the term ας there.
    assert.deepEqual(labels(tierZero), label === " ΑΣ " ? [] : [label])
  }
  for (const text of ["α1σ", "ας1β", "α_σ", "ας_β", "α:ς", "α-σ"]) {
    assert.deepEqual(exact(text), [], `no exact ${text}`)
    assert.deepEqual(labels(grounded(index, text)), [], `no grounding ${text}`)
  }
  assert.deepEqual(labels(candidates(index, "zz", "similar", { limit: 1 })), [
    "ας1β zz",
    "ΑΣ1Β zz"
  ])
  const id = index.labels.indexOf(" ΑΣ ")
  assert.equal(lowerLabel(index, id), " ας ")
  assert.equal(trimmedLowerLabel(index, id), "ας")
  assert.equal(index.lowered.size, 10)

  // A term with a capital sigma is not the index's to answer, and a label
  // with one needs the store's lowercase.
  assert.equal(indexReadsTerm("ΑΣ"), false)
  assert.equal(indexReadsTerm("ας σ"), true)
  assert.throws(() => candidates(index, "ΑΣ", "exact"), /capital sigma/)
  assert.throws(() => grounded(index, "Α1Σ"), /capital sigma/)
  const builder = createIndexBuilder({ fingerprint: "sigma" })
  builder.beginSource("alpha", `${base}graphs/alpha`)
  assert.throws(
    () => builder.addRow({ iri: `${base}s`, label: "ΑΣ", tag: "" }),
    LookupIndexError
  )
}

// ORDER BY ?label in arq: plain literals, then tags compared without case,
// each in UTF-16 order, and here the IRI after that.
{
  assert.ok(compareLabels("b", "", "a", "de") < 0, "plain first")
  assert.ok(compareLabels("z", "de", "a", "en") < 0, "by tag first")
  assert.ok(compareLabels("A", "en", "a", "en") < 0, "then UTF-16")
  assert.ok(compareLabels("a", "en", "a", "en-US") < 0, "en before en-US")
  assert.ok(compareLabels("é", "", "z", "") > 0)
  const rows = [
    ["water b", ""],
    ["water a", "en-US"],
    ["water a", "en"],
    ["water A", "en"],
    ["water a", "de"],
    ["water a", ""],
    ["Water z", ""]
  ].map(([label, tag]) => entry(label, { tag }))
  const ties = [
    entry("water c", { iri: `${base}tie/z` }),
    entry("water c", { iri: `${base}tie/y` })
  ]
  const index = buildIndex({ alpha: [...rows, ...ties] })
  const found = grounded(index, "water")
  assert.deepEqual(
    found.map((row) => [
      row.label,
      row.iri.startsWith(`${base}tie/`) ? row.iri.slice(-1) : ""
    ]),
    [
      ["Water z", ""],
      ["water a", ""],
      ["water b", ""],
      ["water c", "y"],
      ["water c", "z"],
      ["water a", ""],
      ["water A", ""],
      ["water a", ""],
      ["water a", ""]
    ]
  )
  assert.deepEqual(
    index.tagNames.filter(Boolean).sort(),
    ["de", "en", "en-US"].sort()
  )
}

// The candidate rules of candidate-source.rq.
{
  const index = buildIndex({
    alpha: [
      entry("  WaTeR  "),
      entry("water absorption"),
      entry("Fe(III)"),
      entry("FeIII"),
      entry("Fe(II)"),
      entry("Fe(III) oxide"),
      entry("grain"),
      entry("(grain)"),
      entry("micrograin"),
      entry("grains"),
      entry("solid grain"),
      entry("grain property", { typed: false }),
      entry("sintering")
    ],
    beta: [entry("WATER"), entry("other water")]
  })
  // Trimmed and case-folded equality is exact; a longer label is not.
  assert.deepEqual(labels(candidates(index, "water", "exact")), [
    "  WaTeR  ",
    "WATER"
  ])
  assert.deepEqual(labels(candidates(index, "water", "similar")), [
    "water absorption",
    "other water"
  ])
  assert.deepEqual(labels(candidates(index, "fe(iii)", "exact")), ["Fe(III)"])
  assert.deepEqual(labels(candidates(index, "Fe(III)", "similar")), [
    "Fe(III) oxide"
  ])
  assert.deepEqual(labels(candidates(index, "grain", "similar")).sort(), [
    "(grain)",
    "solid grain"
  ])
  assert.deepEqual(labels(candidates(index, "sinter", "similar")), [])
  // Grounding matches word starts, and does not trim the label.
  assert.deepEqual(labels(grounded(index, "sinter")), ["sintering"])
  const water = grounded(index, "water")
  // Tier, then source key, then label: " " sorts before "w".
  assert.deepEqual(
    water.map((row) => [row.label, row.tier]),
    [
      ["WATER", 0],
      ["  WaTeR  ", 1],
      ["water absorption", 1],
      ["other water", 1]
    ]
  )
  // Grounding does not ask for a class; candidates do.
  assert.ok(labels(grounded(index, "grain")).includes("grain property"))
  assert.ok(
    !labels(candidates(index, "grain", "similar")).includes("grain property")
  )
}

// Terms with no word are matched by trying every entry.
{
  const index = buildIndex({
    alpha: [
      entry("Na+"),
      entry("(+)-limonene"),
      entry("(±)-lactic acid"),
      entry("x(±)y"),
      entry("a + b")
    ]
  })
  assert.deepEqual(labels(candidates(index, "+", "similar")).sort(), [
    "(+)-limonene",
    "a + b"
  ])
  assert.deepEqual(labels(grounded(index, "+")), ["Na+"])
  // A whole word needs a non-word character or an end on both sides.
  assert.deepEqual(labels(candidates(index, "(±)", "similar")), [
    "(±)-lactic acid"
  ])
  assert.deepEqual(labels(grounded(index, "(±)")), ["x(±)y"])
}

// Caps and the sentinel row, per source; entries without a definition,
// version or licence do not ground.
{
  const index = buildIndex({
    alpha: Array.from({ length: 30 }, (_, n) =>
      entry(`material ${String(n).padStart(2, "0")}`)
    ),
    beta: [
      entry("material a"),
      entry("material b", { definition: undefined }),
      entry("material c", { version: undefined }),
      entry("material d", { license: undefined })
    ]
  })
  const rows = candidates(index, "material", "similar", { limit: 5 })
  assert.equal(rows.filter((row) => row.key === "alpha").length, 6)
  assert.equal(rows.filter((row) => row.key === "beta").length, 4)
  assert.equal(grounded(index, "material", { cap: 5 }).length, 6)
  assert.deepEqual(labels(grounded(index, "material", { keys: ["beta"] })), [
    "material a"
  ])
  assert.equal(
    grounded(index, "material", { keys: ["beta", "beta"] }).length,
    1,
    "a key listed twice matches once"
  )
  assert.equal(definitionOf(index, 0), "described")
  assert.ok(iriOf(index, 0).startsWith(base))
}

// A second row for one IRI in a source is a cross product SPARQL would
// return and the index does not, so the index refuses to build.
{
  const builder = createIndexBuilder({ fingerprint: "twice" })
  builder.beginSource("alpha", `${base}graphs/alpha`)
  builder.addRow({ iri: `${base}same`, label: "one", tag: "" })
  builder.addRow({ iri: `${base}same`, label: "two", tag: "" })
  assert.throws(() => builder.build(), LookupIndexError)
  const ordered = createIndexBuilder({ fingerprint: "order" })
  ordered.beginSource("beta", `${base}graphs/beta`)
  assert.throws(() => ordered.beginSource("alpha", "x"), LookupIndexError)
  const capped = createIndexBuilder({ fingerprint: "cap", maxRows: 1 })
  capped.beginSource("alpha", `${base}graphs/alpha`)
  capped.addRow({ iri: `${base}a`, label: "a", tag: "" })
  assert.throws(
    () => capped.addRow({ iri: `${base}b`, label: "b", tag: "" }),
    LookupIndexError
  )
}

// The candidate trim, including Java's $ before a final U+0085.
{
  assert.equal(javaTrim("  a \u00a0\u3000"), "a")
  assert.equal(javaTrim("\ufeffa\u2028"), "a")
  assert.equal(javaTrim("a \u0085"), "a\u0085")
  assert.equal(javaTrim("a\u0085 "), "a\u0085")
  assert.equal(javaTrim("\u0085"), "\u0085")
  assert.equal(javaTrim(" \t\n"), "")
  assert.equal(javaTrim("\u200ba"), "\u200ba", "U+200B is not whitespace")
}

// ---------------------------------------------------------------------------
// The index against a plain scan written from the query text.

const width = (point) => (point > 0xffff ? 2 : 1)

// REGEX(text, <term>, "i") at `start`, as Java's Single and Slice nodes
// compare characters. Returns where the match ends, or -1.
function referenceAt(text, term, start) {
  const points = [...term].map((character) => character.codePointAt(0))
  let at = start
  for (const point of points) {
    if (at >= text.length) return -1
    const character = text.codePointAt(at)
    let accepted
    if (points.length === 1) {
      const upper = upperSimple(point)
      const lower = lowerSimple(upper)
      accepted =
        upper !== lower
          ? character === lower || foldCodePoint(character) === lower
          : character === point
    } else {
      const target = foldCodePoint(point)
      accepted = character === target || foldCodePoint(character) === target
    }
    if (!accepted) return -1
    at += width(character)
  }
  return at
}

const WORD = /^[\p{L}\p{N}_]$/u
const isWord = (point) => WORD.test(String.fromCodePoint(point))
function pointBefore(text, start) {
  const low = text.charCodeAt(start - 1)
  if (low >= 0xdc00 && low <= 0xdfff && start >= 2) {
    const high = text.charCodeAt(start - 2)
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(start - 2)
  }
  return low
}

// grounding.rq's "\\b" + term, or candidate-source.rq's term between
// (^|[^\p{L}\p{N}_]) and ($|[^\p{L}\p{N}_]), at any position.
function referenceMatches(text, term, grounding) {
  for (
    let start = 0;
    start < text.length;
    start += width(text.codePointAt(start))
  ) {
    const end = referenceAt(text, term, start)
    if (end < 0) continue
    if (grounding) {
      if (javaWordBoundary(text, start)) return true
    } else if (
      (start === 0 || !isWord(pointBefore(text, start))) &&
      (end === text.length || !isWord(text.codePointAt(end)))
    )
      return true
  }
  return false
}

function referenceGrounding(rows, text, keys, cap) {
  const lower = text.toLowerCase()
  const found = []
  for (const row of rows) {
    if (!keys.includes(row.key)) continue
    if (row.definition === undefined || !row.version || !row.license) continue
    let tier
    if (row.label.toLowerCase() === lower) tier = 0
    else if (referenceMatches(row.label, text, true)) tier = 1
    else if (referenceMatches(row.definition, text, true)) tier = 2
    else continue
    found.push({ ...row, tier })
  }
  found.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      compareLabels(a.label, a.tag, b.label, b.tag) ||
      (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0)
  )
  return found.slice(0, cap + 1).map((row) => [row.iri, row.tier])
}

function referenceCandidates(rows, text, mode, keys, limit) {
  const lower = text.toLowerCase()
  const out = []
  for (const key of keys) {
    const found = rows
      .filter((row) => row.key === key && row.typed)
      .map((row) => ({
        ...row,
        tier: javaTrim(row.label).toLowerCase() === lower ? 0 : 1
      }))
      .filter((row) => row.tier === (mode === "exact" ? 0 : 1))
      .filter(
        (row) => row.tier === 0 || referenceMatches(row.label, text, false)
      )
      .sort((a, b) => {
        const x = a.label.toLowerCase()
        const y = b.label.toLowerCase()
        return x < y
          ? -1
          : x > y
            ? 1
            : a.iri < b.iri
              ? -1
              : a.iri > b.iri
                ? 1
                : 0
      })
    out.push(
      ...found.slice(0, limit + 1).map((row) => [key, row.iri, row.tier])
    )
  }
  return out
}

{
  // A small seeded generator, so a failure repeats.
  let seed = 0x2545f491
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x100000000
  }
  const pick = (items) => items[Math.floor(random() * items.length)]
  const words = [
    "water",
    "Water",
    "WATER",
    "iron",
    "Fe",
    "(III)",
    "Fe(III)",
    "oxide",
    "acid",
    "a",
    "e",
    "1",
    "12",
    "2-propanol",
    "sinter",
    "sintering",
    "ſulfur",
    "sulfur",
    "Ångström",
    "β-carotene",
    "α",
    "naïve",
    "ﬀ",
    "ff",
    "ẞ",
    "ß",
    "İ",
    "ı",
    "i",
    "K",
    "\u212a",
    "όσος",
    "_x",
    "x_",
    "Äwater",
    "e\u0301water",
    "\u0301",
    "(±)",
    "+",
    "--",
    "(",
    ")",
    "\u{1d400}",
    "\u{1d167}",
    "grain",
    "grains",
    "micrograin",
    "CO",
    "co",
    "NaCl",
    "Na+"
  ]
  const separators = [" ", " ", " ", "-", ",", "", "/", " (", ") "]
  const phrase = () => {
    let text = pick(words)
    const count = Math.floor(random() * 4)
    for (let index = 0; index < count; index++)
      text += pick(separators) + pick(words)
    return text
  }
  const tags = ["", "", "", "", "en", "en-US", "de"]
  const sources = { alpha: [], beta: [], gamma: [] }
  const flat = []
  for (let index = 0; index < 1200; index++) {
    const key = pick(Object.keys(sources))
    const row = {
      iri: `${base}random/${String(Math.floor(random() * 1e6)).padStart(6, "0")}-${index}`,
      label: random() < 0.05 ? `  ${phrase()} ` : phrase(),
      tag: pick(tags),
      definition: random() < 0.7 ? phrase() + " " + phrase() : undefined,
      version: random() < 0.97 ? "1" : undefined,
      license: "CC0-1.0",
      typed: random() < 0.9
    }
    sources[key].push(row)
    flat.push({ ...row, key })
  }
  const builder = createIndexBuilder({ fingerprint: "random" })
  for (const key of Object.keys(sources).sort()) {
    builder.beginSource(key, `${base}graphs/${key}`)
    for (const row of sources[key]) builder.addRow(row)
  }
  const index = builder.build()
  const allKeys = ["alpha", "beta", "gamma"]
  const terms = new Set(words)
  for (let index = 0; index < 250; index++) {
    const text = phrase()
    terms.add(text)
    const start = Math.floor(random() * text.length)
    // Sliced, a term can split a surrogate pair. The route sends it as
    // UTF-8, which replaces the half, so the index matches the replacement.
    terms.add(
      text
        .slice(start, start + 1 + Math.floor(random() * 8))
        .toWellFormed()
        .trim() || "x"
    )
  }
  let compared = 0
  for (const term of terms) {
    const text = term.trim()
    if (!text) continue
    for (const keys of [allKeys, ["beta"], ["gamma", "alpha"]]) {
      for (const cap of [1, 5, 50]) {
        assert.deepEqual(
          groundingRows(index, { text, keys, cap }).map((row) => [
            row.iri,
            row.tier
          ]),
          referenceGrounding(flat, text, keys, cap),
          `grounding ${JSON.stringify(text)} in ${keys} cap ${cap}`
        )
        compared++
      }
    }
    for (const mode of ["exact", "similar"]) {
      for (const limit of [1, 5, 20]) {
        assert.deepEqual(
          candidateRows(index, { text, mode, limit, keys: allKeys }).map(
            (row) => [row.key, row.iri, row.tier]
          ),
          referenceCandidates(flat, text, mode, allKeys, limit),
          `candidates ${JSON.stringify(text)} ${mode} limit ${limit}`
        )
        compared++
      }
    }
  }
  assert.ok(compared > 3000)

  // The packed index answers the same after crossing a thread boundary.
  const { packed, transfer } = packIndex(index)
  const copy = unpackIndex(structuredClone(packed, { transfer }))
  for (const text of ["water", "Fe(III)", "(", "a"])
    assert.deepEqual(
      groundingRows(copy, { text, keys: allKeys, cap: 10 }).map(
        (row) => row.iri
      ),
      referenceGrounding(flat, text, allKeys, 10).map(([iri]) => iri)
    )
}

// ---------------------------------------------------------------------------
// The lifecycle, with an injected loader, clock and timer.
{
  let now = 0
  let fingerprint = "one"
  const calls = { catalogue: 0, load: 0 }
  const lines = []
  let release
  let stopOnce = false
  // Loads that fail, and with what, before loads succeed again.
  let failures = []
  // Fingerprints the catalogue gives before `fingerprint`, one per read,
  // where an error is thrown instead.
  let catalogues = []
  const loader = {
    async catalogue() {
      calls.catalogue++
      const next = catalogues.shift()
      if (next instanceof Error) throw next
      return { fingerprint: next ?? fingerprint, sources: [] }
    },
    async load(catalogue) {
      calls.load++
      if (release) await release
      if (stopOnce) {
        stopOnce = false
        throw new Error(
          "query lookup-entries did not complete before the store stopped it"
        )
      }
      if (failures.length) throw failures.shift()
      if (catalogue.fingerprint === "too big")
        throw new LookupIndexError("guard tripped")
      return buildIndex({ alpha: [entry("water")] }, catalogue.fingerprint)
    }
  }
  // Timers that fire only when a test fires them: the retries, and the
  // checks of the fingerprint while an index is ready.
  let timers = []
  const live = (kind) =>
    timers.filter(
      (timer) => timer.kind === kind && !timer.cleared && !timer.fired
    )
  const pending = () => live("retry")
  const checkTimers = () => live("check")
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const fire = async (timer) => {
    assert.ok(!timer.cleared && !timer.fired, "a live timer")
    timer.fired = true
    timer.callback()
    await settle()
  }
  const setUp = () => {
    resetLookupIndex()
    timers = []
    failures = []
    catalogues = []
    configureLookupIndex({
      loader,
      now: () => now,
      checkIntervalMs: 30000,
      setTimer: (callback, ms, kind) => {
        const timer = { callback, ms, kind, cleared: false, fired: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer) => (timer.cleared = true),
      log: (line) => lines.push(line)
    })
  }

  // Off: nothing loads.
  setUp()
  const previous = process.env.MATSCI_ONT_LOOKUP_INDEX
  process.env.MATSCI_ONT_LOOKUP_INDEX = " OFF "
  assert.equal(lookupIndexSwitchedOff(), true)
  assert.equal(warmLookupIndex(), null)
  assert.equal(await usableLookupIndex(), null)
  assert.equal(calls.load, 0)
  assert.equal(lookupIndexStatus().state, "off")
  assert.equal(publicLookupStatus().state, "off")
  assert.equal(pending().length, 0)
  assert.equal(checkTimers().length, 0)
  if (previous === undefined) delete process.env.MATSCI_ONT_LOOKUP_INDEX
  else process.env.MATSCI_ONT_LOOKUP_INDEX = previous
  assert.equal(lookupIndexSwitchedOff({}), false)

  // One load at a time, one log line for it.
  setUp()
  let open
  release = new Promise((resolve) => (open = resolve))
  const first = warmLookupIndex()
  const second = loadLookupIndex()
  assert.equal(first, second, "a second load joins the first")
  assert.equal(await usableLookupIndex(), null, "SPARQL until it is ready")
  open()
  release = null
  const loaded = await first
  assert.equal(calls.load, 1)
  assert.equal(loaded.size, 1)
  assert.deepEqual(
    checkTimers().map((timer) => timer.ms),
    [30000],
    "a ready index is checked an interval later"
  )
  assert.equal(await usableLookupIndex(), loaded)
  const logged = lines.filter((line) => line.includes("loaded"))
  assert.equal(logged.length, 1)
  assert.match(
    logged[0],
    /loaded 1 entries from 1 sources in \d+ ms, index \d+ MB, heapUsed \d+ MB/
  )
  assert.equal(lookupIndexStatus().indexBytes, indexBytes(loaded))

  // The fingerprint is read at most once an interval, and shared.
  const checks = calls.catalogue
  now += 29999
  assert.equal(await usableLookupIndex(), loaded)
  assert.equal(calls.catalogue, checks, "no check within the interval")
  now += 1
  const [a, b] = await Promise.all([usableLookupIndex(), usableLookupIndex()])
  assert.equal(a, loaded)
  assert.equal(b, loaded)
  assert.equal(calls.catalogue, checks + 1, "one check for both requests")

  // A changed store drops the index and loads it again.
  fingerprint = "two"
  now += 30000
  assert.equal(await usableLookupIndex(), null)
  const reloaded = await loadLookupIndex()
  assert.equal(reloaded.fingerprint, "two")
  assert.equal(await usableLookupIndex(), reloaded)
  assert.equal(calls.load, 2)

  // A guard abandons the index for that store, without retrying it...
  fingerprint = "too big"
  now += 30000
  assert.equal(await usableLookupIndex(), null)
  await loadLookupIndex()
  assert.equal(lookupIndexStatus().state, "abandoned")
  assert.equal(
    publicLookupStatus().lastError,
    "a description is one the index cannot reproduce"
  )
  const loads = calls.load
  now += 30000
  await usableLookupIndex()
  await loadLookupIndex()
  assert.equal(calls.load, loads, "the same store is not tried again")
  assert.ok(lines.some((line) => line.includes("abandoned")))
  // ...until the store changes.
  fingerprint = "three"
  now += 30000
  await usableLookupIndex()
  assert.equal((await loadLookupIndex()).fingerprint, "three")

  // A store that stops a load part way fails it for now, not for good: the
  // index is not abandoned, and a lookup that comes once the first retry is
  // due starts the load, and clears the timer that would have.
  setUp()
  now = 0
  fingerprint = "one"
  stopOnce = true
  assert.equal(await warmLookupIndex(), null)
  assert.equal(lookupIndexStatus().state, "failed", "not abandoned")
  assert.ok(lines.some((line) => line.includes("not loaded")))
  assert.ok(lines.at(-1).includes("tried again in 30 s"))
  const tried = calls.load
  const [retry] = pending()
  assert.equal(retry.ms, 30000)
  now += 29999
  assert.equal(await usableLookupIndex(), null)
  assert.equal(calls.load, tried, "not again before it is due")
  now += 1
  assert.equal(await usableLookupIndex(), null)
  assert.equal(retry.cleared, true, "the lookup's load clears the timer")
  assert.equal((await loadLookupIndex())?.fingerprint, "one")
  assert.equal(calls.load, tried + 1)
  assert.equal(pending().length, 0)

  // With no lookups at all, the timer loads it again: after 30 seconds,
  // then 60, then every 2 minutes, and once it loads nothing is pending.
  // Each attempt is one load, and the status says what failed without
  // saying what the error said.
  assert.deepEqual(RETRY_DELAYS_MS, [30000, 60000, 120000])
  setUp()
  now = Date.parse("2026-09-26T17:03:00Z")
  failures = [
    new Error(
      "query lookup-entries could not reach the store: connect ECONNREFUSED 127.0.0.1:3031"
    ),
    new Error(
      "page 3 of 14 of chebi: query lookup-entries answered HTTP 500: java.lang.NullPointerException at /opt/matsci-ont/app"
    ),
    new Error(
      "page 2 of 14 of chebi: query lookup-entries did not complete before the store stopped it (asked 3 times)"
    ),
    new Error("Failed to parse URL from http://127.0.0.1:3031/matsci-ont/query")
  ]
  const expected = [
    [30000, "the store could not be reached"],
    [60000, "the store answered HTTP 500"],
    [120000, "the store stopped a query at its time limit"],
    [120000, "the load failed"]
  ]
  const before = calls.load
  const warmingUp = warmLookupIndex()
  assert.equal(publicLookupStatus().state, "loading")
  assert.equal(await warmingUp, null)
  for (const [attempt, [delay, reason]] of expected.entries()) {
    assert.equal(calls.load, before + attempt + 1, "one load an attempt")
    const timersNow = pending()
    assert.equal(timersNow.length, 1, "one timer at a time")
    assert.equal(timersNow[0].ms, delay)
    const status = publicLookupStatus()
    assert.equal(status.state, "failed")
    assert.equal(status.lastError, reason)
    assert.equal(
      status.nextAttemptAt,
      new Date(now + delay).toISOString(),
      "when it is tried again"
    )
    const text = JSON.stringify(status)
    for (const secret of ["127.0.0.1", "3031", "/opt/", "java.lang", "page 3"])
      assert.ok(!text.includes(secret), `${secret} is not public`)
    assert.ok(lines.at(-1).includes(`tried again in ${delay / 1000} s`))
    now += delay
    await fire(timersNow[0])
  }
  assert.equal(calls.load, before + 5)
  const recoveredIndex = await usableLookupIndex()
  assert.ok(recoveredIndex, "loaded with no lookups")
  assert.equal(pending().length, 0)
  const ready = publicLookupStatus()
  assert.deepEqual(ready, {
    state: "ready",
    entries: 1,
    sources: ["alpha"],
    loadedAt: new Date(now).toISOString(),
    loadMs: ready.loadMs,
    pages: null,
    slowestPageMs: null,
    lastError: null,
    nextAttemptAt: null
  })
  assert.equal(typeof ready.loadMs, "number")
  assert.equal(lookupIndexStatus().failures, 0, "the backoff starts over")

  // A timer that fires while a load runs does not start a second one.
  setUp()
  failures = [new Error("query lookup-entries could not reach the store")]
  await warmLookupIndex()
  const [waitingTimer] = pending()
  release = new Promise((resolve) => (open = resolve))
  now += 30000
  await usableLookupIndex()
  assert.equal(publicLookupStatus().state, "loading")
  const loadsNow = calls.load
  // A timer cleared too late to stop its callback finds a load running.
  waitingTimer.cleared = false
  await fire(waitingTimer)
  assert.equal(calls.load, loadsNow, "no second load")
  open()
  release = null
  await settle()
  assert.ok(await usableLookupIndex())

  // A store replaced while a load reads it is loaded again at once, by the
  // timer, with no lookup.
  setUp()
  catalogues = ["one", "two"]
  fingerprint = "two"
  assert.equal(await warmLookupIndex(), null)
  assert.ok(lines.at(-1).includes("the store changed while loading"))
  const [again] = pending()
  assert.equal(again.ms, 0)
  assert.equal(publicLookupStatus().state, "loading")
  await fire(again)
  assert.equal((await usableLookupIndex())?.fingerprint, "two")
  fingerprint = "one"

  // A reset stops a pending retry.
  setUp()
  failures = [new Error("query lookup-entries could not reach the store")]
  await warmLookupIndex()
  const [stopped] = pending()
  resetLookupIndex()
  assert.equal(stopped.cleared, true)
  setUp()

  // While a load runs, one lookup at a time goes to SPARQL, and the others
  // wait for the load until it ends or their signal fires.
  setUp()
  release = new Promise((resolve) => (open = resolve))
  const warming = warmLookupIndex()
  const sparql = await lookupIndexFor({
    signal: new AbortController().signal
  })
  assert.equal(sparql.index, null, "the first lookup takes SPARQL's place")
  assert.equal(lookupIndexStatus().storeLookups, 1)
  const patient = lookupIndexFor({ signal: new AbortController().signal })
  const leaving = new AbortController()
  const impatient = lookupIndexFor({ signal: leaving.signal })
  leaving.abort()
  assert.equal((await impatient).index, null, "a fired signal ends the wait")
  sparql.release()
  sparql.release()
  assert.equal(lookupIndexStatus().storeLookups, 0, "released once")
  const next = await lookupIndexFor({ signal: new AbortController().signal })
  assert.equal(next.index, null, "a free place is taken again")
  next.release()
  open()
  release = null
  const warmed = await warming
  assert.ok(warmed)
  assert.equal((await patient).index, warmed, "the waiting lookup has it")
  assert.equal((await lookupIndexFor()).index, warmed)
  assert.equal(lookupIndexStatus().storeLookups, 0)

  // A load that fails sends the lookups waiting for it to SPARQL, and with
  // no load running every lookup may use SPARQL at once.
  setUp()
  stopOnce = true
  release = new Promise((resolve) => (open = resolve))
  const failing = warmLookupIndex()
  const place = await lookupIndexFor()
  const waiter = lookupIndexFor()
  open()
  release = null
  assert.equal(await failing, null)
  assert.equal((await waiter).index, null)
  place.release()
  const [x, y] = await Promise.all([lookupIndexFor(), lookupIndexFor()])
  assert.equal(x.index, null)
  assert.equal(y.index, null)
  assert.equal(lookupIndexStatus().storeLookups, 0, "no place taken")

  // While the index is ready, a timer confirms the store's fingerprint an
  // interval after the last confirmation, with no lookup. The same store
  // keeps the index, a lookup's confirmation moves the check later, a store
  // that cannot answer is asked again a whole interval later, and a changed
  // store is loaded again.
  setUp()
  now = 0
  fingerprint = "one"
  const held = await warmLookupIndex()
  assert.ok(held)
  let [check] = checkTimers()
  const readsBefore = calls.catalogue
  now += 30000
  await fire(check)
  assert.equal(calls.catalogue, readsBefore + 1, "one reading")
  assert.equal(await usableLookupIndex(), held)
  ;[check] = checkTimers()
  assert.equal(check.ms, 30000, "the next an interval later")
  now += 35000
  assert.equal(await usableLookupIndex(), held)
  assert.equal(calls.catalogue, readsBefore + 2, "a lookup confirmed it")
  now += 5000
  await fire(check)
  assert.equal(calls.catalogue, readsBefore + 2, "not again so soon")
  ;[check] = checkTimers()
  assert.equal(check.ms, 25000, "an interval after the lookup's")
  catalogues = [new Error("query lookup-fingerprint could not reach the store")]
  now += 25000
  await fire(check)
  assert.equal(calls.catalogue, readsBefore + 3)
  assert.equal(lookupIndexStatus().state, "ready", "kept while unconfirmed")
  ;[check] = checkTimers()
  assert.equal(check.ms, 30000, "a store that did not answer, an interval")
  const loadsBeforeChange = calls.load
  fingerprint = "two"
  now += 30000
  await fire(check)
  assert.ok(lines.includes("lookup index: the store changed, loading it again"))
  assert.equal(calls.load, loadsBeforeChange + 1, "loaded with no lookup")
  assert.equal((await usableLookupIndex())?.fingerprint, "two")
  assert.equal(checkTimers().length, 1)
  const [lastCheck] = checkTimers()
  resetLookupIndex()
  assert.equal(lastCheck.cleared, true, "a reset stops the check")
  fingerprint = "one"

  // Pages that do not add up to the store's count, from a store that did
  // not change while they were read, are the store's own: the index is
  // abandoned with the counts in the log and a fixed phrase in the status,
  // and the store is not read in full again until it changes.
  setUp()
  now = 0
  failures = [
    new LookupCountMismatch(
      "the 1 pages of mdo held 90 descriptions and the store counts 89"
    )
  ]
  const readsAtStart = calls.catalogue
  assert.equal(await warmLookupIndex(), null)
  assert.equal(calls.catalogue, readsAtStart + 2, "read again after it")
  assert.equal(lookupIndexStatus().state, "abandoned")
  assert.equal(
    publicLookupStatus().lastError,
    "the pages did not hold exactly the descriptions the store counts"
  )
  assert.equal(
    lines.at(-1),
    "lookup index: abandoned, lookups stay on SPARQL: the 1 pages of mdo held 90 descriptions and the store counts 89, and the store did not change while loading"
  )
  const mismatchLoads = calls.load
  const [recheck] = pending()
  assert.equal(recheck.ms, 120000)
  now += 120000
  await fire(recheck)
  assert.equal(calls.load, mismatchLoads, "not loaded again")
  fingerprint = "two"
  now += 120000
  await fire(pending()[0])
  assert.equal((await usableLookupIndex())?.fingerprint, "two")
  fingerprint = "one"

  // Pages that do not add up because the store changed while they were
  // read are loaded again at once, by the timer, not backed off.
  setUp()
  catalogues = ["one", "two"]
  fingerprint = "two"
  failures = [
    new LookupCountMismatch(
      "the 7 pages of alpha held 41 descriptions and the store counts 40"
    )
  ]
  assert.equal(await warmLookupIndex(), null)
  assert.equal(
    lines.at(-1),
    "lookup index: the store changed while loading, loading it again"
  )
  assert.equal(publicLookupStatus().state, "loading")
  assert.equal(publicLookupStatus().lastError, null)
  const [atOnce] = pending()
  assert.equal(atOnce.ms, 0)
  await fire(atOnce)
  assert.equal((await usableLookupIndex())?.fingerprint, "two")
  fingerprint = "one"

  // A lookup that finds SPARQL's place taken waits for the load for at
  // most a quarter of the time its deadline leaves, then uses SPARQL with
  // the rest, counted beside the place. One whose deadline leaves time
  // enough for the load has the index.
  assert.equal(LOAD_WAIT_SHARE, 0.25)
  setUp()
  release = new Promise((resolve) => (open = resolve))
  const slowLoad = warmLookupIndex()
  const placeHolder = await lookupIndexFor({ deadline: Date.now() + 12000 })
  assert.equal(placeHolder.index, null)
  // The wait's timer does not hold the process open, which a server does.
  const holdOpen = setTimeout(() => {}, 5000)
  const waitStarted = Date.now()
  const brief = await lookupIndexFor({ deadline: Date.now() + 400 })
  const waitedMs = Date.now() - waitStarted
  assert.equal(brief.index, null, "SPARQL once its wait is over")
  assert.ok(waitedMs >= 90 && waitedMs < 350, `waited ${waitedMs} ms`)
  assert.equal(publicLookupStatus().state, "loading", "the load still runs")
  assert.equal(lookupIndexStatus().storeLookups, 2)
  const late = await lookupIndexFor({ deadline: Date.now() - 1 })
  assert.equal(late.index, null, "no time left, no wait")
  late.release()
  clearTimeout(holdOpen)
  const roomy = lookupIndexFor({ deadline: Date.now() + 60000 })
  open()
  release = null
  const slowIndex = await slowLoad
  assert.ok(slowIndex)
  const roomyAnswer = await roomy
  assert.equal(roomyAnswer.index, slowIndex, "the load ended within its wait")
  roomyAnswer.release()
  brief.release()
  placeHolder.release()
  assert.equal(lookupIndexStatus().storeLookups, 0)

  // A load still running when the state is reset is ignored.
  setUp()
  release = new Promise((resolve) => (open = resolve))
  const stale = loadLookupIndex()
  resetLookupIndex()
  open()
  release = null
  assert.equal(await stale, null)
  assert.equal(await usableLookupIndex(), null)
  resetLookupIndex()
}

console.log(
  "OK: the lookup index reproduces Jena's matching and order, and loads, checks and falls back as designed"
)
