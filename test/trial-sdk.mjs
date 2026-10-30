import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { EXPERIMENTAL_CHECKS } from "../lib/experimental.mjs";
import { makeTrialCatalog, skill } from "./fixtures/catalog.mjs";
import { setup, home, configPath, answer, good, bad, assistantText } from "./fixtures/extension.mjs";

const original = "Retain the log for 2 hours. This is storage, not deletion.";
const classify = (body) => {
  const result = answer(body);
  for (const id of EXPERIMENTAL_CHECKS) if (result.answers[id] && body.state.reply?.text === original) result.answers[id].noul = 0.99;
  return result;
};
const fixture = (options = {}) => setup({ catalog: makeTrialCatalog(), text: original, classify, ...options });

async function until(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the isolated writer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("experimental semantic trial through the native Pi package", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await t.test("defaults retain advisory findings without a rewrite", async () => {
    const f = await fixture({ replies: [] });
    try {
      await f.session.prompt("Give the retention instruction.");
      assert.deepEqual(f.errors, []);
      assert.equal(f.writes(), 0);
      assert.equal(f.results()[0].data.reply, original);
      assert.ok(f.results()[0].data.audit.checks.filter((check) => EXPERIMENTAL_CHECKS.includes(check.id)).every((check) => check.disposition === "advisory"));
    } finally { f.session.dispose(); }
  });
  for (const [name, reply, expected] of [["repairs a semantic violation", good, good], ["rejects a meaning-changing repair", bad, original]]) await t.test(name, async () => {
    const f = await fixture({ config: { experimentalChecks: EXPERIMENTAL_CHECKS, maxRewrites: 1, showVerdicts: false }, replies: [reply] });
    try {
      await f.session.prompt("Give the retention instruction.");
      assert.deepEqual(f.errors, []);
      assert.equal(f.writes(), 1);
      assert.equal(f.toolCalls(), 0);
      const data = f.results()[0].data;
      assert.equal(data.reply, expected);
      assert.equal(data.rewrites, 1);
      assert.equal(data.candidates[0].audit.checks.filter((check) => check.experimental).length, 2);
      assert.equal(data.candidates[1].preserved, reply === good);
      assert.ok(data.audit.checks.filter((check) => check.experimental).every((check) => check.calibration.state === "uncalibrated"));
      if (reply === good) assert.doesNotMatch(f.render(), /\[reply-guard\]/);
      else assert.match(f.render(240), /2 experimental active \(uncalibrated\)/);
      assert.match(f.render(240, true, true), /2 experimental active \(uncalibrated\)/);
      assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), [expected]);
      await f.session.prompt("Refer to the retention instruction.");
      assert.deepEqual(assistantText(f.requests[1].messages), [expected]);
      assert.equal(f.writes(), 1);
    } finally { f.session.dispose(); }
  });
  await t.test("on and off commands persist opt-in and expose effective coverage", async () => {
    const f = await fixture({ replies: [] });
    try {
      await f.session.prompt("Give the retention instruction.");
      await f.command("trial on");
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).experimentalChecks, EXPERIMENTAL_CHECKS);
      await f.command("status");
      assert.deepEqual(JSON.parse(f.notices.at(-1)[0]).experimentalChecks, EXPERIMENTAL_CHECKS);
      await f.command("coverage");
      assert.match(f.editors.at(-1)[1], /active \(uncalibrated, experimental\)/);
      await f.command("trial off");
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).experimentalChecks, []);
      await f.command("coverage");
      assert.doesNotMatch(f.editors.at(-1)[1], /experimental\)/);
      assert.deepEqual(f.errors, []);
    } finally { f.session.dispose(); }
  });
  await t.test("trial command refuses stale definitions without changing settings", async () => {
    const f = await fixture({ skillText: skill.replace("Fictional policy 9.", "Changed policy 9."), replies: [] });
    try {
      await f.session.prompt("Give the retention instruction.");
      const before = readFileSync(configPath, "utf8");
      await f.command("trial on");
      assert.equal(readFileSync(configPath, "utf8"), before);
      assert.match(f.notices.at(-1)[0], /stale or unavailable/);
      assert.equal(f.notices.at(-1)[1], "error");
    } finally { f.session.dispose(); }
  });
  await t.test("trial command keeps observe mode", async () => {
    const f = await fixture({ config: { mode: "observe" }, replies: [] });
    try {
      await f.session.prompt("Give the retention instruction.");
      await f.command("trial on");
      assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mode, "observe");
      assert.equal(f.writes(), 0);
    } finally { f.session.dispose(); }
  });
  for (const experimentalChecks of [true, ["unknown"], ["em-dash"], ["formulaic-contrast", "formulaic-contrast"]]) await t.test(`invalid trial configuration ${JSON.stringify(experimentalChecks)}`, async () => {
    const f = await fixture({ config: { experimentalChecks }, replies: [] });
    try {
      await f.session.prompt("Give the retention instruction.");
      assert.equal(f.results()[0].data.delivery, "withheld");
      assert.equal(f.results()[0].data.termination, "configuration-error");
      assert.equal(f.writes(), 0);
    } finally { f.session.dispose(); }
  });
  await t.test("disabling the trial cancels an in-flight repair", async () => {
    let release;
    let signal;
    const f = await fixture({ config: { experimentalChecks: EXPERIMENTAL_CHECKS }, replies: [(options) => {
      signal = options.signal;
      return new Promise((resolve) => { release = resolve; });
    }] });
    try {
      const pending = f.session.prompt("Give the retention instruction.");
      await until(() => release !== undefined);
      await f.command("trial off");
      await pending;
      assert.equal(signal.aborted, true);
      assert.deepEqual(f.errors, []);
      assert.equal(f.results().at(-1).data.delivery, "withheld");
      assert.equal(f.results().at(-1).data.rewrites, 1);
      assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), []);
      release(good);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(f.results().filter((entry) => entry.data.reply).length, 0);
    } finally { f.session.dispose(); }
  });
});
