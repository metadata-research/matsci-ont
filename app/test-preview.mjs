// Run the production preview queries against a small local dataset. The
// fetch replacement evaluates SPARQL with the installed Jena CLI, so this
// test does not start a server, contact a store, or rebuild the catalogue.
//
// The suite runs twice: first with no lookup index, so every candidate
// search is answered by candidates.rq, then with the index loaded from the
// same dataset through the same fetch, and the two runs must answer alike.
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { jenaEnvironment, runJena } from "../shared/tools.mjs"
import { inferredGraphFor } from "../shared/vocabulary.mjs"
import { common } from "./lib/substitutions.mjs"
import { RejectedInput } from "./lib/terms.mjs"
import { findCandidates, getHierarchy } from "./preview.mjs"
import {
  configureLookupIndex,
  inThreadLoader,
  loadLookupIndex,
  lookupIndexStatus,
  resetLookupIndex
} from "./lib/lookup-state.mjs"

const base = "https://example.org/preview/"
const rdfs = "http://www.w3.org/2000/01/rdf-schema#"
const skos = "http://www.w3.org/2004/02/skos/core#"
const dataset = new Map()
const iri = (name) => `${base}${name}`
function add(graph, triple) {
  if (!dataset.has(graph)) dataset.set(graph, [])
  dataset.get(graph).push(triple)
}
function source(key, { cleared = true, mirror = false, version } = {}) {
  add(
    common.CATALOG,
    `<${iri(`sources/${key}`)}> ont:sourceKey ${JSON.stringify(key)} ;
      ont:namedGraph <${iri(`graphs/${key}`)}> ;
      ont:republishable ${cleared} ;
      dcterms:title ${JSON.stringify(`${key} source`)} ;
      dcterms:license <https://example.org/license/${key}>
      ${version ? `; dcterms:hasVersion ${JSON.stringify(version)}` : ""}
      ${mirror ? `; ont:mirrorOf <${iri("original")}>` : ""} .`
  )
}
function describe(key, name, label, definition) {
  add(
    common.DEFS,
    `<${iri(`entries/${key}/${name}`)}> ont:entity <${iri(name)}> ;
      ont:sourceKey ${JSON.stringify(key)} ;
      ont:fromSource <${iri(`sources/${key}`)}> ;
      ont:label ${JSON.stringify(label)}
      ${definition ? `; ont:definition ${JSON.stringify(definition)}` : ""} .`
  )
}
function triple(key, subject, predicate, object) {
  add(iri(`graphs/${key}`), `<${iri(subject)}> ${predicate} ${object} .`)
}
function entity(key, name, label, type = "owl:Class", definition) {
  describe(key, name, label, definition)
  triple(key, name, "a", type)
}

source("alpha", { version: "1.0" })
source("beta", { version: "2.0" })
source("nist")
source("private", { cleared: false })
source("mirror", { mirror: true })
source("private-mirror", { cleared: false, mirror: true })

entity("alpha", "material", "Material")
entity("alpha", "grain", "Grain")
entity("alpha", "rdfs-grain", "grain class", "rdfs:Class")
entity("alpha", "word-start", "grain phase")
entity("alpha", "word-end", "solid grain")
entity("alpha", "word-punctuation", "(grain)")
entity("alpha", "substring-start", "micrograin")
entity("alpha", "substring-end", "grains")
entity("alpha", "substring-both", "micrograins")
entity("alpha", "definition-only", "unrelated label", "owl:Class", "grain")
entity("alpha", "property", "grain", "rdf:Property")
entity("alpha", "object-property", "grain", "owl:ObjectProperty")
entity("alpha", "datatype-property", "grain", "owl:DatatypeProperty")
entity("alpha", "individual", "grain", "owl:NamedIndividual")
describe("alpha", "untyped", "grain")
triple("alpha", "unindexed", "a", "owl:Class")
triple("alpha", "unindexed", "rdfs:label", '"grain"')
// A description and type in different sources do not make a candidate.
describe("alpha", "wrong-source-type", "grain")
triple("beta", "wrong-source-type", "a", "owl:Class")

// Enough early-sorting alpha results to expose a global candidate limit.
for (let index = 0; index < 21; index += 1) {
  entity("alpha", `crowded-${index}`, `material item ${index}`)
}
entity("beta", "beta-material", "MATERIAL")
entity("beta", "beta-material-phrase", "other material")
// NIST-like SKOS entries need a label and type, but no definition/version.
entity("nist", "nist-material", "material concept", "skos:Concept")
for (const key of ["private", "mirror", "private-mirror"]) {
  entity(key, `${key}-material`, "material")
}
entity("alpha", "water", "  WaTeR  ")
entity("alpha", "water-absorption", "water absorption")
entity("alpha", "iron-three", "Fe(III)")
entity("alpha", "iron-three-unpunctuated", "FeIII")
entity("alpha", "iron-two", "Fe(II)")
entity("alpha", "iron-three-oxide", "Fe(III) oxide")
// Java lowercases a capital sigma by the word around it, and JavaScript by
// another rule: Jena's LCASE gives α1ς and ασ1β zz where JavaScript gives
// α1σ and ας1β zz, which would tie the last two labels.
entity("beta", "sigma-final", "Α1Σ")
entity("beta", "sigma-a", "ΑΣ1Β zz")
entity("beta", "sigma-b", "ας1β zz")

// Shared IRIs have independent labels and direct parents in each source.
entity("alpha", "shared", "Alpha shared")
entity("beta", "shared", "Beta shared")
entity("alpha", "alpha-parent", "Alpha parent")
entity("beta", "beta-parent", "Beta parent")
entity("alpha", "common-parent", "Alpha common parent")
entity("beta", "common-parent", "Beta common parent")
entity("alpha", "broader-parent", "Broader parent", "skos:Concept")
entity("alpha", "narrower-parent", "Narrower parent", "skos:Concept")
entity("beta", "unlabelled-parent", "Label available only in beta")
entity("alpha", "leaf", "Leaf")
entity("beta", "beta-only", "Only indexed in beta")
triple("alpha", "beta-only", "a", "owl:Class")
for (const parent of ["alpha-parent", "common-parent", "unlabelled-parent"]) {
  triple("alpha", "shared", "rdfs:subClassOf", `<${iri(parent)}>`)
}
for (const parent of ["beta-parent", "common-parent"]) {
  triple("beta", "shared", "rdfs:subClassOf", `<${iri(parent)}>`)
}
triple("alpha", "shared", "skos:broader", `<${iri("broader-parent")}>`)
triple("alpha", "narrower-parent", "skos:narrower", `<${iri("shared")}>`)
triple(
  "alpha",
  "shared",
  "rdfs:subClassOf",
  "[ a owl:Restriction ; owl:onProperty <https://example.org/property> ]"
)
triple("alpha", "alpha-parent", "rdfs:subClassOf", `<${iri("grandparent")}>`)
triple("alpha", "child", "rdfs:subClassOf", `<${iri("shared")}>`)
triple("alpha", "shared", "skos:narrower", `<${iri("narrower-child")}>`)
triple("alpha", "shared", "skos:broaderTransitive", `<${iri("transitive")}>`)
triple("uncatalogued", "shared", "rdfs:subClassOf", `<${iri("rogue")}>`)
add(
  inferredGraphFor("alpha"),
  `<${iri("shared")}> rdfs:subClassOf <${iri("inferred-parent")}> .`
)

entity("alpha", "many-parents", "Many parents")
for (let index = 0; index < 52; index += 1) {
  const name = `parent-${String(index).padStart(2, "0")}`
  entity("alpha", name, `Parent ${index}`)
  triple("alpha", "many-parents", "rdfs:subClassOf", `<${iri(name)}>`)
}
triple("alpha", "many-parents", "rdfs:subClassOf", "[ a owl:Class ]")

const originalFetch = globalThis.fetch
const work = await mkdtemp(join(tmpdir(), "matsci-ont-preview-test-"))
let requests = 0
try {
  // Fail locally if the pinned tools are absent instead of downloading.
  globalThis.fetch = async () => {
    throw new Error("Preview tests require the already-installed Jena tools")
  }
  const environment = await jenaEnvironment()
  environment.env.JVM_ARGS = "-Xmx256m"
  const dataPath = join(work, "preview.trig")
  await writeFile(
    dataPath,
    `@prefix ont: <${common.ONT}> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <${rdfs}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix skos: <${skos}> .
${[...dataset]
  .map(([graph, triples]) => `<${graph}> {\n${triples.join("\n")}\n}`)
  .join("\n")}`
  )
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, "POST")
    assert.equal(typeof options.body, "string")
    const queryPath = join(work, `query-${++requests}.rq`)
    await writeFile(queryPath, options.body)
    // The lookup index streams its rows as TSV; everything else is JSON.
    const tsv = options.headers?.Accept === "text/tab-separated-values"
    const result = runJena(environment, "arq", [
      `--data=${dataPath}`,
      `--query=${queryPath}`,
      `--results=${tsv ? "TSV" : "JSON"}`
    ])
    assert.equal(result.status, 0, result.stderr)
    return new Response(result.stdout, {
      headers: {
        "Content-Type": tsv
          ? "text/tab-separated-values"
          : "application/sparql-results+json"
      }
    })
  }

  // Every answer the suite asserts on, in order, for comparing two runs.
  let record = (answer) => answer
  const find = async (...args) => record(await findCandidates(...args))
  const hierarchy = async (...args) => record(await getHierarchy(...args))

  const suite = async () => {
    // Invalid request shapes fail without invoking the store at all.
    const requestsBefore = requests
    for (const q of [undefined, null, 42, {}, "", " \n ", "x".repeat(201)]) {
      await assert.rejects(() => findCandidates(q), RejectedInput)
    }
    for (const limitPerSource of [0, -1, 1.5, 21, "2"]) {
      await assert.rejects(
        () => findCandidates("material", { limitPerSource }),
        RejectedInput
      )
    }
    for (const mode of [null, "", "EXACT", "contains", true, 2, {}]) {
      await assert.rejects(
        () => findCandidates("material", { mode }),
        RejectedInput
      )
    }
    for (const source of [undefined, "", "UPPER", "alpha> }", 2]) {
      await assert.rejects(
        () => getHierarchy(iri("shared"), { source }),
        RejectedInput
      )
    }
    for (const invalidIri of [
      undefined,
      "not-an-iri",
      "https://example.org/> }",
      "x".repeat(2049)
    ]) {
      await assert.rejects(
        () => getHierarchy(invalidIri, { source: "alpha" }),
        RejectedInput
      )
    }
    assert.equal(
      requests,
      requestsBefore,
      "request guards run before any store query"
    )

    // The no-source fast path also identifies the requested match mode.
    const fixtureFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ head: { vars: [] }, results: { bindings: [] } })
      )
    try {
      for (const mode of ["exact", "similar"]) {
        assert.deepEqual(await find("material", { mode }), {
          query: "material",
          mode,
          sources: []
        })
      }
    } finally {
      globalThis.fetch = fixtureFetch
    }
    assert.notEqual(
      lookupIndexStatus().state,
      "loading",
      "the no-source fast path starts no index load"
    )

    // Exact is the default. Case and surrounding whitespace do not change
    // equality, but a longer label remains a different candidate.
    const water = await find("  water  ")
    assert.equal(water.query, "water")
    assert.equal(water.mode, "exact")
    assert.equal(water.sources.length, 1)
    assert.deepEqual(water.sources[0].candidates, [
      { iri: iri("water"), label: "  WaTeR  ", match: "exact" }
    ])
    assert.equal(water.sources[0].truncated, false)
    const similarWater = await find("water", { mode: "similar" })
    assert.equal(similarWater.mode, "similar")
    assert.equal(similarWater.sources.length, 1)
    assert.deepEqual(similarWater.sources[0].candidates, [
      {
        iri: iri("water-absorption"),
        label: "water absorption",
        match: "label"
      }
    ])
    assert.equal(similarWater.sources[0].truncated, false)

    const iron = await find("fe(iii)", { mode: "exact" })
    assert.equal(iron.mode, "exact")
    assert.deepEqual(
      iron.sources.flatMap((group) => group.candidates),
      [{ iri: iri("iron-three"), label: "Fe(III)", match: "exact" }]
    )
    const similarIron = await find("Fe(III)", { mode: "similar" })
    assert.equal(similarIron.mode, "similar")
    assert.deepEqual(
      similarIron.sources.flatMap((group) => group.candidates),
      [{ iri: iri("iron-three-oxide"), label: "Fe(III) oxide", match: "label" }]
    )

    // Exact labels and candidate order follow Jena's LCASE.
    const sigma = await find("α1ς", { mode: "exact" })
    assert.deepEqual(
      sigma.sources.flatMap((group) => group.candidates),
      [{ iri: iri("sigma-final"), label: "Α1Σ", match: "exact" }]
    )
    assert.deepEqual((await find("α1σ", { mode: "exact" })).sources, [])
    const sigmaOrder = await find("zz", { mode: "similar", limitPerSource: 1 })
    assert.deepEqual(
      sigmaOrder.sources.map((group) => [
        group.candidates.map((candidate) => candidate.label),
        group.truncated
      ]),
      [[["ας1β zz"], true]]
    )

    // Broad matches cannot consume the exact mode's cap or sentinel.
    const exactMaterial = await find("material", { limitPerSource: 1 })
    assert.equal(exactMaterial.mode, "exact")
    assert.deepEqual(
      exactMaterial.sources.map((group) => [
        group.source.key,
        group.candidates,
        group.truncated
      ]),
      [
        [
          "alpha",
          [{ iri: iri("material"), label: "Material", match: "exact" }],
          false
        ],
        [
          "beta",
          [{ iri: iri("beta-material"), label: "MATERIAL", match: "exact" }],
          false
        ]
      ]
    )

    const defaults = await find("  material  ", { mode: "similar" })
    assert.equal(defaults.query, "material")
    assert.equal(defaults.mode, "similar")
    const defaultGroups = new Map(
      defaults.sources.map((group) => [group.source.key, group])
    )
    assert.deepEqual([...defaultGroups.keys()].sort(), [
      "alpha",
      "beta",
      "nist"
    ])
    assert.equal(defaultGroups.get("alpha").candidates.length, 5)
    assert.equal(defaultGroups.get("alpha").truncated, true)
    assert.equal(defaultGroups.get("beta").candidates.length, 1)
    assert.equal(defaultGroups.get("beta").truncated, false)
    assert.deepEqual(defaultGroups.get("nist"), {
      source: {
        key: "nist",
        title: "nist source",
        license: "https://example.org/license/nist"
      },
      candidates: [
        { iri: iri("nist-material"), label: "material concept", match: "label" }
      ],
      truncated: false
    })
    assert.deepEqual(defaultGroups.get("alpha").source, {
      key: "alpha",
      title: "alpha source",
      version: "1.0",
      license: "https://example.org/license/alpha"
    })
    assert.deepEqual(defaultGroups.get("beta").candidates[0], {
      iri: iri("beta-material-phrase"),
      label: "other material",
      match: "label"
    })
    for (const group of defaults.sources) {
      assert.equal(
        group.candidates.every((candidate) => candidate.match === "label"),
        true
      )
      assert.equal(
        group.candidates.some(
          (candidate) =>
            candidate.iri === iri("material") ||
            candidate.iri === iri("beta-material")
        ),
        false
      )
    }

    const small = await find("material", {
      mode: "similar",
      limitPerSource: 2
    })
    assert.equal(small.mode, "similar")
    for (const group of small.sources) {
      assert.equal(
        group.candidates.length,
        group.source.key === "alpha" ? 2 : 1
      )
      assert.equal(group.truncated, group.source.key === "alpha")
    }
    const large = await find("material", {
      mode: "similar",
      limitPerSource: 20
    })
    assert.equal(large.mode, "similar")
    assert.equal(
      large.sources.find((group) => group.source.key === "alpha").candidates
        .length,
      20
    )
    assert.equal(
      large.sources.find((group) => group.source.key === "alpha").truncated,
      true
    )

    // A distinctive term keeps whole-word and entity-type checks below the
    // per-source cap while the earlier query tests heavily crowded sources.
    const exactGrain = await find("grain")
    assert.equal(exactGrain.mode, "exact")
    assert.deepEqual(
      exactGrain.sources.flatMap((group) => group.candidates),
      [{ iri: iri("grain"), label: "Grain", match: "exact" }]
    )
    const words = await find("grain", {
      mode: "similar",
      limitPerSource: 20
    })
    assert.equal(words.mode, "similar")
    assert.equal(words.sources.length, 1)
    assert.equal(words.sources[0].source.key, "alpha")
    assert.equal(words.sources[0].truncated, false)
    assert.deepEqual(
      words.sources[0].candidates
        .map((candidate) => [candidate.iri, candidate.label, candidate.match])
        .sort(),
      [
        [iri("rdfs-grain"), "grain class", "label"],
        [iri("word-start"), "grain phase", "label"],
        [iri("word-end"), "solid grain", "label"],
        [iri("word-punctuation"), "(grain)", "label"]
      ].sort(),
      "both word boundaries, indexed types, and source-specific typing constrain label matches"
    )
    const absent = await find("no matching term")
    assert.deepEqual(absent, {
      query: "no matching term",
      mode: "exact",
      sources: []
    })
    const similarAbsent = await find("no matching term", {
      mode: "similar"
    })
    assert.deepEqual(similarAbsent, {
      query: "no matching term",
      mode: "similar",
      sources: []
    })

    const alpha = await hierarchy(iri("shared"), { source: "alpha" })
    assert.deepEqual(alpha.source, defaultGroups.get("alpha").source)
    assert.deepEqual(alpha.entity, {
      iri: iri("shared"),
      label: "Alpha shared"
    })
    assert.equal(alpha.truncated, false)
    assert.equal(alpha.hasAnonymousSuperclasses, true)
    assert.deepEqual(
      alpha.parents
        .map((parent) => ({ ...parent, label: parent.label }))
        .sort((a, b) => a.iri.localeCompare(b.iri)),
      [
        {
          iri: iri("alpha-parent"),
          label: "Alpha parent",
          predicate: `${rdfs}subClassOf`,
          direction: "outgoing"
        },
        {
          iri: iri("common-parent"),
          label: "Alpha common parent",
          predicate: `${rdfs}subClassOf`,
          direction: "outgoing"
        },
        {
          iri: iri("unlabelled-parent"),
          label: undefined,
          predicate: `${rdfs}subClassOf`,
          direction: "outgoing"
        },
        {
          iri: iri("broader-parent"),
          label: "Broader parent",
          predicate: `${skos}broader`,
          direction: "outgoing"
        },
        {
          iri: iri("narrower-parent"),
          label: "Narrower parent",
          predicate: `${skos}narrower`,
          direction: "incoming"
        }
      ].sort((a, b) => a.iri.localeCompare(b.iri))
    )
    const beta = await hierarchy(iri("shared"), { source: "beta" })
    assert.deepEqual(beta.entity, { iri: iri("shared"), label: "Beta shared" })
    assert.equal(beta.hasAnonymousSuperclasses, false)
    assert.equal(beta.truncated, false)
    assert.deepEqual(
      beta.parents.map((parent) => [parent.iri, parent.label]).sort(),
      [
        [iri("beta-parent"), "Beta parent"],
        [iri("common-parent"), "Beta common parent"]
      ].sort()
    )
    const leaf = await hierarchy(iri("leaf"), { source: "alpha" })
    assert.deepEqual(leaf.parents, [])
    assert.equal(leaf.hasAnonymousSuperclasses, false)
    assert.equal(leaf.truncated, false)
    const concept = await hierarchy(iri("nist-material"), { source: "nist" })
    assert.deepEqual(concept.entity, {
      iri: iri("nist-material"),
      label: "material concept"
    })
    assert.deepEqual(concept.parents, [])

    const many = await hierarchy(iri("many-parents"), { source: "alpha" })
    assert.equal(many.parents.length, 50)
    assert.equal(new Set(many.parents.map((parent) => parent.iri)).size, 50)
    assert.equal(many.truncated, true)
    assert.equal(many.hasAnonymousSuperclasses, true)
    for (const parent of many.parents) {
      assert.match(parent.iri, /\/parent-\d\d$/)
      assert.equal(parent.predicate, `${rdfs}subClassOf`)
      assert.equal(parent.direction, "outgoing")
    }

    for (const source of ["unknown", "private", "mirror", "private-mirror"]) {
      await assert.rejects(
        () => getHierarchy(iri(`${source}-material`), { source }),
        RejectedInput
      )
    }
    for (const name of [
      "missing",
      "property",
      "individual",
      "untyped",
      "unindexed",
      "beta-only",
      "wrong-source-type"
    ]) {
      await assert.rejects(
        () => getHierarchy(iri(name), { source: "alpha" }),
        RejectedInput
      )
    }
  }

  const withoutIndex = []
  record = (answer) => (withoutIndex.push(answer), answer)
  await suite()
  assert.equal(lookupIndexStatus().state, "idle")
  assert.equal(lookupIndexStatus().answered, 0, "the first run used SPARQL")

  configureLookupIndex({ loader: inThreadLoader })
  const index = await loadLookupIndex()
  assert.ok(index, "the lookup index loads from the fixture")
  assert.deepEqual(
    index.sources.map((source) => source.key),
    ["alpha", "beta", "mirror", "nist"],
    "cleared sources only"
  )
  const { fallbacks } = lookupIndexStatus()
  const withIndex = []
  record = (answer) => (withIndex.push(answer), answer)
  await suite()
  assert.ok(lookupIndexStatus().answered > 0)
  assert.equal(
    lookupIndexStatus().fallbacks,
    fallbacks,
    "the index answered every candidate search in the second run"
  )
  assert.deepEqual(withIndex, withoutIndex)

  console.log(
    "OK: preview candidates and direct hierarchy retain source scope, caps, and guards, with and without the lookup index"
  )
} finally {
  resetLookupIndex()
  globalThis.fetch = originalFetch
  await rm(work, { recursive: true, force: true })
}
