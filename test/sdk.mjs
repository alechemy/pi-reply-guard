import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { setup, home, sdk, original, good, bad, assistantText } from "./fixtures/extension.mjs";

const occurrences = (text, phrase) => text.split(phrase).length - 1;

test("package entry point, delivery policies, and native Pi rendering", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [name, text, replies, cap, expected, termination] of [
    ["original passes", good, [], 2, good, "passed"],
    ["first repair passes", original, [good], 2, good, "passed"],
    ["last permitted repair passes", original, ["Keep the log—for 2 hours.", good], 2, good, "passed"],
    ["exhaustion selects the preserved fallback", original, ["Keep the log—for 2 hours.", bad], 2, "Keep the log—for 2 hours.", "rewrite-limit"],
    ["all candidates fail", original, ["Keep the log—for 2 hours.", "Save the log—for 2 hours."], 2, "Save the log—for 2 hours.", "rewrite-limit"],
    ["zero cap", original, [], 0, original, "rewrite-limit"],
    ["identical candidate", original, [original], 2, original, "repeated-candidate"],
    ["cycle", original, ["Keep the log—for 2 hours.", original], 2, original, "repeated-candidate"],
    ["tool attempt", original, ["TOOL"], 2, original, "writer-tool-call"],
    ["writer failure", original, ["ERROR"], 2, original, "writer-error"],
    ["empty writer", original, [""], 2, original, "writer-empty"],
  ]) await t.test(name, async () => {
    const f = await setup({ text, replies, config: { maxRewrites: cap } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      assert.equal(f.writes(), replies.length);
      assert.equal(f.toolCalls(), 0);
      assert.equal(f.requests.length, 1);
      assert.equal(f.results().length, 1);
      const data = f.results()[0].data;
      assert.equal(data.delivery, "released");
      assert.equal(data.termination, termination);
      assert.equal(data.reply, expected);
      assert.equal(data.audit.candidateHash, data.selectedId);
      assert.equal(data.rewrites, replies.length);
      assert.equal(data.candidates.length, termination === "repeated-candidate" ? replies.length : replies.some((reply) => ["TOOL", "ERROR", ""].includes(reply)) ? 1 : replies.length + 1);
      assert.equal(occurrences(f.render(), expected), 1);
      assert.match(f.render(), /active checks/);
      assert.match(f.render(), /advisory/);
      assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), [expected]);
      assert.ok(f.sessionManager.getBranch().some((entry) => entry.customType === "other-extension"));
      await f.session.prompt("Refer to your instruction.");
      assert.deepEqual(assistantText(f.requests[1].messages), [expected]);
    } finally { f.session.dispose(); }
  });
  for (const mode of ["off", "observe"]) await t.test(`${mode} preserves the original without repair`, async () => {
    const f = await setup({ config: { mode, releasePolicy: "strict" }, replies: [] });
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      assert.equal(f.writes(), 0);
      assert.equal(f.calls.length > 0, mode === "observe");
      assert.equal(f.results().length, mode === "observe" ? 1 : 0);
      if (mode === "observe") { assert.equal(f.results()[0].data.audit.status, "failed"); assert.equal(f.results()[0].data.reply, undefined); assert.equal(f.results()[0].data.delivery, "released"); }
      assert.equal(occurrences(f.render(), original), 1);
      assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), [original]);
    } finally { f.session.dispose(); }
  });
  for (const strict of [false, true]) await t.test(`${strict ? "strict" : "warning"} exhausted delivery survives resume`, async () => {
    const config = { maxRewrites: 0, releasePolicy: strict ? "strict" : "warning", showVerdicts: false };
    const first = await setup({ config, replies: [] });
    await first.session.prompt("Give the instruction.");
    assert.deepEqual(first.errors, []);
    const file = first.sessionManager.getSessionFile();
    assert.equal(occurrences(first.render(), original), strict ? 0 : 1);
    assert.equal(occurrences(first.render(48), "active checks failed"), 1);
    assert.equal(occurrences(first.render(120, false), original), 1);
    if (strict) {
      assert.equal(first.results()[0].data.reply, undefined);
      assert.equal(first.results()[0].data.delivery, "withheld");
      const before = first.sessionManager.getBranch().length;
      await first.command("recover");
      assert.deepEqual(first.editors.at(-1), ["Withheld draft (inspection only)", original]);
      assert.equal(first.sessionManager.getBranch().length, before);
    }
    first.session.dispose();
    const manager = sdk.SessionManager.open(file);
    assert.deepEqual(assistantText(manager.buildSessionProjection().messages), strict ? [] : [original]);
    const resumed = await setup({ config, priorManager: manager, replies: [] });
    try {
      assert.equal(occurrences(resumed.render(), original), strict ? 0 : 1);
      await resumed.session.prompt("Refer to the instruction you gave.");
      assert.deepEqual(resumed.errors, []);
      assert.deepEqual(assistantText(resumed.requests[0].messages), strict ? [] : [original]);
    } finally { resumed.session.dispose(); }
  });
  await t.test("advisory-only unknowns do not block strict delivery", async () => {
    const f = await setup({ text: good, replies: [], config: { releasePolicy: "strict", model: "typesafe/jev-latest", showVerdicts: false } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      const data = f.results()[0].data;
      assert.equal(data.delivery, "released");
      assert.equal(data.audit.status, "passed");
      assert.equal(data.audit.advisoryIncomplete, true);
      assert.match(f.render(), /advisory coverage incomplete/);
      assert.equal(f.calls.length, 0);
    } finally { f.session.dispose(); }
  });
  await t.test("native streaming component conceals only enforce-mode assistant prose", async () => {
    const f = await setup({ text: good, replies: [] });
    try {
      await f.session.prompt("Give the instruction.");
      const transform = f.extension.markdownTransformer;
      assert.equal(transform("Draft text.", { messageType: "assistant", isStreaming: true }), "");
      assert.equal(transform("User text.", { messageType: "user", isStreaming: true }), "User text.");
      await f.command("observe");
      assert.equal(transform("Draft text.", { messageType: "assistant", isStreaming: true }), "Draft text.");
      assert.equal(occurrences(f.render(), good), 1);
    } finally { f.session.dispose(); }
  });
});
