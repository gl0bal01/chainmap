// =============================================================================
// render/interaction.js — canvas interactions: click->details, dblclick->alias,
// Delete-to-prune, Shift+drag rectangle select, high-degree select, rotation.
// Uses vis + DOM. All mutations still go THROUGH the store.
//
// STAGE A: interface frozen. STAGE B: implement (port reference math cleanly:
// rotate around centroid; DOMtoCanvas rectangle hit-test).
// =============================================================================

/**
 * Read every node id + its current canvas position from `network` in one shot.
 * vis.Network#getPositions() with no argument returns positions for ALL nodes.
 * @param {any} network vis.Network
 * @returns {{ ids:string[], positions:Record<string,{x:number,y:number}> }}
 */
function allPositions(network) {
  const positions = network.getPositions();
  return { ids: Object.keys(positions), positions };
}

/**
 * Wire all interaction handlers. Returns a disposer that detaches every listener.
 * @param {import('./network.js').GraphView} view
 * @param {import('../graphStore.js').GraphStore} store
 * @param {{
 *   container: HTMLElement,
 *   i18n: import('../i18n.js').I18n,
 *   onNodeSelect: (address:string)=>void,
 *   onEdgeSelect: (edgeKey:string)=>void,
 *   onAliasEdit: (address:string)=>void,
 *   onLog: (entry:{level:'info'|'error', key:string, params?:object})=>void
 * }} deps
 * @returns {{ detach: () => void }}
 */
export function attachInteractions(view, store, deps) {
  const { container, onNodeSelect, onEdgeSelect, onAliasEdit, onLog } = deps;
  const network = view.network;

  // --- click -> node/edge selection -----------------------------------------
  function handleClick(params) {
    if (params.nodes.length) {
      onNodeSelect(params.nodes[0]);
    } else if (params.edges.length) {
      onEdgeSelect(params.edges[0]);
    }
  }
  network.on("click", handleClick);

  // --- double-click -> alias edit --------------------------------------------
  function handleDoubleClick(params) {
    if (params.nodes.length) {
      onAliasEdit(params.nodes[0]);
    }
  }
  network.on("doubleClick", handleDoubleClick);

  // --- Delete/Backspace -> prune selected nodes (through the store) ---------
  function handleKeydown(e) {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    const selected = network.getSelectedNodes();
    if (!selected.length) {
      onLog({ level: "error", key: "error.selectNodesFirst" });
      return;
    }
    const result = store.removeNodes(selected);
    onLog({ level: "info", key: "log.nodesDeleted", params: { n: result.removedNodes } });
  }
  document.addEventListener("keydown", handleKeydown);

  // --- Shift+drag -> rectangle box-select ------------------------------------
  let boxSelecting = false;
  let boxStart = null;
  let boxDiv = null;

  function handleMouseDown(e) {
    if (!e.shiftKey) return;
    boxSelecting = true;
    boxStart = { x: e.offsetX, y: e.offsetY };
    network.setOptions({ interaction: { dragView: false } });
    boxDiv = document.createElement("div");
    boxDiv.className = "select-box";
    boxDiv.style.left = boxStart.x + "px";
    boxDiv.style.top = boxStart.y + "px";
    container.appendChild(boxDiv);
    e.preventDefault();
  }
  container.addEventListener("mousedown", handleMouseDown);

  function handleMouseMove(e) {
    if (!boxSelecting) return;
    const x = Math.min(boxStart.x, e.offsetX);
    const y = Math.min(boxStart.y, e.offsetY);
    const w = Math.abs(e.offsetX - boxStart.x);
    const h = Math.abs(e.offsetY - boxStart.y);
    boxDiv.style.left = x + "px";
    boxDiv.style.top = y + "px";
    boxDiv.style.width = w + "px";
    boxDiv.style.height = h + "px";
  }
  container.addEventListener("mousemove", handleMouseMove);

  function handleMouseUp(e) {
    if (!boxSelecting) return;
    boxSelecting = false;
    network.setOptions({ interaction: { dragView: true } });
    const rect = container.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;
    if (boxDiv) {
      boxDiv.remove();
      boxDiv = null;
    }

    const domX1 = Math.min(boxStart.x, endX);
    const domX2 = Math.max(boxStart.x, endX);
    const domY1 = Math.min(boxStart.y, endY);
    const domY2 = Math.max(boxStart.y, endY);
    const c1 = network.DOMtoCanvas({ x: domX1, y: domY1 });
    const c2 = network.DOMtoCanvas({ x: domX2, y: domY2 });

    const { ids, positions } = allPositions(network);
    const selected = ids.filter((id) => {
      const p = positions[id];
      return p.x >= c1.x && p.x <= c2.x && p.y >= c1.y && p.y <= c2.y;
    });
    network.setSelection({ nodes: selected, edges: [] });
    if (selected.length) {
      onLog({ level: "info", key: "log.boxSelected", params: { n: selected.length } });
    }
  }
  window.addEventListener("mouseup", handleMouseUp);

  return {
    detach() {
      network.off("click", handleClick);
      network.off("doubleClick", handleDoubleClick);
      document.removeEventListener("keydown", handleKeydown);
      container.removeEventListener("mousedown", handleMouseDown);
      container.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (boxDiv) {
        boxDiv.remove();
        boxDiv = null;
      }
      boxSelecting = false;
    },
  };
}

/**
 * Rotate all node positions by `angleDeg` around their centroid. Pure geometry
 * over vis positions; no store change (layout only).
 * @param {any} network vis.Network
 * @param {number} angleDeg
 */
export function rotateGraph(network, angleDeg) {
  const { ids, positions } = allPositions(network);
  if (!ids.length) return;

  let cx = 0;
  let cy = 0;
  for (const id of ids) {
    cx += positions[id].x;
    cy += positions[id].y;
  }
  cx /= ids.length;
  cy /= ids.length;

  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (const id of ids) {
    const p = positions[id];
    const dx = p.x - cx;
    const dy = p.y - cy;
    network.moveNode(id, dx * cos - dy * sin + cx, dx * sin + dy * cos + cy);
  }
}

/**
 * Select nodes whose connected-edge count >= threshold (faucets/hubs/spam).
 * @param {any} network vis.Network
 * @param {number} threshold
 * @returns {string[]} selected node ids
 */
export function selectHighDegree(network, threshold) {
  const { ids } = allPositions(network);
  const selected = ids.filter((id) => network.getConnectedEdges(id).length >= threshold);
  network.setSelection({ nodes: selected, edges: [] });
  return selected;
}
