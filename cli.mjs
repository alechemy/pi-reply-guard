#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { auditCandidate } from "./lib/evaluator.mjs";
import { createJevAdapter, JEV_MODEL } from "./lib/jev.mjs";
import { coverageReport, loadCatalog } from "./lib/catalog.mjs";
import { createView } from "./lib/markdown.mjs";
import { evaluateLocal, planSemanticChecks } from "./lib/local-checks.mjs";

async function loadRegistry() {
  const sdk = await import(process.env.PI_PACKAGE_ROOT ? pathToFileURL(join(process.env.PI_PACKAGE_ROOT, "dist/index.js")).href : "@earendil-works/pi-coding-agent");
  return new sdk.ModelRegistry(await sdk.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }));
}

export async function main(args, { registry, fetch: requestFetch } = {}) {
  const [command, ...options] = args;
  if (!["coverage", "check-catalog", "audit-local", "audit"].includes(command)) throw new Error("Usage: node cli.mjs <coverage|check-catalog|audit-local|audit> --catalog FILE --skill FILE [--text FILE] [--request FILE] [--provenance FILE] [--conversation FILE] [--limits FILE] [--model PROVIDER/ID]");
  const flags = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    if (!["--catalog", "--skill", "--text", "--request", "--provenance", "--conversation", "--limits", "--model"].includes(flag) || flags.has(flag) || !options[index + 1] || options[index + 1].startsWith("--")) throw new Error("Invalid or repeated CLI option.");
    flags.set(flag, options[index + 1]);
  }
  if (command !== "audit" && ["--conversation", "--limits", "--model"].some((flag) => flags.has(flag))) throw new Error("Conversation, limits, and model options require the audit command.");
  if (command === "audit" && !flags.has("--request")) throw new Error("audit requires --request FILE for contextual exceptions.");
  if (!flags.has("--catalog") || !flags.has("--skill")) throw new Error("Both --catalog and --skill are required.");
  const result = await loadCatalog(flags.get("--catalog"), flags.get("--skill"));
  if (command === "coverage") return { text: coverageReport(result), code: result.valid ? 0 : 2 };
  if (command === "check-catalog") return { data: { valid: result.valid, rules: result.current.rules.length, checks: result.checks.length, active: result.checks.filter((check) => check.status === "active" && !check.stale).length, advisory: result.checks.filter((check) => check.status === "advisory" && !check.stale).length, catalogDigest: result.catalogDigest, issues: result.issues }, code: result.valid ? 0 : 2 };
  if (!flags.has("--text")) throw new Error(`${command} requires --text FILE.`);
  const text = await readFile(flags.get("--text"), "utf8");
  const request = flags.has("--request") ? await readFile(flags.get("--request"), "utf8") : "";
  const verbatim = flags.has("--provenance") ? JSON.parse(await readFile(flags.get("--provenance"), "utf8")) : [];
  if (command === "audit") {
    const conversation = flags.has("--conversation") ? JSON.parse(await readFile(flags.get("--conversation"), "utf8")) : [];
    const limits = flags.has("--limits") ? JSON.parse(await readFile(flags.get("--limits"), "utf8")) : {};
    const adapter = createJevAdapter(registry ?? await loadRegistry(), flags.get("--model") ?? JEV_MODEL, { fetch: requestFetch });
    const data = await auditCandidate({ catalog: result, text, request, verbatim, conversation, limits, adapter });
    return { data, code: data.status === "failed" ? 1 : data.coverageComplete ? 0 : 2 };
  }
  const view = createView(text, { verbatim });
  const local = evaluateLocal(result, view);
  const semantic = planSemanticChecks(result, view, request).map(({ id, outcome, disposition, reason }) => ({ id, outcome, disposition, ...(reason ? { reason } : {}) }));
  return { data: { local, semantic, catalogIssues: result.issues }, code: local.status === "failed" ? 1 : local.incomplete ? 2 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(result.text ?? `${JSON.stringify(result.data, null, 2)}\n`);
    process.exitCode = result.code;
  }).catch((error) => {
    const detail = error instanceof SyntaxError ? "Invalid JSON in a supplied input file." : error.code ? `File operation failed (${error.code}). Check the supplied paths and permissions.` : error.message;
    process.stderr.write(`Reply guard: ${detail}\n`);
    process.exitCode = 2;
  });
}
