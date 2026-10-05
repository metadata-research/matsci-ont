# Using the hub from an AI client

MatSci-ONT answers the Model Context Protocol at `/mcp`, so a client such
as Claude can query the ontologies directly. The endpoint is read-only and
stateless, and it never writes to the store.

## Connecting

Run the application, then point a client at the endpoint.

```bash
pnpm dev
```

```
http://localhost:3100/mcp
```

For Claude Code, add the server with this command.

```bash
claude mcp add --transport http matsci-ont http://localhost:3100/mcp
```

The endpoint takes POST requests of at most 1 MiB and answers other methods
with HTTP 405. A client must accept both `application/json` and
`text/event-stream`, as every Model Context Protocol client does.

## The tools

| Tool            | Answers                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `list_sources`  | Which ontologies are loaded, with version, licence, size and indexed entries                      |
| `get_source`    | One source in full, including its pinned download, digest, and what reasoning added               |
| `get_entity`    | The label, definition and source triples of one entity IRI, with any parent a reasoner derived    |
| `find_entities` | Search for the term where a word starts in labels and definitions, with an optional source filter |
| `sparql_query`  | A read-only SPARQL 1.1 query over the whole store                                                 |

Every tool except `sparql_query` names the source of each answer, its
licence and, where the source has one, its version. Licences differ
between sources, and an answer drawn from one has to credit it. A
`sparql_query` result holds only the columns the query selects, so name the
graph a result came from when the answer needs crediting. A parent listed
under `inferredParents` was derived by an OWL reasoner at build time and is
not asserted by the source.

## What the tools refuse

`sparql_query` answers SELECT, ASK, CONSTRUCT and DESCRIBE. An update form
such as INSERT or DELETE is refused with a message naming the four forms it
takes. SELECT rows are capped at 200 by default and 500 at most, and a
capped answer says so in its `truncated` field. A CONSTRUCT or DESCRIBE
answer has no row cap, so give such a query a LIMIT. Any answer larger than
2 MB is refused outright.

An unknown IRI or source key comes back as a plain message saying what was
not found.

## An example

A request for "the definition of sintering in every ontology you have"
leads a client to run `find_entities`, which returns the matching entries
of every source with their licences. The client can then call `get_entity`
on any of those IRIs for the full record.

## Selecting a source description

`get_entity` accepts an optional `source` key alongside `iri`.

```json
{ "iri": "http://purl.obolibrary.org/obo/CHEBI_18248", "source": "chebi" }
```

This call selects the ChEBI description of iron atom and limits the
asserted triples and inferred parents to that source. `descriptions` lists
every description of the IRI, each with its own label, optional definition,
definition property and source attribution, and `source: "pmdco"` selects
the PMDco description. Without `source` the tool chooses the alphabetically
first source key, and a source that does not describe the entity is
refused. When several sources describe the IRI, the `note` in the response
says how to select another description.

ChEBI CORE 254 is a cleared source under CC BY 4.0. Credit ChEBI and its
version, and link the publisher entity and the licence when quoting its
definition. A description of an imported IRI by another source creates no
new entity and establishes no equivalence with a similarly named term.
