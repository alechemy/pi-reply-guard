import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { registerRepairLifecycle } from "../lib/repair-lifecycle.mjs";
import { inspectCatalog } from "../lib/catalog.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";

const piRoot = process.env.PI_PACKAGE_ROOT;
assert.ok(piRoot, "Set PI_PACKAGE_ROOT to the installed Pi package directory");
const home = mkdtempSync(join(tmpdir(), "reply-guard-repair-sdk-"));
const path = process.env.PATH;
const testContext = process.env.NODE_TEST_CONTEXT;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: home, PATH: path, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
if (testContext) process.env.NODE_TEST_CONTEXT = testContext;
globalThis.fetch = () => { throw new Error("Network forbidden in repair SDK tests"); };
const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const ai = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const model = { provider: "repair-fixture", id: "writer", name: "Writer", api: "repair-fixture", baseUrl: "http://127.0.0.1:1", input: ["text"], reasoning: true, contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const original = "Retain the log—for 2 hours.";
const good = "Retain the log for 2 hours.";
const bad = "Retain the log for 2 minutes.";

async function setup(replies, { cap = 2, priorManager, exposure = "direct" } = {}) {
  let toolCalls = 0;
  let repairCalls = 0;
  let mainCalls = 0;
  const requests = [];
  const errors = [];
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: home, agentDir: home, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.registerTool({ name: "counted_tool", label: "Counted tool", description: "Counts attempted task execution.", exposure, parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { toolCalls++; return { content: [{ type: "text", text: "Executed." }], details: undefined }; } });
      pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fictional-key", models: [model], streamSimple(_model, context, options) {
        const repair = options.toolChoice === "none";
        let content;
        let stopReason = "stop";
        if (repair) {
          assert.equal(options.maxRetries, 0);
          assert.equal(options.reasoning, "high");
          assert.equal(options.temperature, 0.2);
          assert.doesNotMatch(JSON.stringify(context), /"name":"counted_tool"/);
          const reply = replies[repairCalls++];
          assert.notEqual(reply, undefined, "Uncounted isolated writer call");
          if (reply === "TOOL") { content = [{ type: "toolCall", id: "fictional-call", name: "counted_tool", arguments: {} }]; stopReason = "toolUse"; }
          else if (reply === "ERROR") { content = []; stopReason = "error"; }
          else content = [{ type: "text", text: reply }];
        } else {
          requests.push(context);
          content = [{ type: "text", text: mainCalls++ === 0 && !priorManager ? original : "Follow-up reply." }];
        }
        const message = { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
        const stream = new ai.AssistantMessageEventStream();
        if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: stopReason, message });
        return stream;
      } });
      pi.on("agent_before_settle", (event) => ({ entries: [...event.entries, { type: "custom", customType: "other-extension", data: true }] }));
      registerRepairLifecycle(pi, async () => ({
        catalog: inspectCatalog(makeCatalog(), skill), maxRewrites: cap, generation: { temperature: 0.2 },
        adapter: { available: true, identity: { model: "classifier", provider: "fixture" }, async classify(body, options) {
          options.onAttempt();
          return { servedModel: "classifier", usage: null, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "bool", probability: id === "preserve-quantities" && body.state.revision === bad ? 1 : 0 }])) };
        } },
      }));
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const runtime = await sdk.ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: join(home, "models.json") });
  const sessionManager = priorManager ?? sdk.SessionManager.create(home, join(home, "sessions"));
  const { session } = await sdk.createAgentSession({ cwd: home, agentDir: home, resourceLoader, settingsManager, modelRuntime: runtime, model, thinkingLevel: "high", sessionManager, tools: [] });
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  return { session, sessionManager, requests, errors, toolCalls: () => toolCalls, repairCalls: () => repairCalls };
}
const assistantText = (messages) => messages.filter((message) => message.role === "assistant").map((message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));

test("installed Pi repair lifecycle and tool isolation", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [name, replies, cap, expected, termination] of [
    ["first repair passes", [good], 2, good, "passed"],
    ["last repair passes", ["Keep the log—for 2 hours.", good], 2, good, "passed"],
    ["damaged repair falls back", ["Keep the log—for 2 hours.", bad], 2, "Keep the log—for 2 hours.", "rewrite-limit"],
    ["tool attempt stops", ["TOOL"], 2, original, "writer-tool-call"],
    ["writer error stops", ["ERROR"], 2, original, "writer-error"],
    ["empty writer stops", [""], 2, original, "writer-empty"],
    ["zero cap", [], 0, original, "rewrite-limit"],
  ]) {
    await t.test(name, async () => {
      const f = await setup(replies, { cap });
      try {
        await f.session.prompt("Give the instruction.");
        assert.deepEqual(f.errors, []);
        assert.equal(f.toolCalls(), 0);
        assert.equal(f.repairCalls(), replies.length);
        assert.deepEqual(assistantText(f.sessionManager.buildSessionProjection().messages), [expected]);
        const entries = f.sessionManager.getBranch();
        const result = entries.findLast((entry) => entry.customType === "reply-guard-repair").data;
        assert.equal(result.termination, termination);
        assert.equal(result.writerUsage.length, replies.length);
        assert.ok(entries.some((entry) => entry.customType === "other-extension"));
        const raw = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
        assert.equal(raw.message.content[0].text, original);
        assert.deepEqual(raw.message.usage, usage);
        await f.session.prompt("Refer to the instruction you just gave.");
        assert.deepEqual(assistantText(f.requests[1].messages), [expected]);
        assert.equal(f.toolCalls(), 0);
      } finally { f.session.dispose(); }
    });
  }
  for (const exposure of ["deferred", "codemode"]) {
    await t.test(`isolated ${exposure} tool attempt never executes`, async () => {
      const f = await setup(["TOOL"], { exposure });
      try { await f.session.prompt("Give the instruction."); assert.deepEqual(f.errors, []); assert.equal(f.toolCalls(), 0); assert.equal(f.repairCalls(), 1); }
      finally { f.session.dispose(); }
    });
  }
  await t.test("resumed session reconstructs the accepted fallback", async () => {
    const first = await setup([good]);
    await first.session.prompt("Give the instruction.");
    assert.deepEqual(first.errors, []);
    const sessionFile = first.sessionManager.getSessionFile();
    first.session.dispose();
    const manager = sdk.SessionManager.open(sessionFile);
    assert.deepEqual(assistantText(manager.buildSessionProjection().messages), [good]);
    const resumed = await setup([], { priorManager: manager });
    try {
      await resumed.session.prompt("Refer to the instruction you gave.");
      assert.deepEqual(resumed.errors, []);
      assert.deepEqual(assistantText(resumed.requests[0].messages), [good]);
      assert.equal(resumed.toolCalls(), 0);
    } finally { resumed.session.dispose(); }
  });
});
