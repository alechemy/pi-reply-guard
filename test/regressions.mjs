import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setup, home, agentDir, configPath, sdk, original, good, answer, assistantText } from "./fixtures/extension.mjs";
import { skill } from "./fixtures/catalog.mjs";

const pause = () => new Promise((resolve) => setImmediate(resolve));
const until = async (condition) => { for (let i = 0; i < 200 && !condition(); i++) await pause(); assert.ok(condition(), "Fixture did not reach the expected stage"); };

test("loaded extension failure, cancellation, and configuration regressions", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [name, options, strict] of [
    ["malformed configuration", { configText: "{bad json" }, true],
    ["missing selected skill", { missingSkill: true }, false],
    ["unreadable skill", { config: { skillPath: join(home, "missing.md") } }, false],
    ["missing catalog under strict policy", { config: { catalogPath: join(home, "missing.json"), releasePolicy: "strict" } }, true],
    ["invalid configuration enum", { config: { mode: "invalid" } }, true],
    ["invalid audit budget", { config: { auditDeadlineMs: 0 } }, true],
    ["invalid concurrency", { config: { classifierConcurrency: 1.5 } }, true],
    ["invalid writer deadline", { config: { writerDeadlineMs: 0 } }, true],
    ["legacy thresholds cannot be relabeled as version 2", { config: { skills: { fixture: 0.7 } } }, true],
  ]) await t.test(name, async () => {
    const f = await setup({ ...options, replies: [] });
    const bytes = readFileSync(configPath, "utf8");
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      const data = f.results()[0].data;
      assert.equal(data.audit.status, "incomplete");
      assert.equal(data.termination, "configuration-error");
      assert.equal(data.delivery, strict ? "withheld" : "released");
      assert.equal(data.reply, strict ? undefined : original);
      assert.equal(f.calls.length, 0);
      assert.equal(readFileSync(configPath, "utf8"), bytes);
    } finally { f.session.dispose(); }
  });
  await t.test("stale catalog cannot pass strict checks", async () => {
    const f = await setup({ text: good, replies: [], config: { releasePolicy: "strict" }, skillText: skill + "\nChanged policy.\n" });
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      assert.equal(f.results()[0].data.audit.incomplete, true);
      assert.equal(f.results()[0].data.delivery, "withheld");
      assert.match(f.render(), /catalog stale or incomplete/);
    } finally { f.session.dispose(); }
  });
  for (const [name, classify] of [
    ["bad credentials", () => new Response(JSON.stringify({ error: "PRIVATE-PAYLOAD" }), { status: 401 })],
    ["missing answer", (body) => { const value = answer(body); delete value.answers[Object.keys(value.answers)[0]]; return value; }],
    ["malformed answer", (body) => { const value = answer(body); value.answers[Object.keys(value.answers)[0]] = { type: "bool", probability: 0 }; return value; }],
    ["nonfinite answer", (body) => { const value = answer(body); value.answers[Object.keys(value.answers)[0]].noul = NaN; return value; }],
    ["out-of-range answer", (body) => { const value = answer(body); value.answers[Object.keys(value.answers)[0]].noul = 2; return value; }],
    ["unexpected answer", (body) => ({ ...answer(body), answers: { ...answer(body).answers, unknown: { type: "noul", noul: 0 } } })],
  ]) await t.test(name, async () => {
    const f = await setup({ classify, replies: [], config: { maxRewrites: 0 } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      const data = f.results()[0].data;
      assert.equal(data.audit.status, "failed");
      assert.equal(data.audit.advisoryIncomplete, true);
      assert.ok(data.audit.checks.some((check) => check.id === "em-dash" && check.outcome === "violation"));
      assert.equal(data.reply, original);
      assert.doesNotMatch(JSON.stringify(data), /PRIVATE-PAYLOAD/);
    } finally { f.session.dispose(); }
  });
  await t.test("an audit deadline bounds a classifier that ignores cancellation", async () => {
    const f = await setup({ classify: () => new Promise(() => {}), replies: [], config: { auditDeadlineMs: 20, maxRewrites: 0 } });
    try {
      const start = performance.now();
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      assert.ok(performance.now() - start < 1000);
      assert.equal(f.results()[0].data.audit.advisoryIncomplete, true);
    } finally { f.session.dispose(); }
  });
  await t.test("input budgets remain visible without classifier requests", async () => {
    const f = await setup({ replies: [], config: { maxInputTokens: 1, maxRewrites: 0 } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.equal(f.calls.length, 0);
      assert.equal(f.results()[0].data.audit.advisoryIncomplete, true);
      assert.equal(f.results()[0].data.reply, original);
    } finally { f.session.dispose(); }
  });
  for (const mode of ["off", "observe", "abort"]) await t.test(`${mode} cancels an isolated repair`, async () => {
    let release;
    let signal;
    const f = await setup({ config: { writerDeadlineMs: 1000 }, replies: [(options) => { signal = options.signal; return new Promise((resolve) => { release = resolve; }); }] });
    try {
      const pending = f.session.prompt("Give the instruction.");
      await until(() => release !== undefined);
      const started = performance.now();
      if (mode === "abort") await f.session.abort();
      else await f.command(mode);
      await pending;
      assert.ok(performance.now() - started < 500);
      assert.equal(signal.aborted, true);
      assert.deepEqual(f.errors, []);
      assert.equal(f.results().at(-1).data.delivery, "withheld");
      assert.equal(f.results().at(-1).data.termination, mode === "abort" ? "cancelled" : "mode-changed");
      assert.equal(f.results().at(-1).data.rewrites, 1);
      if (mode !== "abort") assert.equal(f.statuses.at(-1)[1], `Mode: ${mode}`);
      assert.doesNotMatch(f.render(), /Retain the log/);
      assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), []);
      release(good);
      await pause();
      assert.equal(f.results().filter((entry) => entry.data.reply).length, 0);
      await f.session.prompt("Write the next reply.");
      assert.deepEqual(assistantText(f.requests[1].messages), []);
      assert.equal(f.writes(), 1);
    } finally { f.session.dispose(); }
  });
  await t.test("aborted classification stays concealed and recoverable after resume", async () => {
    let release;
    const f = await setup({ replies: [], classify: (body) => new Promise((resolve) => { release = () => resolve(answer(body)); }) });
    const pending = f.session.prompt("Give the instruction.");
    await until(() => release !== undefined);
    await f.session.abort();
    await pending;
    release();
    await pause();
    assert.deepEqual(f.errors, []);
    assert.equal(f.results().at(-1).data.delivery, "withheld");
    assert.doesNotMatch(f.render(), /Retain the log/);
    assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), []);
    const file = f.sessionManager.getSessionFile();
    f.session.dispose();
    const resumed = await setup({ priorManager: sdk.SessionManager.open(file), replies: [] });
    try {
      assert.doesNotMatch(resumed.render(), /Retain the log/);
      await resumed.command("recover");
      assert.deepEqual(resumed.editors.at(-1), ["Withheld draft (inspection only)", original]);
    } finally { resumed.session.dispose(); }
  });
  await t.test("an interrupted draft is concealed on startup and excluded from the next request", async () => {
    const manager = sdk.SessionManager.create(home, join(home, "sessions"));
    const marker = "\n\n<!--reply-guard:fictional-marker-->";
    manager.appendMessage({ role: "user", content: "Give the instruction.", timestamp: Date.now() });
    manager.appendCustomEntry("reply-guard-draft", { id: "interrupted", markers: [marker], text: original, mode: "enforce", releasePolicy: "warning" });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: original + marker }], stopReason: "stop", provider: "fixture", api: "fixture", model: "fixture", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const f = await setup({ priorManager: manager, replies: [] });
    try {
      assert.equal(f.results()[0].data.termination, "interrupted");
      assert.equal(f.results()[0].data.rewrites, null);
      assert.equal(f.results()[0].data.writerUsage, null);
      assert.doesNotMatch(f.render(), /Retain the log/);
      await f.session.prompt("Write the next reply.");
      assert.deepEqual(f.errors, []);
      assert.deepEqual(assistantText(f.requests[0].messages), []);
      assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), ["Follow-up reply."]);
    } finally { f.session.dispose(); }
  });
  await t.test("mid-cycle file edits do not change the captured policy, catalog, or cap", async () => {
    const f = await setup({ replies: [() => {
      writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, skill: "fixture", mode: "off", maxRewrites: 0 }));
      writeFileSync(join(home, "reply-guard.rules.json"), "{invalid");
      return good;
    }] });
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      assert.equal(f.results()[0].data.mode, "enforce");
      assert.equal(f.results()[0].data.reply, good);
      const calls = f.calls.length;
      await f.session.prompt("Write the next reply.");
      assert.equal(f.calls.length, calls);
      assert.equal(f.results().length, 1);
    } finally { f.session.dispose(); }
  });
  await t.test("legacy migration is explicit and preserves threshold meaning and preferences", async () => {
    const legacy = JSON.stringify({ skills: { fixture: 0.7 }, maxRewrites: 2, unrelated: { keep: true } });
    const f = await setup({ configText: legacy, replies: [] });
    try {
      await f.session.prompt("Give the instruction.");
      assert.equal(readFileSync(configPath, "utf8"), legacy);
      assert.equal(f.results()[0].data.delivery, "withheld");
      const before = new Set(readdirSync(agentDir));
      await f.command("migrate");
      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(saved.schemaVersion, 2);
      assert.equal(saved.thresholdMeaning, "violation");
      assert.deepEqual(saved.legacyCompliance.skills, { fixture: 0.7 });
      assert.equal(saved.legacyCompliance.thresholdMeaning, "compliance");
      assert.equal(saved.skills, undefined);
      assert.equal(saved.model, "openrouter/typesafe/jev-1.13");
      assert.equal(saved.preload, true);
      assert.deepEqual(saved.unrelated, { keep: true });
      const backups = readdirSync(agentDir).filter((name) => !before.has(name) && name.endsWith(".bak"));
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(join(agentDir, backups[0]), "utf8"), legacy);
      assert.equal(statSync(join(agentDir, backups[0])).mode & 0o777, 0o600);
      assert.equal(statSync(configPath).mode & 0o777, 0o600);
    } finally { f.session.dispose(); }
  });
  await t.test("migration preserves unsupported multi-skill settings for an explicit mapping decision", async () => {
    const legacy = JSON.stringify({ skills: { fixture: 0.7, other: 0.8 } });
    const f = await setup({ configText: legacy, replies: [] });
    try {
      await f.session.prompt("Give the instruction.");
      await f.command("migrate");
      assert.equal(readFileSync(configPath, "utf8"), legacy);
      assert.ok(f.notices.some(([text]) => text.includes("one catalog-backed skill")));
    } finally { f.session.dispose(); }
  });
  await t.test("configuration editor preserves concurrent changes", async () => {
    const f = await setup({ replies: [], config: { maxRewrites: 0 } });
    try {
      await f.session.prompt("Give the instruction.");
      const replacement = JSON.stringify({ schemaVersion: 2, skill: "fixture", mode: "observe" });
      f.ui.select = async () => { writeFileSync(configPath, replacement); return "Show verdicts: on"; };
      await f.command("");
      assert.equal(readFileSync(configPath, "utf8"), replacement);
      assert.ok(f.notices.some(([text]) => text.includes("Configuration changed")));
    } finally { f.session.dispose(); }
  });
  await t.test("coverage and verdict commands inspect without changing session context", async () => {
    const f = await setup({ text: good, replies: [] });
    try {
      await f.session.prompt("Give the instruction.");
      const before = f.sessionManager.getBranch().length;
      for (const command of ["status", "coverage", "verdict"]) await f.command(command);
      assert.equal(f.sessionManager.getBranch().length, before);
      assert.ok(f.editors.some(([title, text]) => title.includes("coverage") && text.includes("36")));
      assert.ok(f.editors.some(([title, text]) => title.includes("verdict") && JSON.parse(text).reply === undefined && JSON.parse(text).draft === undefined));
    } finally { f.session.dispose(); }
  });
});
