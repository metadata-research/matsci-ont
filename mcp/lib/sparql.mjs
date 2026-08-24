// Loads named queries from mcp/queries/ and runs them against the loopback
// Fuseki query endpoint. User input reaches a query only through the typed
// substitutions here, never through raw string interpolation.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const QUERY_DIR = new URL("../queries/", import.meta.url).pathname;

export const QUERY_URL =
  process.env.MATSCI_ONT_QUERY_URL ??
  `http://127.0.0.1:${process.env.MATSCI_ONT_FUSEKI_PORT ?? 3031}/matsci-ont/query`;

// Thrown when client-supplied input is not a shape the store can hold. The
// server turns it into a 404, distinct from a 502 for a store failure.
export class RejectedInput extends Error {}

// An IRI substitution goes between angle brackets, so anything that could
// close the bracket or smuggle whitespace is refused rather than escaped. An
// http or https IRI only, which is every identifier these sources mint.
export function checkIri(value) {
  if (
    typeof value !== "string" ||
    !/^https?:\/\/[^\s<>"{}|\\^`]+$/.test(value)
  ) {
    throw new RejectedInput(`not a substitutable IRI: ${String(value).slice(0, 80)}`);
  }
  return value;
}

export function checkKey(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new RejectedInput(`not a source key: ${String(value).slice(0, 80)}`);
  }
  return value;
}

export function literal(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

// Escapes Java-regex metacharacters so a search string is matched verbatim
// inside the word-boundary pattern the search query builds around it.
export function regexLiteral(value) {
  return literal(String(value).replace(/[.\\+*?\[\]^$(){}=!<>|:#-]/g, "\\$&"));
}

const queryCache = new Map();

export async function namedQuery(name, substitutions) {
  if (!queryCache.has(name)) {
    queryCache.set(name, await readFile(join(QUERY_DIR, `${name}.rq`), "utf8"));
  }
  const template = queryCache.get(name);
  // Unfilled tokens are detected in the template before substitution, so a
  // user value that happens to contain "@@" cannot look like a leftover.
  const required = new Set([...template.matchAll(/@@([A-Z_]+)@@/g)].map((m) => m[1]));
  for (const token of required) {
    if (!(token in (substitutions ?? {}))) {
      throw new Error(`query ${name} is missing substitution ${token}`);
    }
  }
  let text = template;
  for (const [token, value] of Object.entries(substitutions ?? {})) {
    text = text.split(`@@${token}@@`).join(value);
  }
  return text;
}

// An href allowlist for IRIs that come from the store as link targets. A
// mapping object can be any IRI its author wrote, javascript: and data:
// included, so only http and https reach an href attribute; anything else
// renders as plain text.
export function safeHref(iri) {
  return /^https?:\/\//i.test(iri) ? iri : null;
}

export async function select(name, substitutions) {
  const query = await namedQuery(name, substitutions);
  const response = await fetch(QUERY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/sparql-query",
      Accept: "application/sparql-results+json",
    },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`query ${name} answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = await response.json();
  if (body.boolean !== undefined) return body.boolean;
  return body.results.bindings;
}
