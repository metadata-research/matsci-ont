// Reports every problem with the manifest, rather than stopping at the
// first. The rules themselves are in pipeline/lib/manifest.mjs, where the
// ingest applies them too, so this command and the build cannot disagree
// about what a valid entry is.
//
//   node pipeline/check-manifest.mjs

import { loadManifest } from "./lib/manifest.mjs"

const { entries, problems } = await loadManifest({ check: false })

if (entries.length === 0) {
  console.error("manifest/ holds no entries")
  process.exit(1)
}

if (problems.length > 0) {
  console.error(`FAIL: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

for (const entry of entries) {
  console.log(
    `${entry.key.padEnd(16)} ${(entry.version ?? "mirror").padEnd(10)} ` +
      `${entry.license.padEnd(14)} republishable=${entry.republishable} ${entry.format}`
  )
}
console.log(`OK: ${entries.length} entries`)
