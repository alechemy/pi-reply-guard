import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { setup, home, configPath, sdk, original, good, assistantText } from "./fixtures/extension.mjs";

const settled = (session) => new Promise((resolve) => {
  const off = session.subscribe((event) => { if (event.type === "agent_settled") { off(); resolve(); } });
});

test("review regressions through the installed package", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const order of ["beforeBoundary", "afterBoundary"]) {
    await t.test(`abort during ${order} cannot publish`, async () => {
      let enter;
      let release;
      let once = true;
      const entered = new Promise((resolve) => { enter = resolve; });
      const f = await setup({ [order]: async (event) => {
        if (once) { once = false; enter(); await new Promise((resolve) => { release = resolve; }); }
        return { entries: event.entries };
      } });
      try {
        const running = f.session.prompt("Give the instruction.");
        await entered;
        assert.equal(f.results().length, 0);
        const aborting = f.session.abort();
        release();
        await Promise.all([running, aborting]);
        assert.deepEqual(f.errors, []);
        assert.equal(f.results().length, 1);
        assert.equal(f.results()[0].data.delivery, "withheld");
        assert.equal(f.results()[0].data.termination, "cancelled");
        assert.doesNotMatch(f.render(), /Retain the log/);
        const file = f.sessionManager.getSessionFile();
        f.session.dispose();
        const resumed = await setup({ priorManager: sdk.SessionManager.open(file), replies: [] });
        try {
          await resumed.session.prompt("Continue again.");
          assert.deepEqual(resumed.errors, []);
          assert.deepEqual(assistantText(resumed.requests[0].messages), []);
        } finally { resumed.session.dispose(); }
      } finally { f.session.dispose(); }
    });
    await t.test(`conflicting edit in ${order} cannot publish or reach the next request`, async () => {
      let once = true;
      const f = await setup({ [order]: (event) => {
        if (!once) return;
        once = false;
        const target = event.context.contextEntries.findLast((entry) => entry.messages.some((message) => message.role === "assistant"));
        return { entries: [...event.entries, { type: "context_edit", targetId: target.sourceEntry.id, replacement: { content: [{ type: "text", text: "Other extension replacement." }] } }] };
      } });
      try {
        await f.session.prompt("Give the instruction.");
        assert.deepEqual(f.errors, []);
        assert.equal(f.results().length, 1);
        assert.equal(f.results()[0].data.delivery, "withheld");
        assert.equal(f.results()[0].data.termination, "superseded");
        assert.doesNotMatch(f.render(), /Retain the log|Other extension replacement/);
        const file = f.sessionManager.getSessionFile();
        f.session.dispose();
        const resumed = await setup({ priorManager: sdk.SessionManager.open(file), replies: [] });
        try {
          await resumed.session.prompt("Refer to your previous answer.");
          assert.deepEqual(resumed.errors, []);
          assert.deepEqual(assistantText(resumed.requests[0].messages), []);
        } finally { resumed.session.dispose(); }
      } finally { f.session.dispose(); }
    });
  }
  await t.test("later continuation supersedes the prepared reply without publishing it", async () => {
    let once = true;
    const f = await setup({ afterBoundary: (event) => {
      if (!once) return;
      once = false;
      return { entries: [...event.entries, { type: "custom_message", customType: "fixture-feedback", content: "Continue.", display: false }], continue: true };
    } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      assert.equal(f.requests.length, 2);
      assert.deepEqual(assistantText(f.requests[1].messages), []);
      assert.equal(f.results()[0].data.delivery, "withheld");
      assert.equal(f.results().at(-1).data.reply, "Follow-up reply.");
      assert.doesNotMatch(f.render(), /Retain the log/);
    } finally { f.session.dispose(); }
  });
  await t.test("a dropped preparation record cannot expose a continuing candidate", async () => {
    let once = true;
    const f = await setup({ afterBoundary: (event) => {
      if (!once) return;
      once = false;
      return { entries: [...event.entries.filter((entry) => entry.customType !== "reply-guard-prepared"), { type: "custom_message", customType: "fixture-feedback", content: "Continue.", display: false }], continue: true };
    } });
    try {
      await f.session.prompt("Give the instruction.");
      assert.deepEqual(f.errors, []);
      assert.deepEqual(assistantText(f.requests[1].messages), []);
      assert.equal(f.results()[0].data.delivery, "withheld");
    } finally { f.session.dispose(); }
  });
  await t.test("an interrupted preparation is withheld on resume", async () => {
    let manager;
    const first = await setup({ afterBoundary: (event, ctx) => {
      manager = sdk.SessionManager.inMemory(home);
      manager.appendMessage({ role: "user", content: "Give the instruction.", timestamp: Date.now() });
      const draft = ctx.sessionManager.getBranch().find((entry) => entry.customType === "reply-guard-draft");
      manager.appendCustomEntry(draft.customType, draft.data);
      const originalEntry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      const targetId = manager.appendMessage(originalEntry.message);
      for (const entry of event.entries) {
        if (entry.type === "context_edit") manager.appendContextEdit(targetId, entry.replacement);
        if (entry.customType === "reply-guard-prepared") manager.appendCustomEntry(entry.customType, { ...entry.data, targetId });
      }
    } });
    await first.session.prompt("Give the instruction.");
    assert.deepEqual(first.errors, []);
    first.session.dispose();
    const f = await setup({ priorManager: manager, replies: [] });
    try {
      assert.equal(f.results()[0].data.termination, "interrupted");
      assert.equal(f.results()[0].data.delivery, "withheld");
      assert.doesNotMatch(f.render(), /Retain the log/);
      await f.session.prompt("Continue.");
      assert.deepEqual(f.errors, []);
      assert.deepEqual(assistantText(f.requests[0].messages), []);
    } finally { f.session.dispose(); }
  });
  await t.test("handled input and a mode change preserve the consumed request budget", async () => {
    const f = await setup({ config: { maxRewrites: 1 }, replies: [original, good], mainReplies: [original, original, original],
      onInput: (event) => event.text === "handled input" ? { action: "handled" } : undefined,
    });
    try {
      await f.session.prompt("Give the instruction.");
      assert.equal(f.writes(), 1);
      await f.session.prompt("handled input");
      writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, skill: "fixture", maxRewrites: 2 }));
      await f.command("off");
      await f.command("enforce");
      const done = settled(f.session);
      f.feedback();
      await done;
      assert.deepEqual(f.errors, []);
      assert.equal(f.writes(), 1);
      assert.equal(f.results().at(-1).data.requestRewrites, 1);
      await f.session.prompt("A genuinely new request.");
      assert.equal(f.writes(), 2);
      assert.equal(f.results().at(-1).data.reply, good);
    } finally { f.session.dispose(); }
  });
  await t.test("resumed extension feedback retains the consumed request budget", async () => {
    const first = await setup({ config: { maxRewrites: 1 }, replies: [original] });
    await first.session.prompt("Give the instruction.");
    assert.deepEqual(first.errors, []);
    const file = first.sessionManager.getSessionFile();
    first.session.dispose();
    const f = await setup({ priorManager: sdk.SessionManager.open(file), config: { maxRewrites: 2 }, replies: [], mainReplies: [original] });
    try {
      const done = settled(f.session);
      f.feedback();
      await done;
      assert.deepEqual(f.errors, []);
      assert.equal(f.writes(), 0);
      assert.equal(f.results().at(-1).data.requestRewrites, 1);
    } finally { f.session.dispose(); }
  });
  for (const [request, text] of [["Reproduce exactly: Keep—this.", "Keep—this."], ["Reproduce exactly: “Enabled”.", "“Enabled”."], ["Reproduce this sentence exactly: This is not just a parser.", "This is not just a parser."]]) {
    await t.test(request, async () => {
      const f = await setup({ text, replies: [], config: { releasePolicy: "strict" } });
      try {
        await f.session.prompt(request);
        assert.deepEqual(f.errors, []);
        assert.equal(f.writes(), 0);
        assert.equal(f.results()[0].data.delivery, "released");
        assert.equal(f.results()[0].data.reply, text);
        assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), [text]);
      } finally { f.session.dispose(); }
    });
  }
});
