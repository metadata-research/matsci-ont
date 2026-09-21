// That a second build from the same manifest produces the same store.
//
// Three tiers, because the cheap ones do not settle it. Counts miss a
// changed value inside a blank node, which is where an OWL axiom actually
// is; a blank-node-blinded hash misses the same values attached to
// different subjects. Per-graph isomorphism is the gate, and the first two
// tiers are kept because when they disagree they say where to look.

import { spawnSync } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { hashFile } from "../../../shared/tools.mjs"
import { ROOT, STORE, STAGING } from "../../../shared/paths.mjs"
import { extensionFor } from "../manifest.mjs"
import { graphCounts, dumpBlinded, graphsIsomorphic } from "../compare.mjs"

export async function checkDeterminism({
  record,
  environment,
  manifest,
  publication,
  counts,
  work
}) {
  await checkMirrorsUnchanged({ record, manifest })

  await rm(STAGING, { recursive: true, force: true })
  const rebuild = spawnSync(
    process.execPath,
    // Reuses the mirrored documents the first build fetched: the point of
    // this comparison is whether the pipeline is deterministic, not whether
    // a publisher re-projected its dataset in between.
    [
      join(ROOT, "pipeline/ingest.mjs"),
      "--no-swap",
      "--reuse-mirror",
      ...(publication ? ["--publication"] : [])
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }
  )
  if (rebuild.status !== 0) {
    record(
      "a second run describes the same graphs",
      false,
      `rebuild failed\n${rebuild.stderr}`
    )
    return
  }

  const second = await graphCounts(environment, STAGING, work)
  const differences = []
  for (const graph of new Set([...counts.keys(), ...second.keys()])) {
    const before = counts.get(graph) ?? 0
    const after = second.get(graph) ?? 0
    if (before !== after) differences.push(`${graph}: ${before} then ${after}`)
  }
  record(
    "tier 1, per-graph counts match",
    differences.length === 0,
    differences.join("\n") || `${counts.size} graphs`
  )

  const firstDump = await dumpBlinded(environment, STORE)
  const secondDump = await dumpBlinded(environment, STAGING)
  const same = firstDump.hash === secondDump.hash
  record(
    "tier 2, blank-node-blinded hashes match",
    same,
    same
      ? `${firstDump.quads.toLocaleString()} quads, ${firstDump.hash.slice(0, 16)}`
      : `${firstDump.hash.slice(0, 16)} then ${secondDump.hash.slice(0, 16)}`
  )

  const notIsomorphic = []
  for (const graph of [...counts.keys()].sort()) {
    const comparison = await graphsIsomorphic(
      environment,
      graph,
      STORE,
      STAGING,
      join(work, "iso")
    )
    if (!comparison.equal) notIsomorphic.push(graph)
  }
  record(
    "tier 3, every graph is isomorphic",
    notIsomorphic.length === 0,
    notIsomorphic.length > 0
      ? `not isomorphic: ${notIsomorphic.join(", ")}`
      : `${counts.size} graphs equal modulo blank node labels`
  )

  await rm(STAGING, { recursive: true, force: true })
}

// A store built before the mirrored documents were last fetched would
// differ from a rebuild for a reason that has nothing to do with this
// pipeline. Saying so is more use than reporting it as non-determinism.
async function checkMirrorsUnchanged({ record, manifest }) {
  const report = JSON.parse(
    await readFile(join(ROOT, "build/ingest-report.json"), "utf8").catch(
      () => "{}"
    )
  )
  const stale = []
  for (const [key, digest] of Object.entries(report.mirrorDigests ?? {})) {
    const entry = manifest.find((e) => e.key === key)
    if (!entry) continue
    const path = join(
      ROOT,
      "cache/mirror",
      `${key}.${extensionFor(entry?.format ?? "ttl")}`
    )
    const current = await hashFile(path, "sha256").catch(() => undefined)
    if (current !== digest) stale.push(key)
  }
  if (stale.length > 0) {
    record(
      "the store was built from the mirrored documents now in the cache",
      false,
      `${stale.join(", ")} changed since this store was built. Run pnpm ingest, then compare.`
    )
  }
}
