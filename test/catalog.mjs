import assert from "node:assert/strict";
import test from "node:test";
import { coverageReport, inspectCatalog, parseSkill } from "../lib/catalog.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";
import { createView } from "../lib/markdown.mjs";
import { evaluateLocal, planSemanticChecks } from "../lib/local-checks.mjs";

const inspect = (catalog = makeCatalog(), source = skill) => inspectCatalog(catalog, source);

test("catalog covers every numbered rule and resolves check metadata", () => {
  const result = inspect();
  assert.equal(result.valid, true);
  assert.equal(result.current.rules.length, 36);
  for (let number = 1; number <= 36; number++) assert.ok(result.checks.some((check) => check.sourceRule === number));
  for (const check of result.checks) {
    assert.equal(check.source.number, check.sourceRule);
    assert.match(check.source.digest, /^[a-f0-9]{64}$/);
    assert.match(check.definitionDigest, /^[a-f0-9]{64}$/);
    assert.ok(check.protectionPolicy);
    assert.ok(check.rulesetVersion);
  }
  const report = coverageReport(result);
  assert.equal(report.split("\n").filter((line) => /^\| \d+\./.test(line)).length, 36);
  assert.match(report, /Active: 2/);
  assert.match(report, /Internal execution cannot be verified/);
});

test("schema and cross-reference failures are explicit", () => {
  for (const mutate of [
    (catalog) => { catalog.checks[0].id = catalog.checks[1].id; },
    (catalog) => { catalog.checks[0].status = "active"; },
    (catalog) => { catalog.checks[0].calibration.threshold = 1.1; },
    (catalog) => { catalog.checks[0].sourceRule = 99; },
    (catalog) => { catalog.source.rules.push(catalog.source.rules[0]); },
    (catalog) => { delete catalog.checks[0].question.criteria.false; },
    (catalog) => { catalog.checks[0].examples = catalog.checks[0].examples.filter((example) => example.label !== "exception"); },
    (catalog) => { catalog.processRequirements[0].observableChecks = ["missing"]; },
    (catalog) => { catalog.checks.at(-1).predicate = "arbitrary-regex"; },
    (catalog) => { catalog.checks.at(-1).predicate.codePoints = [65]; },
    (catalog) => { catalog.checks.at(-1).status = "advisory"; },
    (catalog) => { catalog.checks.at(-1).scope = "heading"; },
    (catalog) => { catalog.checks.pop(); },
  ]) {
    const catalog = makeCatalog();
    mutate(catalog);
    assert.throws(() => inspect(catalog));
  }
});

test("source drift identifies changed, added, removed, and unmapped rules", () => {
  const edited = skill.replace("Fictional policy 9.", "Changed policy 9.");
  const result = inspect(makeCatalog(), edited);
  assert.equal(result.valid, false);
  assert.deepEqual(result.checks.filter((check) => check.stale).map((check) => check.id), ["fictional-9"]);
  assert.equal(inspect(makeCatalog(), skill + "37. **New rule.** New policy.\n").issues[0].kind, "unmapped-rule");
  assert.ok(inspect(makeCatalog(), skill.replace(/36\. \*\*Rule 36\.\*\*[^\n]+\n/, "")).issues.some((issue) => issue.kind === "removed-rule"));
  const catalog = makeCatalog();
  catalog.checks = catalog.checks.filter((check) => check.sourceRule !== 1);
  catalog.processRequirements[0].observableChecks = [];
  assert.ok(inspect(catalog).issues.some((issue) => issue.kind === "unmapped-rule"));
});

test("policy and preprocessing changes invalidate all affected checks", () => {
  const policy = inspect(makeCatalog(), skill.replace("Preserve meaning.", "Preserve every quantity."));
  assert.ok(policy.checks.every((check) => check.stale));
  const catalog = makeCatalog();
  catalog.preprocessingVersion = "obsolete";
  const stale = inspect(catalog);
  assert.equal(evaluateLocal(stale, createView("Valid prose.")).status, "incomplete");
  assert.ok(planSemanticChecks(stale, createView("Valid prose."), "Request.").every((job) => job.outcome === "unavailable"));
});

test("changed questions, thresholds, or exceptions change definition digests", () => {
  const before = inspect().checks[0].definitionDigest;
  for (const mutate of [
    (check) => { check.calibration.threshold = 0.8; },
    (check) => { check.exceptions = "A changed exception."; },
    (check) => { check.question.instructions = "A changed question?"; },
  ]) {
    const catalog = makeCatalog();
    mutate(catalog.checks[0]);
    assert.notEqual(inspect(catalog).checks[0].definitionDigest, before);
  }
});

test("semantic plans retain exact context and do not claim an executed audit", () => {
  const catalog = inspect();
  const request = "x".repeat(5000) + " Reproduce the supplied text exactly.";
  const text = "A sentence. ".repeat(2000) + "The final sentence.";
  const conversation = [{ role: "user", text: "An earlier correction." }];
  const jobs = planSemanticChecks(catalog, createView(text), request, conversation);
  assert.equal(jobs.length, 36);
  assert.ok(jobs.every((job) => job.outcome === "pending" && job.disposition === "advisory" && job.threshold === 0.9));
  assert.ok(jobs.every((job) => job.state.request === request && job.state.reply === text));
  assert.deepEqual(jobs[0].state.conversation, conversation);
  assert.throws(() => planSemanticChecks(catalog, createView(text), request, [{ role: "tool", text: "Private payload" }]));
  assert.equal(evaluateLocal(catalog, createView(text)).semanticEvaluation, "not-executed");
});

test("scoped checks can be inapplicable with a recorded reason", () => {
  const catalog = makeCatalog();
  catalog.checks[0].scope = "heading";
  const jobs = planSemanticChecks(inspect(catalog), createView("One paragraph."), "Write prose.");
  assert.equal(jobs[0].outcome, "inapplicable");
  assert.match(jobs[0].reason, /No passages/);
  const heading = planSemanticChecks(inspect(catalog), createView("# Heading\n\nProse."), "Write prose.");
  assert.deepEqual(heading[0].rangeIds, ["p1"]);
});

test("catalog results are immutable snapshots", () => {
  const input = makeCatalog();
  const snapshot = inspect(input);
  input.checks[0].question.instructions = "Changed after inspection.";
  assert.notEqual(snapshot.checks[0].question.instructions, input.checks[0].question.instructions);
  assert.throws(() => { snapshot.checks[0].calibration.threshold = 0.1; }, TypeError);
});

test("process numbering is excluded and malformed source fails", () => {
  assert.equal(parseSkill(skill.replace("Preserve meaning.", "1. Scan.\n2. Edit.")).rules.length, 36);
  assert.throws(() => parseSkill("1. **No section.** Text."));
  assert.throws(() => parseSkill(skill.replace("9. **Rule 9.", "8. **Rule 9.")));
});
