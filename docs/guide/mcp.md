# Using the hub from an AI client

MatSci-ONT answers the Model Context Protocol at `/mcp`, so a client such
as Claude can query the ontologies directly. The endpoint is read-only. It
holds no session state, and it never writes to the store.

## Connecting

Run the application, then point a client at the endpoint:

```bash
pnpm dev
```

```
http://localhost:3100/mcp
```

For Claude Code, add the server with:

```bash
claude mcp add --transport http matsci-ont http://localhost:3100/mcp
```

The endpoint takes POST. A client must accept both `application/json` and
`text/event-stream`, which every Model Context Protocol client does.

## The tools

| Tool            | Answers                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `list_sources`  | Which ontologies are loaded, with version, licence, size and indexed entries                         |
| `get_source`    | One source in full, including its pinned download, digest, and what reasoning added                  |
| `get_entity`    | One entity IRI: label, definition, the triples its source asserts, and any parent a reasoner derived |
| `find_entities` | Whole-word search over labels and definitions, with an optional source filter                        |
| `sparql_query`  | A read-only SPARQL 1.1 query over the whole store                                                    |

Every answer names the source, its version and its licence, because
licences differ between sources and an answer drawn from one has to credit
it. A parent listed under `inferredParents` was derived by an OWL reasoner
at build time and is not asserted by the source.

## What the tools refuse

`sparql_query` answers SELECT, ASK, CONSTRUCT and DESCRIBE. An update form
such as INSERT or DELETE is refused with a message naming the four it
takes. SELECT rows are capped, and a capped answer says
so in its `truncated` field rather than looking complete. A CONSTRUCT or
DESCRIBE answer is bounded by size instead, and is refused outright if it
passes the ceiling.

An unknown IRI or source key comes back as a plain message saying what was
not found.

## An example

Asking a client for "the definition of sintering in every ontology you
have" runs `find_entities`, which returns a hit from every
source that defines the term, each with its licence, and the client can
then call `get_entity` on any of those IRIs for the full record.
