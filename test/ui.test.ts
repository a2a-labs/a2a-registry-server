import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { startRegistryServer, type RegistryRuntime } from "../src/cli.js";

function baseUrl(runtime: RegistryRuntime): string {
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function start(ui: boolean, uiDir: string): Promise<RegistryRuntime> {
  return startRegistryServer(loadConfig({}, {
    host: "127.0.0.1",
    port: 0,
    minTtlSeconds: 1,
    defaultTtlSeconds: 5,
    maxTtlSeconds: 10,
    pruneIntervalMs: 100,
    logLevel: "silent",
    ui,
    uiDir,
  }));
}

describe("registry web UI", () => {
  it("keeps the JSON service root when UI hosting is disabled", async () => {
    const runtime = await start(false, "/unused");
    try {
      const response = await fetch(`${baseUrl(runtime)}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
      assert.equal((await response.json() as { name: string }).name, "A2A Registry Server");
    } finally {
      await runtime.close();
    }
  });

  it("serves static assets, HEAD requests, SPA routes, and APIs together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a2a-registry-ui-"));
    const outsideDirectory = await mkdtemp(join(tmpdir(), "a2a-registry-ui-outside-"));
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<!doctype html><title>Registry UI</title>", "utf8");
    await writeFile(join(directory, "assets", "index.js"), "globalThis.registryUi = true;", "utf8");
    const outsideFile = join(outsideDirectory, "secret.txt");
    await writeFile(outsideFile, "not public", "utf8");
    await symlink(outsideFile, join(directory, "assets", "escape.txt"));
    const runtime = await start(true, directory);
    const url = baseUrl(runtime);

    try {
      const root = await fetch(`${url}/`);
      assert.equal(root.status, 200);
      assert.match(root.headers.get("content-type") ?? "", /^text\/html/u);
      assert.match(await root.text(), /Registry UI/u);

      const head = await fetch(`${url}/`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.match(head.headers.get("content-type") ?? "", /^text\/html/u);
      assert.equal(await head.text(), "");

      const asset = await fetch(`${url}/assets/index.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript/u);
      assert.match(await asset.text(), /registryUi/u);

      const spa = await fetch(`${url}/agents/test-agent`);
      assert.equal(spa.status, 200);
      assert.match(spa.headers.get("content-type") ?? "", /^text\/html/u);
      assert.match(await spa.text(), /Registry UI/u);

      const agents = await fetch(`${url}/v1/agents`);
      assert.equal(agents.status, 200);
      assert.match(agents.headers.get("content-type") ?? "", /^application\/json/u);
      assert.equal((await agents.json() as { total: number }).total, 0);

      assert.equal((await fetch(`${url}/health/ready`)).status, 200);
      assert.match((await fetch(`${url}/metrics`)).headers.get("content-type") ?? "", /^text\/plain/u);

      const unknownApi = await fetch(`${url}/v1/not-a-route`);
      assert.equal(unknownApi.status, 404);
      assert.match(unknownApi.headers.get("content-type") ?? "", /^application\/json/u);

      const traversal = await fetch(`${url}/..%2Foutside.txt`);
      assert.equal(traversal.status, 400);

      const symlinkEscape = await fetch(`${url}/assets/escape.txt`);
      assert.equal(symlinkEscape.status, 400);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it("returns a helpful response when the configured UI build is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a2a-registry-ui-missing-"));
    const missing = join(directory, "dist");
    const runtime = await start(true, missing);
    try {
      const response = await fetch(`${baseUrl(runtime)}/`);
      assert.equal(response.status, 503);
      assert.match(await response.text(), /build not found/u);
      assert.equal((await fetch(`${baseUrl(runtime)}/health/ready`)).status, 200);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
