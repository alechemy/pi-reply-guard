import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../cli.mjs";
import { inspectCatalog, coverageReport } from "../lib/catalog.mjs";
import { importCorpus, validateCorpus, corpusDigest, parseSubmissions } from "../lib/corpus.mjs";
import { evaluateCorpus, calibrationReport, promotionRecord, promoteRule, reportMarkdown } from "../lib/calibration.mjs";
import { promotionProblems, upper95 } from "../lib/calibration-policy.mjs";
import { auditCandidate } from "../lib/evaluator.mjs";
import { TRANSPORT_VERSION } from "../lib/jev.mjs";
import { PRESERVATION_IDS } from "../lib/preservation.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";

const model = { provider: "fictional", model: "fixture-1.0", adapter: TRANSPORT_VERSION };
function catalog() {
  const value = makeCatalog();
  value.checks.filter((check) => check.kind !== "local").forEach((check) => { if (check.id !== "fictional-9") check.scope = "heading"; });
  return inspectCatalog(value, skill);
}
function sample(index, changes = {}) {
  return { id: `sample-${index}`, group: `group-${index}`, split: "held-out", kind: "style", request: "Write a fictional instruction.", reply: `${index % 2 ? "Acceptable" : "Violation"} sample ${index}.`, labels: { "fictional-9": index % 2 ? "clear" : "violation" }, review: { basis: "human-labeled", reviewer: "fictional-reviewer" }, ...changes };
}
const corpusOf = (records) => importCorpus(records, { name: "fictional", version: "v1" });
function adapter(judge = (_id, body) => body.state.reply?.text.includes("Violation") ? 1 : 0) {
  let calls = 0;
  return { identity: model, available: true, calls: () => calls, async classify(body, options) {
    calls++;
    options.onAttempt();
    return { servedModel: model.model, usage: null, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "bool", probability: judge(id, body) }])) };
  } };
}
const approve = (record) => ({ ...record, review: { decision: "approve", reviewer: "fictional-reviewer", reviewedAt: "2026-01-01T00:00:00.000Z" } });

test("corpus import retains corrections, labels, review origin, and missing context", () => {
  const pair = { schemaVersion: 1, id: "timer-example", split: "development", request: null, source: "fictional-submission", rejected: { reply: "The timer runs hourly. It reads tags, not branches.", labels: { "fictional-9": "violation", "fictional-35": "violation" } }, accepted: { reply: "The timer runs hourly.", labels: { "fictional-9": "clear", "fictional-35": "clear" } }, review: { basis: "human-labeled", reviewer: "fictional-reviewer" } };
  const corpus = corpusOf(pair);
  assert.equal(corpus.records.length, 2);
  assert.equal(corpus.records[1].correctionOf, corpus.records[0].id);
  assert.equal(corpus.records[0].request, null);
  assert.deepEqual(validateCorpus(corpus), corpus);
  assert.deepEqual(parseSubmissions(JSON.stringify(pair)), pair);
  assert.equal(parseSubmissions(JSON.stringify(sample(1)) + "\n" + JSON.stringify(sample(2))).length, 2);
  assert.throws(() => corpusOf({ ...pair, split: "held-out" }), /original request/);
  const edited = structuredClone(corpus); edited.records[0].reply += " Changed.";
  assert.throws(() => validateCorpus(edited), /digest mismatch/);
});

test("corpus validation rejects leakage, hidden content, and unsupported labels", () => {
  for (const records of [
    [sample(1), sample(1)],
    [sample(1), sample(2, { group: "group-1", split: "development" })],
    [sample(1), sample(2, { reply: " Acceptable   sample 1. ", split: "development" })],
    [sample(1), sample(2, { reply: sample(1).reply })],
    [sample(1, { hidden: "PRIVATE" })],
    [sample(1, { conversation: [{ role: "tool", text: "PRIVATE" }] })],
    [sample(1, { labels: { "fictional-9": "maybe" } })],
    [sample(1, { review: { basis: "human-labeled" } })],
    [sample(1, { correctionOf: "missing" })],
    [sample(1, { original: "Unexpected reference." })],
  ]) assert.throws(() => corpusOf(records));
});

test("evaluation reports per-rule errors and excludes raw prose from artifacts", async () => {
  const corpus = corpusOf([sample(0), sample(1)]);
  const { evaluation } = await evaluateCorpus({ corpus, catalog: catalog(), adapter: adapter(() => 1) });
  const report = calibrationReport(corpus, evaluation);
  assert.equal(report.metrics[0].tp, 1);
  assert.equal(report.metrics[0].fp, 1);
  assert.equal(report.metrics[0].falsePositiveRate, 1);
  assert.equal(report.metrics[0].human, 2);
  assert.equal(report.samples.evaluated, 2);
  assert.doesNotMatch(JSON.stringify(evaluation), /Write a fictional instruction|Acceptable sample|Violation sample/);
  assert.match(reportMarkdown(report), /fictional-9/);
  assert.ok(report.latency.meanMs >= 0);
  assert.equal(report.repairs.humanVerifiedMeaningRegressions, null);
});

test("sample, request, input, deadline, and cancellation budgets retain unknown coverage", async () => {
  const corpus = corpusOf([sample(0), sample(1), sample(2)]);
  for (const limits of [{ maxSamples: 1 }, { maxClassifierRequests: 1 }, { maxInputTokens: 1 }]) {
    const remote = adapter();
    const { evaluation } = await evaluateCorpus({ corpus, catalog: catalog(), adapter: remote, limits });
    assert.ok(remote.calls() <= 1);
    assert.equal(evaluation.rows.length, 3);
    assert.ok(calibrationReport(corpus, evaluation).metrics[0].incompleteRate > 0);
  }
  const slow = adapter();
  slow.classify = () => new Promise(() => {});
  const start = performance.now();
  const { evaluation } = await evaluateCorpus({ corpus, catalog: catalog(), adapter: slow, limits: { runDeadlineMs: 20 } });
  assert.ok(performance.now() - start < 1000);
  const unresolved = calibrationReport(corpus, evaluation).metrics[0];
  assert.equal(unresolved.incompleteRate, 1);
  assert.equal(unresolved.falsePositiveRate, null);
  assert.equal(unresolved.missedViolationRate, null);
  assert.equal(unresolved.falsePositiveUpper95, null);
  const controller = new AbortController(); controller.abort();
  const remote = adapter();
  const cancelled = await evaluateCorpus({ corpus, catalog: catalog(), adapter: remote, signal: controller.signal });
  assert.equal(remote.calls(), 0);
  assert.equal(cancelled.evaluation.rows.length, 3);
  for (const limits of [null, [], { maxSamples: 0 }, { unknown: 1 }]) await assert.rejects(evaluateCorpus({ corpus, catalog: catalog(), adapter: remote, limits }), /limit/i);
});

test("missing context, provider failures, and test runs cannot qualify for promotion", async () => {
  const corpus = corpusOf([sample(1, { split: "development", request: null })]);
  const result = await evaluateCorpus({ corpus, catalog: catalog(), adapter: adapter(), split: "development" });
  const record = approve(promotionRecord(corpus, result.evaluation, "fictional-9"));
  assert.ok(promotionProblems(record).some((problem) => problem.includes("held-out")));
  assert.equal(record.metrics.unknownNegative, 1);
  let attempts = 0;
  const failing = adapter(); failing.classify = async () => { attempts++; throw new Error("PRIVATE provider output"); };
  const failed = await evaluateCorpus({ corpus: corpusOf([sample(0), sample(1), sample(2)]), catalog: catalog(), adapter: failing });
  assert.equal(attempts, 1);
  assert.equal(failed.evaluation.rows[0].checks["fictional-9"].incomplete, true);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
  assert.ok(promotionProblems({ ...record, execution: "test" }).some((problem) => problem.includes("Test execution")));
});

test("preservation evaluation measures labeled damage separately from style", async () => {
  const corpus = corpusOf([
    sample(0, { kind: "preservation", original: "Keep the sample for two hours.", reply: "Keep the sample for two minutes.", labels: { "preserve-quantities": "violation" } }),
    sample(1, { kind: "preservation", original: "Keep the other sample for one hour.", reply: "Retain the other sample for one hour.", labels: Object.fromEntries(PRESERVATION_IDS.map((id) => [id, "clear"])) }),
  ]);
  const { evaluation } = await evaluateCorpus({ corpus, catalog: catalog(), adapter: adapter(() => 0) });
  const report = calibrationReport(corpus, evaluation);
  assert.equal(report.samples.preservation, 2);
  assert.equal(report.preservation.humanDamagedPairs, 1);
  assert.equal(report.preservation.damagedPairsAccepted, 1);
  assert.equal(report.preservation.humanPreservedPairs, 1);
  assert.equal(report.preservation.preservedPairsRejected, 0);
  assert.throws(() => promotionRecord(corpus, evaluation, "preserve-quantities"), /semantic style/);
});

test("repair benchmarking uses isolated bounded generations and keeps human review pending", async () => {
  let writes = 0;
  const corpus = corpusOf([sample(0), sample(2)]);
  const result = await evaluateCorpus({ corpus, catalog: catalog(), adapter: adapter(), limits: { maxWriterGenerations: 1 }, writerIdentity: { provider: "fictional", model: "writer-1" }, writer: async () => { writes++; return { text: "Acceptable repaired sample." }; } });
  assert.equal(writes, 1);
  assert.equal(result.evaluation.budget.writerGenerations, 1);
  assert.equal(result.repairDrafts.length, 1);
  assert.equal(result.repairDrafts[0].review.basis, "unreviewed");
  assert.throws(() => corpusOf(result.repairDrafts));
  const report = calibrationReport(corpus, result.evaluation);
  assert.equal(report.repairs.rewritten, 1);
  assert.equal(report.repairs.auditSuccessWithinCap, 1);
  assert.equal(report.repairs.humanVerifiedMeaningRegressions, null);
});

test("held-out promotion requires exact reviewed evidence and remains model-bound", async () => {
  const corpus = corpusOf(Array.from({ length: 200 }, (_, index) => sample(index)));
  const current = catalog();
  const { evaluation } = await evaluateCorpus({ corpus, catalog: current, adapter: adapter(), limits: { maxSamples: 200 } });
  const pending = promotionRecord(corpus, evaluation, "fictional-9");
  assert.equal(pending.metrics.positive, 100);
  assert.equal(pending.metrics.negative, 100);
  assert.ok(upper95(0, 100) < 0.05);
  assert.throws(() => promoteRule({ corpus, evaluation, record: pending, catalog: current, skillText: skill }), /approval/);
  const record = approve(pending);
  assert.deepEqual(promotionProblems(record), []);
  const next = promoteRule({ corpus, evaluation, record, catalog: current, skillText: skill });
  const promoted = inspectCatalog(next, skill);
  assert.equal(promoted.checks.find((check) => check.id === "fictional-9").status, "active");
  assert.match(coverageReport(promoted), /fictional-9: active \(calibrated\)/);
  const audit = await auditCandidate({ catalog: promoted, text: "Violation sample.", request: "Write an instruction.", adapter: adapter() });
  assert.equal(audit.status, "failed");
  const moved = adapter(); moved.identity = { ...model, endpointDigest: "changed" };
  const advisory = await auditCandidate({ catalog: promoted, text: "Violation sample.", request: "Write an instruction.", adapter: moved });
  assert.equal(advisory.status, "passed");
  assert.equal(advisory.checks.find((check) => check.id === "fictional-9").calibration.state, "stale");
  for (const mutate of [
    (value) => { value.checks[8].question.instructions += " Changed."; },
    (value) => { value.checks[8].calibration.threshold = 0.8; },
    (value) => { value.checks[8].calibration.record.evaluatorVersion = "old"; },
  ]) {
    const changed = structuredClone(next); mutate(changed);
    const stale = inspectCatalog(changed, skill).checks.find((check) => check.id === "fictional-9");
    assert.equal(stale.status, "advisory");
    assert.equal(stale.calibration.state, "stale");
  }
  for (const mutate of [
    (value) => { value.metrics.fp = 1; },
    (value) => { value.criteria.minPositive = 1; },
    (value) => { value.definitionDigest = "0".repeat(64); },
    (value) => { value.model.model = "other-1"; },
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assert.throws(() => promoteRule({ corpus, evaluation, record: changed, catalog: current, skillText: skill }), /differs/);
  }
  const synthetic = corpusOf(corpus.records.map((record) => ({ ...record, review: { basis: "synthetic" } })));
  const syntheticEvaluation = { ...evaluation, dataset: { ...evaluation.dataset, digest: synthetic.digest } };
  delete syntheticEvaluation.digest; syntheticEvaluation.digest = corpusDigest(syntheticEvaluation);
  assert.ok(promotionProblems(approve(promotionRecord(synthetic, syntheticEvaluation, "fictional-9"))).some((problem) => problem.includes("human")));
  const badCounts = structuredClone(record); badCounts.metrics.positiveGroups = 1;
  assert.ok(promotionProblems(badCounts).some((problem) => problem.includes("independent group")));
  const badRates = structuredClone(record); badRates.metrics.falsePositiveRate = 0.1;
  assert.ok(promotionProblems(badRates).some((problem) => problem.includes("rates differ")));
});

test("known development examples and modified evaluation artifacts are refused", async () => {
  await assert.rejects(evaluateCorpus({ corpus: corpusOf([sample(1, { reply: "Fictional reply." })]), catalog: catalog(), adapter: adapter() }), /development examples/);
  const corpus = corpusOf([sample(1)]);
  const { evaluation } = await evaluateCorpus({ corpus, catalog: catalog(), adapter: adapter() });
  evaluation.rows[0].checks["fictional-9"].outcome = "violation";
  assert.throws(() => calibrationReport(corpus, evaluation), /digest/);
});

test("CLI stores private artifacts, refuses replacement, and requires remote consent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reply-calibration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.jsonl");
  const output = join(directory, "corpus.json");
  await writeFile(input, JSON.stringify(sample(0)) + "\n" + JSON.stringify(sample(1)));
  const imported = await main(["corpus-import", "--input", input, "--output", output, "--name", "fictional", "--version", "v1"]);
  assert.equal(imported.data.records, 2);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(imported), /Violation sample/);
  await assert.rejects(main(["corpus-import", "--input", input, "--output", output, "--name", "fictional", "--version", "v2"]), /already exists/);
  await assert.rejects(main(["evaluate-corpus", "--corpus", output, "--output", join(directory, "evaluation.json")]), /allow-remote/);
  const corpus = JSON.parse(await readFile(output, "utf8"));
  const { evaluation } = await evaluateCorpus({ corpus, catalog: catalog(), adapter: adapter() });
  const evaluationPath = join(directory, "evaluation.json");
  await writeFile(evaluationPath, JSON.stringify(evaluation));
  const report = join(directory, "report.md");
  await main(["calibration-report", "--corpus", output, "--evaluation", evaluationPath, "--output", report]);
  assert.match(await readFile(report, "utf8"), /fictional-9/);
  const review = join(directory, "review.json");
  await main(["calibration-review", "--corpus", output, "--evaluation", evaluationPath, "--check", "fictional-9", "--output", review]);
  assert.equal(JSON.parse(await readFile(review, "utf8")).review.decision, "pending");
  assert.equal((await stat(review)).mode & 0o777, 0o600);
});
