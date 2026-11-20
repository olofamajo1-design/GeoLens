import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import task from "../src/schemas/agent-task.v1.json" with { type: "json" };
import result from "../src/schemas/agent-result.v1.json" with { type: "json" };

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const standalone = require("ajv/dist/standalone/index.js");
const ajv = new Ajv2020({ strict: true, code: { source: true, esm: true } });
ajv.addSchema(task, "task");
ajv.addSchema(result, "result");

const directory = new URL("../src/newsroom/generated/", import.meta.url);
mkdirSync(directory, { recursive: true });
const generated = standalone(ajv, {
  validateTask: "task",
  validateResult: "result",
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
