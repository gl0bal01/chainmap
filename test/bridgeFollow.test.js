import { test, expect, describe } from "bun:test";
import { findBridgeExits, matchReleases, followBridgeExit } from "../src/bridgeFollow.js";

const REG = {
  "1": {
    "0xbbbb000000000000000000000000000000000001": { name: "Test Bridge", kind: "lock-mint", destChains: [137] },
    "0xbbbb000000000000000000000000000000000002": { name: "LP Bridge", kind: "liquidity", destChains: [10] },
  },
};

const edge = (o) => ({
  from: "0xdead000000000000000000000000000000000001",
  to: "0xbbbb000000000000000000000000000000000001",
  amountText: "50", symbol: "ETH", timeStamp: "1700000000", hash: "0xh1",
  methodId: "", methodArgs: [], ...o,
});

describe("findBridgeExits", () => {
  test("detects a lock-mint bridge edge; recipient defaults to depositor", () => {
    const exits = findBridgeExits([edge({})], REG, 1);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      bridgeAddr: "0xbbbb000000000000000000000000000000000001",
      name: "Test Bridge", kind: "lock-mint", destChains: [137],
      amountText: "50", symbol: "ETH", timeStamp: "1700000000",
      depositor: "0xdead000000000000000000000000000000000001",
      recipient: "0xdead000000000000000000000000000000000001", // defaults to depositor
      hash: "0xh1",
    });
  });

  test("uses a decoded recipient arg (by name) when present and valid", () => {
    const exits = findBridgeExits([edge({
      methodArgs: [{ type: "address", value: "0xFEED000000000000000000000000000000000009", name: "recipient" }],
    })], REG, 1);
    expect(exits[0].recipient).toBe("0xfeed000000000000000000000000000000000009"); // lowercased
  });

  test("liquidity bridge is returned but tagged kind:liquidity", () => {
    const exits = findBridgeExits([edge({ to: "0xbbbb000000000000000000000000000000000002" })], REG, 1);
    expect(exits[0].kind).toBe("liquidity");
  });

  test("ignores edges whose 'to' is not a registered bridge, and other chains", () => {
    expect(findBridgeExits([edge({ to: "0x0000000000000000000000000000000000000009" })], REG, 1)).toEqual([]);
    expect(findBridgeExits([edge({})], REG, 137)).toEqual([]);
    expect(findBridgeExits([], REG, 1)).toEqual([]);
    expect(findBridgeExits([edge({})], null, 1)).toEqual([]);
  });

  test("does not mutate its inputs (pure over plain edge arrays)", () => {
    const edges = [edge({})];
    const snapshot = JSON.stringify(edges);
    findBridgeExits(edges, REG, 1);
    expect(JSON.stringify(edges)).toBe(snapshot);
  });

  test("honors entry.recipientParam when the recipient arg isn't named 'recipient'", () => {
    const reg = { "1": { "0xbbbb000000000000000000000000000000000003": { name: "Custom", kind: "lock-mint", destChains: [137], recipientParam: "user" } } };
    const e = { from: "0xdead000000000000000000000000000000000001", to: "0xbbbb000000000000000000000000000000000003",
      amountText: "5", symbol: "ETH", timeStamp: "1700000000", hash: "0xc",
      methodId: "0x00000000", methodArgs: [{ type: "address", value: "0xFEED000000000000000000000000000000000009", name: "user" }] };
    expect(findBridgeExits([e], reg, 1)[0].recipient).toBe("0xfeed000000000000000000000000000000000009");
  });
});

const EXIT = {
  recipient: "0xfeed000000000000000000000000000000000009",
  amountText: "50", timeStamp: "1700000000",
};
const cand = (o) => ({ to: "0xfeed000000000000000000000000000000000009", timeStamp: "1700000600", amountText: "50", hash: "0xr", symbol: "WETH", ...o });

describe("matchReleases", () => {
  test("recipient + forward-time + tight amount => exact, sorted first", () => {
    const r = matchReleases(EXIT, [cand({})]);
    expect(r).toHaveLength(1);
    expect(r[0].confidence).toBe("exact");
    expect(r[0].matched.recipient).toBe(true);
    expect(r[0].matched.timeDeltaSecs).toBe(600);
  });

  test("excludes wrong recipient, and releases before the exit (time must move forward)", () => {
    expect(matchReleases(EXIT, [cand({ to: "0x0000000000000000000000000000000000000001" })])).toEqual([]);
    expect(matchReleases(EXIT, [cand({ timeStamp: "1699999999" })])).toEqual([]);
  });

  test("excludes releases outside the time window", () => {
    expect(matchReleases(EXIT, [cand({ timeStamp: String(1700000000 + 90000) })], { windowSecs: 86400 })).toEqual([]);
  });

  test("loose amount => amount+time; indeterminate amount => weak", () => {
    expect(matchReleases(EXIT, [cand({ amountText: "49" })])[0].confidence).toBe("amount+time"); // ~2% off
    expect(matchReleases(EXIT, [cand({ amountText: "indeterminate" })])[0].confidence).toBe("weak");
  });

  test("orders exact before amount+time before weak", () => {
    const r = matchReleases(EXIT, [
      cand({ amountText: "indeterminate", hash: "0xw" }),
      cand({ amountText: "49", hash: "0xa" }),
      cand({ amountText: "50", hash: "0xe" }),
    ]);
    expect(r.map((x) => x.hash)).toEqual(["0xe", "0xa", "0xw"]);
  });

  test("boundary: dt === windowSecs is KEPT; dt === windowSecs+1 is excluded", () => {
    const base = 1700000000;
    const inWindow = matchReleases(EXIT, [cand({ timeStamp: String(base + 86400) })], { windowSecs: 86400 });
    expect(inWindow).toHaveLength(1);
    const outWindow = matchReleases(EXIT, [cand({ timeStamp: String(base + 86401) })], { windowSecs: 86400 });
    expect(outWindow).toEqual([]);
  });

  test("boundary: dt === 0 (same second) is KEPT", () => {
    expect(matchReleases(EXIT, [cand({ timeStamp: "1700000000" })])).toHaveLength(1);
  });

  test("boundary: amount delta exactly at exactTol (0.005) => exact; just over => amount+time", () => {
    // exit amount 50; 0.005 tol => 50 +/- 0.25. 50.25 is exactly at the boundary (delta = 0.005) -> exact.
    expect(matchReleases(EXIT, [cand({ amountText: "50.25" })])[0].confidence).toBe("exact");
    // 50.26 -> delta = 0.0052 > 0.005 -> amount+time
    expect(matchReleases(EXIT, [cand({ amountText: "50.26" })])[0].confidence).toBe("amount+time");
  });

  test("boundary: amount delta exactly at looseTol (0.05) => amount+time; just over => weak", () => {
    // 50 * 1.05 = 52.5 => delta = 0.05 exactly -> amount+time
    expect(matchReleases(EXIT, [cand({ amountText: "52.5" })])[0].confidence).toBe("amount+time");
    // 52.6 => delta = 0.052 > 0.05 -> weak
    expect(matchReleases(EXIT, [cand({ amountText: "52.6" })])[0].confidence).toBe("weak");
  });

  test("empty/malformed recipient yields no matches (no '' === '' spurious match)", () => {
    expect(matchReleases({ recipient: "", amountText: "50", timeStamp: "1700000000" }, [cand({ to: "" })])).toEqual([]);
  });
});

// Minimal fake limiter (runs fn immediately) + fake client.
const limiter = { run: (fn) => fn() };
function fakeClient(byAction) {
  return { chainId: null, setChainId(id) { this.chainId = id; },
    async fetchAction(address, action) { return (byAction[action] || []); } };
}

const EXIT4 = { recipient: "0xfeed000000000000000000000000000000000009", amountText: "50", timeStamp: "1700000000" };

describe("followBridgeExit", () => {
  test("sets dest chain, fetches recipient inbound, returns ranked candidates", async () => {
    const client = fakeClient({
      txlist: [{ to: "0xFEED000000000000000000000000000000000009", value: "50000000000000000000", tokenDecimal: "", timeStamp: "1700000600", hash: "0xr1" }],
      tokentx: [],
    });
    const r = await followBridgeExit({ client, limiter, exit: EXIT4, destChainId: 137, offset: 20 });
    expect(client.chainId).toBe(137);
    expect(r).toHaveLength(1);
    expect(r[0].hash).toBe("0xr1");
    expect(r[0].confidence).toBe("exact"); // 50e18 / 18 decimals == 50
  });

  test("resolves [] (never throws) when a fetch errors", async () => {
    const client = { setChainId() {}, async fetchAction() { throw new Error("boom"); } };
    await expect(followBridgeExit({ client, limiter, exit: EXIT4, destChainId: 137 })).resolves.toEqual([]);
  });

  test("filters non-recipient inbound out via matchReleases", async () => {
    const client = fakeClient({ txlist: [{ to: "0x0000000000000000000000000000000000000001", value: "50000000000000000000", timeStamp: "1700000600", hash: "0xx" }], tokentx: [] });
    expect(await followBridgeExit({ client, limiter, exit: EXIT4, destChainId: 137 })).toEqual([]);
  });

  test("finds a release delivered as an internal tx (txlistinternal)", async () => {
    const client = fakeClient({
      txlist: [], tokentx: [],
      txlistinternal: [{ to: "0xFEED000000000000000000000000000000000009", value: "50000000000000000000", tokenDecimal: "", timeStamp: "1700000600", hash: "0xint1" }],
    });
    const r = await followBridgeExit({ client, limiter, exit: EXIT4, destChainId: 137, offset: 20 });
    expect(r.map((x) => x.hash)).toContain("0xint1");
  });
});
