import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const piRoot = process.env.PI_PACKAGE_ROOT;
assert.ok(piRoot, "Set PI_PACKAGE_ROOT to the installed Pi package directory");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "reply-guard-sdk-"));
const agentDir = join(home, ".pi/agent");
const path = process.env.PATH;
const testContext = process.env.NODE_TEST_CONTEXT;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: home, PATH: path, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
if (testContext) process.env.NODE_TEST_CONTEXT = testContext;
globalThis.fetch = () => { throw new Error("Network forbidden in SDK tests"); };
const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const ai = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const model = {
  id: "fixture", name: "Fixture", provider: "reply-guard-fixture", api: "reply-guard-fixture", baseUrl: "http://127.0.0.1:1",
  input: ["text"], reasoning: false, contextWindow: 200000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function create(maxRewrites, probabilities) {
  mkdirSync(agentDir, { recursive: true });
  const skillPath = join(home, "SKILL.md");
  writeFileSync(skillPath, "# Fictional rule\nUse clear prose.\n");
  writeFileSync(join(agentDir, "reply-guard.json"), JSON.stringify({ skills: { fixture: 0.9 }, maxRewrites, preload: false }));
  let writes = 0;
  const audits = [];
  const errors = [];
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: home, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(root, "extensions/reply-guard.ts")],
    skillsOverride: () => ({ skills: [{ name: "fixture", description: "Fictional rule", filePath: skillPath, baseDir: home, source: "user", disableModelInvocation: false }], diagnostics: [] }),
    extensionFactories: [(pi) => {
      pi.registerProvider(model.provider, {
        api: model.api, baseUrl: model.baseUrl, apiKey: "fictional-test-key", models: [model],
        streamSimple() {
          writes++;
          assert.ok(writes <= maxRewrites + 1, "Unbounded writer loop");
          const stream = new ai.AssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message: {
            role: "assistant", content: [{ type: "text", text: `Candidate ${writes}.` }], stopReason: "stop",
            api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage,
          } });
          return stream;
        },
      });
      pi.on("before_agent_start", (_event, ctx) => {
        ctx.modelRegistry.getModelOfType = () => ({ id: "fixture", provider: "fixture" });
        ctx.modelRegistry.classify = async (_model, body) => {
          audits.push(body.state.reply);
          const probability = probabilities[audits.length - 1];
          assert.notEqual(probability, undefined, "Unexpected audit");
          return { provider: "fixture", model: "fixture", stopReason: "stop", answers: { meets: { type: "bool", probability } } };
        };
      });
      pi.on("agent_before_settle", (event) => ({ entries: [...event.entries, { type: "custom", customType: "other-extension", data: { retained: true } }] }));
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: join(home, "models.json") });
  const sessionManager = sdk.SessionManager.inMemory(home);
  const { session } = await sdk.createAgentSession({ cwd: home, agentDir, resourceLoader, settingsManager, modelRuntime, model, thinkingLevel: "off", sessionManager, tools: [] });
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  return { session, sessionManager, audits, errors, writes: () => writes };
}

test("installed Pi SDK settlement integration", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [title, cap, probabilities, termination] of [
    ["original success", 2, [1], "passed"],
    ["final permitted repair success", 2, [0, 0, 1], "passed"],
    ["rewrite exhaustion", 2, [0, 0, 0], "rewrite-limit"],
    ["zero cap", 0, [0], "rewrite-limit"],
  ]) {
    await t.test(title, async () => {
      const f = await create(cap, probabilities);
      try {
        await f.session.prompt("Write a fictional response.");
        assert.deepEqual(f.errors, []);
        assert.equal(f.writes(), probabilities.length);
        assert.equal(f.audits.length, probabilities.length);
        const entries = f.sessionManager.getBranch();
        const results = entries.filter((entry) => entry.type === "custom" && entry.customType === "reply-guard-verdict");
        assert.equal(results.length, probabilities.length);
        assert.equal(results.at(-1).data.termination, termination);
        assert.equal(results.at(-1).data.delivery, "released");
        assert.equal(results.at(-1).data.reply, `Candidate ${probabilities.length}.`);
        assert.equal(results.filter((entry) => entry.data.reply !== undefined).length, 1);
        assert.equal(entries.filter((entry) => entry.customType === "other-extension").length, probabilities.length);
      } finally {
        f.session.dispose();
      }
    });
  }
});
