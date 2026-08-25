// The substitutions every application query needs: this project's
// vocabulary namespace, the two graphs it derives, and the prefix that
// marks an inferred graph.
//
// One definition, because the pages and the data layer ask the same store
// the same questions. Two copies would let one surface quietly read a
// different graph from the other, which is a difference no test asserting
// "the page renders" would notice.

import {
  graphIris,
  vocabularyIri,
  inferredGraphPrefix
} from "../../shared/vocabulary.mjs"

export const graphs = graphIris()
export const ONT = vocabularyIri()

export const common = {
  ONT,
  CATALOG: graphs.catalog,
  DEFS: graphs.definitions,
  INFPREFIX: inferredGraphPrefix()
}
