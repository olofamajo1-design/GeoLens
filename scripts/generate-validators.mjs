import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import task from "../src/schemas/agent-task.v1.json" with { type: "json" };
import result from "../src/schemas/agent-result.v1.json" with { type: "json" };
import discovery from "../src/schemas/discovery-documents.v1.json" with { type: "json" };
import fixtureTask from "../src/schemas/newsroom-fixture-task.v1.json" with { type: "json" };
import fixtureOutput from "../src/schemas/newsroom-fixture-output.v1.json" with { type: "json" };
import { agents } from "../src/newsroom/registry.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const standalone = require("ajv/dist/standalone/index.js");
const ajv = new Ajv2020({ strict: true, code: { source: true, esm: true } });
ajv.addSchema(task, "task");
ajv.addSchema(result, "result");
ajv.addSchema(discovery, "discovery");
ajv.addSchema(fixtureOutput, "fixtureOutput");
ajv.addSchema(fixtureTask, "fixtureTask");

const directory = new URL("../src/newsroom/generated/", import.meta.url);
mkdirSync(directory, { recursive: true });
const generated = standalone(ajv, {
  validateTask: "task",
  validateResult: "result",
  validateDiscovery: "discovery",
  validateFixtureTask: "fixtureTask",
  validateFixtureOutput: "fixtureOutput",
});
// Ajv emits a CommonJS reference for its Unicode length helper even in ESM mode.
const esm = generated.replaceAll('require("ajv/dist/runtime/ucs2length").default', "ucs2length");
if (/\brequire\s*\(/.test(esm)) {
  throw new Error("A generated validator uses an unexpected CommonJS helper");
}
writeFileSync(
  new URL("validators.mjs", directory),
  'import unicodeLength from "ajv/dist/runtime/ucs2length.js";\nconst ucs2length = typeof unicodeLength === "function" ? unicodeLength : unicodeLength.default;\n' + esm,
);

const promptDirectory = new URL("../prompts/newsroom/", import.meta.url);
const files = readdirSync(promptDirectory).sort();
const prompts = [];
const manifest = Object.keys(agents).map((agentId) => {
  const versions = [];
  for (const file of files) {
    const match = /^(GL-AGENT-00[1-8])\.v([1-9][0-9]*)\.md$/.exec(file);
    if (match?.[1] !== agentId) continue;
    const version = Number(match[2]);
    if (!Number.isSafeInteger(version) || version > 2_147_483_647) throw new Error("Invalid prompt version " + file);
    const text = readFileSync(new URL(file, promptDirectory), "utf8");
    const digest = createHash("sha256").update(text).digest("hex");
    prompts.push({ agentId, version, text, digest });
    versions.push({ agentId, version, digest });
  }
  if (versions.length === 0) throw new Error("Missing fixture prompt for " + agentId);
  return versions.sort((first, second) => second.version - first.version)[0];
});
writeFileSync(new URL("prompts.mjs", directory),
  "export const fixturePrompts = " + JSON.stringify(prompts) + ";\n"
  + "export const promptManifest = " + JSON.stringify(manifest) + ";\n");
