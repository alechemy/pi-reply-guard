import { inspectCatalog } from "./catalog.mjs";
import { auditCandidate, validateAuditLimits } from "./evaluator.mjs";
import { createView } from "./markdown.mjs";
import { repairReply } from "./repair.mjs";
import { PRESERVATION_IDS, PRESERVATION_VERSION } from "./preservation.mjs";
import { TRANSPORT_VERSION } from "./jev.mjs";
import { EVALUATOR_VERSION } from "./versions.mjs";
import { corpusDigest, proseKey, validateCorpus } from "./corpus.mjs";
import { PROMOTION_CRITERIA, promotionProblems, ratio, same, upper95 } from "./calibration-policy.mjs";

export const CORPUS_LIMITS = Object.freeze({ maxSamples: 100, maxClassifierRequests: 200, maxInputTokens: 2000000, maxWriterGenerations: 20, runDeadlineMs: 600000, maxRewrites: 2, writerDeadlineMs: 60000 });
function limitsOf(supplied) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("Corpus limits must be an object.");
  const limits = { ...CORPUS_LIMITS, ...supplied };
  for (const [key, value] of Object.entries(limits)) if (!Object.hasOwn(CORPUS_LIMITS, key) || !Number.isSafeInteger(value) || value < (["maxRewrites", "maxWriterGenerations"].includes(key) ? 0 : 1) || (key.endsWith("Ms") && value > 2147483647)) throw new Error("Invalid corpus evaluation limit.");
  return limits;
}
function benchmarkAudit(audit, ids) {
  const checks = audit.checks.map((check) => ids.includes(check.id) ? { ...check, disposition: "active" } : check);
  const incomplete = audit.incomplete || checks.some((check) => check.disposition === "active" && check.incomplete);
  return { ...audit, checks, incomplete, status: checks.some((check) => check.disposition === "active" && check.outcome === "violation") ? "failed" : incomplete ? "incomplete" : "passed" };
}
export async function evaluateCorpus({ corpus: input, catalog, adapter, split = "held-out", limits: supplied = {}, auditLimits = {}, writer, writerIdentity, signal }) {
  const corpus = validateCorpus(input);
  const limits = limitsOf(supplied);
  auditLimits = validateAuditLimits(auditLimits);
  if (!catalog.valid || !["development", "held-out"].includes(split)) throw new Error("Evaluation needs a current catalog and an explicit dataset split.");
  if (writer && (!writerIdentity?.provider || !writerIdentity.model)) throw new Error("Repair evaluation requires an explicit writer identity.");
  const records = corpus.records.filter((record) => record.split === split);
  if (!records.length) throw new Error("The selected split has no samples.");
  const ids = new Set([...catalog.checks.map((check) => check.id), ...PRESERVATION_IDS]);
  if (records.some((record) => Object.keys(record.labels).some((id) => !ids.has(id)))) throw new Error("Corpus labels reference unknown checks.");
  const examples = new Set(catalog.checks.flatMap((check) => check.examples.map((example) => proseKey(example.reply))));
  if (split === "held-out" && records.some((record) => [record.reply, record.original].filter(Boolean).some((text) => examples.has(proseKey(text))))) throw new Error("Held-out prose overlaps development examples in the catalog.");
  const model = structuredClone(adapter.identity);
  const controller = new AbortController();
  const cancellation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const started = performance.now();
  const deadline = started + limits.runDeadlineMs;
  const budget = { classifierRequests: 0, inputTokens: 0, writerGenerations: 0 };
  const bounded = { identity: model, available: adapter.available, async classify(body, options) {
    if (!bounded.available || cancellation.aborted || performance.now() >= deadline || budget.classifierRequests >= limits.maxClassifierRequests || budget.inputTokens + options.maxRequestBytes > limits.maxInputTokens) throw new Error("Corpus classifier budget exhausted.");
    budget.classifierRequests++;
    budget.inputTokens += options.maxRequestBytes;
    try {
      const result = await adapter.classify(body, { ...options, timeoutMs: Math.min(options.timeoutMs, Math.max(1, Math.ceil(deadline - performance.now()))) });
      if (Number.isSafeInteger(result.usage?.input) && result.usage.input > options.maxRequestBytes) budget.inputTokens += result.usage.input - options.maxRequestBytes;
      if (result.reason) bounded.available = false;
      return result;
    } catch {
      bounded.available = false;
      throw new Error("Classifier unavailable during corpus evaluation.");
    }
  } };
  const rows = [];
  const repairDrafts = [];
  const timer = setTimeout(() => controller.abort(), limits.runDeadlineMs);
  try {
    for (const [index, record] of records.entries()) {
      const row = { id: record.id, candidateHash: proseKey(record.reply), contextComplete: record.request !== null, checks: {}, latencyMs: null, classifierMs: null, requests: 0, inputTokens: 0, usage: [], preservationAccepted: null };
      rows.push(row);
      if (index >= limits.maxSamples || cancellation.aborted || performance.now() >= deadline) { row.reason = "run-limit"; continue; }
      const began = performance.now();
      const before = { ...budget };
      const input = { catalog, adapter: bounded, text: record.reply, request: record.request ?? "", conversation: record.conversation, verbatim: record.verbatim, limits: auditLimits, signal: cancellation };
      const audits = [];
      const audit = async (args) => { const value = await auditCandidate(args); audits.push(value); return value; };
      const original = await audit({ ...input, ...(record.kind === "preservation" ? { baseline: createView(record.original, { request: input.request, verbatim: record.verbatim }) } : {}) });
      row.classifierMs = performance.now() - began;
      if (!bounded.available) row.reason = "classifier-unavailable";
      row.checks = Object.fromEntries(original.checks.filter((check) => Object.hasOwn(record.labels, check.id)).map((check) => [check.id, { outcome: check.outcome, incomplete: check.incomplete === true }]));
      if (record.kind === "preservation") row.preservationAccepted = original.preservation.accepted;
      if (writer && bounded.available && record.kind === "style" && record.request !== null) {
        const targets = Object.keys(record.labels);
        const result = await repairReply({ ...input, maxRewrites: Math.min(limits.maxRewrites, Math.max(0, limits.maxWriterGenerations - budget.writerGenerations)), writerDeadlineMs: limits.writerDeadlineMs,
          writer: async (...args) => {
            if (cancellation.aborted || performance.now() >= deadline || budget.writerGenerations >= limits.maxWriterGenerations) return { error: "corpus-writer-limit" };
            budget.writerGenerations++;
            return writer(...args);
          },
          audit: async (args) => benchmarkAudit(args.baseline === undefined ? original : await audit(args), targets),
        });
        row.repair = { needed: benchmarkAudit(original, targets).status !== "passed", rewrites: result.rewrites, termination: result.termination, selectedHash: result.selected?.id ?? null, acceptedByAudit: result.selected?.audit.status === "passed" && result.selected.preserved && !result.selected.audit.incomplete, writerUsage: result.writerUsage };
        for (const [candidateIndex, candidate] of result.candidates.entries()) if (candidateIndex > 0) repairDrafts.push({ id: `${record.id}:repair:${candidateIndex}`, group: record.group, split: "development", kind: "preservation", request: record.request, original: record.reply, reply: candidate.text, conversation: record.conversation, verbatim: record.verbatim, labels: {}, review: { basis: "unreviewed" }, source: `${corpus.name}:${corpus.version}:${record.id}` });
      }
      row.latencyMs = performance.now() - began;
      row.requests = budget.classifierRequests - before.classifierRequests;
      row.inputTokens = budget.inputTokens - before.inputTokens;
      row.usage = audits.flatMap((audit) => audit.usage);
    }
  } finally { clearTimeout(timer); controller.abort(); }
  const data = {
    schemaVersion: 1, dataset: { name: corpus.name, version: corpus.version, digest: corpus.digest, split },
    execution: model.adapter === TRANSPORT_VERSION ? "provider" : "test", model,
    writer: writer ? writerIdentity : null, evaluatorVersion: EVALUATOR_VERSION, preservationVersion: PRESERVATION_VERSION,
    catalogDigest: catalog.catalogDigest, bindings: Object.fromEntries(catalog.checks.filter((check) => check.kind !== "local").map((check) => [check.id, { definitionDigest: check.calibrationDigest, threshold: check.calibration.threshold, sourceRule: check.sourceRule }])),
    limits, auditLimits, budget, elapsedMs: performance.now() - started, rows,
  };
  return { evaluation: { ...data, digest: corpusDigest(data) }, repairDrafts };
}
function checkedRows(corpusInput, evaluation) {
  const corpus = validateCorpus(corpusInput);
  const { digest, ...data } = evaluation;
  if (evaluation.schemaVersion !== 1 || digest !== corpusDigest(data) || evaluation.dataset?.digest !== corpus.digest || evaluation.dataset.name !== corpus.name || evaluation.dataset.version !== corpus.version || !["development", "held-out"].includes(evaluation.dataset.split) || !Array.isArray(evaluation.rows)) throw new Error("Evaluation does not match the corpus or its recorded digest.");
  const records = corpus.records.filter((record) => record.split === evaluation.dataset.split);
  const rows = new Map(evaluation.rows.map((row) => [row.id, row]));
  if (rows.size !== records.length || rows.size !== evaluation.rows.length || records.some((record) => !rows.has(record.id) || rows.get(record.id).candidateHash !== proseKey(record.reply) || rows.get(record.id).contextComplete !== (record.request !== null))) throw new Error("Evaluation sample identities or coverage differ from the corpus.");
  return records.map((record) => ({ record, row: rows.get(record.id) }));
}
export function calibrationReport(corpus, evaluation) {
  const entries = checkedRows(corpus, evaluation);
  const checks = new Map();
  for (const { record, row } of entries) for (const [id, label] of Object.entries(record.labels)) {
    if (!checks.has(id)) checks.set(id, { id, kind: record.kind, sourceRule: evaluation.bindings?.[id]?.sourceRule ?? null, samples: 0, positive: 0, negative: 0, human: 0, synthetic: 0, tp: 0, fp: 0, tn: 0, fn: 0, unknownPositive: 0, unknownNegative: 0, groupIds: new Set(), positiveGroupIds: new Set(), negativeGroupIds: new Set() });
    const m = checks.get(id);
    const positive = label === "violation";
    m.samples++; m[positive ? "positive" : "negative"]++;
    m[record.review.basis === "synthetic" ? "synthetic" : "human"]++;
    m.groupIds.add(record.group);
    m[positive ? "positiveGroupIds" : "negativeGroupIds"].add(record.group);
    const answer = row.checks?.[id];
    if (!row.contextComplete || !answer || answer.incomplete || !["clear", "violation", "inapplicable"].includes(answer.outcome)) m[positive ? "unknownPositive" : "unknownNegative"]++;
    else m[answer.outcome === "violation" ? positive ? "tp" : "fp" : positive ? "fn" : "tn"]++;
  }
  const metrics = [...checks.values()].map(({ groupIds, positiveGroupIds, negativeGroupIds, ...m }) => ({ ...m, groups: groupIds.size, positiveGroups: positiveGroupIds.size, negativeGroups: negativeGroupIds.size, falsePositiveRate: ratio(m.fp, m.negative - m.unknownNegative), missedViolationRate: ratio(m.fn, m.positive - m.unknownPositive), falsePositiveUpper95: upper95(m.fp, m.negative - m.unknownNegative), missUpper95: upper95(m.fn, m.positive - m.unknownPositive), incompleteRate: ratio(m.unknownPositive + m.unknownNegative, m.samples) }));
  const styleRows = entries.filter(({ record }) => record.kind === "style");
  const repairRows = styleRows.filter(({ row }) => row.repair);
  const preservation = entries.filter(({ record }) => record.kind === "preservation" && record.review.basis !== "synthetic");
  const damaged = preservation.filter(({ record }) => Object.values(record.labels).includes("violation"));
  const preserved = preservation.filter(({ record }) => PRESERVATION_IDS.every((id) => ["clear", "exception"].includes(record.labels[id])));
  const latencies = entries.map(({ row }) => row.latencyMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return {
    dataset: evaluation.dataset, execution: evaluation.execution, model: evaluation.model, metrics,
    samples: { total: entries.length, evaluated: latencies.length, style: styleRows.length, preservation: entries.length - styleRows.length },
    latency: { meanMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null, p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null },
    repairs: { evaluated: repairRows.length, needed: repairRows.filter(({ row }) => row.repair.needed).length, rewritten: repairRows.filter(({ row }) => row.repair.rewrites > 0).length, rewriteFrequency: ratio(repairRows.filter(({ row }) => row.repair.rewrites > 0).length, repairRows.length), auditSuccessWithinCap: repairRows.filter(({ row }) => row.repair.needed && row.repair.acceptedByAudit).length, meanAddedMs: repairRows.length ? repairRows.reduce((sum, { row }) => sum + row.latencyMs - row.classifierMs, 0) / repairRows.length : null, humanVerifiedMeaningRegressions: null },
    preservation: { humanDamagedPairs: damaged.length, damagedPairsAccepted: damaged.filter(({ row }) => row.preservationAccepted === true).length, humanPreservedPairs: preserved.length, preservedPairsRejected: preserved.filter(({ row }) => row.preservationAccepted === false).length },
    budget: evaluation.budget,
  };
}
export function promotionRecord(corpus, evaluation, checkId) {
  const report = calibrationReport(corpus, evaluation);
  const binding = evaluation.bindings?.[checkId];
  const metrics = report.metrics.find((metric) => metric.id === checkId && metric.kind === "style");
  if (!binding || !metrics) throw new Error("Promotion requires an evaluated semantic style check with labels.");
  return { schemaVersion: 1, checkId, definitionDigest: binding.definitionDigest, dataset: evaluation.dataset, execution: evaluation.execution, model: evaluation.model, evaluatorVersion: evaluation.evaluatorVersion, threshold: binding.threshold, metrics, criteria: PROMOTION_CRITERIA, evaluationDigest: evaluation.digest, review: { decision: "pending", reviewer: "", reviewedAt: null } };
}
export function promoteRule({ corpus, evaluation, record, catalog, skillText }) {
  const expected = { ...promotionRecord(corpus, evaluation, record.checkId), review: record.review };
  if (!same(expected, record)) throw new Error("Promotion record differs from the evaluated evidence.");
  const problems = promotionProblems(record);
  const check = catalog.checks.find((check) => check.id === record.checkId);
  if (!catalog.valid || !check || record.definitionDigest !== check.calibrationDigest || record.evaluatorVersion !== EVALUATOR_VERSION || evaluation.preservationVersion !== PRESERVATION_VERSION || record.threshold !== check.calibration.threshold) problems.push("Evaluation is stale for this rule or implementation.");
  if (problems.length) throw new Error(`Promotion refused: ${problems.join(" ")}`);
  const next = structuredClone(catalog.catalog);
  const target = next.checks.find((check) => check.id === record.checkId);
  target.status = "active";
  target.statusReason = "Approved against versioned human-reviewed held-out evidence.";
  target.calibration = { state: "calibrated", threshold: record.threshold, model: record.model, dataset: record.dataset, priority: target.calibration.priority, record: structuredClone(record) };
  inspectCatalog(next, skillText);
  return next;
}
export function reportMarkdown(report) {
  const rate = (value) => value === null ? "unknown" : `${(value * 100).toFixed(1)}%`;
  const lines = ["# Reply guard calibration", "", `Dataset: ${report.dataset.name}, version ${report.dataset.version}, split ${report.dataset.split}. Execution: ${report.execution}.`, `Classifier: ${report.model.provider}/${report.model.model}.`, "", "| Check | Kind | Samples | Human | False positives | Missed violations | Incomplete |", "| --- | --- | --- | --- | --- | --- | --- |"];
  const priority = (metric) => { const index = [9, 25, 34, 35].indexOf(metric.sourceRule); return index < 0 ? 4 : index; };
  for (const m of [...report.metrics].sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id))) lines.push(`| ${m.id} | ${m.kind} | ${m.samples} | ${m.human} | ${m.fp}/${m.negative - m.unknownNegative} (${rate(m.falsePositiveRate)}) | ${m.fn}/${m.positive - m.unknownPositive} (${rate(m.missedViolationRate)}) | ${rate(m.incompleteRate)} |`);
  lines.push("", `Evaluated ${report.samples.evaluated} of ${report.samples.total} samples. Mean added audit/repair latency: ${report.latency.meanMs?.toFixed(1) ?? "unknown"} ms. P95: ${report.latency.p95Ms?.toFixed(1) ?? "unknown"} ms.`, `Repair benchmarks: ${report.repairs.evaluated}. Rewrite frequency: ${rate(report.repairs.rewriteFrequency)}. Audit-accepted repairs within the cap: ${report.repairs.auditSuccessWithinCap}/${report.repairs.needed} needed. Human review of generated repairs is pending.`, `Human-labeled damaged preservation pairs: ${report.preservation.humanDamagedPairs}. Incorrectly accepted: ${report.preservation.damagedPairsAccepted}. Human-labeled preserved pairs: ${report.preservation.humanPreservedPairs}. Rejected: ${report.preservation.preservedPairsRejected}.`, "", "Promotion requires explicit review of held-out evidence. Test executions and synthetic labels cannot authorize activation.");
  return lines.join("\n") + "\n";
}
