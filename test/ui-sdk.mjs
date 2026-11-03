import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { setup, home, sdk, good, bad, answer } from "./fixtures/extension.mjs";
import { makeTrialCatalog } from "./fixtures/catalog.mjs";
import { EXPERIMENTAL_CHECKS } from "../lib/experimental.mjs";

const assertQuiet = (f) => {
  assert.doesNotMatch(f.render(), /\[reply-guard\]/);
  assert.equal(f.render().split(good).length - 1, 1);
  assert.deepEqual(f.statuses.at(-1), ["reply-guard", undefined]);
};

test("quiet verdicts and transient footer through native Pi rendering", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await t.test("passing replies are quiet by default and details remain available", async () => {
    const f = await setup({ text: good, replies: [] });
    try {
      assert.ok(f.statuses.every(([, value]) => value === undefined));
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      assertQuiet(f);
      assert.deepEqual(f.statuses.filter(([, value]) => value !== undefined), [["reply-guard", "Reply guard: checking"]]);
      assert.match(f.render(120, true, true), /active checks passed/);
      await f.command("verdict");
      assert.equal(JSON.parse(f.editors.at(-1)[1]).audit.status, "passed");
    } finally { f.session.dispose(); }
  });
  await t.test("advisory-only incomplete coverage stays in the stored verdict", async () => {
    const f = await setup({ text: good, replies: [], config: { showVerdicts: false, model: "typesafe/jev-latest" } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.equal(f.results()[0].data.audit.advisoryIncomplete, true);
      assertQuiet(f);
      assert.match(f.render(300, true, true), /advisory coverage incomplete/);
    } finally { f.session.dispose(); }
  });
  await t.test("advisory findings stay in the stored verdict", async () => {
    const f = await setup({ text: good, replies: [], config: { showVerdicts: false }, classify: (body) => {
      const result = answer(body);
      for (const value of Object.values(result.answers)) value.noul = 0.99;
      return result;
    } });
    try {
      await f.session.prompt("Give the instruction.");
      const audit = f.results()[0].data.audit;
      assert.equal(audit.status, "passed");
      assert.ok(audit.checks.some((check) => check.disposition === "advisory" && check.outcome === "violation"));
      assertQuiet(f);
    } finally { f.session.dispose(); }
  });
  await t.test("experimental passes are quiet and retain uncalibrated labels in details", async () => {
    const f = await setup({ text: good, replies: [], catalog: makeTrialCatalog(), config: { experimentalChecks: EXPERIMENTAL_CHECKS, showVerdicts: false } });
    try {
      await f.session.prompt("Give the instruction.");
      assertQuiet(f);
      assert.match(f.render(240, true, true), /3 experimental active \(uncalibrated\)/);
    } finally { f.session.dispose(); }
  });
  await t.test("successful rewrites show the attempt count even when passing banners are hidden", async () => {
    const f = await setup({ config: { showVerdicts: false } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.equal(f.writes(), 1);
      assert.match(f.render(300), /1 rewrite attempt/);
      assert.match(f.render(300), /rewritten reply released \(passed\)/);
      assert.equal(f.render().split(good).length - 1, 1);
      assert.deepEqual(f.statuses.at(-1), ["reply-guard", undefined]);
    } finally { f.session.dispose(); }
  });
  await t.test("inconclusive preservation explains why the original was released", async () => {
    const f = await setup({ config: { showVerdicts: false }, classify: (body) => {
      const result = answer(body);
      if (body.questions["preserve-negation"]) result.answers["preserve-negation"].noul = 0.5;
      return result;
    } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.equal(f.writes(), 1);
      assert.equal(f.results()[0].data.termination, "checker-unavailable");
      assert.match(f.render(300), /1 rewrite attempt/);
      assert.match(f.render(300), /original released \(checker-unavailable\)/);
      assert.match(f.render(300), /Last audited rewrite: preservation inconclusive/);
    } finally { f.session.dispose(); }
  });
  await t.test("rewrite diagnostics include budget exhaustion without claiming a preservation violation", async () => {
    const f = await setup({ text: good, replies: [], config: { showVerdicts: false } });
    try {
      await f.session.prompt("Give the instruction.");
      const data = f.results()[0].data;
      f.sessionManager.appendCustomEntry("reply-guard-repair", {
        ...data, reply: undefined, rewrites: 1, termination: "checker-unavailable",
        candidates: [...data.candidates, { id: "incomplete-revision", preserved: false, audit: {
          status: "incomplete", incomplete: true, checks: [
            { id: "preserve-negation", disposition: "active", outcome: "unavailable", incomplete: true, reasons: ["Meaning-preservation confidence is inconclusive."] },
            { id: "unnecessary-qualification", disposition: "active", outcome: "unavailable", incomplete: true, reasons: ["Classifier input budget reached."] },
          ],
        } }],
      });
      assert.match(f.render(300), /Last audited rewrite: preservation inconclusive · classifier input budget reached/);
      assert.doesNotMatch(f.render(300), /meaning-preservation violation/);
    } finally { f.session.dispose(); }
  });
  await t.test("historical records do not invent rewrite counts or release origins", async () => {
    const f = await setup({ text: good, replies: [], config: { showVerdicts: false } });
    try {
      await f.session.prompt("Give the instruction.");
      const data = f.results()[0].data;
      f.sessionManager.appendCustomEntry("reply-guard-repair", {
        ...data, reply: undefined, rewrites: undefined, candidates: undefined, selectedId: undefined,
      });
      assertQuiet(f);
      f.sessionManager.appendCustomEntry("reply-guard-repair", {
        ...data, reply: undefined, rewrites: null, candidates: [], selectedId: undefined, delivery: "withheld", termination: "interrupted",
      });
      assert.match(f.render(300), /rewrite count unavailable/);
      assert.doesNotMatch(f.render(300), /original released|rewritten reply released/);
    } finally { f.session.dispose(); }
  });
  await t.test("a rejected revision remains visible after an earlier rewrite is selected", async () => {
    const partial = "Retain the log\u2014for 2 hours. Keep it available.";
    const f = await setup({ config: { showVerdicts: false, maxRewrites: 2 }, replies: [partial, bad] });
    try {
      await f.session.prompt("Give the instruction.");
      assert.equal(f.writes(), 2);
      assert.equal(f.results()[0].data.reply, partial);
      assert.match(f.render(300), /2 rewrite attempts/);
      assert.match(f.render(300), /rewritten reply released \(rewrite-limit\)/);
      assert.match(f.render(300), /Last audited rewrite: meaning-preservation violation/);
    } finally { f.session.dispose(); }
  });
  await t.test("writer errors count as attempts without claiming a revised candidate", async () => {
    const f = await setup({ replies: ["ERROR"], config: { showVerdicts: false } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.equal(f.results()[0].data.candidates.length, 1);
      assert.match(f.render(300), /1 rewrite attempt/);
      assert.match(f.render(300), /original released \(writer-error\)/);
      assert.doesNotMatch(f.render(300), /Last audited rewrite/);
    } finally { f.session.dispose(); }
  });
  await t.test("showVerdicts explicitly enables passing banners without a persistent footer", async () => {
    const f = await setup({ text: good, replies: [], config: { showVerdicts: true } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.match(f.render(), /active checks passed/);
      assert.deepEqual(f.statuses.at(-1), ["reply-guard", undefined]);
      await f.command("off");
      assert.deepEqual(f.statuses.at(-1), ["reply-guard", undefined]);
    } finally { f.session.dispose(); }
  });
  await t.test("current display preference hides historical passing banners on resume", async () => {
    const first = await setup({ text: good, replies: [], config: { showVerdicts: true } });
    let file;
    try {
      await first.session.prompt("Give the instruction.");
      assert.match(first.render(), /active checks passed/);
      file = first.sessionManager.getSessionFile();
    } finally { first.session.dispose(); }
    const resumed = await setup({ priorManager: sdk.SessionManager.open(file), config: { showVerdicts: false }, replies: [] });
    try {
      assert.equal(resumed.results()[0].data.showVerdicts, true);
      assertQuiet(resumed);
      assert.deepEqual(resumed.errors, []);
    } finally { resumed.session.dispose(); }
  });
  for (const releasePolicy of ["warning", "strict"]) await t.test(`${releasePolicy} failures remain visible without a persistent footer`, async () => {
    const f = await setup({ replies: [], config: { showVerdicts: false, maxRewrites: 0, releasePolicy } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.match(f.render(), /active checks failed/);
      assert.match(f.render(), /0 rewrite attempts/);
      assert.deepEqual(f.statuses.at(-1), ["reply-guard", undefined]);
      if (releasePolicy === "strict") assert.match(f.render(), /reply-guard recover/);
      assert.deepEqual(f.errors, []);
    } finally { f.session.dispose(); }
  });
});
