// Search across the definitions index, grouped by source.

import { regexLiteral, literal } from "../lib/terms.mjs"
import { select } from "../lib/store.mjs"
import { escape, layout, termLink, licenseLink } from "../lib/html.mjs"
import { common } from "../lib/substitutions.mjs"
import { catalogueRows } from "./common.mjs"

export async function searchPage(q) {
  const query = (q ?? "").trim().slice(0, 200)
  if (!query)
    return layout("Search", "<h1>Search</h1><p>Type a term above.</p>")
  const rows = await select("search", {
    ...common,
    TEXT: literal(query),
    REGEX: regexLiteral(query)
  })

  const byKey = new Map()
  for (const row of rows) {
    if (!byKey.has(row.key.value)) byKey.set(row.key.value, [])
    byKey.get(row.key.value).push(row)
  }
  const catalogue = new Map(
    (await catalogueRows()).map((row) => [row.key.value, row])
  )
  const sections = [...byKey.entries()]
    .map(
      ([
        key,
        hits
      ]) => `<h2>${escape(catalogue.get(key)?.title.value ?? key)}</h2>
${
  catalogue.get(key)?.mirrorOf
    ? `<p class="mark">Mirrored from MatSci-SAM, licence ${licenseLink(
        catalogue.get(key)?.license.value ?? ""
      )}.</p>`
    : `<p class="mark">${licenseLink(catalogue.get(key)?.license.value ?? "")}</p>`
}
<ul>${hits
        .map(
          (row) =>
            `<li>${termLink(row.s.value, row.label.value, false, key)}${
              row.definition
                ? `<span class="mark">: ${escape(row.definition.value.slice(0, 200))}</span>`
                : ""
            }</li>`
        )
        .join("\n")}</ul>`
    )
    .join("\n")
  // The query caps at 200, so a full page of results may not be all of them.
  const overflow =
    rows.length >= 200 ? "<p>Only the first 200 results are shown.</p>" : ""
  return layout(
    `Search: ${query}`,
    `<h1>Search</h1>
<p>${rows.length} result(s) for <strong>${escape(query)}</strong>, matched on word boundaries.</p>
${overflow}
${sections || "<p>Nothing matched.</p>"}`
  )
}
