import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { CliUsageError, loadEnvironmentFile, parseCliArgs, startRegistryServer } from "../src/cli.js";

describe("registry CLI", () => {
  it("parses flags and keeps CLI values separate from process environment", () => {
    const options = parseCliArgs([
      "--host=127.0.0.1",
      "--port", "0",
      "--store", "etcd",
      "--log-level", "debug",
      "--default-ttl-seconds", "30",
      "--ui",
      "--ui-dir", "custom-ui",
      "--etcd-endpoint", "https://etcd.example.test:2379",
    ]);
    assert.equal(options.help, false);
    assert.equal(options.overrides.host, "127.0.0.1");
    assert.equal(options.overrides.port, 0);
    assert.equal(options.overrides.store, "etcd");
    assert.equal(options.overrides.logLevel, "debug");
    assert.equal(options.overrides.defaultTtlSeconds, 30);
    assert.equal(options.overrides.ui, true);
    assert.equal(options.overrides.uiDir, "custom-ui");
    assert.equal(options.overrides.etcd?.endpoint, "https://etcd.example.test:2379");

    const config = loadConfig({}, { ...options.overrides, minTtlSeconds: 1 });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 0);
    assert.equal(config.store, "etcd");
    assert.equal(config.logLevel, "debug");
    assert.equal(config.ui, true);
    assert.ok(config.uiDir.endsWith("custom-ui"));
  });

  it("rejects unknown options and malformed values", () => {
    assert.throws(() => parseCliArgs(["--unknown"]), CliUsageError);
    assert.throws(() => parseCliArgs(["--port", "not-a-number"]), CliUsageError);
    assert.throws(() => parseCliArgs(["--store", "redis"]), CliUsageError);
    assert.throws(() => parseCliArgs(["--log-level", "verbose"]), CliUsageError);
    assert.throws(() => parseCliArgs(["--host"]), CliUsageError);
    assert.throws(() => parseCliArgs(["--ui=false"]), CliUsageError);
    assert.throws(() => loadConfig({ REGISTRY_UI: "sometimes" }), /must be a boolean/);
    assert.throws(() => loadConfig({ REGISTRY_LOG_LEVEL: "verbose" }), /must be one of/);
  });

  it("loads the log level from the environment and lets the CLI override it", () => {
    assert.equal(loadConfig({ REGISTRY_LOG_LEVEL: "warn" }).logLevel, "warn");
    assert.equal(loadConfig({ REGISTRY_LOG_LEVEL: "warn" }, { logLevel: "trace" }).logLevel, "trace");
  });

  it("loads either supported UI environment flag", () => {
    assert.equal(loadConfig({ REGISTRY_UI: "true" }).ui, true);
    assert.equal(loadConfig({ REGISTRY_ENABLE_UI: "1" }).ui, true);
    assert.equal(loadConfig({ REGISTRY_UI: "false", REGISTRY_ENABLE_UI: "true" }).ui, false);
  });

  it("loads a dotenv-compatible file without overriding explicit environment values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a2a-registry-cli-"));
    const path = join(directory, "registry.env");
    const key = "A2A_REGISTRY_CLI_TEST_VALUE";
    const previous = process.env[key];
    delete process.env[key];
    await writeFile(path, `# comment\nexport ${key} = \"from-file\"\n`, "utf8");
    try {
      await loadEnvironmentFile(path);
      assert.equal(process.env[key], "from-file");
      await writeFile(path, `${key}=new-value\n`, "utf8");
      await loadEnvironmentFile(path);
      assert.equal(process.env[key], "from-file");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts and gracefully closes a server runtime", async () => {
    const runtime = await startRegistryServer(loadConfig({}, {
      host: "127.0.0.1",
      port: 0,
      minTtlSeconds: 1,
      defaultTtlSeconds: 5,
      maxTtlSeconds: 10,
      pruneIntervalMs: 100,
      logLevel: "silent",
    }));
    try {
      assert.equal(runtime.logger.level, "silent");
      const address = runtime.server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ready", store: "memory" });
    } finally {
      await runtime.close();
      await runtime.close();
    }
    assert.equal(runtime.server.listening, false);
  });
});
