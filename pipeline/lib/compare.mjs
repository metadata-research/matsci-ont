// Compares two TDB2 stores built from the same manifest.
//
// TDB2 directories are not byte-stable and blank node labels are minted per
// parser run, so byte comparison is impossible and label comparison is
// meaningless. Three tiers, cheapest first, each strictly stronger than the
// one above it:
//
//   1 per-graph quad counts     localizes which graph moved
//   2 blank-node-blinded hash   catches a changed value hanging off a bnode
//   3 per-graph isomorphism     the actual gate, blank-node aware
//
// Tier 2 alone is not sufficient and tier 1 is much weaker still: a store
// where owl:minCardinality "2" became "3" inside a restriction keeps every
// count and can keep a ground-quad hash, while tier 3 catches it. In these
// ontologies the axioms live inside blank nodes, which is exactly where the
// weaker tiers are blind.

import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { runJena } from "../../shared/tools.mjs"

const DEFAULT_GRAPH = "urn:x-arq:DefaultGraph"

// A bare GRAPH ?g pattern silently omits the default graph, so a source that
// loaded into the wrong place would not appear at all.
export const COUNT_QUERY = `SELECT ?g (COUNT(*) AS ?n)
WHERE {
  { GRAPH ?g { ?s ?p ?o } }
  UNION
  { ?s ?p ?o BIND(<${DEFAULT_GRAPH}> AS ?g) }
}
GROUP BY ?g ORDER BY ?g`

// Replaces every blank node label with one placeholder. Scans quoted spans so
// a literal containing "_:" is left alone; a naive replace would drop or
// rewrite real data.
export function blindBlankNodes(line) {
  let out = ""
  let inQuote = false
  let i = 0
  while (i < line.length) {
    const character = line[i]
    if (inQuote) {
      out += character
      if (character === "\\") {
        out += line[i + 1] ?? ""
        i += 2
        continue
      }
      if (character === '"') inQuote = false
      i += 1
      continue
    }
    if (character === '"') {
      inQuote = true
      out += character
      i += 1
      continue
    }
    if (character === "_" && line[i + 1] === ":") {
      out += "_:_"
      i += 2
      while (i < line.length && /[A-Za-z0-9_.-]/.test(line[i])) i += 1
      continue
    }
    out += character
    i += 1
  }
  return out
}

// Always queries by location. An assembler with unionDefaultGraph would
// report the union as the default graph and inflate every total.
export async function graphCounts(environment, location, workDirectory) {
  await mkdir(workDirectory, { recursive: true })
  const queryPath = join(workDirectory, "graph-counts.rq")
  await writeFile(queryPath, `${COUNT_QUERY}\n`)

  const result = runJena(environment, "tdb2.tdbquery", [
    `--loc=${location}`,
    "--results=CSV",
    `--query=${queryPath}`
  ])
  if (result.status !== 0)
    throw new Error(`count query failed\n${result.stderr}`)

  const counts = new Map()
  for (const line of result.stdout.trim().split("\n").slice(1)) {
    const comma = line.lastIndexOf(",")
    if (comma < 0) continue
    counts.set(line.slice(0, comma), Number(line.slice(comma + 1)))
  }
  return counts
}

export function dumpBlinded(environment, location) {
  const dump = runJena(environment, "tdb2.tdbdump", [`--loc=${location}`])
  if (dump.status !== 0) throw new Error(`tdbdump failed\n${dump.stderr}`)
  const lines = dump.stdout.split("\n").filter((line) => line.trim() !== "")
  const blinded = lines.map(blindBlankNodes).sort()
  return {
    quads: lines.length,
    hash: createHash("sha256").update(blinded.join("\n")).digest("hex")
  }
}

// Blank-node-aware graph isomorphism, the only tier that proves equivalence.
// rdfcompare loads both graphs into memory and answers 0 equal, 1 unequal.
export async function graphsIsomorphic(
  environment,
  graph,
  locationA,
  locationB,
  workDirectory
) {
  await mkdir(workDirectory, { recursive: true })
  const construct =
    graph === DEFAULT_GRAPH
      ? "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"
      : `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`
  const queryFilePath = join(workDirectory, "construct.rq")
  await writeFile(queryFilePath, `${construct}\n`)

  const sides = []
  for (const [name, location] of [
    ["a", locationA],
    ["b", locationB]
  ]) {
    // tdb2.tdbquery emits Turtle for CONSTRUCT whatever --results says.
    const result = runJena(environment, "tdb2.tdbquery", [
      `--loc=${location}`,
      `--query=${queryFilePath}`
    ])
    if (result.status !== 0)
      throw new Error(`construct failed for ${graph}\n${result.stderr}`)
    const path = join(workDirectory, `${name}.ttl`)
    await writeFile(path, result.stdout)
    sides.push(path)
  }

  const comparison = runJena(environment, "rdfcompare", [
    ...sides,
    "TURTLE",
    "TURTLE"
  ])
  if (comparison.status === 0) return { equal: true }
  if (comparison.status === 1)
    return { equal: false, detail: comparison.stdout.trim() }
  throw new Error(
    `rdfcompare errored on ${graph} (exit ${comparison.status})\n${comparison.stderr}`
  )
}
