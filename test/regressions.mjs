import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = process.env.PI_PACKAGE_ROOT;
assert.ok(piRoot, "Set PI_PACKAGE_ROOT to the installed Pi package directory");
const home = mkdtempSync(join(tmpdir(), "reply-guard-test-"));
const agentDir = join(home, ".pi/agent");
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
mkdirSync(agentDir, { recursive: true });
globalThis.fetch = () => { throw new Error("Network forbidden in regression tests"); };
const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")));
const skill = { name: "fixture", filePath: join(home, "SKILL.md"), description: "Fictional writing rule", source: "user", baseDir: home, disableModelInvocation: false };
writeFileSync(skill.filePath, "# Fictional rule\n\nUse clear prose.\n");
const response = (probability) => ({
  provider: "openrouter", model: "typesafe/jev-1.14", stopReason: "stop",
  answers: { meets: { type: "bool", probability } },
});
const message = (text) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });

async function fixture({ config = {}, answers = [response(1)], skills = [skill] } = {}) {
  const configPath = join(agentDir, "reply-guard.json");
  writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify({
    skills: { fixture: 0.9 }, preload: false, model: "openrouter/typesafe/jev-1.14", ...config,
  }));
  const { extensions, errors } = await loadExtensions([join(root, "extensions/reply-guard.ts")], home);
  assert.deepEqual(errors, []);
  const extension = extensions[0];
  const calls = [];
  const callOptions = [];
  const statuses = [];
  const notices = [];
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal, hasUI: false,
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args) },
    sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ messages: [{ role: "user", content: "Write a fictional reply." }] }) },
    modelRegistry: {
      getModelOfType: () => ({ id: "typesafe/jev-1.14", provider: "openrouter" }),
      classify: async (_model, body, options) => {
        calls.push(body);
        callOptions.push(options);
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
        if (typeof answer === "function") return answer();
        return answer;
      },
    },
  };
  async function emit(name, event = {}) {
    let result;
    for (const handler of extension.handlers.get(name) ?? []) {
      const value = await handler({ type: name, ...event }, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  }
  await emit("before_agent_start", { messageType: "user", prompt: "Write a fictional reply.", systemPromptOptions: { skills } });
  await emit("message_start", { message: { role: "user" } });
  async function candidate(text, entries = []) {
    const value = message(text);
    await emit("message_start", { message: value });
    const ended = await emit("message_end", { message: value });
    const boundary = await emit("agent_before_settle", { entries, outcome: "completed", continue: false, context: { canContinue: false } });
    return { ended, boundary, verdict: boundary?.entries.findLast((entry) => entry.customType === "reply-guard-verdict")?.data };
  }
  return { calls, callOptions, statuses, notices, candidate, emit, ctx, controller, configPath, extension };
}

test("reply guard upstream regressions", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [title, maxRewrites, probabilities, expectedCalls, termination] of [
    ["original passes", 2, [1], 1, "passed"],
    ["first repair passes", 2, [0, 1], 2, "passed"],
    ["last permitted repair passes", 2, [0, 0, 1], 3, "passed"],
    ["all candidates fail", 2, [0, 0, 0], 3, "rewrite-limit"],
    ["zero budget audits once", 0, [0], 1, "rewrite-limit"],
  ]) {
    await t.test(title, async () => {
      const f = await fixture({ config: { maxRewrites }, answers: probabilities.map(response) });
      let result;
      let repairs = 0;
      do {
        result = await f.candidate(`Fictional candidate ${repairs}.`);
        if (result.boundary?.continue) repairs++;
        assert.ok(repairs <= maxRewrites, "Repair count exceeded the configured cap");
      } while (result.boundary?.continue);
      assert.equal(f.calls.length, expectedCalls);
      assert.equal(result.verdict.termination, termination);
      assert.equal(result.verdict.reply, `Fictional candidate ${repairs}.`);
      assert.equal(result.verdict.status, termination === "passed" ? "passed" : "failed");
    });
  }
  for (const [title, answer] of [
    ["returned credential error", { stopReason: "error", answers: {}, errorMessage: "Synthetic credential rejection" }],
    ["missing answer", { stopReason: "stop", answers: {} }],
    ["wrong answer type", { stopReason: "stop", answers: { meets: { type: "noul", noul: 1 } } }],
    ["NaN probability", response(NaN)],
    ["out of range probability", response(2)],
    ["thrown error", () => { throw new Error("Synthetic transport failure"); }],
  ]) {
    await t.test(title, async () => {
      const f = await fixture({ answers: [answer] });
      const { verdict, boundary } = await f.candidate("Original.");
      assert.equal(verdict.status, "incomplete");
      assert.equal(verdict.termination, "checker-unavailable");
      assert.notEqual(boundary.continue, true);
      assert.equal(verdict.reply, "Original.");
      assert.ok(verdict.verdicts[0].error);
    });
  }
  await t.test("unavailable model remains incomplete", async () => {
    const f = await fixture();
    f.ctx.modelRegistry.getModelOfType = () => undefined;
    const { verdict } = await f.candidate("Original.");
    assert.equal(verdict.status, "incomplete");
    assert.equal(verdict.termination, "checker-unavailable");
    assert.equal(f.calls.length, 0);
  });
  for (const [title, options] of [
    ["invalid configuration", { config: "{bad json" }],
    ["missing selected skill", { skills: [] }],
    ["unreadable selected skill", { skills: [{ ...skill, filePath: join(home, "missing.md") }] }],
    ["no selected skills", { config: { skills: {} } }],
  ]) {
    await t.test(title, async () => {
      const f = await fixture(options);
      const before = readFileSync(f.configPath, "utf8");
      const { verdict } = await f.candidate("Original.");
      assert.equal(verdict.status, "incomplete");
      assert.equal(verdict.termination, "configuration-error");
      assert.equal(verdict.reply, "Original.");
      assert.equal(readFileSync(f.configPath, "utf8"), before);
      assert.equal(f.calls.length, 0);
    });
  }
  await t.test("boundary entries survive and a false initial canContinue permits feedback", async () => {
    const f = await fixture({ answers: [response(0)] });
    const other = { type: "custom", customType: "other-extension", data: { keep: true } };
    const { boundary } = await f.candidate("Original.", [other]);
    assert.deepEqual(boundary.entries[0], other);
    assert.equal(boundary.continue, true);
  });
  await t.test("request exceptions and response endings are not truncated", async () => {
    const f = await fixture();
    const request = "a".repeat(4500) + " Reproduce the quoted text exactly.";
    const reply = "b".repeat(17000) + " Ending.";
    f.ctx.sessionManager.buildSessionProjection = () => ({ messages: [{ role: "user", content: request }] });
    await f.candidate(reply);
    assert.equal(f.calls[0].state.request, request);
    assert.equal(f.calls[0].state.reply, reply);
  });
  for (const texts of [["A.", "A."], ["A.", "B.", "A."]]) {
    await t.test(`cycle ${texts.join(" ")}`, async () => {
      const f = await fixture({ config: { maxRewrites: 5 }, answers: [response(0)] });
      let result;
      for (const text of texts) result = await f.candidate(text);
      assert.equal(result.verdict.termination, "repeated-candidate");
      assert.equal(result.verdict.reply, "A.");
      assert.notEqual(result.boundary.continue, true);
      assert.equal(f.calls.length, texts.length - 1);
    });
  }
  await t.test("low-level agent starts do not replenish the rewrite budget", async () => {
    const f = await fixture({ config: { maxRewrites: 1 }, answers: [response(0)] });
    await f.candidate("A.");
    await f.emit("agent_start");
    assert.equal((await f.candidate("B.")).verdict.termination, "rewrite-limit");
    await f.emit("message_start", { message: { role: "user" } });
    assert.equal((await f.candidate("C.")).boundary.continue, true);
  });
  await t.test("every text block is audited and whitespace is retained", async () => {
    const f = await fixture();
    await f.emit("message_end", { message: { ...message(""), content: [{ type: "text", text: "  First. " }, { type: "thinking", thinking: "Not prose." }, { type: "text", text: "Last.\n" }] } });
    const result = await f.emit("agent_before_settle", { entries: [], outcome: "completed" });
    assert.equal(f.calls[0].state.reply, "  First. \nLast.\n");
    assert.equal(result.entries[0].data.reply, "  First. \nLast.\n");
  });
  for (const reason of ["aborted", "length", "error", "toolUse"]) {
    await t.test(`incomplete generation ${reason} is not audited`, async () => {
      const f = await fixture();
      await f.emit("message_end", { message: { ...message("Partial."), stopReason: reason } });
      assert.equal(f.calls.length, 0);
    });
  }
  await t.test("deadline bounds a provider that ignores cancellation", async () => {
    const f = await fixture({ config: { auditDeadlineMs: 20 }, answers: [() => new Promise(() => {})] });
    const started = performance.now();
    const { verdict } = await f.candidate("Original.");
    assert.equal(verdict.status, "incomplete");
    assert.ok(performance.now() - started < 500);
    assert.equal(f.calls.length, 1);
    assert.equal(f.callOptions[0].maxRetries, 0);
    assert.equal(f.callOptions[0].signal.aborted, true);
  });
  for (const event of ["input", "session_shutdown", "session_tree"]) {
    await t.test(`${event} discards an awaited result`, async () => {
      let finish;
      const f = await fixture({ answers: [() => new Promise((resolve) => { finish = resolve; })] });
      const pending = f.emit("message_end", { message: message("Obsolete.") });
      await f.emit(event);
      finish(response(0));
      assert.equal(await pending, undefined);
      assert.equal(await f.emit("agent_before_settle", { entries: [], outcome: "completed" }), undefined);
    });
  }
  await t.test("partial failure retains a known violation", async () => {
    const f = await fixture({
      config: { skills: { fixture: 0.9, second: 0.9 }, maxRewrites: 0 },
      skills: [skill, { ...skill, name: "second" }],
      answers: [response(0), { stopReason: "error", answers: {} }],
    });
    const { verdict } = await f.candidate("Original.");
    assert.equal(verdict.status, "failed");
    assert.equal(verdict.incomplete, true);
    assert.deepEqual(verdict.verdicts.map((v) => v.outcome), ["violation", "unavailable"]);
  });
  await t.test("request and concurrency budgets hold", async () => {
    const skills = Array.from({ length: 6 }, (_, index) => ({ ...skill, name: `skill${index}` }));
    const f = await fixture({ config: { skills: Object.fromEntries(skills.map((s) => [s.name, 0.9])), classifierConcurrency: 2, maxClassifierRequests: 3 }, skills });
    let active = 0;
    let peak = 0;
    let requests = 0;
    f.ctx.modelRegistry.classify = async () => {
      requests++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return response(1);
    };
    const { verdict } = await f.candidate("Original.");
    assert.equal(requests, 3);
    assert.equal(peak, 2);
    assert.equal(verdict.status, "incomplete");
    assert.equal(verdict.verdicts.filter((v) => v.outcome === "unavailable").length, 3);
  });
  await t.test("oversize exact input is marked incomplete without sending a prefix", async () => {
    const f = await fixture();
    const { verdict } = await f.candidate("Long prose. ".repeat(10000));
    assert.equal(verdict.status, "incomplete");
    assert.equal(f.calls.length, 0);
    assert.match(verdict.verdicts[0].error, /per-question limit/);
  });
  await t.test("legacy settings migrate on save with compliance thresholds and a private backup", async () => {
    const legacy = JSON.stringify({ skills: { fixture: 0.7 }, maxRewrites: 2, unrelated: { keep: true } });
    const f = await fixture({ config: legacy });
    const before = new Set(readdirSync(agentDir));
    let selections = 0;
    f.ctx.hasUI = true;
    f.ctx.ui.select = async () => selections++ === 0 ? "Show verdicts: on" : "Done";
    await f.extension.commands.get("reply-guard").handler("", f.ctx);
    const saved = JSON.parse(readFileSync(f.configPath, "utf8"));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.thresholdMeaning, "compliance");
    assert.equal(saved.skills.fixture, 0.7);
    assert.equal(saved.model, "openrouter/typesafe/jev-1.13");
    assert.equal(saved.preload, true);
    assert.deepEqual(saved.unrelated, { keep: true });
    const backups = readdirSync(agentDir).filter((name) => !before.has(name) && name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    const backup = join(agentDir, backups[0]);
    assert.equal(readFileSync(backup, "utf8"), legacy);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(statSync(f.configPath).mode & 0o777, 0o600);
  });
  await t.test("configuration editor preserves concurrent changes", async () => {
    const f = await fixture();
    const replacement = JSON.stringify({ skills: { fixture: 0.5 } });
    let selections = 0;
    f.ctx.hasUI = true;
    f.ctx.ui.select = async () => {
      if (selections++ !== 0) return "Done";
      writeFileSync(f.configPath, replacement);
      return "Show verdicts: on";
    };
    await f.extension.commands.get("reply-guard").handler("", f.ctx);
    assert.equal(readFileSync(f.configPath, "utf8"), replacement);
    assert.ok(f.notices.some(([text]) => text.includes("Configuration changed")));
  });
  for (const config of [{ schemaVersion: 2 }, { thresholdMeaning: "violation" }, { auditDeadlineMs: 0 }, { classifierConcurrency: 1.5 }, { maxClassifierRequests: -1 }]) {
    await t.test(`invalid setting ${Object.keys(config)[0]} fails explicitly`, async () => {
      const f = await fixture({ config });
      const { verdict } = await f.candidate("Original.");
      assert.equal(verdict.termination, "configuration-error");
      assert.equal(f.calls.length, 0);
    });
  }
  await t.test("input budget prevents transport", async () => {
    const f = await fixture({ config: { maxInputTokens: 1 } });
    const { verdict } = await f.candidate("Original.");
    assert.equal(verdict.status, "incomplete");
    assert.equal(f.calls.length, 0);
  });
});
