// What the store endpoint refuses to be.
//
// Both of these are about the surface the server offers rather than the
// data it holds, and both have already been wrong once: the launcher
// started the full Fuseki, whose admin API takes no credential and will
// create a dataset on request.

export async function checkEndpoint(context) {
  await checkNoFederation(context)
  await checkNoAdminSurface(context)
}

// Federated query is closed, so a SERVICE clause cannot make the store
// fetch a URL for whoever sent the query.
async function checkNoFederation({ record, ask }) {
  const answer = await ask("service-probe", {})
  record(
    "a SERVICE clause is refused",
    !answer.ok,
    answer.ok ? "the query was accepted" : `refused with HTTP ${answer.status}`
  )
}

// The reviewed host unit selects the entry point without a web UI or an
// admin API, and so must the local runner: otherwise development runs a
// service the served policy forbids.
async function checkNoAdminSurface({ record, server }) {
  const origin = new URL(server.base).origin
  const answered = []
  for (const [path, method] of [
    ["/", "GET"],
    ["/$/server", "GET"],
    ["/$/datasets", "GET"]
  ]) {
    const response = await fetch(`${origin}${path}`, { method }).catch(
      () => null
    )
    if (response?.ok)
      answered.push(`${method} ${path} answered ${response.status}`)
  }
  record(
    "no web UI and no admin API are served",
    answered.length === 0,
    answered.length > 0
      ? answered.join("\n")
      : "root and admin paths all refused"
  )
}
