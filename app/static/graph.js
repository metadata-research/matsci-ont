// Draws one source's class hierarchy. The source key and the path the site
// is served under both come from the container's data attributes rather than
// from values interpolated into this file, so nothing the page renders can
// reach the script.
;(async () => {
  const container = document.getElementById("cy")
  const key = container.dataset.source
  const base = container.dataset.base ?? ""
  const response = await fetch(`${base}/graph/${encodeURIComponent(key)}.json`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json()
  if (!data.elements) throw new Error("No graph data returned")
  document.getElementById("note").textContent = data.note

  const cy = cytoscape({
    container,
    elements: data.elements,
    layout: {
      name: "dagre",
      rankDir: data.overview ? "LR" : "BT",
      fit: !data.overview,
      nodeSep: 30,
      rankSep: 60,
      animate: false
    },
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "font-size": data.overview ? "14px" : "10px",
          "text-wrap": "wrap",
          "text-max-width": "90px",
          width: 24,
          height: 24,
          "background-color": "#4a6fa5"
        }
      },
      { selector: "node.external", style: { "background-color": "#b0b0b0" } },
      {
        selector: "edge.hierarchy",
        style: {
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          width: 1,
          "line-color": "#888",
          "target-arrow-color": "#888"
        }
      },
      {
        selector: "edge.property",
        style: {
          "curve-style": "bezier",
          "line-style": "dashed",
          "line-color": "#8e6fae",
          width: 1,
          label: "data(label)",
          "font-size": "8px",
          "text-rotation": "autorotate"
        }
      },
      { selector: ".dim", style: { opacity: 0.15 } }
    ]
  })

  if (data.overview && cy.nodes().length) {
    cy.zoom(1)
    cy.center(cy.nodes().max((node) => node.degree()).ele)
  }
  for (const id of ["zoom-in", "zoom-out", "fit-graph"]) {
    document.getElementById(id).disabled = false
  }
  document.getElementById("zoom-in").addEventListener("click", () => {
    cy.zoom({
      level: cy.zoom() * 1.4,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 }
    })
  })
  document.getElementById("zoom-out").addEventListener("click", () => {
    cy.zoom({
      level: cy.zoom() / 1.4,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 }
    })
  })
  document
    .getElementById("fit-graph")
    .addEventListener("click", () => cy.fit(undefined, 30))

  cy.on("tap", "node", (event) => {
    window.location = event.target.data("url")
  })

  document.getElementById("filter").disabled = false
  document.getElementById("filter").addEventListener("input", (event) => {
    const wanted = event.target.value.toLowerCase()
    cy.batch(() => {
      cy.elements().removeClass("dim")
      if (!wanted) return
      const keep = cy
        .nodes()
        .filter((node) => node.data("label").toLowerCase().includes(wanted))
      cy.elements().not(keep).not(keep.connectedEdges()).addClass("dim")
      if (data.overview && keep.length) {
        cy.zoom(1)
        cy.center(keep.first())
      }
    })
  })
})().catch(() => {
  document.getElementById("note").textContent =
    "The graph could not be loaded. Retry or use the source page to browse terms."
})
