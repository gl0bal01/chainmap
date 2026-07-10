import { describe, test, expect } from "bun:test";
import { rotateGraph, selectHighDegree } from "../src/render/interaction.js";

/**
 * Minimal FAKE vis.Network stand-in exposing only the surface rotateGraph /
 * selectHighDegree actually call: getPositions, moveNode, getConnectedEdges,
 * setSelection, getSelectedNodes. Node ids are discovered the same way the
 * real implementation discovers them — via getPositions() called with no ids.
 */
function makeFakeNetwork({ positions = {}, edgeCounts = {} } = {}) {
  const state = {};
  for (const [id, p] of Object.entries(positions)) state[id] = { x: p.x, y: p.y };
  const moveCalls = [];
  let selection = { nodes: [], edges: [] };

  return {
    getPositions(ids) {
      if (ids === undefined) {
        const out = {};
        for (const id of Object.keys(state)) out[id] = { ...state[id] };
        return out;
      }
      const list = Array.isArray(ids) ? ids : [ids];
      const out = {};
      for (const id of list) {
        if (Object.prototype.hasOwnProperty.call(state, id)) out[id] = { ...state[id] };
      }
      return out;
    },
    moveNode(id, x, y) {
      moveCalls.push({ id, x, y });
      state[id] = { x, y };
    },
    getConnectedEdges(id) {
      const n = edgeCounts[id] || 0;
      return Array.from({ length: n }, (_, i) => `${id}-edge-${i}`);
    },
    setSelection(sel) {
      selection = sel;
    },
    getSelectedNodes() {
      return selection.nodes;
    },
    // test-only introspection helpers
    _moveCalls: moveCalls,
    _selection: () => selection,
  };
}

describe("rotateGraph", () => {
  test("rotates points 90deg around their centroid", () => {
    // Two nodes on the x-axis, centroid at (1, 0).
    const network = makeFakeNetwork({
      positions: { a: { x: 0, y: 0 }, b: { x: 2, y: 0 } },
    });

    rotateGraph(network, 90);

    expect(network._moveCalls).toHaveLength(2);
    const byId = Object.fromEntries(network._moveCalls.map((c) => [c.id, c]));

    // dx=-1,dy=0 around centroid (1,0) rotated +90deg -> (1, -1)
    expect(byId.a.x).toBeCloseTo(1, 5);
    expect(byId.a.y).toBeCloseTo(-1, 5);
    // dx=1,dy=0 around centroid (1,0) rotated +90deg -> (1, 1)
    expect(byId.b.x).toBeCloseTo(1, 5);
    expect(byId.b.y).toBeCloseTo(1, 5);
  });

  test("is a no-op when there are no nodes", () => {
    const network = makeFakeNetwork({ positions: {} });

    expect(() => rotateGraph(network, 45)).not.toThrow();
    expect(network._moveCalls).toHaveLength(0);
  });

  test("does not mutate positions for a 0deg rotation (identity, within float tolerance)", () => {
    const network = makeFakeNetwork({
      positions: { a: { x: 3, y: -4 }, b: { x: -1, y: 2 } },
    });

    rotateGraph(network, 0);

    const byId = Object.fromEntries(network._moveCalls.map((c) => [c.id, c]));
    expect(byId.a.x).toBeCloseTo(3, 5);
    expect(byId.a.y).toBeCloseTo(-4, 5);
    expect(byId.b.x).toBeCloseTo(-1, 5);
    expect(byId.b.y).toBeCloseTo(2, 5);
  });
});

describe("selectHighDegree", () => {
  test("selects and returns only ids whose connected-edge count meets the threshold", () => {
    const network = makeFakeNetwork({
      positions: { n1: { x: 0, y: 0 }, n2: { x: 1, y: 1 }, n3: { x: 2, y: 2 } },
      edgeCounts: { n1: 1, n2: 3, n3: 5 },
    });

    const selected = selectHighDegree(network, 3);

    expect(selected.sort()).toEqual(["n2", "n3"]);
    expect(network._selection()).toEqual({ nodes: selected, edges: [] });
  });

  test("returns an empty selection when no node meets the threshold", () => {
    const network = makeFakeNetwork({
      positions: { n1: { x: 0, y: 0 } },
      edgeCounts: { n1: 1 },
    });

    const selected = selectHighDegree(network, 5);

    expect(selected).toEqual([]);
    expect(network._selection()).toEqual({ nodes: [], edges: [] });
  });
});
