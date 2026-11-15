// Preloaded into the build CLI by test/buildKnownAddresses.test.js: answers the
// GitHub API + raw registry fetches with an empty (drifted) registry, and fails
// any other URL so the test can never reach the network.
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (u.startsWith("https://api.github.com/")) return json({ sha: "0".repeat(40), commit: { committer: { date: "2026-11-13T00:00:00Z" } } });
  if (u.endsWith("/addresses.json")) return json({});
  if (u.endsWith("/chainList.json")) return json([]);
  throw new Error(`unexpected fetch in test: ${u}`);
};
