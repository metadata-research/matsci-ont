// That a source nobody has cleared cannot reach a published store.
//
// A source not cleared for publication may sit in a workstation store; what
// must not happen is a publication build that carries it anyway. This runs
// the real build with --publication over exactly the uncleared sources and
// requires each one to be named as excluded, because an earlier version
// refused the whole build instead, which meant no publishable store could
// be produced at all and the refusal read as safety.

import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { ROOT } from "../../../shared/paths.mjs"

export function checkPublication({
  record,
  fullManifest,
  excluded,
  publication,
  counts
}) {
  // A publication store must hold nothing it excluded. The other checks
  // judge it against what it was built to hold; this one judges the rest.
  if (publication) {
    const present = fullManifest.filter(
      (entry) =>
        excluded.has(entry.key) && (counts.get(entry.graphIri) ?? 0) > 0
    )
    record(
      "this publication build holds no source it excluded",
      present.length === 0,
      present.length > 0
        ? `present: ${present.map((e) => e.key).join(", ")}`
        : `${excluded.size} excluded, none present`
    )
  }

  const notCleared = fullManifest.filter((entry) => !entry.republishable)
  if (notCleared.length === 0) return

  const attempt = spawnSync(
    process.execPath,
    [
      join(ROOT, "pipeline/ingest.mjs"),
      "--publication",
      "--no-swap",
      "--reuse-mirror",
      `--only=${notCleared.map((entry) => entry.key).join(",")}`
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }
  )
  const excludedAll = notCleared.every((entry) =>
    new RegExp(
      `${entry.key}[\\s\\S]{0,120}excluded from a publication build`
    ).test(attempt.stderr)
  )
  record(
    "a publication build leaves out every source that is not cleared",
    excludedAll,
    excludedAll
      ? `${notCleared.length} excluded`
      : `not all of ${notCleared.map((e) => e.key).join(", ")} were excluded`
  )
}
