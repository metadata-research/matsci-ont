// The candidate and grounding lookups, answered from memory.
//
// Both routes match a term with a regular expression over every label, and
// a regular expression cannot use an index, so each request used to scan
// every description in the store. This module holds the same descriptions
// in memory with a word index over labels and definitions, and answers the
// same questions. The SPARQL queries stay the reference: every rule below
// reproduces what Jena 6.2.0 on Java 21 does with grounding.rq and
// candidate-source.rq, and pnpm verify compares the two paths on the real
// store.
//
// Nothing here does IO. lookup-state.mjs loads, checks and replaces the
// index, and the routes fall back to SPARQL whenever it cannot answer.

export class LookupIndexError extends Error {}

// ---------------------------------------------------------------------------
// Characters as Java 21 sees them.
//
// REGEX with the flag "i" compiles with CASE_INSENSITIVE and UNICODE_CASE,
// which compares code points by Character.toLowerCase(Character.toUpperCase(c)),
// the simple (one code point) case mappings. JavaScript exposes only the full
// mappings, which agree with the simple ones wherever the full mapping is a
// single code point, so a multi-code-point result falls back to the code
// point itself. The one exception in the lowercase direction is U+0130,
// whose simple lowercase is i and whose full lowercase is i with a dot.

const WORD = /^[\p{L}\p{N}_]$/u
const MARK = /^\p{Mn}$/u
const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u
// candidate-source.rq trims [\s\p{Z}\x{FEFF}]; Java's \s is [ \t\n\x0B\f\r].
const TRIM = /^[\t\n\v\f\r\p{Z}\uFEFF]$/u

const COMPUTED = 1
const WORD_CHAR = 2 // [\p{L}\p{N}_], the candidate word boundary
const ASCII_WORD = 4 // [A-Za-z0-9_], Java 21's \b
const NON_SPACING_MARK = 8 // counts as a word character after a base
const LETTER_DIGIT = 16 // Character.isLetterOrDigit, the base test
const FOLDS_TO_WORD = 32 // the folded code point is a word character
const TRIMMED = 64

function singleCodePoint(text, fallback) {
  const first = text.codePointAt(0)
  return text.length === (first > 0xffff ? 2 : 1) ? first : fallback
}

export function upperSimple(point) {
  return singleCodePoint(String.fromCodePoint(point).toUpperCase(), point)
}

export function lowerSimple(point) {
  if (point === 0x130) return 0x69
  return singleCodePoint(String.fromCodePoint(point).toLowerCase(), point)
}

const bmpFlags = new Uint8Array(0x10000)
const bmpFolds = new Uint16Array(0x10000)
const astral = new Map()

function describe(point) {
  const text = String.fromCodePoint(point)
  const fold = lowerSimple(upperSimple(point))
  let flags = COMPUTED
  if (WORD.test(text)) flags |= WORD_CHAR
  if (point < 128 && WORD.test(text)) flags |= ASCII_WORD
  if (MARK.test(text)) flags |= NON_SPACING_MARK
  if (LETTER_OR_DIGIT.test(text)) flags |= LETTER_DIGIT
  if (WORD.test(String.fromCodePoint(fold))) flags |= FOLDS_TO_WORD
  if (TRIM.test(text)) flags |= TRIMMED
  return { flags, fold }
}

function flagsOf(point) {
  if (point < 0x10000) {
    let flags = bmpFlags[point]
    if (flags === 0) {
      const described = describe(point)
      bmpFlags[point] = flags = described.flags
      bmpFolds[point] = described.fold
    }
    return flags
  }
  let described = astral.get(point)
  if (!described) astral.set(point, (described = describe(point)))
  return described.flags
}

// Character.toLowerCase(Character.toUpperCase(point)).
export function foldCodePoint(point) {
  if (point < 0x10000) {
    if (bmpFlags[point] === 0) flagsOf(point)
    return bmpFolds[point]
  }
  flagsOf(point)
  return astral.get(point).fold
}

export const isWordCodePoint = (point) => (flagsOf(point) & WORD_CHAR) !== 0

function codePointBefore(text, index) {
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff)
      return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
  }
  return low
}

const width = (point) => (point > 0xffff ? 2 : 1)

// java.util.regex.Pattern.Bound.hasBaseCharacter. It steps back one UTF-16
// unit at a time, so a supplementary mark reads as its lone low surrogate
// and has no base, which Jena confirms.
function hasBaseCharacter(text, index) {
  for (let at = index; at >= 0; at--) {
    const flags = flagsOf(text.codePointAt(at))
    if (flags & LETTER_DIGIT) return true
    if (flags & NON_SPACING_MARK) continue
    return false
  }
  return false
}

function boundWord(text, point, index) {
  const flags = flagsOf(point)
  return (
    (flags & ASCII_WORD) !== 0 ||
    ((flags & NON_SPACING_MARK) !== 0 && hasBaseCharacter(text, index))
  )
}

// Whether Java 21's \b holds before text[index]. The word test is ASCII
// since JDK 19, so "Äwater" matches \bwater and "_water" does not, and a
// non-spacing mark after a letter or digit counts as part of the word.
export function javaWordBoundary(text, index) {
  const left =
    index > 0 && boundWord(text, codePointBefore(text, index), index - 1)
  const right =
    index < text.length && boundWord(text, text.codePointAt(index), index)
  return left !== right
}

// candidate-source.rq's surrounding-whitespace REPLACE. Java's $ also
// matches before a final line terminator, and U+0085 is the one terminator
// outside the trimmed set, so whitespace before a final U+0085 goes too.
export function javaTrim(text) {
  let start = 0
  while (start < text.length && flagsOf(text.charCodeAt(start)) & TRIMMED)
    start++
  if (start === text.length) return ""
  let end = text.length
  while (end > start && flagsOf(text.charCodeAt(end - 1)) & TRIMMED) end--
  if (end === text.length && text.charCodeAt(end - 1) === 0x85) {
    let before = end - 1
    while (before > start && flagsOf(text.charCodeAt(before - 1)) & TRIMMED)
      before--
    if (before < end - 1) return text.slice(start, before) + "\u0085"
  }
  return start === 0 && end === text.length ? text : text.slice(start, end)
}

const ASCII_ONLY = /^\p{ASCII}*$/u

// LCASE lowercases a capital sigma to the final form ς or to σ by what
// surrounds it, and Java and JavaScript decide that by different rules:
// Jena gives ς for Α1Σ and σ for Α:Σ, and JavaScript the reverse. It is the
// only context-dependent lowercase either applies. So a label with a
// capital sigma carries the lowercase the store computed for it, and a
// term with one is left to SPARQL (indexReadsTerm). Matching with REGEX's
// "i" flag compares code point by code point and is unaffected.
const CAPITAL_SIGMA = "Σ"

export function indexReadsTerm(text) {
  return !text.includes(CAPITAL_SIGMA)
}

// The text with every code point folded. Folding never changes a code
// point's UTF-16 width, so positions in the result are positions in the text.
export function foldText(text) {
  if (ASCII_ONLY.test(text)) return text.toLowerCase()
  const parts = []
  for (let index = 0; index < text.length; ) {
    const point = text.codePointAt(index)
    parts.push(String.fromCodePoint(foldCodePoint(point)))
    index += width(point)
  }
  return parts.join("")
}

// ---------------------------------------------------------------------------
// The term as Java compiles it.
//
// A term of one code point becomes a single-character predicate, which
// matches the character exactly when its upper and folded forms agree
// (REGEX("ẞ", "ß", "i") is false), and matches by fold otherwise. A longer
// term becomes a slice, which matches a text character c against the folded
// pattern character t when c is t or folds to t (REGEX("ẞx", "ßx", "i") is
// true). Both are reproduced here.
export function compileTerm(term, alphabet) {
  const points = [...term].map((character) => character.codePointAt(0))
  const targets = []
  const exact = []
  if (points.length === 1) {
    const upper = upperSimple(points[0])
    const lower = lowerSimple(upper)
    targets.push(upper !== lower ? lower : points[0])
    exact.push(upper === lower)
  } else {
    for (const point of points) {
      targets.push(foldCodePoint(point))
      exact.push(false)
    }
  }
  // The regular expression finds candidate positions quickly. Its classes
  // hold every character of the index's alphabet that the predicate
  // accepts, so for text from the index it accepts exactly what Java does.
  const classes = targets.map((target, index) => {
    const members = new Set([target])
    if (!exact[index])
      for (const point of alphabet?.get(target) ?? []) members.add(point)
    return `[${[...members].map((point) => `\\u{${point.toString(16)}}`).join("")}]`
  })
  return {
    targets,
    exact,
    pattern: new RegExp(classes.join(""), "gu")
  }
}

// Whether the compiled term occurs at a position accepted by `boundary`.
// Occurrences may overlap, so the search resumes one code point on.
function occurs(text, term, boundary) {
  const pattern = term.pattern
  pattern.lastIndex = 0
  for (;;) {
    const found = pattern.exec(text)
    if (found === null) return false
    const start = found.index
    if (boundary(text, start, start + found[0].length)) return true
    pattern.lastIndex = start + width(text.codePointAt(start))
  }
}

// grounding.rq: REGEX(text, CONCAT("\\b", term), "i").
const wordStart = (text, start) => javaWordBoundary(text, start)

// candidate-source.rq: the term between (^|[^\p{L}\p{N}_]) and ($|[^\p{L}\p{N}_]).
function wholeWord(text, start, end) {
  if (start > 0 && isWordCodePoint(codePointBefore(text, start))) return false
  return end === text.length || !isWordCodePoint(text.codePointAt(end))
}

export function matchesWordStart(text, term) {
  return occurs(text, term, wordStart)
}

export function matchesWholeWord(text, term) {
  return occurs(text, term, wholeWord)
}

// ---------------------------------------------------------------------------
// Order.

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// ARQ's ORDER BY over label terms: plain literals first, then language-tagged
// literals grouped by tag compared without case, each group in UTF-16 order
// of its lexical form. Tags arrive in their canonical case.
export function compareLabels(labelA, tagA, labelB, tagB) {
  if (tagA === tagB) return compare(labelA, labelB)
  if (tagA === "") return -1
  if (tagB === "") return 1
  const lowerA = tagA.toLowerCase()
  const lowerB = tagB.toLowerCase()
  if (lowerA !== lowerB) return compare(lowerA, lowerB)
  return compare(labelA, labelB) || compare(tagA, tagB)
}

function hashText(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ---------------------------------------------------------------------------
// Words.
//
// A word is a maximal run of code points whose folded form is a letter,
// number or underscore, folded. Every match of a term covers the term's
// words in the text, so looking up one of them finds a superset of the
// entries that can match, which the matchers above then decide:
//
//   a word inside the term      is a whole word of the text
//   the term's last word        begins a word of the text (grounding may
//                               continue it, as sinter continues to sintering)
//   the term's first word       is a whole word, or for grounding starts at
//                               a Java \b inside a word of the text
//
// The last case is why a word's suffix is also indexed wherever Java's \b
// falls inside it, as it does between Ä and water in "Äwater". Only a word
// mixing ASCII and other characters has such a position. A text containing
// a character whose word class changes when folded (U+0345 is the only one)
// could break the first two rules, so it is verified for every term.

const EMPTY_INTS = new Int32Array(0)
const ASCII_WORD_TABLE = new Uint8Array(128)
for (let code = 0; code < 128; code++)
  if (/[A-Za-z0-9_]/.test(String.fromCharCode(code))) ASCII_WORD_TABLE[code] = 1

// A copy sharing no memory with a larger string. V8 keeps a substring of 13
// or more characters as a view into its parent, so a word kept from a
// temporary string would otherwise keep the whole temporary string alive.
function ownString(text) {
  return text.length < 13 ? text : Buffer.from(text, "utf8").toString("utf8")
}

// Calls `emit` with each word of the text, a word possibly more than once,
// and returns whether the text has to be verified for every term.
function eachWord(text, alphabet, emit) {
  if (ASCII_ONLY.test(text)) {
    let start = -1
    for (let index = 0; index <= text.length; index++) {
      const code = index < text.length ? text.charCodeAt(index) : 0
      if (ASCII_WORD_TABLE[code]) {
        if (start < 0) start = index
      } else if (start >= 0) {
        emit(text.slice(start, index).toLowerCase())
        start = -1
      }
    }
    return false
  }
  const folded = foldText(text)
  let weird = false
  let start = -1
  const finish = (end) => {
    emit(folded.slice(start, end))
    for (let index = start; index < end; ) {
      const point = text.codePointAt(index)
      if (index > start && javaWordBoundary(text, index))
        emit(folded.slice(index, end))
      index += width(point)
    }
    start = -1
  }
  for (let index = 0; index < text.length; ) {
    const point = text.codePointAt(index)
    const flags = flagsOf(point)
    if (point > 127) alphabet.add(point)
    const word = (flags & WORD_CHAR) !== 0
    const foldsToWord = (flags & FOLDS_TO_WORD) !== 0
    if (word !== foldsToWord) weird = true
    if (foldsToWord) {
      if (start < 0) start = index
    } else if (start >= 0) finish(index)
    index += width(point)
  }
  if (start >= 0) finish(folded.length)
  return weird
}

class IntList {
  constructor(capacity = 1024) {
    this.items = new Int32Array(capacity)
    this.length = 0
  }
  push(value) {
    if (this.length === this.items.length) {
      const grown = new Int32Array(this.items.length * 2)
      grown.set(this.items)
      this.items = grown
    }
    this.items[this.length++] = value
  }
  toArray() {
    return this.items.slice(0, this.length)
  }
}

// A sorted dictionary of words and, for each, the ascending entry ids
// containing it, in one compressed postings array.
function wordIndex(size, textOf, alphabet) {
  const temporary = new Map()
  const lastSeen = new IntList(1 << 14)
  const flat = new IntList(1 << 16)
  const starts = new Int32Array(size + 1)
  const always = []
  let id = 0
  const emit = (word) => {
    let wordId = temporary.get(word)
    if (wordId === undefined) {
      wordId = temporary.size
      temporary.set(ownString(word), wordId)
      lastSeen.push(-1)
    }
    if (lastSeen.items[wordId] === id) return
    lastSeen.items[wordId] = id
    flat.push(wordId)
  }
  for (; id < size; id++) {
    starts[id] = flat.length
    const text = textOf(id)
    if (text !== undefined && eachWord(text, alphabet, emit)) always.push(id)
  }
  starts[size] = flat.length
  const tokens = [...temporary.keys()]
  temporary.clear()
  const byWord = tokens.map((_, index) => index)
  byWord.sort((a, b) => compare(tokens[a], tokens[b]))
  const rank = new Int32Array(tokens.length)
  byWord.forEach((wordId, position) => (rank[wordId] = position))
  const offsets = new Int32Array(tokens.length + 1)
  for (let index = 0; index < flat.length; index++)
    offsets[rank[flat.items[index]] + 1]++
  for (let index = 0; index < tokens.length; index++)
    offsets[index + 1] += offsets[index]
  const cursor = offsets.slice(0, tokens.length)
  const postings = new Int32Array(flat.length)
  for (let entry = 0; entry < size; entry++) {
    for (let index = starts[entry]; index < starts[entry + 1]; index++)
      postings[cursor[rank[flat.items[index]]]++] = entry
  }
  return {
    tokens: byWord.map((wordId) => tokens[wordId]),
    offsets,
    postings,
    always: Int32Array.from(always)
  }
}

function lowerBound(tokens, word) {
  let low = 0
  let high = tokens.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (tokens[middle] < word) low = middle + 1
    else high = middle
  }
  return low
}

// The dictionary range holding `word`, or every word it begins.
function wordRange(words, word, prefix) {
  const low = lowerBound(words.tokens, word)
  let high = low
  if (!prefix) {
    if (words.tokens[low] === word) high = low + 1
  } else {
    let top = words.tokens.length
    while (high < top) {
      const middle = (high + top) >>> 1
      if (words.tokens[middle].startsWith(word)) high = middle + 1
      else top = middle
    }
  }
  return { low, high, count: words.offsets[high] - words.offsets[low] }
}

// The word of the folded term whose lookup finds the fewest entries, or
// null when the term has no word and every entry has to be tried.
function anchorFor(words, foldedTerm, grounding) {
  const spans = []
  let start = -1
  for (let index = 0; index < foldedTerm.length; ) {
    const point = foldedTerm.codePointAt(index)
    if (isWordCodePoint(point)) {
      if (start < 0) start = index
    } else if (start >= 0) {
      spans.push([start, index])
      start = -1
    }
    index += width(point)
  }
  if (start >= 0) spans.push([start, foldedTerm.length])
  let best = null
  for (const [from, to] of spans) {
    const prefix = grounding && to === foldedTerm.length
    const range = wordRange(words, foldedTerm.slice(from, to), prefix)
    if (!best || range.count < best.count) best = range
    if (best.count === 0) break
  }
  return best
}

// Marks the anchor's entries, plus those always verified, in a bitmap over
// positions (entry ids, or candidate ranks when `positionOf` is given).
function mark(bitmap, words, anchor, positionOf) {
  const place = (id) => {
    const position = positionOf ? positionOf[id] : id
    bitmap[position >>> 5] |= 1 << (position & 31)
  }
  const end = words.offsets[anchor.high]
  for (let index = words.offsets[anchor.low]; index < end; index++)
    place(words.postings[index])
  for (const id of words.always) place(id)
}

// Visits the marked positions in [start, end) in ascending order until
// `visit` returns false.
function eachMarked(bitmap, start, end, visit) {
  if (start >= end) return
  for (let word = start >>> 5; word <= (end - 1) >>> 5; word++) {
    let bits = bitmap[word]
    while (bits !== 0) {
      const lowest = bits & -bits
      const position = (word << 5) + (31 - Math.clz32(lowest))
      bits ^= lowest
      if (position < start || position >= end) continue
      if (!visit(position)) return
    }
  }
}

// Visits the positions of [start, end) that can match, in order: the
// anchor's marked entries, or every position when the term has no word.
function eachCandidate(bitmap, anchor, start, end, visit) {
  if (anchor === null) {
    for (let position = start; position < end; position++)
      if (!visit(position)) return
    return
  }
  eachMarked(bitmap, start, end, visit)
}

// ---------------------------------------------------------------------------
// Building.
//
// Labels are kept as strings, because every lookup reads them. IRIs and
// definitions are read only for the few entries a lookup returns or checks,
// so they are kept as UTF-8 bytes outside the JavaScript heap, which is
// about half the memory and none of the garbage collector's work.

const TYPED = 1 // a class or concept in its own source's graph
const GROUNDABLE = 2 // has the definition, version and licence grounding needs
const TRIMMED_LABEL = 4 // the candidate trim changes the label
const HAS_DEFINITION = 8
const ASCII_LABEL = 16

// UTF-8 text in fixed blocks, so that growing never copies what is already
// stored. A value never spans two blocks.
const BLOCK_BYTES = 4 * 1024 * 1024

class Utf8Column {
  constructor() {
    this.blocks = []
    this.block = null
    this.used = BLOCK_BYTES
    this.starts = new IntList(1 << 16)
    this.ends = new IntList(1 << 16)
  }
  push(text) {
    const length = text ? Buffer.byteLength(text, "utf8") : 0
    if (length > BLOCK_BYTES)
      throw new LookupIndexError("a description is longer than 4 MB")
    if (this.used + length > BLOCK_BYTES) {
      this.block = Buffer.allocUnsafe(BLOCK_BYTES)
      this.blocks.push(this.block)
      this.used = 0
    }
    const start = (this.blocks.length - 1) * BLOCK_BYTES + this.used
    if (length) this.used += this.block.write(text, this.used, "utf8")
    this.starts.push(start)
    this.ends.push(start + length)
  }
  finish() {
    const blocks = [...this.blocks]
    // The last block is cut to what it holds. Buffer.alloc, because a small
    // Buffer.from comes from Node's shared pool, which cannot be moved to
    // another thread.
    if (blocks.length) {
      const last = Buffer.alloc(this.used)
      this.block.copy(last, 0, 0, this.used)
      blocks[blocks.length - 1] = last
    }
    return {
      blocks,
      starts: this.starts.toArray(),
      ends: this.ends.toArray()
    }
  }
}

function textAt(column, row) {
  const start = column.starts[row]
  const end = column.ends[row]
  if (start === end) return ""
  const block = Math.floor(start / BLOCK_BYTES)
  const offset = start - block * BLOCK_BYTES
  return column.blocks[block].toString("utf8", offset, offset + end - start)
}

export function iriOf(index, id) {
  return textAt(index.iriColumn, index.rowOf[id])
}

export function definitionOf(index, id) {
  if (!(index.flags[id] & HAS_DEFINITION)) return undefined
  return textAt(index.definitionColumn, index.rowOf[id])
}

// LCASE(STR(label)): the store's own lowercase for a label with a capital
// sigma, and JavaScript's, which agrees with Java's, for every other.
export function lowerLabel(index, id) {
  return index.lowered.get(id) ?? index.labels[id].toLowerCase()
}

// LCASE of candidate-source.rq's trimmed label. The trim removes only
// characters that have no case and never join a word, so trimming the
// lowercase gives the lowercase of the trimmed label, sigma included, which
// Jena confirms and pnpm verify checks on every label that is not ASCII.
export function trimmedLowerLabel(index, id) {
  const lower = index.lowered.get(id)
  return lower === undefined
    ? javaTrim(index.labels[id]).toLowerCase()
    : javaTrim(lower)
}

// hashText(label.toLowerCase()) for an ASCII label, without the copy.
function hashAsciiLowered(label) {
  let hash = 0x811c9dc5
  for (let index = 0; index < label.length; index++) {
    const code = label.charCodeAt(index)
    hash ^= code >= 65 && code <= 90 ? code + 32 : code
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// LCASE(a) against LCASE(b) in UTF-16 order for two ASCII labels, compared
// in place rather than through a lowercase copy of every label.
function compareAsciiLowered(a, b) {
  const shorter = Math.min(a.length, b.length)
  for (let index = 0; index < shorter; index++) {
    let x = a.charCodeAt(index)
    let y = b.charCodeAt(index)
    if (x >= 65 && x <= 90) x += 32
    if (y >= 65 && y <= 90) y += 32
    if (x !== y) return x - y
  }
  return a.length - b.length
}

// Entries sort together in a Float64Array as hash * 2^21 + position.
const POSITIONS = 0x200000

export function createIndexBuilder({ fingerprint, maxRows = Infinity } = {}) {
  const sources = []
  const iris = new Utf8Column()
  const definitions = new Utf8Column()
  const iriHashes = new IntList(1 << 16)
  let labels = []
  const tags = new IntList(1 << 16)
  const versions = new IntList(1 << 16)
  const licences = new IntList(1 << 16)
  const rowFlags = new IntList(1 << 16)
  const tagNames = [""]
  const tagIds = new Map([["", 0]])
  const values = []
  const valueIds = new Map()
  // The store's LCASE of each label with a capital sigma, by row.
  const storeLowered = new Map()
  let current = null
  const limit = Math.min(maxRows, POSITIONS - 1)

  const valueId = (value) => {
    if (value === undefined) return 0xffff
    let id = valueIds.get(value)
    if (id === undefined) {
      if (values.length >= 0xfffe)
        throw new LookupIndexError("too many distinct versions and licences")
      valueIds.set(value, (id = values.length))
      values.push(value)
    }
    return id
  }

  return {
    get rows() {
      return labels.length
    },
    beginSource(key, graph) {
      if (current && !(key > current.key))
        throw new LookupIndexError(
          "sources must be added once each, in key order"
        )
      current = { key, graph, start: labels.length, end: labels.length }
      sources.push(current)
    },
    addRow(row) {
      if (!current)
        throw new LookupIndexError("a row arrived before its source")
      if (labels.length >= limit)
        throw new LookupIndexError(`more than ${limit} descriptions`)
      let tag = tagIds.get(row.tag ?? "")
      if (tag === undefined) {
        if (tagNames.length >= 255)
          throw new LookupIndexError("too many label languages")
        tagIds.set(row.tag, (tag = tagNames.length))
        tagNames.push(row.tag)
      }
      if (row.label.includes(CAPITAL_SIGMA)) {
        if (typeof row.lower !== "string")
          throw new LookupIndexError(
            `${row.iri} has a capital sigma in its label and no lowercase from the store`
          )
        storeLowered.set(labels.length, row.lower)
      }
      iris.push(row.iri)
      iriHashes.push(hashText(row.iri))
      labels.push(row.label)
      definitions.push(row.definition)
      tags.push(tag)
      versions.push(valueId(row.version))
      licences.push(valueId(row.license))
      rowFlags.push(
        (row.typed === true ? TYPED : 0) |
          (row.definition !== undefined ? HAS_DEFINITION : 0) |
          (ASCII_ONLY.test(row.label) ? ASCII_LABEL : 0)
      )
      current.end = labels.length
    },
    build() {
      const size = labels.length
      const iriColumn = iris.finish()
      const iriAt = (row) => textAt(iriColumn, row)
      const definitionColumn = definitions.finish()

      // One label, at most one definition, one version and one licence per
      // description, as the build writes them. A second row for an IRI
      // would mean SPARQL answers with a cross product this index does not
      // reproduce, so the index refuses and the routes stay on SPARQL.
      for (const source of sources) {
        const keyed = new Float64Array(source.end - source.start)
        for (let row = source.start; row < source.end; row++)
          keyed[row - source.start] =
            (iriHashes.items[row] >>> 0) * POSITIONS + row
        keyed.sort()
        for (let position = 1; position < keyed.length; position++) {
          const hash = Math.floor(keyed[position] / POSITIONS)
          if (hash !== Math.floor(keyed[position - 1] / POSITIONS)) continue
          const row = keyed[position] % POSITIONS
          for (let before = position - 1; before >= 0; before--) {
            if (Math.floor(keyed[before] / POSITIONS) !== hash) break
            if (iriAt(keyed[before] % POSITIONS) === iriAt(row))
              throw new LookupIndexError(
                `source ${source.key} has more than one row for ${iriAt(row)}`
              )
          }
        }
      }

      // Entry ids follow grounding's order within a source: label as ARQ
      // orders it, then IRI. Sources are contiguous and in key order.
      const order = new Int32Array(size)
      for (const source of sources) {
        const part = []
        for (let row = source.start; row < source.end; row++) part.push(row)
        part.sort(
          (a, b) =>
            compareLabels(
              labels[a],
              tagNames[tags.items[a]],
              labels[b],
              tagNames[tags.items[b]]
            ) || compare(iriAt(a), iriAt(b))
        )
        order.set(part, source.start)
      }
      const index = {
        fingerprint,
        size,
        sources: sources.map((source) => Object.freeze({ ...source })),
        tagNames,
        values,
        rowOf: order,
        iriColumn,
        definitionColumn,
        labels: Array.from(order, (row) => labels[row]),
        tags: Uint8Array.from(order, (row) => tags.items[row]),
        versions: Uint16Array.from(order, (row) => versions.items[row]),
        licences: Uint16Array.from(order, (row) => licences.items[row]),
        flags: Uint8Array.from(order, (row) => rowFlags.items[row]),
        lowered: new Map()
      }
      if (storeLowered.size) {
        const idOf = new Int32Array(size)
        order.forEach((row, id) => (idOf[row] = id))
        for (const [row, lower] of storeLowered)
          index.lowered.set(idOf[row], lower)
        storeLowered.clear()
      }
      labels = null
      for (let id = 0; id < size; id++) {
        let flags = index.flags[id]
        if (
          flags & HAS_DEFINITION &&
          index.versions[id] !== 0xffff &&
          index.licences[id] !== 0xffff
        )
          flags |= GROUNDABLE
        if (javaTrim(index.labels[id]) !== index.labels[id])
          flags |= TRIMMED_LABEL
        index.flags[id] = flags
      }
      index.sourceByKey = new Map(
        index.sources.map((source) => [source.key, source])
      )

      // Candidate order within a source: LCASE(STR(label)), then IRI.
      let lowered = new Array(size)
      const lowerOf = (id) => (lowered[id] ??= lowerLabel(index, id))
      const ascii = (id) => (index.flags[id] & ASCII_LABEL) !== 0
      index.byCandidate = new Int32Array(size)
      index.candidateRank = new Int32Array(size)
      for (const source of index.sources) {
        const part = []
        for (let id = source.start; id < source.end; id++) part.push(id)
        part.sort(
          (a, b) =>
            (ascii(a) && ascii(b)
              ? compareAsciiLowered(index.labels[a], index.labels[b])
              : compare(lowerOf(a), lowerOf(b))) ||
            compare(iriOf(index, a), iriOf(index, b))
        )
        part.forEach((id, offset) => {
          index.byCandidate[source.start + offset] = id
          index.candidateRank[id] = source.start + offset
        })
      }

      // Exact labels by a hash of LCASE(label), sorted for binary search.
      const keyed = new Float64Array(size)
      for (let id = 0; id < size; id++)
        keyed[id] =
          (ascii(id)
            ? hashAsciiLowered(index.labels[id])
            : hashText(lowerOf(id))) *
            POSITIONS +
          id
      lowered = null
      keyed.sort()
      index.hashes = new Uint32Array(size)
      index.hashIds = new Int32Array(size)
      for (let position = 0; position < size; position++) {
        index.hashes[position] = Math.floor(keyed[position] / POSITIONS)
        index.hashIds[position] = keyed[position] % POSITIONS
      }
      const trimmed = []
      for (let id = 0; id < size; id++)
        if (index.flags[id] & TRIMMED_LABEL) trimmed.push(id)
      index.trimmedIds = trimmed.length ? Int32Array.from(trimmed) : EMPTY_INTS

      const alphabet = new Set()
      index.labelWords = wordIndex(size, (id) => index.labels[id], alphabet)
      index.definitionWords = wordIndex(
        size,
        (id) => definitionOf(index, id),
        alphabet
      )
      // Every character of the index grouped by its fold, so a compiled
      // term's classes hold each character its predicate accepts.
      index.alphabet = new Map()
      for (let point = 0; point < 128; point++) alphabet.add(point)
      for (const point of alphabet) {
        const fold = foldCodePoint(point)
        if (!index.alphabet.has(fold)) index.alphabet.set(fold, [])
        index.alphabet.get(fold).push(point)
      }
      index.bitmap = new Uint32Array(Math.ceil(size / 32) + 1)
      return Object.freeze(index)
    }
  }
}

// What the index holds in memory, in bytes: its arrays exactly, most of
// them outside the JavaScript heap, and its strings estimated at V8's one
// or two bytes a character plus a header. The load's log line reports it,
// and pnpm verify holds it to a budget.
export function indexBytes(index) {
  let bytes = 0
  const arrays = [
    index.rowOf,
    index.tags,
    index.versions,
    index.licences,
    index.flags,
    index.byCandidate,
    index.candidateRank,
    index.hashes,
    index.hashIds,
    index.trimmedIds,
    index.bitmap
  ]
  for (const column of [index.iriColumn, index.definitionColumn])
    arrays.push(column.starts, column.ends, ...column.blocks)
  for (const words of [index.labelWords, index.definitionWords])
    arrays.push(words.offsets, words.postings, words.always)
  for (const array of arrays) bytes += array.byteLength
  const twoByte = /[Ā-￿]/
  const text = (value) => 20 + value.length * (twoByte.test(value) ? 2 : 1)
  for (const list of [
    index.labels,
    index.labelWords.tokens,
    index.definitionWords.tokens,
    index.lowered.values()
  ])
    for (const value of list) bytes += text(value)
  return bytes
}

// ---------------------------------------------------------------------------
// Answering.

// Entries whose LCASE(label) equals the lowercased term, in id order.
function sameLabel(index, lowerTerm) {
  const hash = hashText(lowerTerm)
  const found = []
  let low = 0
  let high = index.size
  while (low < high) {
    const middle = (low + high) >>> 1
    if (index.hashes[middle] < hash) low = middle + 1
    else high = middle
  }
  for (
    let position = low;
    position < index.size && index.hashes[position] === hash;
    position++
  ) {
    const id = index.hashIds[position]
    if (lowerLabel(index, id) === lowerTerm) found.push(id)
  }
  return found.sort((a, b) => a - b)
}

// Entries whose trimmed label equals the term, candidate-source.rq's tier 0.
function exactCandidates(index, lowerTerm) {
  const found = sameLabel(index, lowerTerm).filter(
    (id) => !(index.flags[id] & TRIMMED_LABEL)
  )
  for (const id of index.trimmedIds)
    if (trimmedLowerLabel(index, id) === lowerTerm) found.push(id)
  return new Set(found)
}

// The term as the index reads it: well formed, as the store receives it
// over the wire, and lowercased as LCASE does, which only a term without a
// capital sigma can be here.
function readTerm(text) {
  const term = text.toWellFormed()
  if (!indexReadsTerm(term))
    throw new Error(
      "the lookup index cannot lowercase a capital sigma as the store does"
    )
  return { term, lowerTerm: term.toLowerCase() }
}

// Whether the index holds every source a candidate search reads, typed
// against the graph the live catalogue names. A key listed twice would give
// candidates.rq two branches for it, which the index does not reproduce.
export function indexCovers(index, sources) {
  return (
    new Set(sources.map((source) => source.key)).size === sources.length &&
    sources.every(
      (source) => index.sourceByKey.get(source.key)?.graph === source.graph
    )
  )
}

export function indexHasKeys(index, keys) {
  return keys.every((key) => index.sourceByKey.has(key))
}

// candidates.rq with one candidate-source.rq branch per source: for each
// key, up to `limit + 1` rows of the requested tier, in candidate order.
export function candidateRows(index, { text, mode, limit, keys }) {
  const { term, lowerTerm } = readTerm(text)
  const want = limit + 1
  const exact = exactCandidates(index, lowerTerm)
  const rows = []
  const add = (key, id, tier) =>
    rows.push({ key, iri: iriOf(index, id), label: index.labels[id], tier })
  if (mode === "exact") {
    const chosen = [...exact].filter((id) => index.flags[id] & TYPED)
    chosen.sort((a, b) => index.candidateRank[a] - index.candidateRank[b])
    for (const key of keys) {
      const source = index.sourceByKey.get(key)
      const inSource = chosen.filter(
        (id) => id >= source.start && id < source.end
      )
      for (const id of inSource.slice(0, want)) add(key, id, 0)
    }
    return rows
  }
  const compiled = compileTerm(term, index.alphabet)
  const words = index.labelWords
  const anchor = anchorFor(words, foldText(term), false)
  if (anchor) mark(index.bitmap, words, anchor, index.candidateRank)
  try {
    for (const key of keys) {
      const source = index.sourceByKey.get(key)
      let found = 0
      eachCandidate(
        index.bitmap,
        anchor,
        source.start,
        source.end,
        (position) => {
          const id = index.byCandidate[position]
          if (!(index.flags[id] & TYPED) || exact.has(id)) return true
          if (!matchesWholeWord(index.labels[id], compiled)) return true
          add(key, id, 1)
          return ++found < want
        }
      )
    }
  } finally {
    if (anchor) index.bitmap.fill(0)
  }
  return rows
}

// grounding.rq: up to `cap + 1` rows ordered by tier, source key, label and
// IRI, from the allowed keys.
export function groundingRows(index, { text, keys, cap }) {
  const { term, lowerTerm } = readTerm(text)
  const want = cap + 1
  // A key listed twice in FILTER IN matches once.
  const ranges = [...new Set(keys)]
    .map((key) => index.sourceByKey.get(key))
    .sort((a, b) => a.start - b.start)
  const sourceOf = (id) =>
    ranges.find((source) => id >= source.start && id < source.end)
  const chosen = sameLabel(index, lowerTerm)
    .filter((id) => index.flags[id] & GROUNDABLE && sourceOf(id))
    .slice(0, want)
  const tierOf = new Map(chosen.map((id) => [id, 0]))
  if (chosen.length < want) {
    const compiled = compileTerm(term, index.alphabet)
    const folded = foldText(term)
    // Tier 1, the label begins a word with the term, then tier 2, only the
    // definition does. Tier 2 is read only when tier 1 is exhausted, so
    // every tier 1 entry is in tierOf by then.
    for (const [tier, words, textOf] of [
      [1, index.labelWords, (id) => index.labels[id]],
      [2, index.definitionWords, (id) => definitionOf(index, id)]
    ]) {
      const anchor = anchorFor(words, folded, true)
      if (anchor) mark(index.bitmap, words, anchor, null)
      try {
        for (const source of ranges) {
          if (chosen.length >= want) break
          eachCandidate(
            index.bitmap,
            anchor,
            source.start,
            source.end,
            (id) => {
              if (!(index.flags[id] & GROUNDABLE) || tierOf.has(id)) return true
              if (!matchesWordStart(textOf(id), compiled)) return true
              tierOf.set(id, tier)
              chosen.push(id)
              return chosen.length < want
            }
          )
        }
      } finally {
        if (anchor) index.bitmap.fill(0)
      }
      if (chosen.length >= want) break
    }
  }
  return chosen.map((id) => ({
    iri: iriOf(index, id),
    label: index.labels[id],
    definition: definitionOf(index, id),
    key: sourceOf(id).key,
    version: index.values[index.versions[id]],
    license: index.values[index.licences[id]],
    tier: tierOf.get(id)
  }))
}
