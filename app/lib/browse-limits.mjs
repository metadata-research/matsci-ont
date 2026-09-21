// Bound large-source views before fetching their whole hierarchy.
export const FULL_TREE_MAX_ENTRIES = 5000
export const ROOT_LIMIT = 100
export const OVERVIEW_NODE_LIMIT = 300
export const OVERVIEW_EDGE_LIMIT = 1200

export function needsOverview(source) {
  return Number(source.entries?.value ?? 0) > FULL_TREE_MAX_ENTRIES
}
