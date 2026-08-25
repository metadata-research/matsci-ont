// Builds the source-page class forest from tree.rq rows. Pure.
//
// A node roots the forest when none of its named parents is a labelled node
// of the source, so a class whose only parent is external (a CHAMEO class
// below an unloaded EMMO class) roots the tree and carries its external
// parent as an annotation. A node with parents that are all outside the
// labelled set but present as a cycle would otherwise be unreachable, so
// after the parent pass any node not reached from a root also seeds one,
// which keeps a mutual-subclass pair or a self-parent visible.

export function buildForest(rows) {
  const nodes = new Map()
  for (const row of rows) {
    const iri = row.s.value
    if (!nodes.has(iri)) {
      nodes.set(iri, {
        iri,
        label: row.label.value,
        parents: new Set(),
        inferredFrom: new Set()
      })
    }
    if (row.parent) {
      nodes.get(iri).parents.add(row.parent.value)
      if (row.inferred?.value === "true")
        nodes.get(iri).inferredFrom.add(row.parent.value)
    }
  }

  const childrenOf = new Map()
  const rootIris = []
  for (const node of nodes.values()) {
    const inSet = [...node.parents].filter((parent) => nodes.has(parent))
    node.externalParents = [...node.parents]
      .filter((parent) => !nodes.has(parent))
      .sort()
    if (inSet.length === 0) rootIris.push(node.iri)
    for (const parent of inSet) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent).push(node.iri)
    }
  }

  const byLabel = (a, b) => {
    const na = nodes.get(a)
    const nb = nodes.get(b)
    return na.label.localeCompare(nb.label) || a.localeCompare(b)
  }
  rootIris.sort(byLabel)
  for (const list of childrenOf.values()) list.sort(byLabel)

  // Expand each node once, so a shared subtree does not multiply and a cycle
  // cannot loop. A node reached again is emitted as a repeat leaf.
  const expanded = new Set()
  const build = (iri, viaInferred) => {
    const node = nodes.get(iri)
    if (expanded.has(iri)) {
      return {
        iri,
        label: node.label,
        repeat: true,
        inferredEdge: viaInferred,
        children: []
      }
    }
    expanded.add(iri)
    return {
      iri,
      label: node.label,
      repeat: false,
      inferredEdge: viaInferred,
      externalParents: node.externalParents,
      children: (childrenOf.get(iri) ?? []).map((child) =>
        build(child, nodes.get(child).inferredFrom.has(iri))
      )
    }
  }

  const forest = rootIris.map((iri) => build(iri, false))
  // Any node never reached from a root belongs to a cycle with no external
  // or unlabelled entry point. Seed it as a root so it is not lost.
  for (const iri of [...nodes.keys()].sort(byLabel)) {
    if (!expanded.has(iri)) forest.push(build(iri, false))
  }
  return { forest, count: nodes.size }
}
