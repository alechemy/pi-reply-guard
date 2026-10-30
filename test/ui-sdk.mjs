import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { setup, home, sdk, good, answer } from "./fixtures/extension.mjs";
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
      assert.match(f.render(120, true, true), /advisory coverage incomplete/);
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
      assert.match(f.render(240, true, true), /2 experimental active \(uncalibrated\)/);
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
      assert.deepEqual(f.statuses.at(-1), ["reply-guard", undefined]);
      if (releasePolicy === "strict") assert.match(f.render(), /reply-guard recover/);
      assert.deepEqual(f.errors, []);
    } finally { f.session.dispose(); }
  });
});
