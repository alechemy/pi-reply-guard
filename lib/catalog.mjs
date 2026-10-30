import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Ajv from "ajv";

export const PREPROCESSING_VERSION = "markdown-1";
export const DETECTOR_VERSION = "literal-1";
export const digest = (text) => createHash("sha256").update(text).digest("hex");
const schema = JSON.parse(await readFile(new URL("../schemas/catalog.schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

export function parseSkill(text) {
  const start = text.indexOf("## Patterns to detect and fix");
  if (start < 0) throw new Error("Skill has no numbered-patterns section.");
  const matches = [...text.slice(start).matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)];
  if (!matches.length) throw new Error("Skill has no numbered rules.");
  const rules = matches.map((match, index) => {
    const offset = start + match.index;
    let end = matches[index + 1] ? start + matches[index + 1].index : text.length;
    const heading = text.slice(offset, end).search(/\n###? /);
    if (heading >= 0) end = offset + heading;
    const body = text.slice(offset, end).trimEnd();
    const startLine = text.slice(0, offset).split("\n").length;
    return { number: Number(match[1]), title: match[2].replace(/\.$/, ""), startLine, endLine: startLine + body.split("\n").length - 1, digest: digest(body) };
  });
  if (rules.some((rule, index) => rule.number !== index + 1)) throw new Error("Skill rule numbers must be unique, ordered, and contiguous from 1.");
  return { file: "SKILL.md", digest: digest(text), policyDigest: digest(text.slice(0, start)), rules };
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function inspectCatalog(catalog, skillText) {
  catalog = structuredClone(catalog);
  if (!validate(catalog)) throw new Error(`Invalid rule catalog: ${validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join(". ")}`);
  const current = parseSkill(skillText);
  const issues = [];
  const ids = new Set();
  const sources = new Map();
  for (const source of catalog.source.rules) {
    if (sources.has(source.number)) throw new Error(`Duplicate source rule ${source.number}.`);
    sources.set(source.number, source);
  }
  for (const check of catalog.checks) {
    if (ids.has(check.id)) throw new Error(`Duplicate check ID ${check.id}.`);
    ids.add(check.id);
    if (!sources.has(check.sourceRule)) throw new Error(`Check ${check.id} references a missing source rule.`);
    for (const label of ["violation", "clear", "exception"]) {
      if (!check.examples.some((example) => example.label === label)) throw new Error(`Check ${check.id} needs a ${label} example.`);
    }
    if (check.kind === "local" && ((check.predicate.id === "em-dash" && check.sourceRule !== 13) || (check.predicate.id === "curly-quotes" && check.sourceRule !== 19))) throw new Error(`Local predicate has the wrong source: ${check.id}.`);
  }
  for (const predicate of ["em-dash", "curly-quotes"]) {
    const matching = catalog.checks.filter((check) => check.kind === "local" && check.predicate.id === predicate);
    if (matching.length !== 1 || matching[0].status !== "active") throw new Error(`Catalog requires one active ${predicate} predicate.`);
  }
  for (const process of catalog.processRequirements) {
    if (process.observableChecks.some((id) => !ids.has(id))) throw new Error(`Unknown observable check for ${process.id}.`);
  }
  const policyChanged = current.policyDigest !== catalog.source.policyDigest;
  const versionChanged = catalog.preprocessingVersion !== PREPROCESSING_VERSION || catalog.detectorVersion !== DETECTOR_VERSION;
  if (policyChanged) issues.push({ kind: "policy-changed", checks: [...ids] });
  if (versionChanged) issues.push({ kind: "implementation-version-changed", checks: [...ids] });
  for (const rule of current.rules) {
    const mapped = catalog.checks.filter((check) => check.sourceRule === rule.number);
    const source = sources.get(rule.number);
    if (!source || !mapped.length) issues.push({ kind: "unmapped-rule", rule: rule.number, checks: [] });
    else if (source.digest !== rule.digest || source.title !== rule.title || source.startLine !== rule.startLine || source.endLine !== rule.endLine) issues.push({ kind: "source-changed", rule: rule.number, checks: mapped.map((check) => check.id) });
  }
  for (const rule of sources.values()) {
    if (!current.rules.some((source) => source.number === rule.number)) issues.push({ kind: "removed-rule", rule: rule.number, checks: catalog.checks.filter((check) => check.sourceRule === rule.number).map((check) => check.id) });
  }
  if (current.digest !== catalog.source.digest && !issues.length) issues.push({ kind: "source-file-changed", checks: [...ids] });
  const staleIds = new Set(issues.flatMap((issue) => issue.checks));
  const checks = catalog.checks.map((check) => ({
    ...check, source: sources.get(check.sourceRule), rulesetVersion: catalog.rulesetVersion,
    preprocessingVersion: catalog.preprocessingVersion, detectorVersion: catalog.detectorVersion,
    protectionPolicy: catalog.protectionPolicy, stale: staleIds.has(check.id),
    definitionDigest: digest(JSON.stringify({ check, source: sources.get(check.sourceRule), policy: catalog.source.policyDigest, protection: catalog.protectionPolicy, preprocessing: catalog.preprocessingVersion, detector: catalog.detectorVersion })),
  }));
  return freeze({ valid: issues.length === 0, issues, checks, current, catalogDigest: digest(JSON.stringify(catalog)), catalog });
}

export async function loadCatalog(catalogPath, skillPath) {
  const [catalogText, skillText] = await Promise.all([readFile(catalogPath, "utf8"), readFile(skillPath, "utf8")]);
  return inspectCatalog(JSON.parse(catalogText), skillText);
}

export function coverageReport(result) {
  const lines = ["# Unslop rule coverage", "", `Ruleset: ${result.catalog.rulesetVersion}. Source status: ${result.valid ? "current" : "stale or incomplete"}.`, "",
    `Catalog SHA-256: \`${result.catalogDigest}\`.`, `Source: [SKILL.md](SKILL.md). Skill SHA-256: \`${result.current.digest}\`.`,  "",
    "This report describes catalog mappings. Semantic checks are uncalibrated advisory definitions. Their examples exercise behavior and do not establish writing accuracy.", "",
    "| Rule | Checks | Disposition | Source lines |", "| --- | --- | --- | --- |"];
  for (const rule of result.current.rules) {
    const checks = result.checks.filter((check) => check.sourceRule === rule.number);
    lines.push(`| ${rule.number}. ${rule.title.replaceAll("|", "\\|")} | ${checks.map((check) => `\`${check.id}\``).join(", ") || "Unmapped"} | ${checks.map((check) => `${check.id}: ${check.stale ? "stale" : check.status}`).join(", ") || "Incomplete"} | ${rule.startLine}-${rule.endLine} |`);
  }
  lines.push("", `Checks: ${result.checks.length}. Active: ${result.checks.filter((check) => check.status === "active" && !check.stale).length}. Advisory: ${result.checks.filter((check) => check.status === "advisory" && !check.stale).length}. Stale: ${result.checks.filter((check) => check.stale).length}.`, "",
    "Only the em-dash and curly-quotation predicates are active. Both require eligible prose and resolved protection. Semantic promotion needs a separate reviewed held-out record. Rules 9, 25, 34, and 35 have high calibration priority.", "",
    "## Process requirements", "", ...result.catalog.processRequirements.map((process) => `- ${process.requirement} Internal execution cannot be verified from the reply. Observable checks: ${process.observableChecks.join(", ")}.`));
  if (result.issues.length) lines.push("", "## Drift", "", ...result.issues.map((issue) => `- ${issue.kind}${issue.rule ? ` at rule ${issue.rule}` : ""}.`));
  return lines.join("\n") + "\n";
}
