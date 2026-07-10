import { test, expect } from "bun:test";
import { GraphStore } from "../src/graphStore.js";
import { bundleEdges } from "../src/display.js";

const A = (c) => "0x" + c.repeat(40);

test("addEdge flags hasData from non-empty input calldata", () => {
  const s = new GraphStore();
  s.addNode(A("a"), { depth: 0 });
  s.addNode(A("b"), { depth: 1 });
  s.addNode(A("c"), { depth: 1 });
  s.addNode(A("d"), { depth: 1 });

  const plain = s.addEdge({ action: "txlist", group: "normal", color: "#0", from: A("a"), to: A("b"), tx: { value: "1", hash: "0x1", input: "0x" } });
  expect(plain.hasData).toBe(false); // "0x" == plain transfer

  const call = s.addEdge({ action: "txlist", group: "normal", color: "#0", from: A("a"), to: A("c"), tx: { value: "0", hash: "0x2", input: "0xa9059cbb0000" } });
  expect(call.hasData).toBe(true); // non-empty calldata == contract call
  expect(call.rawInput).toBe("0xa9059cbb0000"); // full calldata kept verbatim

  expect(plain.rawInput).toBe("0x"); // stored, but hasData false
  const none = s.addEdge({ action: "txlistinternal", group: "internal", color: "#0", from: A("a"), to: A("d"), tx: { value: "0", hash: "0x3" } });
  expect(none.hasData).toBe(false); // no input field (internal/token)
  expect(none.rawInput).toBe(""); // non-string/absent input -> ""
});

test("bundleEdges flags hasData if any collapsed member carried calldata", () => {
  const edges = [
    { key: "k1", from: "0xa", to: "0xb", symbol: "ETH", tokenContract: "", color: "#0", group: "normal", amountText: "1", hasData: false },
    { key: "k2", from: "0xa", to: "0xb", symbol: "ETH", tokenContract: "", color: "#0", group: "normal", amountText: "2", hasData: true },
  ];
  const [b] = bundleEdges(edges);
  expect(b.count).toBe(2);
  expect(b.hasData).toBe(true);
});
