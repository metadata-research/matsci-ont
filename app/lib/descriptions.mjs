// An index record owns one source's description, even when another source
// describes the same publisher entity. Never merge fields across records.
import { RejectedInput, checkKey } from "./terms.mjs"

export function descriptionsFrom(rows) {
  return rows
    .map((row) => ({
      sourceKey: row.key.value,
      sourceVersion: row.version.value,
      license: row.license.value,
      label: row.label.value,
      definition: row.definition?.value,
      definitionProperty: row.definitionProperty?.value
    }))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
}

export function chooseDescription(descriptions, sourceKey) {
  if (sourceKey === undefined) return descriptions[0]
  checkKey(sourceKey)
  const chosen = descriptions.find((entry) => entry.sourceKey === sourceKey)
  if (!chosen)
    throw new RejectedInput("This source does not describe the entity.")
  return chosen
}
