import assert from "node:assert/strict";
import test from "node:test";
import { inspectCatalog, digest } from "../lib/catalog.mjs";
import { createView } from "../lib/markdown.mjs";
import { auditCandidate } from "../lib/evaluator.mjs";
import { repairReply, createIsolatedWriter } from "../lib/repair.mjs";
import { repairBoundary } from "../lib/repair-boundary.mjs";
import { registerRepairLifecycle } from "../lib/repair-lifecycle.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";
import { preservationFixtures } from "./fixtures/preservation.mjs";

const catalog = inspectCatalog(makeCatalog(), skill);
function adapter(judge = () => 0) {
  const calls = [];
  return {
    available: true, identity: { model: "fictional-1", provider: "fictional" }, calls,
    async classify(body, options) {
      calls.push(body);
      options.onAttempt();
      return { servedModel: "fictional-1", usage: null, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "bool", probability: judge(id, body.state) }])) };
    },
  };
}
const auditRevision = (original, text, remote = adapter(), options = {}) => auditCandidate({ catalog, text, baseline: createView(original), request: "Edit the reply.", adapter: remote, ...options });
const run = (revisions, options = {}) => {
  let writes = 0;
  const feedback = [];
  return {
    feedback, writes: () => writes,
    result: repairReply({ text: "Keep the log—retain it for 2 hours.", request: "Give the instruction.", catalog, adapter: adapter(), writer: async (data) => {
      feedback.push(data);
      const revision = revisions[writes++];
      assert.notEqual(revision, undefined, "Unexpected writer generation");
      return typeof revision === "string" ? { text: revision, usage: null } : revision;
    }, ...options }),
  };
};

test("preservation fixtures exercise required acceptance independently of advisory style", async () => {
  for (const fixture of preservationFixtures) {
    const result = await auditRevision(fixture.original, fixture.revision, adapter((id) => id === fixture.check ? 0.99 : 0));
    assert.equal(result.preservation.accepted, fixture.check === null, fixture.name);
    assert.equal(result.preservation.reference, digest(fixture.original));
    assert.equal(result.preservation.calibration, "uncalibrated");
    assert.equal(result.checks.filter((check) => check.id.startsWith("preserve-")).length, 10);
    if (fixture.check) assert.equal(result.checks.find((check) => check.id === fixture.check).outcome, "violation");
  }
});

test("catalog checks cannot shadow mandatory preservation IDs", async () => {
  const value = makeCatalog();
  value.checks[1].id = "preserve-negation";
  await assert.rejects(auditRevision("Keep the log.", "Retain the log.", adapter(), { catalog: inspectCatalog(value, skill) }), /reserved/);
});

test("preservation rejects inconclusive, malformed, missing, and over-budget answers", async () => {
  for (const probability of [0.5, NaN, 1.1]) {
    const result = await auditRevision("Keep the log.", "Retain the log.", adapter((id) => id === "preserve-negation" ? probability : 0));
    assert.equal(result.preservation.accepted, false);
    assert.equal(result.incomplete, true);
  }
  const missing = adapter();
  const original = missing.classify;
  missing.classify = async (...args) => { const result = await original(...args); delete result.answers["preserve-negation"]; return result; };
  assert.equal((await auditRevision("Keep the log.", "Retain the log.", missing)).preservation.accepted, false);
  const limited = await auditRevision("Keep the log.", "Retain the log.", adapter(), { limits: { maxInputTokens: 1 } });
  assert.equal(limited.preservation.accepted, false);
  const large = await auditRevision("x".repeat(40000), "Retain the log.");
  assert.equal(large.preservation.accepted, false);
  assert.ok(large.checks.filter((check) => check.id.startsWith("preserve-") && check.id !== "preserve-literals").every((check) => check.outcome === "unavailable"));
});

test("literal changes and new wrappers fail even when semantic probabilities are clear", async () => {
  for (const [original, revision] of [["Run `save()`.", "Run `erase()`."], ["Use /tmp/example.", "Use /tmp/other."], ["Plain prose.", "```text\nPlain prose.\n```"]]) {
    const result = await auditRevision(original, revision);
    assert.equal(result.preservation.accepted, false);
    assert.equal(result.checks.find((check) => check.id === "preserve-literals").outcome, "violation");
  }
  assert.equal((await auditRevision("Plain prose.", "", adapter((id) => id === "preserve-omission" ? 1 : 0))).preservation.accepted, false);
});

test("identical originals need no semantic preservation call", async () => {
  const remote = adapter();
  const result = await auditRevision("Good prose.", "Good prose.", remote);
  assert.equal(result.preservation.accepted, true);
  assert.equal(result.preservation.calibration, "identity");
  assert.ok(remote.calls.every((call) => !Object.keys(call.questions).some((id) => id.startsWith("preserve-"))));
});

test("preservation and style share the candidate request budget", async () => {
  const remote = adapter();
  const result = await auditRevision("Keep the log—retain it.", "Keep the log.", remote, { limits: { maxClassifierRequests: 1 } });
  assert.equal(remote.calls.length, 1);
  assert.ok(Object.keys(remote.calls[0].questions).every((id) => id.startsWith("preserve-")));
  assert.equal(result.preservation.accepted, true);
  assert.equal(result.advisoryIncomplete, true);
});

test("original, first repair, last repair, exhaustion, and zero-cap bounds", async () => {
  for (const [text, revisions, maxRewrites, count, termination, selected] of [
    ["Keep the log.", [], 2, 1, "passed", "Keep the log."],
    ["Keep the log—retain it.", ["Keep the log."], 2, 2, "passed", "Keep the log."],
    ["Keep the log—retain it.", ["Retain the log—keep it.", "Keep the log."], 2, 3, "passed", "Keep the log."],
    ["Keep the log—retain it.", ["Retain the log—keep it.", "Keep it—the log."], 2, 3, "rewrite-limit", "Keep it—the log."],
    ["Keep the log—retain it.", [], 0, 1, "rewrite-limit", "Keep the log—retain it."],
  ]) {
    const f = run(revisions, { text, maxRewrites });
    const result = await f.result;
    assert.equal(result.termination, termination);
    assert.equal(result.candidates.length, count);
    assert.equal(result.rewrites, count - 1);
    assert.equal(f.writes(), count - 1);
    assert.equal(result.selected.text, selected);
    assert.equal(result.selected.audit.candidateHash, digest(selected));
  }
});

test("damaged revisions fall back to the latest preserved candidate with its own verdict", async () => {
  const original = "Keep the log—retain it for 2 hours.";
  const first = "Retain the log—for 2 hours.";
  const damaged = "Retain the log for 2 minutes.";
  const remote = adapter((id, state) => id === "preserve-quantities" && state.revision === damaged ? 1 : 0);
  const f = run([first, damaged], { adapter: remote });
  const result = await f.result;
  assert.equal(result.termination, "rewrite-limit");
  assert.equal(result.selected.text, first);
  assert.equal(result.selected.audit.status, "failed");
  assert.equal(result.selected.audit.candidateHash, digest(first));
  assert.equal(result.candidates.at(-1).preserved, false);
  assert.ok(remote.calls.filter((call) => call.state.original).every((call) => call.state.original === original));
  const recovered = run([damaged, "Retain the log for 2 hours."], { adapter: adapter((id, state) => id === "preserve-quantities" && state.revision === damaged ? 1 : 0) });
  assert.equal((await recovered.result).termination, "passed");
  assert.equal(recovered.feedback[1].original, original);
  assert.equal(recovered.feedback[1].current, original);
  assert.equal(recovered.feedback[1].rejectedRevision.text, damaged);
});

test("an inconclusive revision never becomes the fallback", async () => {
  const f = run(["Keep the log for 2 hours."], { adapter: adapter((id) => id === "preserve-negation" ? 0.5 : 0) });
  const result = await f.result;
  assert.equal(result.termination, "checker-unavailable");
  assert.equal(result.selected.text, "Keep the log—retain it for 2 hours.");
});

test("previously passing checks run again and repeated candidates do not reroll", async () => {
  const f = run(["“Keep the log for 2 hours.”", "Keep the log for 2 hours."]);
  const result = await f.result;
  assert.equal(result.candidates[1].audit.checks.find((check) => check.id === "curly-quotes").outcome, "violation");
  assert.equal(result.termination, "passed");
  for (const revisions of [["Keep the log—retain it for 2 hours."], ["Retain the log—for 2 hours.", "Keep the log—retain it for 2 hours."]]) {
    const cycle = await run(revisions).result;
    assert.equal(cycle.termination, "repeated-candidate");
    assert.equal(cycle.candidates.length, revisions.length);
    assert.equal(cycle.selected.text, revisions.at(-1));
  }
});

test("writer protocol failures consume one generation and keep the original", async () => {
  for (const revision of [{ error: "writer-tool-call", usage: { input: 10 } }, { error: "writer-error" }, { text: "" }, { arbitrary: true }]) {
    const f = run([revision]);
    const result = await f.result;
    assert.equal(result.rewrites, 1);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.selected.text, "Keep the log—retain it for 2 hours.");
    assert.equal(result.writerUsage.length, 1);
  }
});

test("writer deadlines and request cancellation discard late completions", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let release;
    let begin;
    const started = new Promise((resolve) => { begin = resolve; });
    const f = run([], { signal: controller.signal, writerDeadlineMs: 30, writer: async () => {
      begin();
      return new Promise((resolve) => { release = resolve; });
    } });
    await started;
    if (cancel) controller.abort();
    const result = await f.result;
    assert.equal(result.termination, cancel ? "cancelled" : "writer-timeout");
    assert.equal(result.rewrites, 1);
    if (cancel) assert.equal(result.selected, undefined);
    else assert.equal(result.selected.text, "Keep the log—retain it for 2 hours.");
    release({ text: "Late replacement." });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.candidates.length, 1);
  }
});

test("cancelled audits, stale request identity, and audit failures cannot release a stale repair", async () => {
  let current = true;
  const stale = run([], { isCurrent: () => current, writer: async () => { current = false; return { text: "Stale." }; } });
  assert.equal((await stale.result).selected, undefined);
  const controller = new AbortController();
  const cancelled = run([], { signal: controller.signal, audit: async () => { controller.abort(); return new Promise(() => {}); } });
  assert.equal((await cancelled.result).selected, undefined);
  const failed = await run([], { audit: async () => { throw new Error("Private exception"); } }).result;
  assert.equal(failed.selected.text, "Keep the log—retain it for 2 hours.");
  assert.equal(failed.selected.audit.status, "incomplete");
  assert.doesNotMatch(JSON.stringify(failed), /Private exception/);
});

test("later settlement boundaries cannot replenish a request's repair budget", async () => {
  const handlers = new Map();
  const pi = { on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } };
  registerRepairLifecycle(pi, async () => ({ catalog, adapter: adapter(), maxRewrites: 1 }));
  let writes = 0;
  const ctx = { model, signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "fixture", buildSessionProjection: () => ({ messages: [{ role: "user", content: "Write a reply." }] }) },
    modelRegistry: { streamSimple: () => ({ result: async () => { writes++; return { stopReason: "stop", content: [{ type: "text", text: "Revision—reply." }] }; } }) },
  };
  const emit = async (name, event) => { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx); return result; };
  await emit("message_start", { message: { role: "user" } });
  for (const text of ["Original—reply.", "Later—reply."]) {
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
    await emit("message_start", { message });
    await emit("message_end", { message });
    const event = { entries: [], outcome: "completed", continue: false, context: { contextEntries: [{ sourceEntry: { id: text }, messages: [message] }] } };
    await emit("turn_end", event);
    const boundary = await emit("agent_before_settle", event);
    assert.equal(boundary.entries.at(-1).data.requestRewrites, 1);
    assert.equal(writes, 1);
  }
});

test("lifecycle invalidation prevents late repair delivery after input or navigation", async () => {
  for (const cancelEvent of ["input", "session_shutdown", "session_tree", "session_before_switch", "session_before_fork"]) {
    const handlers = new Map();
    const pi = { on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } };
    registerRepairLifecycle(pi, async () => ({ catalog, adapter: adapter() }));
    let begin;
    let release;
    const started = new Promise((resolve) => { begin = resolve; });
    const ctx = { model, thinkingLevel: "off", signal: new AbortController().signal,
      sessionManager: { getSessionId: () => "fictional-session", buildSessionProjection: () => ({ messages: [{ role: "user", content: "Give the instruction." }] }) },
      modelRegistry: { streamSimple: () => ({ result: () => { begin(); return new Promise((resolve) => { release = resolve; }); } }) },
    };
    const emit = async (event, data = {}) => {
      let result;
      for (const handler of handlers.get(event) ?? []) result = await handler(data, ctx);
      return result;
    };
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Keep the log—retain it." }] };
    await emit("message_start", { message: { role: "user" } });
    await emit("message_end", { message });
    const event = { entries: [], outcome: "completed", continue: false, context: { contextEntries: [{ sourceEntry: { id: "entry" }, messages: [message] }] } };
    const pending = emit("turn_end", event);
    await started;
    await emit(cancelEvent);
    assert.equal(await pending, undefined);
    release({ stopReason: "stop", content: [{ type: "text", text: "Stale reply." }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await emit("agent_before_settle", event), undefined);
  }
});

test("repair snapshots visible conversation and excludes extra message fields", async () => {
  const conversation = [{ role: "user", text: "Keep the same meaning.", hidden: "PRIVATE" }];
  const f = run(["Keep the log for 2 hours."], { conversation });
  conversation[0].text = "Changed after the repair started.";
  await f.result;
  assert.equal(f.feedback[0].conversation[0].text, "Keep the same meaning.");
  assert.doesNotMatch(JSON.stringify(f.feedback), /PRIVATE|Changed after/);
});

const model = { provider: "fixture", id: "writer", contextWindow: 100000, maxTokens: 4000 };
test("isolated writer preserves generation settings and refuses tool results", async () => {
  const calls = [];
  const registry = { streamSimple: (...args) => { calls.push(args); return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "  Exact reply.\n" }], usage: { input: 10 }, provider: "fixture", model: "writer" }) }; } };
  const writer = createIsolatedWriter(registry, model, { reasoning: "high", temperature: 0.2, maxTokens: 2000, samplingParams: { top_p: 0.9 }, apiKey: "PRIVATE" });
  const options = { signal: new AbortController().signal, timeoutMs: 1000 };
  const result = await writer({ original: "Original." }, options);
  assert.equal(result.text, "  Exact reply.\n");
  assert.deepEqual(calls[0][1].tools, []);
  assert.equal(calls[0][2].toolChoice, "none");
  assert.equal(calls[0][2].maxRetries, 0);
  assert.equal(calls[0][2].reasoning, "high");
  assert.equal(calls[0][2].temperature, 0.2);
  assert.deepEqual(calls[0][2].samplingParams, { top_p: 0.9 });
  assert.equal(calls[0][2].apiKey, undefined);
  registry.streamSimple = () => ({ result: async () => ({ stopReason: "toolUse", content: [{ type: "toolCall", name: "edit", arguments: {} }], usage: { input: 20 } }) });
  const blocked = await writer({}, options);
  assert.equal(blocked.error, "writer-tool-call");
  assert.equal(blocked.usage.input, 20);
  assert.equal((await createIsolatedWriter(registry, model, { samplingParams: { tools: [{}] } })({}, options)).error, "writer-configuration");
});

test("boundary edits preserve other entries and bind the exact selected candidate", async () => {
  const result = await run(["Keep the log for 2 hours."]).result;
  const other = { type: "custom", customType: "other", data: true };
  const event = { outcome: "completed", continue: false, entries: [other], context: { contextEntries: [{ sourceEntry: { id: "original-entry" }, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Keep the log—retain it for 2 hours." }] }] }] } };
  const args = { targetId: "original-entry", originalHash: digest("Keep the log—retain it for 2 hours."), result, isCurrent: () => true };
  const boundary = repairBoundary(event, args);
  assert.deepEqual(boundary.entries[0], other);
  assert.equal(boundary.entries[1].replacement.content[0].text, result.selected.text);
  assert.equal(boundary.entries[2].data.audit.candidateHash, digest(result.selected.text));
  assert.equal(boundary.continue, undefined);
  assert.equal(repairBoundary({ ...event, continue: true }, args), undefined);
  assert.equal(repairBoundary({ ...event, outcome: "aborted" }, args), undefined);
  assert.equal(repairBoundary(event, { ...args, isCurrent: () => false }), undefined);
  assert.equal(repairBoundary({ ...event, entries: [{ type: "context_edit", targetId: "original-entry", replacement: null }] }, args), undefined);
});
