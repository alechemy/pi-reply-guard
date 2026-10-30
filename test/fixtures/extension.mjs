import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCatalog, skill } from "./catalog.mjs";

const piRoot = process.env.PI_PACKAGE_ROOT;
assert.ok(piRoot, "Set PI_PACKAGE_ROOT to the installed Pi package directory");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const home = mkdtempSync(join(tmpdir(), "reply-guard-extension-"));
export const agentDir = join(home, ".pi/agent");
const path = process.env.PATH;
const testContext = process.env.NODE_TEST_CONTEXT;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: home, PATH: path, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
if (testContext) process.env.NODE_TEST_CONTEXT = testContext;
mkdirSync(agentDir, { recursive: true });
export const configPath = join(agentDir, "reply-guard.json");
globalThis.fetch = () => { throw new Error("Network forbidden in extension tests"); };
export const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const ai = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const themes = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/theme/theme.js")));
const { AssistantMessageComponent } = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/components/assistant-message.js")));
sdk.initTheme("dark", false);
const model = { id: "writer", name: "Fixture", provider: "reply-guard-fixture", api: "reply-guard-fixture", baseUrl: "http://127.0.0.1:1", input: ["text"], reasoning: false, contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const original = "Retain the log—for 2 hours.";
export const good = "Retain the log for 2 hours.";
export const bad = "Retain the log for 2 minutes.";
export const assistantText = (messages) => messages.filter((message) => message.role === "assistant").map((message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
export function answer(body) {
  return { model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: id === "preserve-quantities" && body.state.revision === bad ? 1 : 0 }])) };
}

export async function setup({ config = {}, configText, catalog = makeCatalog(), skillText = skill, missingSkill = false, text = original, replies = [good], classify = answer, priorManager, beforeBoundary, afterBoundary, onInput, mainReplies, onMain } = {}) {
  const skillPath = join(home, "SKILL.md");
  writeFileSync(skillPath, skillText);
  writeFileSync(join(home, "reply-guard.rules.json"), JSON.stringify(catalog));
  writeFileSync(configPath, configText ?? JSON.stringify({ schemaVersion: 2, skill: "fixture", ...config }));
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "fictional-test-key" } }), { mode: 0o600 });
  let writes = 0;
  let toolCalls = 0;
  let ctx;
  let extensionAPI;
  const calls = [];
  const requests = [];
  const errors = [];
  const notices = [];
  const statuses = [];
  const editors = [];
  const ui = { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args), editor: async (...args) => { editors.push(args); return undefined; }, select: async () => undefined, confirm: async () => true };
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, "/api/v1/systemone");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fictional-test-key");
    const body = JSON.parse(init.body);
    calls.push(body);
    const response = await classify(body, calls.length, init);
    return response instanceof Response ? response : new Response(JSON.stringify(response));
  };
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const skills = missingSkill ? [] : [{ name: "fixture", description: "Fictional rule", filePath: skillPath, baseDir: home, source: "user", disableModelInvocation: false }];
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: home, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(root, "extensions/reply-guard.ts")], skillsOverride: () => ({ skills, diagnostics: [] }),
    extensionFactories: [(pi) => {
      extensionAPI = pi;
      if (onInput) pi.on("input", onInput);
      pi.registerTool({ name: "counted_tool", label: "Counted", description: "Count task execution.", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { toolCalls++; return { content: [{ type: "text", text: "Executed." }], details: undefined }; } });
      pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fictional-writer-key", models: [model], streamSimple(_model, context, options) {
        const stream = new ai.AssistantMessageEventStream();
        const repair = options.toolChoice === "none";
        let reply;
        if (repair) {
          assert.equal(options.maxRetries, 0);
          assert.equal(context.tools?.length ?? 0, 0);
          reply = replies[writes++];
          assert.notEqual(reply, undefined, "Unbounded writer loop");
        } else { requests.push(context); reply = mainReplies?.[requests.length - 1] ?? (requests.length === 1 && !priorManager ? text : "Follow-up reply."); onMain?.(); }
        Promise.resolve(typeof reply === "function" ? reply(options) : reply).then((value) => {
          const stopReason = value === "TOOL" ? "toolUse" : value === "ERROR" ? "error" : "stop";
          const content = value === "TOOL" ? [{ type: "toolCall", id: "fictional-call", name: "counted_tool", arguments: {} }] : [{ type: "text", text: value === "ERROR" ? "" : value }];
          const message = { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage };
          stream.push(stopReason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: stopReason, message });
        });
        return stream;
      } });
      pi.on("before_agent_start", (_event, context) => { ctx = context; });
      pi.on("agent_before_settle", (event, context) => afterBoundary?.(event, context) ?? { entries: [...event.entries, { type: "custom", customType: "other-extension", data: { retained: true } }] });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const extension = resourceLoader.getExtensions().extensions.find((extension) => extension.commands.has("reply-guard"));
  if (beforeBoundary) extension.handlers.get("agent_before_settle").unshift(beforeBoundary);
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const sessionManager = priorManager ?? sdk.SessionManager.create(home, join(home, "sessions"));
  const { session } = await sdk.createAgentSession({ cwd: home, agentDir, resourceLoader, settingsManager, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager, tools: [] });
  await session.bindExtensions({ uiContext: ui, onError: (error) => errors.push(error) });
  const results = () => sessionManager.getBranch().filter((entry) => entry.customType === "reply-guard-repair");
  const render = (width = 120, enabled = true) => sessionManager.buildContextEntries().flatMap((entry) => {
    if (entry.type === "message" && entry.message.role === "assistant") return new AssistantMessageComponent(entry.message, true, sdk.getMarkdownTheme(), "Thinking...", 1, enabled ? [extension.markdownTransformer] : []).render(width);
    if (entry.type === "custom" && enabled) return extension.entryRenderers.get(entry.customType)?.(entry, { expanded: false }, themes.theme)?.render(width) ?? [];
    return [];
  }).join("\n");
  const command = (args) => extension.commands.get("reply-guard").handler(args, { ...ctx, hasUI: true, ui, sessionManager, getSystemPromptOptions: () => ({ skills }) });
  return { session, sessionManager, extension, calls, requests, errors, notices, statuses, editors, ui, results, render, command,
    feedback: () => extensionAPI.sendMessage({ customType: "fixture-feedback", content: "Continue the same request.", display: false }, { triggerTurn: true }), writes: () => writes, toolCalls: () => toolCalls };
}
