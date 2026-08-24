// Assembles the entity-page hierarchy card from ancestry.rq rows. Pure.
//
// The card keeps the OntServe idea: one chain from the entity to its root,
// then the entity's other parents as a separate line. The primary parent at
// each step is the alphabetically smallest parent IRI, which is arbitrary
// but deterministic, and the remaining parents of the entity itself are
// never hidden.

export function buildAncestry(rows, entityIri) {
  const parents = new Map();
  const labels = new Map();
  for (const row of rows) {
    const anc = row.anc.value;
    if (!parents.has(anc)) parents.set(anc, new Set());
    if (row.parent) parents.get(anc).add(row.parent.value);
    if (row.label) labels.set(anc, row.label.value);
  }

  // The primary parent is the smallest IRI among the in-store parents, so a
  // class below both a local class and an unloaded external class follows
  // its local chain to a root instead of terminating one hop up at the
  // external parent. Only if every parent is external does the chain end.
  const primaryParent = (iri) => {
    const all = [...(parents.get(iri) ?? [])].sort();
    const inStore = all.filter((parent) => labels.has(parent));
    return (inStore.length > 0 ? inStore : all)[0];
  };

  const chain = [];
  const seen = new Set();
  let current = entityIri;
  let stoppedAtLimit = false;
  while (current && !seen.has(current)) {
    if (chain.length >= 16) {
      stoppedAtLimit = true;
      break;
    }
    seen.add(current);
    chain.push({ iri: current, label: labels.get(current), external: !labels.has(current) });
    current = primaryParent(current);
  }
  chain.reverse();

  const primary = chain.length > 1 ? chain[chain.length - 2].iri : undefined;
  const secondary = [...(parents.get(entityIri) ?? [])]
    .filter((iri) => iri !== primary)
    .sort()
    .map((iri) => ({ iri, label: labels.get(iri), external: !labels.has(iri) }));

  return { chain, secondary, truncated: stoppedAtLimit };
}
