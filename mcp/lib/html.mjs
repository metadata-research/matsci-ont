// HTML rendering: escaping and the shared page layout. Every dynamic value
// passes through escape() or attr() on its way into markup.

export function escape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const attr = escape;

export function entityUrl(iri, inferred) {
  return `/entity?iri=${encodeURIComponent(iri)}${inferred ? "&inferred=1" : ""}`;
}

// The readable tail of an IRI. A trailing slash is dropped first, so a
// namespace IRI such as https://w3id.org/pmd/co/ shortens to "co" instead
// of falling back to the whole IRI.
export function localName(iri) {
  const trimmed = iri.endsWith("/") ? iri.slice(0, -1) : iri;
  const cut = Math.max(trimmed.lastIndexOf("#"), trimmed.lastIndexOf("/"));
  return cut >= 0 && cut < trimmed.length - 1 ? trimmed.slice(cut + 1) : trimmed;
}

export function termLink(iri, label, inferred) {
  return `<a href="${attr(entityUrl(iri, inferred))}" title="${attr(iri)}">${escape(label ?? localName(iri))}</a>`;
}

export function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} - MatSci-ONT</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header>
<nav>
<a class="brand" href="/">MatSci-ONT</a>
<form action="/search" method="get">
<input type="search" name="q" placeholder="Search labels and definitions" required>
<button type="submit">Search</button>
</form>
</nav>
</header>
<main>
${body}
</main>
<footer>
<p>A reference ontology hub. Every entity keeps the identifier its
publisher minted. Source and entity pages name the source, version, and
license of what they show.</p>
</footer>
</body>
</html>
`;
}

export function errorPage(status, message) {
  return layout(
    `${status}`,
    `<h1>${status}</h1><p>${escape(message)}</p><p><a href="/">Back to the catalogue</a></p>`,
  );
}
