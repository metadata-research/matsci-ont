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

import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { createReadStream, openSync, closeSync } from "node:fs"
import { createInterface } from "node:readline"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createWriteStream } from "node:fs"
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

// Database exports can exceed spawnSync's buffer and Node's string limit.
// Spool them to disk, blind a line at a time, and use a bounded external sort.
// The final digest includes newlines and retains duplicate blinded quads.
function exportToFile(environment, tool, args, path) {
  const fd = openSync(path, "w")
  try {
    const result = runJena(environment, tool, args, {
      stdio: ["ignore", fd, "pipe"]
    })
    if (result.status !== 0) throw new Error(`${tool} failed\n${result.stderr}`)
  } finally {
    closeSync(fd)
  }
}

export async function dumpBlinded(environment, location) {
  const work = await mkdtemp(join(tmpdir(), "matsci-ont-compare-"))
  try {
    const dumpPath = join(work, "dump.nq")
    const blindPath = join(work, "blinded.nq")
    const sortedPath = join(work, "sorted.nq")
    exportToFile(environment, "tdb2.tdbdump", [`--loc=${location}`], dumpPath)
    let quads = 0
    async function* blindedLines() {
      const lines = createInterface({
        input: createReadStream(dumpPath),
        crlfDelay: Infinity
      })
      for await (const line of lines) {
        if (!line.trim()) continue
        quads += 1
        yield `${blindBlankNodes(line)}\n`
      }
    }
    await pipeline(Readable.from(blindedLines()), createWriteStream(blindPath))
    const sorted = spawnSync(
      "sort",
      ["-S", "64M", "-T", work, "-o", sortedPath, blindPath],
      {
        env: { ...process.env, LC_ALL: "C" },
        encoding: "utf8"
      }
    )
    if (sorted.error) throw sorted.error
    if (sorted.status !== 0) throw new Error(`sort failed\n${sorted.stderr}`)
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(sortedPath)) hash.update(chunk)
    return { quads, hash: hash.digest("hex") }
  } finally {
    await rm(work, { recursive: true, force: true })
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
    const path = join(workDirectory, `${name}.ttl`)
    exportToFile(
      environment,
      "tdb2.tdbquery",
      [`--loc=${location}`, `--query=${queryFilePath}`],
      path
    )
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
