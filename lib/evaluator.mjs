import { digest } from "./catalog.mjs";
import { createView, eligibility, location } from "./markdown.mjs";
import { evaluateLocal, planSemanticChecks } from "./local-checks.mjs";
import { JudgmentCache } from "./judgment-cache.mjs";
import { probability } from "./jev.mjs";

export const EVALUATOR_VERSION = "per-rule-1";
export const AUDIT_LIMITS = Object.freeze({ auditDeadlineMs: 5000, classifierConcurrency: 2, maxClassifierRequests: 8, maxInputTokens: 64000, perQuestionTokens: 32000, perRequestTokens: 64000 });
const overlap = 256;
export const estimateInput = (body) => Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
const intersects = (a, b) => a.start < b.end && a.end > b.start;
const rangeOf = ({ id, start, end }) => ({ passageId: id, start, end });

function validatedLimits(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Audit limits must be an object.");
  const limits = { ...AUDIT_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(AUDIT_LIMITS, key) || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid audit limit: ${key}.`);
  }
  if (limits.perQuestionTokens > 32000 || limits.perRequestTokens > 64000) throw new Error("Audit limits exceed the pinned Jev context limits.");
  return limits;
}

function boundary(text, offset) {
  return offset > 0 && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset] ?? "") ? offset - 1 : offset;
}

function unitFor(plan, view, request, conversation, start, end) {
  const window = { start: boundary(view.text, Math.max(0, start - overlap)), end: boundary(view.text, Math.min(view.text.length, end + overlap)) };
  const targets = view.passages.filter((passage) => plan.rangeIds.includes(passage.id) && intersects(passage, { start, end }))
    .map((passage) => ({ passageId: passage.id, start: Math.max(start, passage.start), end: Math.min(end, passage.end) }));
  const unresolved = view.uncertainSpans.filter((span) => intersects(span, window) && eligibility(view, span) === "uncertain");
  const state = {
    evaluationPolicy: plan.state.evaluationPolicy, request, conversation,
    reply: { ...window, text: view.text.slice(window.start, window.end), totalLength: view.text.length },
    passages: view.passages.filter((passage) => intersects(passage, window)).map(({ id, kind, start, end, listed, quoted }) => ({ id, kind, start, end, listed, quoted })),
    targetPassages: [...new Set(targets.map((range) => range.passageId))], targetRanges: targets,
    protections: view.protections.filter((span) => intersects(span, window)).map(({ start, end, kind, sourceId }) => ({ start, end, kind, ...(sourceId ? { sourceId } : {}) })),
    unresolved,
    newWrappers: view.wrapperChanges.filter((span) => intersects(span, window)).map(({ start, end, kind }) => ({ start, end, kind })),
  };
  return { plan, state, targets, window, uncertain: unresolved.some((span) => targets.some((target) => intersects(span, target))), question: plan.question };
}

function* unitsFor(plan, view, request, conversation, limits, expired) {
  const whole = unitFor(plan, view, request, conversation, 0, view.text.length);
  const fits = (unit) => estimateInput({ state: unit.state, questions: { [plan.id]: unit.question } }) <= Math.min(limits.perQuestionTokens, limits.perRequestTokens);
  if (fits(whole)) { yield whole; return; }
  if (["reply", "conversation"].includes(plan.scope)) {
    yield { reason: "Exact full-reply context exceeds the per-question limit." };
    return;
  }
  let start = 0;
  while (start < view.text.length && !expired()) {
    let low = start;
    let high = Math.min(view.text.length, start + limits.perQuestionTokens);
    while (low < high && !expired()) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(unitFor(plan, view, request, conversation, start, middle))) low = middle;
      else high = middle - 1;
    }
    if (expired()) return;
    let end = boundary(view.text, low);
    const paragraphEnd = view.text.lastIndexOf("\n\n", end - 2);
    if (paragraphEnd > start + (end - start) / 2) end = paragraphEnd + 2;
    if (end <= start) { yield { reason: "Exact request, conversation, or overlapping context exceeds the per-question limit." }; return; }
    const unit = unitFor(plan, view, request, conversation, start, end);
    if (!fits(unit)) { yield { reason: "Exact chunk exceeds the per-question limit." }; return; }
    if (unit.targets.length) yield unit;
    start = end;
  }
}

function missingRanges(expected, executed) {
  return expected.flatMap((range) => {
    let remaining = [{ ...range }];
    for (const done of executed.filter((item) => item.passageId === range.passageId)) {
      remaining = remaining.flatMap((item) => !intersects(item, done) ? [item] : [
        ...(done.start > item.start ? [{ ...item, end: done.start }] : []),
        ...(done.end < item.end ? [{ ...item, start: done.end }] : []),
      ]);
    }
    return remaining;
  });
}

async function abortable(operation, signal) {
  if (signal.aborted) throw signal.reason;
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function auditCandidate({ catalog, text, request, conversation = [], verbatim = [], baseline, adapter, cache = new JudgmentCache(), limits: inputLimits = {}, signal: externalSignal }) {
  const started = performance.now();
  const limits = validatedLimits(inputLimits);
  const deadline = started + limits.auditDeadlineMs;
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const expired = () => signal.aborted || performance.now() >= deadline;
  const view = createView(text, { verbatim: structuredClone(verbatim), baseline });
  const local = evaluateLocal(catalog, view);
  const plans = planSemanticChecks(catalog, view, request, conversation);
  conversation = conversation.map(({ role, text }) => ({ role, text }));
  const model = structuredClone(adapter.identity);
  const results = new Map(plans.map((plan) => [plan.id, {
    id: plan.id, sourceRule: plan.sourceRule, disposition: plan.disposition, threshold: plan.threshold,
    calibration: plan.calibration, definitionDigest: plan.definitionDigest, outcome: plan.outcome,
    expected: view.passages.filter((passage) => plan.rangeIds?.includes(passage.id)).map(rangeOf),
    executed: [], omitted: [], findings: [], reasons: plan.reason ? [plan.reason] : [], incomplete: plan.outcome === "unavailable",
  }]));
  const batches = [];
  const groups = new Map();
  let requests = 0;
  let transportAttempts = 0;
  let estimatedInputTokens = 0;
  let reconciledInputTokens = 0;
  let cacheHits = 0;
  const usage = [];
  const servedModels = new Set();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - performance.now()));
  function apply(unit, answer, cached = false, protocolIssue) {
    const check = results.get(unit.plan.id);
    if (protocolIssue) { check.incomplete = true; check.reasons.push(protocolIssue); }
    if (answer?.type !== "bool" || !probability(answer.probability)) {
      check.reasons.push("Missing or malformed classifier answer.");
      return;
    }
    check.executed.push({ ranges: unit.targets, contextRange: unit.window, probability: answer.probability, cacheHit: cached });
    if (unit.uncertain) {
      check.incomplete = true;
      check.reasons.push("Protection or source mapping is unresolved in an evaluated range.");
    } else if (answer.probability >= unit.plan.threshold) {
      check.findings.push({ probability: answer.probability, threshold: unit.plan.threshold, evidenceKind: "evaluated-range", evidence: unit.targets.map((range) => ({ passageId: range.passageId, ...location(view, range.start, range.end) })), guidance: unit.plan.repair });
    }
  }
  try {
    for (const plan of plans) {
      if (expired()) break;
      if (plan.outcome !== "pending") continue;
      const check = results.get(plan.id);
      if (!adapter.available) { check.reasons.push("Pinned classifier is unavailable in the Pi registry."); continue; }
      for (const unit of unitsFor(plan, view, request, conversation, limits, expired)) {
        if (expired()) break;
        if (unit.reason) { check.reasons.push(unit.reason); break; }
        unit.key = digest(JSON.stringify({ evaluator: EVALUATOR_VERSION, model, catalog: catalog.catalogDigest, definition: plan.definitionDigest, candidate: view.hash, state: unit.state, question: unit.question, threshold: plan.threshold }));
        const cached = cache.get(unit.key);
        if (cached && cached.servedModel === model.model && probability(cached.probability)) {
          cacheHits++;
          servedModels.add(cached.servedModel);
          apply(unit, { type: "bool", probability: cached.probability }, true);
          continue;
        }
        const stateKey = digest(JSON.stringify(unit.state));
        let batch = groups.get(stateKey);
        const questions = { ...batch?.body.questions, [plan.id]: unit.question };
        if (!batch || estimateInput({ state: unit.state, questions }) > limits.perRequestTokens) {
          if (batches.length >= limits.maxClassifierRequests) { check.reasons.push("Classifier request budget reached during planning."); continue; }
          batch = { body: { state: unit.state, questions: {} }, units: [] };
          groups.set(stateKey, batch);
          batches.push(batch);
        }
        batch.body.questions[plan.id] = unit.question;
        batch.units.push(unit);
      }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limits.classifierConcurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const estimate = estimateInput(batch.body);
        const reason = expired() ? "Audit cancelled or deadline reached." : reconciledInputTokens + estimate > limits.maxInputTokens ? "Classifier input budget reached." : undefined;
        if (reason) { for (const unit of batch.units) results.get(unit.plan.id).reasons.push(reason); continue; }
        requests++;
        estimatedInputTokens += estimate;
        reconciledInputTokens += estimate;
        const usageIndex = usage.push(null) - 1;
        try {
          const result = await abortable(() => adapter.classify(batch.body, { signal, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())), maxRequestBytes: estimate, onAttempt: () => { if (!signal.aborted) transportAttempts++; } }), signal);
          if (expired()) continue;
          usage[usageIndex] = result.usage ?? null;
          if (Number.isSafeInteger(result.usage?.input) && result.usage.input >= 0) reconciledInputTokens += Math.max(estimate, result.usage.input) - estimate;
          if (result.servedModel === model.model) servedModels.add(result.servedModel);
          for (const unit of batch.units) {
            const check = results.get(unit.plan.id);
            if (result.reason || result.servedModel !== model.model) { check.reasons.push(result.reason ?? "Classifier served model does not match the snapshot."); continue; }
            const answer = result.answers?.[unit.plan.id];
            const protocolIssue = result.protocolIssue ?? (Object.keys(result.answers ?? {}).some((id) => !Object.hasOwn(batch.body.questions, id)) ? "Unexpected classifier answer IDs." : undefined);
            apply(unit, answer, false, protocolIssue);
            if (!protocolIssue && answer?.type === "bool" && probability(answer.probability)) cache.set(unit.key, { probability: answer.probability, servedModel: result.servedModel });
          }
        } catch {
          for (const unit of batch.units) results.get(unit.plan.id).reasons.push(expired() ? "Audit cancelled or deadline reached." : "Classifier request failed.");
        }
      }
    }));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const semantic = [...results.values()].map((check) => {
    if (["inapplicable", "unavailable"].includes(check.outcome)) {
      check.omitted = check.outcome === "unavailable" ? [...check.expected] : [];
      return check;
    }
    check.omitted = missingRanges(check.expected, check.executed.flatMap((entry) => entry.ranges));
    if (check.omitted.length) {
      check.incomplete = true;
      if (!check.reasons.length) check.reasons.push(performance.now() >= deadline || externalSignal?.aborted ? "Audit cancelled or deadline reached." : "Evaluation coverage is incomplete.");
    }
    check.reasons = [...new Set(check.reasons)];
    check.outcome = check.findings.length ? "violation" : check.incomplete ? "unavailable" : "clear";
    return check;
  });
  const incomplete = local.incomplete || semantic.some((check) => check.disposition === "active" && check.incomplete);
  const failed = local.status === "failed" || semantic.some((check) => check.disposition === "active" && check.outcome === "violation");
  return {
    status: failed ? "failed" : incomplete ? "incomplete" : "passed", incomplete,
    advisoryIncomplete: semantic.some((check) => check.disposition === "advisory" && check.incomplete),
    coverageComplete: catalog.valid && [...local.checks, ...semantic].every((check) => !check.incomplete),
    checks: [...local.checks, ...semantic], catalogIssues: catalog.issues, catalogDigest: catalog.catalogDigest, candidateHash: view.hash,
    evaluatorVersion: EVALUATOR_VERSION, rulesetVersion: catalog.catalog.rulesetVersion, preprocessingVersion: view.version,
    limits, model, servedModels: [...servedModels], requests, transportAttempts,
    estimatedInputTokens, reconciledInputTokens, usage, cacheHits, ms: performance.now() - started,
  };
}
