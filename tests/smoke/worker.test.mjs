import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("the built Worker serves health and renders the synthetic newsroom", { timeout: 45_000 }, async () => {
  const port = 4174;
  const baseUrl = "http://127.0.0.1:" + port;
  const server = spawn(process.execPath, [
    "node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  server.stdout.on("data", (chunk) => { logs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; });
  const closed = once(server, "close");

  try {
    // Probe the Worker itself. Vite's URL banner varies with terminal formatting.
    const startupSignal = AbortSignal.timeout(30_000);
    let health;
    while (!startupSignal.aborted && server.exitCode === null && server.signalCode === null) {
      try {
        health = await fetch(baseUrl + "/health", { signal: startupSignal });
        break;
      } catch (error) {
        if (startupSignal.aborted) break;
        if (error.cause?.code !== "ECONNREFUSED") {
          throw new Error("Worker preview readiness request failed:\n" + logs, { cause: error });
        }
        await delay(250);
      }
    }

    assert.ok(health, "Worker preview did not answer /health:\n" + logs);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", mode: "synthetic" });

    const home = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Synthetic preview/);
    assert.match(html, /No reporting was performed/);
    assert.match(html, /GL-AGENT-008/);
  } finally {
    server.kill();
    await closed;
  }
});
