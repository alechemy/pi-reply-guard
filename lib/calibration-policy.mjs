import { EVALUATOR_VERSION } from "./versions.mjs";

export const PROMOTION_CRITERIA = Object.freeze({ minPositive: 100, minNegative: 100, minGroups: 100, maxFalsePositiveUpper95: 0.05, maxMissUpper95: 0.1, maxUnknown: 0 });
export const canonicalJSON = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
export const ratio = (count, total) => total ? count / total : null;
export function upper95(errors, samples) {
  if (!samples) return null;
  const z = 1.959963984540054;
  const rate = errors / samples;
  return (rate + z * z / (2 * samples) + z * Math.sqrt(rate * (1 - rate) / samples + z * z / (4 * samples * samples))) / (1 + z * z / samples);
}
export function promotionProblems(record) {
  const problems = [];
  if (record?.execution !== "provider") problems.push("Test execution cannot authorize activation.");
  const m = record?.metrics;
  const c = record?.criteria;
  if (record?.schemaVersion !== 1 || typeof record.checkId !== "string" || !/^[a-f0-9]{64}$/.test(record.definitionDigest ?? "") || !/^[a-f0-9]{64}$/.test(record.evaluationDigest ?? "")) problems.push("Invalid evidence identity.");
  if (record?.dataset?.split !== "held-out" || typeof record.dataset.name !== "string" || !record.dataset.name.trim() || typeof record.dataset.version !== "string" || !record.dataset.version.trim() || !/^[a-f0-9]{64}$/.test(record.dataset.digest ?? "")) problems.push("A versioned held-out dataset is required.");
  if (typeof record?.model?.provider !== "string" || !record.model.provider.trim() || typeof record.model.model !== "string" || !record.model.model.trim() || /(?:latest|preview|auto)$/iu.test(record.model.model)) problems.push("A pinned model identity is required.");
  if (!Number.isFinite(record?.threshold) || record.threshold < 0 || record.threshold > 1) problems.push("Invalid violation threshold.");
  if (!same(c, PROMOTION_CRITERIA)) problems.push("Acceptance criteria differ from the supported policy.");
  const counts = ["samples", "positive", "negative", "groups", "positiveGroups", "negativeGroups", "human", "synthetic", "tp", "fp", "tn", "fn", "unknownPositive", "unknownNegative"];
  if (!m || counts.some((key) => !Number.isSafeInteger(m[key]) || m[key] < 0)) return [...problems, "Invalid sample counts."];
  if (m.id !== record.checkId || m.kind !== "style") problems.push("Metrics identify a different check or evaluation kind.");
  if (m.falsePositiveRate !== ratio(m.fp, m.negative - m.unknownNegative) || m.missedViolationRate !== ratio(m.fn, m.positive - m.unknownPositive) || m.falsePositiveUpper95 !== upper95(m.fp, m.negative - m.unknownNegative) || m.missUpper95 !== upper95(m.fn, m.positive - m.unknownPositive) || m.incompleteRate !== ratio(m.unknownPositive + m.unknownNegative, m.samples)) problems.push("Reported rates differ from the observed counts.");
  if (m.positive + m.negative !== m.samples || m.human + m.synthetic !== m.samples || m.tp + m.fn + m.unknownPositive !== m.positive || m.tn + m.fp + m.unknownNegative !== m.negative || m.groups > m.samples) problems.push("Sample counts are inconsistent.");
  if (m.positiveGroups !== m.positive || m.negativeGroups !== m.negative) problems.push("Promotion needs one sample per class and independent group.");
  if (m.human !== m.samples || m.synthetic !== 0) problems.push("Every sample requires a human label or documented human review.");
  if (m.positive < PROMOTION_CRITERIA.minPositive || m.negative < PROMOTION_CRITERIA.minNegative || m.groups < PROMOTION_CRITERIA.minGroups) problems.push("Insufficient independent held-out examples.");
  if (m.unknownPositive + m.unknownNegative > PROMOTION_CRITERIA.maxUnknown) problems.push("Evaluation has unresolved samples.");
  if (upper95(m.fp, m.negative - m.unknownNegative) === null || upper95(m.fp, m.negative - m.unknownNegative) > PROMOTION_CRITERIA.maxFalsePositiveUpper95) problems.push("False-positive upper bound exceeds the acceptance limit.");
  if (upper95(m.fn, m.positive - m.unknownPositive) === null || upper95(m.fn, m.positive - m.unknownPositive) > PROMOTION_CRITERIA.maxMissUpper95) problems.push("Missed-violation upper bound exceeds the acceptance limit.");
  if (record?.review?.decision !== "approve" || typeof record.review.reviewer !== "string" || !record.review.reviewer.trim() || !/^\d{4}-\d{2}-\d{2}T/.test(record.review.reviewedAt ?? "") || !Number.isFinite(Date.parse(record.review.reviewedAt))) problems.push("An explicit, dated human approval is required.");
  return problems;
}
export function calibrationCurrent(check, binding) {
  return check.calibration.state === "calibrated" && check.calibration.record.definitionDigest === binding && check.calibration.record.evaluatorVersion === EVALUATOR_VERSION && check.calibration.threshold === check.calibration.record.threshold && same(check.calibration.model, check.calibration.record.model) && same(check.calibration.dataset, check.calibration.record.dataset);
}
