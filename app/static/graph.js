// Draws one source's class hierarchy. The source key and the path the site
// is served under both come from the container's data attributes rather than
// from values interpolated into this file, so nothing the page renders can
// reach the script.
;(async () => {
  const container = document.getElementById("cy")
  const key = container.dataset.source
  const base = container.dataset.base ?? ""
  const data = await (
    await fetch(`${base}/graph/${encodeURIComponent(key)}.json`)
  ).json()
  document.getElementById("note").textContent = data.note

  const cy = cytoscape({
    container,
    elements: data.elements,
    layout: {
      name: "dagre",
      rankDir: "BT",
      nodeSep: 30,
      rankSep: 60,
      animate: false
    },
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "font-size": "10px",
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

  cy.on("tap", "node", (event) => {
    window.location = event.target.data("url")
  })

  document.getElementById("filter").addEventListener("input", (event) => {
    const wanted = event.target.value.toLowerCase()
    cy.batch(() => {
      cy.elements().removeClass("dim")
      if (!wanted) return
      const keep = cy
        .nodes()
        .filter((node) => node.data("label").toLowerCase().includes(wanted))
      cy.elements().not(keep).not(keep.connectedEdges()).addClass("dim")
    })
  })
})()
