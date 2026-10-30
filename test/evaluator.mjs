import assert from "node:assert/strict";
import test from "node:test";
import { inspectCatalog } from "../lib/catalog.mjs";
import { auditCandidate, estimateInput } from "../lib/evaluator.mjs";
import { JudgmentCache } from "../lib/judgment-cache.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";

function catalog(scopes = ["reply"], mutate = () => {}) {
  const value = makeCatalog();
  value.checks.filter((check) => check.kind !== "local").forEach((check, index) => { check.scope = scopes[index] ?? "heading"; });
  mutate(value);
  return inspectCatalog(value, skill);
}
function fake(answer = () => 0) {
  const calls = [];
  const adapter = {
    identity: { provider: "fixture", model: "fixture-1", adapter: "fake-1" }, available: true,
    async classify(body, options) {
      options.onAttempt();
      calls.push({ body, options });
      return { servedModel: adapter.identity.model, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "bool", probability: answer(id, body) }])), attempts: 1, usage: null };
    },
  };
  return { adapter, calls };
}
const run = (adapter, options = {}) => auditCandidate({ catalog: catalog(), text: "The response is ready.", request: "Write a reply.", adapter, ...options });
const get = (result, id = "fictional-1") => result.checks.find((check) => check.id === id);

test("all semantic rules run in shared-state batches with violation polarity and fixed evidence", async () => {
  const f = fake((id) => id === "fictional-9" ? 0.9 : 0);
  const result = await run(f.adapter, { catalog: inspectCatalog(makeCatalog(), skill) });
  assert.equal(result.requests, 1);
  assert.equal(result.transportAttempts, 1);
  assert.equal(f.calls[0].options.maxRequestBytes, estimateInput(f.calls[0].body));
  assert.equal(Object.keys(f.calls[0].body.questions).length, 36);
  assert.equal(result.status, "passed");
  assert.equal(result.advisoryIncomplete, false);
  assert.equal(result.coverageComplete, true);
  assert.equal(get(result, "fictional-9").outcome, "violation");
  const finding = get(result, "fictional-9").findings[0];
  assert.equal(finding.evidenceKind, "evaluated-range");
  assert.equal(finding.evidence[0].quote, "The response is ready.");
  assert.match(finding.guidance, /without changing meaning/);
});

test("shared protection policy is supplied once per batch within the default input budget", async () => {
  const value = makeCatalog();
  value.protectionPolicy = "Preserve all exact source literals. ".repeat(40);
  const f = fake();
  const result = await run(f.adapter, { catalog: inspectCatalog(value, skill) });
  assert.equal(result.coverageComplete, true);
  assert.ok(result.estimatedInputTokens < 64000);
  assert.equal(f.calls[0].body.state.evaluationPolicy, value.protectionPolicy);
  assert.ok(Object.values(f.calls[0].body.questions).every((question) => !question.instructions.includes(value.protectionPolicy)));
});

test("invalid limits are rejected before scheduling", async () => {
  const f = fake();
  for (const limits of [null, [], { maxClassifierRequests: 0 }, { classifierConcurrency: -1 }, { auditDeadlineMs: Infinity }, { perQuestionTokens: 32001 }, { perRequestTokens: 64001 }, { unknown: 2 }]) {
    await assert.rejects(run(f.adapter, { limits }));
  }
  assert.equal(f.calls.length, 0);
});

test("a partial batch retains valid violations and names omitted coverage", async () => {
  const f = fake(() => 1);
  const original = f.adapter.classify;
  f.adapter.classify = async (...args) => {
    const value = await original(...args);
    delete value.answers["fictional-2"];
    return value;
  };
  const result = await run(f.adapter, { catalog: catalog(["reply", "reply"]), text: "A literal—failure." });
  assert.equal(result.status, "failed");
  assert.equal(result.incomplete, false);
  assert.equal(result.advisoryIncomplete, true);
  assert.equal(get(result).outcome, "violation");
  assert.equal(get(result, "fictional-2").outcome, "unavailable");
  assert.deepEqual(get(result, "fictional-2").omitted, get(result, "fictional-2").expected);
});

test("wrong types, nonfinite values, unknown IDs, and model changes cannot clear coverage", async () => {
  for (const answer of [{ type: "noul", noul: 0 }, { type: "bool", probability: NaN }, { type: "bool", probability: Infinity }, { type: "bool", probability: -0.1 }, { type: "bool", probability: 1.1 }, { type: "bool", probability: "0" }]) {
    const f = fake();
    f.adapter.classify = async () => ({ servedModel: "fixture-1", answers: { "fictional-1": answer } });
    assert.equal(get(await run(f.adapter)).outcome, "unavailable");
  }
  for (const change of [
    (result) => { result.answers["invented-evidence"] = { type: "bool", probability: 0 }; },
    (result) => { result.servedModel = "fixture-2"; },
  ]) {
    const f = fake();
    const original = f.adapter.classify;
    f.adapter.classify = async (...args) => { const result = await original(...args); change(result); return result; };
    assert.equal((await run(f.adapter)).advisoryIncomplete, true);
  }
});

test("remote failure preserves active local findings and records unknown usage", async () => {
  const f = fake();
  f.adapter.classify = async () => { throw new Error("A sensitive provider payload must not reach diagnostics"); };
  const result = await run(f.adapter, { text: "The process—failed." });
  assert.equal(result.status, "failed");
  assert.equal(result.advisoryIncomplete, true);
  assert.deepEqual(result.usage, [null]);
  assert.doesNotMatch(JSON.stringify(result), /sensitive provider payload/);
  f.adapter.available = false;
  const unavailable = await run(f.adapter);
  assert.equal(unavailable.requests, 0);
  assert.equal(get(unavailable).outcome, "unavailable");
});

test("exact request exceptions and visible conversation survive without extra message fields", async () => {
  const f = fake();
  const request = "x".repeat(4100) + " Reproduce the quotation exactly.";
  await run(f.adapter, { request, conversation: [{ role: "user", text: "An earlier correction.", hidden: "PRIVATE" }] });
  assert.equal(f.calls[0].body.state.request, request);
  assert.deepEqual(f.calls[0].body.state.conversation, [{ role: "user", text: "An earlier correction." }]);
  assert.doesNotMatch(JSON.stringify(f.calls[0].body), /PRIVATE/);
  await assert.rejects(run(f.adapter, { conversation: [{ role: "tool", text: "Private payload" }] }));
});

test("local semantic chunks cover the ending beyond 16000 characters with overlapping exact context", async () => {
  const text = Array.from({ length: 42 }, (_, index) => `Paragraph ${index}. ${"Fictional text. ".repeat(35)}`).join("\n\n") + " FINAL-VIOLATION";
  const f = fake((_id, body) => body.state.reply.text.includes("FINAL-VIOLATION") ? 1 : 0);
  const result = await run(f.adapter, { text, catalog: catalog(["passage"]), limits: { perQuestionTokens: 8000, maxInputTokens: 100000 } });
  const check = get(result);
  assert.ok(text.length > 16000);
  assert.ok(f.calls.length > 1);
  assert.equal(check.outcome, "violation");
  assert.deepEqual(check.omitted, []);
  assert.equal(check.executed.at(-1).ranges.at(-1).end, text.length);
  for (let index = 0; index < f.calls.length; index++) {
    const state = f.calls[index].body.state;
    assert.equal(state.reply.text, text.slice(state.reply.start, state.reply.end));
    if (index) assert.ok(state.reply.start < f.calls[index - 1].body.state.reply.end);
    assert.ok(estimateInput(f.calls[index].body) <= 8000);
  }
});

test("an oversized paragraph splits with context on both sides of its boundary", async () => {
  const text = "A fictional sentence. ".repeat(1500);
  const first = fake();
  await run(first.adapter, { text, catalog: catalog(["passage"]), limits: { perQuestionTokens: 8000, maxInputTokens: 100000 } });
  const end = first.calls[0].body.state.targetRanges.at(-1).end;
  const split = text.slice(0, end - 8) + "CROSSING-PATTERN" + text.slice(end + 8);
  const f = fake((_id, body) => body.state.reply.text.includes("CROSSING-PATTERN") ? 1 : 0);
  const result = await run(f.adapter, { text: split, catalog: catalog(["passage"]), limits: { perQuestionTokens: 8000, maxInputTokens: 100000 } });
  assert.equal(get(result).outcome, "violation");
  assert.deepEqual(get(result).omitted, []);
  assert.ok(f.calls.filter(({ body }) => body.state.reply.text.includes("CROSSING-PATTERN")).length >= 2);
});

test("whole-reply rules never turn a scanned prefix into a complete audit", async () => {
  const f = fake();
  const result = await run(f.adapter, { text: "Fictional sentence. ".repeat(2000), catalog: catalog(["reply", "passage"]), limits: { perQuestionTokens: 8000 } });
  assert.equal(get(result).outcome, "unavailable");
  assert.match(get(result).reasons.join(" "), /full-reply/);
  assert.equal(result.coverageComplete, false);
  const tooLarge = await run(f.adapter, { request: "r".repeat(40000) });
  assert.equal(tooLarge.requests, 0);
  assert.equal(get(tooLarge).outcome, "unavailable");
});

test("request, cumulative input, actual usage, and concurrency budgets hold", async () => {
  const text = "A fictional paragraph. ".repeat(1500);
  for (const limits of [{ maxClassifierRequests: 2 }, { maxInputTokens: 9000 }]) {
    const f = fake();
    const result = await run(f.adapter, { text, catalog: catalog(["passage"]), limits: { perQuestionTokens: 8000, ...limits } });
    assert.ok(result.requests <= (limits.maxClassifierRequests ?? 8));
    assert.ok(result.estimatedInputTokens <= (limits.maxInputTokens ?? 64000));
    assert.equal(result.advisoryIncomplete, true);
    assert.ok(get(result).omitted.length);
  }
  const f = fake();
  let active = 0;
  let maximum = 0;
  const original = f.adapter.classify;
  f.adapter.classify = async (...args) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return { ...await original(...args), usage: { input: 70000, output: 0, cost: null } };
  };
  const result = await run(f.adapter, { text, catalog: catalog(["passage"]), limits: { perQuestionTokens: 8000 } });
  assert.equal(maximum, 2);
  assert.equal(result.requests, 2);
  assert.ok(result.reconciledInputTokens >= 140000);
  assert.equal(result.advisoryIncomplete, true);
});

test("deadline and cancellation discard late answers and do not populate the cache", async () => {
  for (const cancel of [false, true]) {
    const f = fake();
    const cache = new JudgmentCache();
    const controller = new AbortController();
    let release;
    let began;
    const started = new Promise((resolve) => { began = resolve; });
    f.adapter.classify = async (_body, options) => {
      options.onAttempt();
      began();
      return new Promise((resolve) => { release = resolve; });
    };
    const pending = run(f.adapter, { cache, signal: controller.signal, limits: { auditDeadlineMs: 50 } });
    await started;
    if (cancel) controller.abort();
    const result = await pending;
    assert.equal(result.transportAttempts, 1);
    assert.equal(get(result).outcome, "unavailable");
    assert.ok(result.ms < 1000);
    release({ servedModel: "fixture-1", answers: { "fictional-1": { type: "bool", probability: 0 } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cache.size, 0);
    assert.equal(get(result).executed.length, 0);
  }
});

test("cache keys bind exact context, definitions, thresholds, model, protection, and candidate", async () => {
  const f = fake(() => 0.85);
  const cache = new JudgmentCache();
  const base = { cache, catalog: catalog() };
  await run(f.adapter, base);
  const cached = await run(f.adapter, base);
  assert.equal(cached.cacheHits, 1);
  assert.equal(cached.requests, 0);
  assert.equal(cache.size, 1);
  for (const changed of [
    { request: "A new request." },
    { text: "A changed reply." },
    { conversation: [{ role: "assistant", text: "Prior visible context." }] },
    { verbatim: [{ text: "The response is ready.", sourceId: "user:quote" }] },
    { catalog: catalog(["reply"], (value) => { value.checks[0].exceptions = "New exception."; }) },
    { catalog: catalog(["reply"], (value) => { value.checks[0].calibration.threshold = 0.8; }) },
  ]) {
    const result = await run(f.adapter, { ...base, ...changed });
    assert.equal(result.cacheHits, 0);
    assert.equal(result.requests, 1);
    if (changed.catalog?.checks[0].calibration.threshold === 0.8) assert.equal(get(result).outcome, "violation");
  }
  f.adapter.identity.model = "fixture-2";
  assert.equal((await run(f.adapter, base)).cacheHits, 0);
});

test("transient failures are retried on a new audit while valid partial judgments are cached", async () => {
  const f = fake();
  const cache = new JudgmentCache();
  const original = f.adapter.classify;
  let partial = true;
  f.adapter.classify = async (...args) => {
    const result = await original(...args);
    if (partial) delete result.answers["fictional-2"];
    return result;
  };
  const options = { cache, catalog: catalog(["reply", "reply"]) };
  await run(f.adapter, options);
  partial = false;
  const result = await run(f.adapter, options);
  assert.equal(result.cacheHits, 1);
  assert.equal(result.requests, 1);
  assert.deepEqual(Object.keys(f.calls.at(-1).body.questions), ["fictional-2"]);
  assert.equal(result.coverageComplete, true);
});

test("unknown wrapper intent remains unresolved and stale catalogs retain applicable ranges", async () => {
  const f = fake(() => 1);
  const unknown = await run(f.adapter, { text: "`Generated prose.`" });
  assert.equal(get(unknown).outcome, "unavailable");
  assert.equal(get(unknown).findings.length, 0);
  const verified = await run(f.adapter, { text: "`Generated prose.`", verbatim: [{ text: "`Generated prose.`", sourceId: "user:quote" }] });
  assert.equal(get(verified).incomplete, false);
  const stale = inspectCatalog(makeCatalog(), skill.replace("Fictional policy 1.", "Changed policy 1."));
  const result = await run(f.adapter, { catalog: stale });
  assert.equal(result.status, "incomplete");
  assert.equal(get(result).outcome, "unavailable");
  assert.ok(get(result).omitted.length);
});

test("cache capacity, retention, and cloning are bounded", () => {
  let time = 0;
  const cache = new JudgmentCache({ capacity: 2, ttlMs: 10, now: () => time });
  cache.set("a", { probability: 0 });
  cache.set("b", { probability: 1 });
  cache.get("a").probability = 1;
  cache.set("c", { probability: 0 });
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a").probability, 0);
  time = 10;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
  cache.clear();
  assert.equal(cache.size, 0);
});
