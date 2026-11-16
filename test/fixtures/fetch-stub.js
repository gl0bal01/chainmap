// Preloaded into the build CLI by test/buildKnownAddresses.test.js so CLI tests never
// reach the network. FETCH_STUB picks the scenario:
//   (unset)         every fetch throws
//   empty-registry  GitHub API ok, registry files empty (drifted)
//   github-403      GitHub API refuses
//   verify-fail     fixture registry; every cited (--verify-sources) page fetch throws
//   verify-absent   fixture registry; every cited page answers 200 without the address
import { readFileSync } from "node:fs";

const mode = process.env.FETCH_STUB ?? "";
const fx = (f) => JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REGISTRY = "https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/";

globalThis.fetch = async (url) => {
  const u = String(url);
  if (mode && u.startsWith("https://api.github.com/")) {
    if (mode === "github-403") return json({ message: "rate limited" }, 403);
    return json({ sha: "0".repeat(40), commit: { committer: { date: "2026-11-13T00:00:00Z" } } });
  }
  if (mode && u.startsWith(REGISTRY)) {
    const empty = mode === "empty-registry";
    if (u.endsWith("/addresses.json")) return json(empty ? {} : fx("superchain-addresses.json"));
    if (u.endsWith("/chainList.json")) return json(empty ? [] : fx("superchain-chainList.json"));
  }
  if (mode === "verify-absent") return new Response("no address on this page", { status: 200 });
  throw new Error(`unexpected fetch in test: ${u}`);
};
