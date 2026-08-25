// Data access shared by the MCP tools. Every function answers from the
// loopback SPARQL endpoint, read only, and returns plain objects.

import { graphIris, baseUrl } from "../pipeline/lib/derive.mjs";
import {
  select,
  checkIri,
  checkKey,
  literal,
  regexLiteral,
  QUERY_URL,
  RejectedInput,
  readCapped,
  MAX_ANSWER_BYTES,
} from "./lib/sparql.mjs";

const graphs = graphIris();
const ONT = `${baseUrl()}vocab#`;

const common = {
  ONT,
  CATALOG: graphs.catalog,
  DEFS: graphs.definitions,
  INFPREFIX: `${baseUrl()}graphs/inferred/`,
};

export const ROW_CAP = 500;
// Matches arq:queryTimeout in the reviewed Fuseki configuration.
export const STORE_TIMEOUT_MS = 30000;

export function checkLimit(value, fallback, cap) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > cap) {
    throw new RejectedInput(`limit must be a whole number between 1 and ${cap}`);
  }
  return value;
}

// A mirror has no version and no ontology IRI of its own, so those are
// absent rather than empty, and it says instead what it mirrors and when
// its publisher last projected it.
export async function listSources() {
  const rows = await select("catalogue", common);
  return rows.map((row) => ({
    key: row.key.value,
    title: row.title.value,
    license: row.license.value,
    graphIri: row.graphIri.value,
    triples: Number(row.triples.value),
    entries: Number(row.entries?.value ?? 0),
    clearedForPublication: row.republishable?.value === "true",
    ...(row.version ? { version: row.version.value } : {}),
    ...(row.ontologyIri ? { ontologyIri: row.ontologyIri.value } : {}),
    ...(row.mirrorOf
      ? {
          mirrorOf: row.mirrorOf.value,
          mirroredFrom: row.mirroredFrom?.value,
          authorityBase: row.authorityBase?.value,
        }
      : {}),
  }));
}

export async function getSource(key) {
  checkKey(key);
  const source = (await listSources()).find((row) => row.key === key);
  if (!source) throw new RejectedInput(`no source is named ${key}`);

  // The catalogue holds more than the listing shows, the reasoning record
  // among it. Only this project's own predicates are read: the Dublin Core
  // and VoID statements repeat fields the listing already carries, in
  // their own IRIs, and adding them would return each value twice under
  // two names.
  const detail = await select("source-detail", { ...common, KEY: literal(key) });
  const multiple = new Set(["module"]);
  for (const row of detail) {
    if (!row.p.value.startsWith(ONT)) continue;
    const name = row.p.value.slice(ONT.length);
    if (["sourceKey", "namedGraph", "ontologyIri"].includes(name)) continue;
    const value = row.o.datatype?.endsWith("#integer") ? Number(row.o.value) : row.o.value;
    if (multiple.has(name)) {
      source[`${name}s`] = [...(source[`${name}s`] ?? []), value];
    } else {
      source[name] = value;
    }
  }
  return source;
}

export async function getEntity(iri) {
  checkIri(iri);
  const rows = await select("entity", { ...common, IRI: iri });
  if (rows.length === 0) {
    // The entity query matches the IRI as a subject. An IRI from an
    // ontology this store does not hold, an upper-level class among them,
    // commonly appears only as an object, and saying nothing mentions it
    // would be false.
    const references = await select("incoming", { ...common, IRI: iri });
    if (references.length === 0) {
      throw new RejectedInput(`nothing in the store mentions ${iri}`);
    }
    return {
      iri,
      describedHere: false,
      note: "No source in this store describes this entity. It appears only as the object of statements made about others.",
      referencedBy: references.slice(0, 50).map((row) => ({
        iri: row.s.value,
        label: row.label?.value,
        predicate: row.p.value,
      })),
      truncated: references.length > 50,
    };
  }

  const entry = {};
  const triples = [];
  for (const row of rows) {
    if (row.g.value === graphs.definitions && row.s.value === iri) {
      const name = row.p.value.startsWith(ONT) ? row.p.value.slice(ONT.length) : row.p.value;
      entry[name] = row.o.value;
      continue;
    }
    if (row.g.value === graphs.catalog) continue;
    triples.push({
      subject: row.s.type === "bnode" ? `_:${row.s.value}` : row.s.value,
      predicate: row.p.value,
      object: row.o.type === "bnode" ? `_:${row.o.value}` : row.o.value,
      objectKind: row.o.type,
      language: row.o["xml:lang"],
      graph: row.g.value,
    });
  }

  // The inferred placements sit in their own graph, which entity.rq
  // excludes, so they are fetched separately and marked as derived.
  const inferred = entry.sourceKey
    ? await select("entity-inferred", {
        ...common,
        IRI: iri,
        INFGRAPH: checkIri(`${baseUrl()}graphs/inferred/${checkKey(entry.sourceKey)}`),
      })
    : [];

  // An entity the definitions index skipped, because it has no label,
  // still comes from a source: the graph its triples are in names it.
  const catalogue = await listSources();
  const graphKeys = new Set(triples.map((triple) => triple.graph));
  const fromGraph = entry.sourceKey
    ? undefined
    : catalogue.find((source) => graphKeys.has(source.graphIri));

  return {
    iri,
    describedHere: true,
    label: entry.label,
    definition: entry.definition,
    definitionProperty: entry.definitionProperty,
    source: entry.sourceKey
      ? {
          key: entry.sourceKey,
          ...(entry.sourceVersion && entry.sourceVersion !== "mirror"
            ? { version: entry.sourceVersion }
            : {}),
          license: entry.license,
          // A client is told to act on these, so every payload naming a
          // source carries them, not only the catalogue listing.
          ...mirrorFacts(catalogue, entry.sourceKey),
        }
      : fromGraph
        ? {
            key: fromGraph.key,
            ...(fromGraph.version ? { version: fromGraph.version } : {}),
            license: fromGraph.license,
            ...mirrorFacts(catalogue, fromGraph.key),
          }
        : undefined,
    triples: triples.slice(0, ROW_CAP),
    truncated: triples.length > ROW_CAP,
    inferredParents: inferred.map((row) => row.parent.value),
  };
}

// What a client needs in order to say where something came from and
// whether it may be passed on.
function mirrorFacts(catalogue, key) {
  const source = catalogue.find((row) => row.key === key);
  if (!source) return {};
  return {
    clearedForPublication: source.clearedForPublication,
    ...(source.mirrorOf ? { mirrorOf: source.mirrorOf, mirroredFrom: source.mirroredFrom } : {}),
  };
}

export async function findEntities(q, { sources, limit } = {}) {
  const text = String(q ?? "").trim();
  if (text === "") throw new RejectedInput("a search needs a term");
  const cap = checkLimit(limit, 20, 200);

  // Keys are validated before they reach the fragment, so no caller text
  // enters the query.
  const filter =
    sources && sources.length > 0
      ? `FILTER(?key IN (${sources.map((key) => `"${checkKey(key)}"`).join(", ")}))`
      : "";

  const rows = await select("find", {
    ...common,
    REGEX: regexLiteral(text.slice(0, 200)),
    SOURCEFILTER: filter,
    LIMIT: String(cap + 1),
  });

  const catalogue = await listSources();
  return {
    results: rows.slice(0, cap).map((row) => ({
      iri: row.s.value,
      label: row.label.value,
      definition: row.definition?.value,
      source: row.key.value,
      // "mirror" is a placeholder the index writes where a version would
      // be, not a version. A client is not given it as one.
      ...(row.version.value === "mirror" ? {} : { version: row.version.value }),
      license: row.license.value,
      ...mirrorFacts(catalogue, row.key.value),
    })),
    truncated: rows.length > cap,
  };
}

const UPDATE_FORMS = [
  "INSERT",
  "DELETE",
  "LOAD",
  "CLEAR",
  "DROP",
  "CREATE",
  "ADD",
  "MOVE",
  "COPY",
];

const PROLOGUE = /^((?:\s*(?:BASE\s*<[^>]*>|PREFIX\s+[^\s:]*:\s*<[^>]*>))*)/i;

// Returns the query with the inside of comments, string literals and IRIs
// replaced by spaces, position for position. Keywords are then read from
// this copy, never from the text itself, so a word a caller wrote inside a
// literal or a comment cannot be mistaken for syntax. The text that reaches
// the store is always the original.
export function maskQuery(query) {
  const out = new Array(query.length).fill("");
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) out[k] = query[k] === "\n" ? "\n" : " ";
  };
  while (i < query.length) {
    const rest = query.slice(i);
    if (query[i] === "#") {
      const end = query.indexOf("\n", i);
      const stop = end === -1 ? query.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (query[i] === "<" && /^<[^\s<>"{}|\\^`]*>/.test(rest)) {
      const stop = i + rest.indexOf(">") + 1;
      out[i] = "<";
      blank(i + 1, stop - 1);
      out[stop - 1] = ">";
      i = stop;
      continue;
    }
    for (const quote of ['"""', "'''", '"', "'"]) {
      if (rest.startsWith(quote)) {
        let j = i + quote.length;
        while (j < query.length) {
          if (query[j] === "\\") {
            j += 2;
            continue;
          }
          if (query.startsWith(quote, j)) break;
          j += 1;
        }
        const stop = Math.min(j + quote.length, query.length);
        for (let k = 0; k < quote.length; k += 1) out[i + k] = quote[0];
        blank(i + quote.length, stop);
        i = stop;
        break;
      }
    }
    if (out[i] !== "") continue;
    out[i] = query[i];
    i += 1;
  }
  return out.join("");
}

// Splits a query into its prologue and the rest. The split point is found
// on the masked copy and applied to the original.
export function splitQuery(query) {
  const masked = maskQuery(query);
  const end = PROLOGUE.exec(masked)?.[0].length ?? 0;
  return {
    prologue: query.slice(0, end).trim(),
    body: query.slice(end).trim(),
    maskedBody: masked.slice(end).trim(),
  };
}

// A query whose form is not one of the four read operations is refused here
// rather than at the endpoint, which would answer with a parser error.
export function queryForm(query) {
  const { maskedBody } = splitQuery(query);
  return /^([A-Za-z]+)/.exec(maskedBody)?.[1]?.toUpperCase() ?? "";
}

// Puts the caller's row cap into the query, so the store returns what was
// asked for rather than everything for this process to cut afterwards. One
// row beyond the cap is asked for, which is how truncation is detected.
//
// A query with its own dataset clause is left alone: FROM is not allowed in
// a subselect, and rewriting it would turn a working query into a parse
// error. Those fall back to the size ceiling. The closing braces go on
// their own line, because a query ending in a partial-line comment would
// otherwise swallow them.
export function withRowLimit(query, limit) {
  const { prologue, body, maskedBody } = splitQuery(query);
  // A dataset clause, not a variable named from, nor a prefixed name
  // ending in it. Treating those as dataset clauses would drop the cap
  // and leave the query to be bounded by size alone.
  if (/(?<![?$:\w])FROM(?![\w:])/i.test(maskedBody)) return null;
  return `${prologue}\nSELECT * WHERE { {\n${body}\n} } LIMIT ${limit}`.trim();
}

export async function sparqlQuery(query, { limit } = {}) {
  const text = String(query ?? "").trim();
  if (text === "") throw new RejectedInput("a query is required");
  const cap = checkLimit(limit, 200, ROW_CAP);

  const form = queryForm(text);
  if (UPDATE_FORMS.includes(form)) {
    throw new RejectedInput(
      `${form} is an update, and this endpoint answers queries only. Use SELECT, ASK, CONSTRUCT or DESCRIBE.`,
    );
  }
  if (!["SELECT", "ASK", "CONSTRUCT", "DESCRIBE"].includes(form)) {
    throw new RejectedInput(
      `the query form ${form || "(none)"} is not one this endpoint answers. Use SELECT, ASK, CONSTRUCT or DESCRIBE.`,
    );
  }

  const wantsGraph = form === "CONSTRUCT" || form === "DESCRIBE";
  const sent = form === "SELECT" ? (withRowLimit(text, cap + 1) ?? text) : text;
  let response;
  try {
    response = await fetch(QUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/sparql-query",
        Accept: wantsGraph ? "text/turtle" : "application/sparql-results+json",
      },
      body: sent,
      // Above the 30 seconds the store allows a query, so a store that
      // stops one answers first and this is only the backstop.
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS + 5000),
    });
  } catch (error) {
    throw new Error(
      error.name === "TimeoutError"
        ? `the query ran longer than the store allows (${STORE_TIMEOUT_MS / 1000} seconds). Narrow it or add a LIMIT.`
        : `the store could not be reached: ${error.message}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `the store refused the query (HTTP ${response.status}): ${(await readCapped(response)).body.slice(0, 300).trim()}`,
    );
  }

  // Read with a ceiling. A query that matches most of the store would
  // otherwise be assembled whole in this process, which serves the pages
  // too: one call could take the application down. The store stopping a
  // query mid-stream also leaves a partial body, which is what reading it
  // whole turned into an unreadable internal error.
  const { body: answer, exceeded } = await readCapped(response);
  if (exceeded) {
    throw new Error(
      `the answer passed ${MAX_ANSWER_BYTES / (1024 * 1024)} MB before it finished. Add a LIMIT or ask for less.`,
    );
  }

  if (wantsGraph) return { form, turtle: answer, truncated: false };

  let parsed;
  try {
    parsed = JSON.parse(answer);
  } catch {
    // The store answers 200 and then stops a long query part-way, leaving
    // a truncated body. Below the size ceiling that arrives here as a
    // parse failure, and the caller needs the reason, not the position
    // where the JSON broke.
    throw new Error(
      `the query ran longer than the store allows (${STORE_TIMEOUT_MS / 1000} seconds) and was stopped part-way. Narrow it or add a LIMIT.`,
    );
  }
  if (parsed.boolean !== undefined) return { form, boolean: parsed.boolean, truncated: false };

  const bindings = parsed.results.bindings;
  const rows = bindings.slice(0, cap).map((binding) => {
    const row = {};
    for (const [name, term] of Object.entries(binding)) {
      row[name] = term.type === "bnode" ? `_:${term.value}` : term.value;
    }
    return row;
  });
  return { form, variables: parsed.head.vars, rows, truncated: bindings.length > cap };
}
