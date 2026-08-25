// Checks the choices the definitions index makes.
//
//   node pipeline/test-derive.mjs
//
// Label and definition precedence and language preference decide what a
// reader and the grounding route of Phase 5 are shown, and a source can
// carry several candidates for one entity. These assertions pin the order.

import {
  definitionsTurtle,
  LABEL_PROPERTIES,
  DEFINITION_PROPERTIES
} from "./lib/derive.mjs"

const GRAPH = "http://example.org/g"
const MANIFEST = [
  {
    key: "demo",
    graphIri: GRAPH,
    version: "1.0",
    license: "CC-BY-4.0",
    republishable: true
  }
]

const literal = (value, language) =>
  language ? { value, "xml:lang": language } : { value }

// byGraph: graph -> subject -> property -> candidate literals
function turtleFor(properties) {
  const byGraph = new Map([
    [GRAPH, new Map([["http://example.org/s", new Map(properties)]])]
  ])
  return definitionsTurtle(MANIFEST, byGraph).turtle
}

const failures = []
function expect(label, condition, detail) {
  process.stdout.write(`${condition ? "pass" : "FAIL"}  ${label}\n`)
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`)
}

const [SKOS_PREF, RDFS_LABEL] = LABEL_PROPERTIES
const [SKOS_DEFINITION, IAO, ELUCIDATION, RDFS_COMMENT] = DEFINITION_PROPERTIES

// Label precedence: a SKOS preferred label wins over an RDFS label.
const labelOrder = turtleFor([
  [RDFS_LABEL, [literal("rdfs one", "en")]],
  [SKOS_PREF, [literal("skos one", "en")]]
])
expect(
  "skos:prefLabel outranks rdfs:label",
  labelOrder.includes('ont:label "skos one"@en')
)

// Language: English wins over another language whatever the order of the
// candidates, and an untagged literal is taken before an unrelated language.
const german = turtleFor([
  [SKOS_PREF, [literal("Sintern", "de"), literal("sintering", "en")]]
])
expect("an English label wins over German", german.includes('"sintering"@en'))
const regional = turtleFor([
  [SKOS_PREF, [literal("colour", "en-GB"), literal("Farbe", "de")]]
])
expect("a regional English label is taken", regional.includes('"colour"@en-GB'))
const untagged = turtleFor([
  [SKOS_PREF, [literal("Farbe", "de"), literal("plain")]]
])
expect(
  "an untagged label beats an unrelated language",
  untagged.includes('ont:label "plain" .')
)

// Definition precedence, in full order. Each case offers every lower-ranked
// candidate as well, so a wrong order shows up as the wrong text.
const all = [
  [RDFS_COMMENT, [literal("comment text", "en")]],
  [ELUCIDATION, [literal("elucidation text", "en")]],
  [IAO, [literal("iao text", "en")]],
  [SKOS_DEFINITION, [literal("skos text", "en")]],
  [SKOS_PREF, [literal("label", "en")]]
]
expect(
  "skos:definition is taken first",
  turtleFor(all).includes('ont:definition "skos text"@en')
)
expect(
  "IAO 0000115 is taken next",
  turtleFor(all.filter(([p]) => p !== SKOS_DEFINITION)).includes(
    'ont:definition "iao text"@en'
  )
)
expect(
  "the EMMO elucidation is taken before rdfs:comment",
  turtleFor(all.filter(([p]) => p !== SKOS_DEFINITION && p !== IAO)).includes(
    'ont:definition "elucidation text"@en'
  )
)
expect(
  "rdfs:comment is the last resort",
  turtleFor([
    [RDFS_COMMENT, [literal("comment text", "en")]],
    [SKOS_PREF, [literal("label", "en")]]
  ]).includes('ont:definition "comment text"@en')
)

// An entity with a definition but no label is not findable, so it is not an
// entry. A NIST concept with a label and no definition is.
expect(
  "an entity without a label is skipped",
  definitionsTurtle(
    MANIFEST,
    new Map([
      [
        GRAPH,
        new Map([
          [
            "http://example.org/s",
            new Map([[SKOS_DEFINITION, [literal("orphan")]]])
          ]
        ])
      ]
    ])
  ).entries === 0
)
const labelOnly = turtleFor([[SKOS_PREF, [literal("term", "en")]]])
expect(
  "a label without a definition is still an entry",
  labelOnly.includes('ont:label "term"@en')
)
expect(
  "that entry carries no definition",
  !labelOnly.includes("ont:definition")
)

// Every entry states its licence and version, which is what the grounding
// contract of Phase 5 hands on to a reader.
expect(
  "an entry states its licence",
  labelOnly.includes('ont:license "CC-BY-4.0"')
)
expect(
  "an entry states its source version",
  labelOnly.includes('ont:sourceVersion "1.0"')
)

// A quotation mark or newline in a definition must not break the Turtle.
const awkward = turtleFor([
  [SKOS_PREF, [literal('a "quoted" term')]],
  [SKOS_DEFINITION, [literal("line one\nline two\\end")]]
])
expect(
  "a quotation mark is escaped",
  awkward.includes('ont:label "a \\"quoted\\" term"')
)
expect(
  "a newline and a backslash are escaped",
  awkward.includes('ont:definition "line one\\nline two\\\\end"')
)

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log("\nOK: the index makes the documented choices")
