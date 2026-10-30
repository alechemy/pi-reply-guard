#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { coverageReport, loadCatalog } from "./lib/catalog.mjs";
import { createView } from "./lib/markdown.mjs";
import { evaluateLocal, planSemanticChecks } from "./lib/local-checks.mjs";

export async function main(args) {
  const [command, ...options] = args;
  if (!["coverage", "check-catalog", "audit-local"].includes(command)) throw new Error("Usage: node cli.mjs <coverage|check-catalog|audit-local> --catalog FILE --skill FILE [--text FILE] [--request FILE] [--provenance FILE]");
  const flags = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    if (!["--catalog", "--skill", "--text", "--request", "--provenance"].includes(flag) || flags.has(flag) || !options[index + 1] || options[index + 1].startsWith("--")) throw new Error("Invalid or repeated CLI option.");
    flags.set(flag, options[index + 1]);
  }
  if (!flags.has("--catalog") || !flags.has("--skill")) throw new Error("Both --catalog and --skill are required.");
  const result = await loadCatalog(flags.get("--catalog"), flags.get("--skill"));
  if (command === "coverage") return { text: coverageReport(result), code: result.valid ? 0 : 2 };
  if (command === "check-catalog") return { data: { valid: result.valid, rules: result.current.rules.length, checks: result.checks.length, active: result.checks.filter((check) => check.status === "active" && !check.stale).length, advisory: result.checks.filter((check) => check.status === "advisory" && !check.stale).length, catalogDigest: result.catalogDigest, issues: result.issues }, code: result.valid ? 0 : 2 };
  if (!flags.has("--text")) throw new Error("audit-local requires --text FILE.");
  const text = await readFile(flags.get("--text"), "utf8");
  const request = flags.has("--request") ? await readFile(flags.get("--request"), "utf8") : "";
  const verbatim = flags.has("--provenance") ? JSON.parse(await readFile(flags.get("--provenance"), "utf8")) : [];
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
    const detail = error instanceof SyntaxError ? "Invalid JSON in the catalog or provenance file." : error.code ? `File operation failed (${error.code}). Check the supplied paths and permissions.` : error.message;
    process.stderr.write(`Reply guard: ${detail}\n`);
    process.exitCode = 2;
  });
}
