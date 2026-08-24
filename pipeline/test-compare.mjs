// Proves the comparison tiers catch what they claim to catch.
//
//   node pipeline/test-compare.mjs
//
// Each case builds two throwaway TDB2 stores from crafted Turtle and asserts
// the verdict of each tier. The cases are the ones that motivated the three
// tiers: a value buried inside a blank node, and a blank node topology swap
// that a hash cannot see. Without these, a regression in the comparison
// would show up as checks that pass on everything.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jenaEnvironment, runJena } from "./lib/tools.mjs";
import { blindBlankNodes, dumpBlinded, graphsIsomorphic } from "./lib/compare.mjs";

const GRAPH = "http://example.org/g/test";
const environment = await jenaEnvironment();
const root = await mkdtemp(join(tmpdir(), "matsci-ont-compare-"));

async function buildStore(name, turtle) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const file = join(root, `${name}.ttl`);
  await writeFile(file, turtle);
  const load = runJena(environment, "tdb2.tdbloader", [
    `--loc=${directory}`,
    `--graph=${GRAPH}`,
    file,
  ]);
  if (load.status !== 0) throw new Error(`load failed for ${name}\n${load.stderr}`);
  return directory;
}

const failures = [];
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  process.stdout.write(`${ok ? "pass" : "FAIL"}  ${label} (${actual})\n`);
  if (!ok) failures.push(`${label}: expected ${wanted}, got ${actual}`);
}

// A literal that contains "_:" must survive blinding untouched, while a real
// blank node label is replaced. Dropping lines that merely contain "_:"
// would silently discard data.
const literalLine = `<http://example.org/s> <http://example.org/p> "mentions _:B123 inside" <${GRAPH}> .`;
expect("a literal containing _: is left alone", blindBlankNodes(literalLine), literalLine);
expect(
  "a real blank node label is blinded",
  blindBlankNodes(`_:Bdeadbeef <http://example.org/p> "x" <${GRAPH}> .`),
  `_:_ <http://example.org/p> "x" <${GRAPH}> .`,
);

const restriction = (cardinality) => `
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex:   <http://example.org/> .
ex:Alloy rdfs:subClassOf [
  a owl:Restriction ;
  owl:onProperty ex:hasComponent ;
  owl:minCardinality "${cardinality}"^^<http://www.w3.org/2001/XMLSchema#nonNegativeInteger>
] .
`;

// Case 1: the difference is a value inside a restriction blank node, which
// is where an OWL axiom actually is. Counts cannot see it.
const same1 = await buildStore("card-a", restriction(2));
const same2 = await buildStore("card-a2", restriction(2));
const different = await buildStore("card-b", restriction(3));

expect(
  "identical inputs agree on the blinded hash",
  dumpBlinded(environment, same1).hash === dumpBlinded(environment, same2).hash,
  true,
);
expect(
  "identical inputs are isomorphic",
  (await graphsIsomorphic(environment, GRAPH, same1, same2, join(root, "w1"))).equal,
  true,
);
expect(
  "a changed cardinality has equal quad counts",
  dumpBlinded(environment, same1).quads === dumpBlinded(environment, different).quads,
  true,
);
expect(
  "a changed cardinality is caught by isomorphism",
  (await graphsIsomorphic(environment, GRAPH, same1, different, join(root, "w2"))).equal,
  false,
);

// Case 2: the same values attached to different subjects. The blinded
// multiset is identical, so only isomorphism can tell these apart. This is
// the case that makes tier 3 the gate rather than a formality.
const swapA = await buildStore(
  "swap-a",
  `@prefix ex: <http://example.org/> .
   ex:A ex:p [ ex:q "1" ] .
   ex:B ex:p [ ex:q "2" ] .`,
);
const swapB = await buildStore(
  "swap-b",
  `@prefix ex: <http://example.org/> .
   ex:A ex:p [ ex:q "2" ] .
   ex:B ex:p [ ex:q "1" ] .`,
);

expect(
  "a topology swap slips past the blinded hash",
  dumpBlinded(environment, swapA).hash === dumpBlinded(environment, swapB).hash,
  true,
);
expect(
  "a topology swap is caught by isomorphism",
  (await graphsIsomorphic(environment, GRAPH, swapA, swapB, join(root, "w3"))).equal,
  false,
);

await rm(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("\nOK: the comparison tiers behave as documented");
