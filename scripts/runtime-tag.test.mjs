import assert from "node:assert/strict";
import test from "node:test";
import { runtimeTagExists } from "./runtime-tag.mjs";
const manifest = { repository: "ghcr.io/gauge-sh/gauge-runtime", version: "0.1.0" };
function fetchFor(status, authStatus = 200) {
  let calls = 0;
  return async (url) => {
    if (calls++ === 0) {
      assert.match(url, /:pull,push$/);
      return new Response(JSON.stringify({ token: "registry-token" }), { status: authStatus });
    }
    return new Response(null, { status });
  };
}
test("only authorized registry 404 permits first publication; existing tags are reused", async () => {
  for (const status of [200, 404])
    assert.equal(await runtimeTagExists(manifest, { actor: "publisher", token: "test", fetchImpl: fetchFor(status) }), status === 200);
});
test("registry authorization, server and network errors fail closed", async () => {
  for (const status of [401, 403, 429, 500])
    await assert.rejects(runtimeTagExists(manifest, { actor: "publisher", token: "test", fetchImpl: fetchFor(status) }), /tag availability/);
  await assert.rejects(runtimeTagExists(manifest, { actor: "publisher", token: "test", fetchImpl: fetchFor(404, 403) }), /authentication/);
  await assert.rejects(runtimeTagExists(manifest, { actor: "publisher", token: "test", fetchImpl: async () => { throw new Error("Network unavailable"); } }), /Network/);
});
test("native image tags are checked independently of the multi-platform version", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return urls.length === 1 ? new Response(JSON.stringify({ token: "registry-token" })) : new Response(null, { status: 404 });
  };
  assert.equal(await runtimeTagExists(manifest, { actor: "publisher", token: "test", tag: "0.1.0-arm64", fetchImpl }), false);
  assert.equal(urls[1], "https://ghcr.io/v2/gauge-sh/gauge-runtime/manifests/0.1.0-arm64");
});
