import { test, expect } from "bun:test";
import { classifyHubs, hubDim } from "../src/sinkFaucet.js";

const edge = (from, to) => ({ from, to });

test("high in-degree, zero out-degree -> sink", () => {
  const edges = [];
  for (let i = 0; i < 8; i++) edges.push(edge(`0xsender${i}`, "0xhub"));
  const result = classifyHubs([], edges, {});
  expect(result.get("0xhub")).toBe("sink");
});

test("high out-degree, zero in-degree -> faucet", () => {
  const edges = [];
  for (let i = 0; i < 8; i++) edges.push(edge("0xhub", `0xrecipient${i}`));
  const result = classifyHubs([], edges, {});
  expect(result.get("0xhub")).toBe("faucet");
});

test("balanced hub (6 in, 6 out) -> not classified", () => {
  const edges = [];
  for (let i = 0; i < 6; i++) edges.push(edge(`0xsender${i}`, "0xhub"));
  for (let i = 0; i < 6; i++) edges.push(edge("0xhub", `0xrecipient${i}`));
  const result = classifyHubs([], edges, {});
  expect(result.has("0xhub")).toBe(false);
});

test("below minDegree -> not classified", () => {
  const edges = [];
  for (let i = 0; i < 5; i++) edges.push(edge(`0xsender${i}`, "0xhub"));
  const result = classifyHubs([], edges, {});
  expect(result.has("0xhub")).toBe(false);
});

test("distinct-counterparty counting: repeated sender counts once", () => {
  const edges = [
    edge("0xsame", "0xhub"),
    edge("0xsame", "0xhub"), // duplicate sender, same edge shape (bundled/parallel tx)
    edge("0xother1", "0xhub"),
    edge("0xother2", "0xhub"),
    edge("0xother3", "0xhub"),
    edge("0xother4", "0xhub"),
    edge("0xother5", "0xhub"),
  ];
  // distinct senders = 6 (0xsame counted once + 5 others) -> meets minDegree
  const result = classifyHubs([], edges, {});
  expect(result.get("0xhub")).toBe("sink");

  // without dedup this would be 7 raw edges but only 6 distinct senders either way;
  // verify the dedup actually matters by dropping one distinct sender below threshold
  const edgesBelow = [
    edge("0xsame", "0xhub"),
    edge("0xsame", "0xhub"),
    edge("0xother1", "0xhub"),
    edge("0xother2", "0xhub"),
    edge("0xother3", "0xhub"),
    edge("0xother4", "0xhub"),
  ];
  // distinct senders = 5 (below default minDegree 6) despite 6 raw edges
  const resultBelow = classifyHubs([], edgesBelow, {});
  expect(resultBelow.has("0xhub")).toBe(false);
});

test("self-loop ignored in degree counts", () => {
  const edges = [
    edge("0xhub", "0xhub"), // self-loop, must not count toward in or out
    edge("0xsender0", "0xhub"),
    edge("0xsender1", "0xhub"),
    edge("0xsender2", "0xhub"),
    edge("0xsender3", "0xhub"),
    edge("0xsender4", "0xhub"),
    edge("0xsender5", "0xhub"),
  ];
  const result = classifyHubs([], edges, {});
  expect(result.get("0xhub")).toBe("sink");

  // isolated self-loop only -> no in/out degree at all -> never classified
  const onlySelfLoop = [edge("0xhub", "0xhub")];
  const resultSelfOnly = classifyHubs([], onlySelfLoop, {});
  expect(resultSelfOnly.has("0xhub")).toBe(false);
});

test("respects custom minDegree/ratio opts", () => {
  const edges = [
    edge("0xa", "0xhub"),
    edge("0xb", "0xhub"),
    edge("0xc", "0xhub"),
    edge("0xhub", "0xd"),
  ];
  // inDeg=3, outDeg=1: default ratio 4 -> 3 >= 1*4 (4) is false -> not classified
  expect(classifyHubs([], edges, {}).has("0xhub")).toBe(false);
  // lower minDegree and ratio -> now qualifies as sink (inDeg 3 >= minDegree 2, 3 >= 1*2)
  const result = classifyHubs([], edges, { minDegree: 2, ratio: 2 });
  expect(result.get("0xhub")).toBe("sink");
});

test("tie under low ratio prefers the larger side (sink on equal degrees)", () => {
  const edges = [];
  for (let i = 0; i < 6; i++) edges.push(edge(`0xin${i}`, "0xhub"));
  for (let i = 0; i < 6; i++) edges.push(edge("0xhub", `0xout${i}`));
  // ratio 1: both isSink and isFaucet math hold true (6>=6*1); equal degrees -> sink
  const result = classifyHubs([], edges, { minDegree: 6, ratio: 1 });
  expect(result.get("0xhub")).toBe("sink");
});

test("candidate addresses come from nodes and/or edges", () => {
  // node present but no edges touching it -> never classified (degree 0 < minDegree)
  const nodes = [{ address: "0xisolated", depth: 0, isRoot: false, alias: null }];
  const result = classifyHubs(nodes, [], {});
  expect(result.size).toBe(0);
});

test("hubDim returns 0.4 for sink/faucet, 1 otherwise", () => {
  expect(hubDim("sink")).toBe(0.4);
  expect(hubDim("faucet")).toBe(0.4);
  expect(hubDim(undefined)).toBe(1);
  expect(hubDim(null)).toBe(1);
  expect(hubDim("other")).toBe(1);
});
