// Checks the pure page logic: axiom verbalization, the tree builder, the
// ancestry chain, and the substitution guards. These decide what a reader
// is shown, so their behavior is pinned here rather than trusted.
//
//   node mcp/test-app.mjs

import { verbalize, renderExpression, subgraphOf } from "./lib/axioms.mjs";
import { buildForest } from "./lib/tree.mjs";
import { buildAncestry } from "./lib/hierarchy.mjs";
import { checkIri, checkKey, regexLiteral, safeHref } from "./lib/sparql.mjs";
import { escape } from "./lib/html.mjs";

const failures = [];
function expect(label, condition, detail) {
  process.stdout.write(`${condition ? "pass" : "FAIL"}  ${label}\n`);
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
}

const uri = (value) => ({ type: "uri", value });
const bnode = (value) => ({ type: "bnode", value });
const lit = (value) => ({ type: "literal", value });
const row = (g, s, p, o) => ({ g: uri(g), s, p: uri(p), o });

const G = "http://example.org/g";
const OWL = "http://www.w3.org/2002/07/owl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const C = "http://example.org/C";

// subclass of (P some F)
{
  const rows = [
    row(G, uri(C), `${RDFS}subClassOf`, bnode("b0")),
    row(G, bnode("b0"), `${RDF}type`, uri(`${OWL}Restriction`)),
    row(G, bnode("b0"), `${OWL}onProperty`, uri("http://example.org/P")),
    row(G, bnode("b0"), `${OWL}someValuesFrom`, uri("http://example.org/F")),
  ];
  const { axioms, fallbacks } = verbalize(rows, C);
  const text = axioms[0]?.tokens.map((t) => t.iri ?? t.text).join(" ");
  expect(
    "an existential restriction verbalizes",
    axioms.length === 1 && fallbacks === 0 && text === "http://example.org/P some http://example.org/F",
    text,
  );
}

// subclass of (P exactly 2 F), the qualified form OntServe left in raw TTL
{
  const rows = [
    row(G, uri(C), `${RDFS}subClassOf`, bnode("b0")),
    row(G, bnode("b0"), `${OWL}onProperty`, uri("http://example.org/P")),
    row(G, bnode("b0"), `${OWL}qualifiedCardinality`, lit("2")),
    row(G, bnode("b0"), `${OWL}onClass`, uri("http://example.org/F")),
  ];
  const text = verbalize(rows, C).axioms[0]?.tokens.map((t) => t.iri ?? t.text).join(" ");
  expect(
    "a qualified cardinality verbalizes with its class",
    text === "http://example.org/P exactly 2 http://example.org/F",
    text,
  );
}

// equivalent to (A and (P only B))
{
  const rows = [
    row(G, uri(C), `${OWL}equivalentClass`, bnode("i")),
    row(G, bnode("i"), `${OWL}intersectionOf`, bnode("l1")),
    row(G, bnode("l1"), `${RDF}first`, uri("http://example.org/A")),
    row(G, bnode("l1"), `${RDF}rest`, bnode("l2")),
    row(G, bnode("l2"), `${RDF}first`, bnode("r")),
    row(G, bnode("l2"), `${RDF}rest`, uri(`${RDF}nil`)),
    row(G, bnode("r"), `${OWL}onProperty`, uri("http://example.org/P")),
    row(G, bnode("r"), `${OWL}allValuesFrom`, uri("http://example.org/B")),
  ];
  const { axioms, fallbacks } = verbalize(rows, C);
  const text = axioms[0]?.tokens.map((t) => t.iri ?? t.text).join(" ");
  expect(
    "an intersection with a nested universal verbalizes",
    fallbacks === 0 &&
      text === "( http://example.org/A and http://example.org/P only http://example.org/B )",
    text,
  );
}

// An unrecognized expression counts as a fallback instead of vanishing.
{
  const rows = [
    row(G, uri(C), `${RDFS}subClassOf`, bnode("weird")),
    row(G, bnode("weird"), "http://example.org/odd", lit("x")),
  ];
  const { axioms, fallbacks } = verbalize(rows, C);
  expect("an unrecognized expression is a counted fallback", axioms.length === 0 && fallbacks === 1);
}

// A cyclic blank structure terminates.
{
  const rows = [
    row(G, uri(C), `${RDFS}subClassOf`, bnode("a")),
    row(G, bnode("a"), `${OWL}complementOf`, bnode("b")),
    row(G, bnode("b"), `${OWL}complementOf`, bnode("a")),
  ];
  const result = renderExpression(subgraphOf(rows), bnode("a"));
  expect("a cyclic expression terminates", result === null || Array.isArray(result));
}

// A bnode shared by two branches of one axiom (a DAG, not a cycle) renders
// on both branches instead of collapsing the second to a fallback.
{
  const rows = [
    row(G, uri(C), `${OWL}equivalentClass`, bnode("i")),
    row(G, bnode("i"), `${OWL}intersectionOf`, bnode("l1")),
    row(G, bnode("l1"), `${RDF}first`, bnode("r")),
    row(G, bnode("l1"), `${RDF}rest`, bnode("l2")),
    row(G, bnode("l2"), `${RDF}first`, bnode("r")),
    row(G, bnode("l2"), `${RDF}rest`, uri(`${RDF}nil`)),
    row(G, bnode("r"), `${OWL}onProperty`, uri("http://example.org/P")),
    row(G, bnode("r"), `${OWL}someValuesFrom`, uri("http://example.org/F")),
  ];
  const { axioms, fallbacks } = verbalize(rows, C);
  const text = axioms[0]?.tokens.map((t) => t.iri ?? t.text).join(" ");
  expect(
    "a shared bnode across branches renders on both",
    fallbacks === 0 &&
      text === "( http://example.org/P some http://example.org/F and http://example.org/P some http://example.org/F )",
    text,
  );
}

// A list clipped by the depth-five closure is a counted fallback, not a
// shortened axiom rendered as if whole.
{
  const rows = [
    row(G, uri(C), `${OWL}equivalentClass`, bnode("i")),
    row(G, bnode("i"), `${OWL}intersectionOf`, bnode("l1")),
    row(G, bnode("l1"), `${RDF}first`, uri("http://example.org/M1")),
    row(G, bnode("l1"), `${RDF}rest`, bnode("l2")),
    // l2 is referenced but absent, as the closure would leave it.
  ];
  const { axioms, fallbacks } = verbalize(rows, C);
  expect("a clipped list is a counted fallback", axioms.length === 0 && fallbacks === 1);
}

// safeHref keeps http and https, refuses everything else.
{
  expect(
    "safeHref passes http and https only",
    safeHref("https://x/y") === "https://x/y" &&
      safeHref("http://x") === "http://x" &&
      safeHref("javascript:alert(1)") === null &&
      safeHref("data:text/html,x") === null,
  );
}

// Tree: roots, external parents, repeats under multi-parents, and a cycle
// that would otherwise be unreachable.
{
  const treeRow = (s, label, parent, inferred) => ({
    s: uri(s),
    label: lit(label),
    ...(parent ? { parent: uri(parent) } : {}),
    ...(inferred ? { inferred: { type: "literal", value: "true" } } : {}),
  });
  const rows = [
    treeRow("http://x/root", "root"),
    treeRow("http://x/a", "a", "http://x/root"),
    treeRow("http://x/b", "b", "http://x/root"),
    treeRow("http://x/b", "b", "http://x/a"),
    treeRow("http://x/stranded", "stranded", "http://external/parent"),
  ];
  const flatten = (forest, depth = 0, out = []) => {
    for (const node of forest) {
      out.push(`${node.label}@${depth}${node.repeat ? "*" : ""}`);
      flatten(node.children, depth + 1, out);
    }
    return out;
  };
  const { forest } = buildForest(rows);
  const labels = flatten(forest);
  expect(
    "the tree roots, nests, and marks repeats",
    labels.join(" ") === "root@0 a@1 b@2 b@1* stranded@0",
    labels.join(" "),
  );
  const stranded = forest.find((node) => node.label === "stranded");
  expect(
    "an external parent is annotated on its root",
    stranded?.externalParents?.[0] === "http://external/parent",
  );

  // A mutual-subclass cycle with no external entry still appears.
  const cycle = buildForest([
    treeRow("http://x/p", "p", "http://x/q"),
    treeRow("http://x/q", "q", "http://x/p"),
  ]);
  expect(
    "an unreachable cycle is still rendered",
    flatten(cycle.forest).length >= 2 && cycle.count === 2,
    flatten(cycle.forest).join(" "),
  );
}

// Ancestry: deterministic primary chain, secondary parents kept.
{
  const ancestryRow = (anc, parent, label) => ({
    anc: uri(anc),
    ...(parent ? { parent: uri(parent) } : {}),
    ...(label ? { label: lit(label) } : {}),
  });
  const rows = [
    ancestryRow("http://x/e", "http://x/p1", "e"),
    ancestryRow("http://x/e", "http://x/p2", "e"),
    ancestryRow("http://x/p1", "http://x/top", "p1"),
    ancestryRow("http://x/p2", "http://x/top", "p2"),
    ancestryRow("http://x/top", undefined, "top"),
  ];
  const ancestry = buildAncestry(rows, "http://x/e");
  expect(
    "the chain is root first and picks the smallest parent",
    ancestry.chain.map((node) => node.label).join(" ") === "top p1 e",
    ancestry.chain.map((node) => node.label).join(" "),
  );
  expect(
    "the other parent is a secondary, not hidden",
    ancestry.secondary.length === 1 && ancestry.secondary[0].iri === "http://x/p2",
  );
}

// Ancestry prefers an in-store parent, so an external parent does not cut
// the chain short when a local chain to a root exists.
{
  const ancestryRow = (anc, parent, label) => ({
    anc: uri(anc),
    ...(parent ? { parent: uri(parent) } : {}),
    ...(label ? { label: lit(label) } : {}),
  });
  // "http://emmo/X" sorts before "http://x/local", so the old rule would
  // have taken the external parent first.
  const rows = [
    ancestryRow("http://x/e", "http://emmo/X", "e"),
    ancestryRow("http://x/e", "http://x/local", "e"),
    ancestryRow("http://x/local", undefined, "local"),
  ];
  const ancestry = buildAncestry(rows, "http://x/e");
  expect(
    "the chain follows the in-store parent past an external one",
    ancestry.chain.map((node) => node.label).join(" ") === "local e",
    ancestry.chain.map((node) => node.label ?? "external").join(" "),
  );
  expect(
    "the external parent is kept as a secondary",
    ancestry.secondary.some((node) => node.iri === "http://emmo/X" && node.external),
  );
}

// Guards: what must not pass, does not pass.
{
  let threw = 0;
  for (const bad of ["javascript:x", "http://a b", 'http://a>"', "ftp://x", ""]) {
    try {
      checkIri(bad);
    } catch {
      threw += 1;
    }
  }
  expect("checkIri refuses what cannot go between angle brackets", threw === 5);
  let keyThrew = 0;
  for (const bad of ["../etc", "A", "x y", ""]) {
    try {
      checkKey(bad);
    } catch {
      keyThrew += 1;
    }
  }
  expect("checkKey refuses path and case tricks", keyThrew === 4);
  // The SPARQL literal carries \\. so the parsed regex sees \. and matches
  // the dot verbatim. One escape level for the regex, one for the literal.
  expect(
    "regex metacharacters are matched verbatim",
    regexLiteral("a.b(c)") === String.raw`"a\\.b\\(c\\)"`,
    regexLiteral("a.b(c)"),
  );
  expect("HTML escaping covers the four", escape('<a b="c">&') === "&lt;a b=&quot;c&quot;&gt;&amp;");
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("\nOK: the page logic behaves as documented");
