import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { main } from "../cli.mjs";
import { createJevAdapter, JEV_MODEL } from "../lib/jev.mjs";
import { auditCandidate } from "../lib/evaluator.mjs";
import { inspectCatalog } from "../lib/catalog.mjs";
import { importCorpus } from "../lib/corpus.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";

const piRoot = process.env.PI_PACKAGE_ROOT;
assert.ok(piRoot, "Set PI_PACKAGE_ROOT to the installed Pi package directory");
const home = mkdtempSync(join(tmpdir(), "reply-guard-transport-"));
const path = process.env.PATH;
const testContext = process.env.NODE_TEST_CONTEXT;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: home, PATH: path, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
if (testContext) process.env.NODE_TEST_CONTEXT = testContext;
globalThis.fetch = () => { throw new Error("Network forbidden in transport tests"); };
const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
writeFileSync(join(home, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "fictional-test-key" } }), { mode: 0o600 });
const runtime = await sdk.ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: join(home, "models.json") });
const registry = new sdk.ModelRegistry(runtime);
const context = { state: { text: "Fictional text." }, questions: {
  first: { type: "bool", instructions: "Does a violation occur?", criteria: { true: "Violation", false: "No violation" } },
  second: { type: "bool", instructions: "Does another violation occur?", criteria: { true: "Violation", false: "No violation" } },
} };
const options = () => ({ signal: new AbortController().signal, timeoutMs: 1000, maxRequestBytes: 64000 });
const valid = () => ({ model: "typesafe/jev-1.14", answers: { first: { type: "noul", noul: 0.95 }, second: { type: "noul", noul: 0 } }, usage: { input_tokens: 25, output_tokens: 2 } });

function transport(body, status = 200) {
  let calls = 0;
  const adapter = createJevAdapter(registry, JEV_MODEL, { fetch: async (url, init) => {
    calls++;
    assert.equal(init.redirect, "error");
    assert.equal(new URL(url).pathname, "/api/v1/systemone");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fictional-test-key");
    const request = JSON.parse(init.body);
    assert.equal(request.model, "typesafe/jev-1.14");
    assert.ok(Object.values(request.questions).every((question) => question.type === "noul"));
    return new Response(JSON.stringify(typeof body === "function" ? body(request) : body), { status });
  } });
  return { adapter, calls: () => calls };
}

test("installed Pi native System One transport", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await t.test("preserves Pi authentication and normalizes typed answers", async () => {
    const f = transport(valid());
    const result = await f.adapter.classify(context, options());
    assert.equal(f.adapter.available, true);
    assert.equal(result.servedModel, "typesafe/jev-1.14");
    assert.deepEqual(result.answers.first, { type: "bool", probability: 0.95 });
    assert.equal(result.attempts, 1);
    assert.equal(result.usage.input, 25);
    assert.equal(result.usage.output, 2);
    assert.doesNotMatch(JSON.stringify(f.adapter.identity), /https:|fictional-test-key/);
  });
  await t.test("recovers valid partial answers after the native parser rejects a batch", async () => {
    for (const invalid of [undefined, { type: "bool", probability: 0 }, { type: "noul", noul: 1.1 }, { type: "noul", noul: -0.1 }, { type: "noul", noul: null }, { type: "noul", noul: "0" }]) {
      const body = valid();
      body.answers.second = invalid;
      const f = transport(body);
      const result = await f.adapter.classify(context, options());
      assert.equal(result.reason, undefined);
      assert.equal(result.answers.first.probability, 0.95);
      assert.match(result.answers.second.error, /malformed/);
      assert.equal(result.usage.input, 25);
    }
  });
  await t.test("rejects unknown answers and missing or changed served identities", async () => {
    const extra = valid();
    extra.answers.unknown = { type: "noul", noul: 0 };
    const result = await transport(extra).adapter.classify(context, options());
    assert.match(result.protocolIssue, /Unexpected/);
    assert.equal(result.answers.first.probability, 0.95);
    for (const model of [undefined, "jev-latest", "typesafe/jev-1.13"]) {
      const body = { ...valid(), model };
      const invalid = await transport(body).adapter.classify(context, options());
      assert.deepEqual(invalid.answers, {});
      assert.match(invalid.reason, /served model/);
    }
  });
  await t.test("auth failures, throttling, and server errors never retry or leak raw errors", async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const f = transport({ error: "PRIVATE-PROVIDER-PAYLOAD" }, status);
      const result = await f.adapter.classify(context, options());
      assert.equal(f.calls(), 1);
      assert.equal(result.attempts, 1);
      assert.deepEqual(result.answers, {});
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
  });
  await t.test("missing usage and zero catalog prices stay unknown", async () => {
    const body = valid();
    delete body.usage;
    assert.equal((await transport(body).adapter.classify(context, options())).usage, null);
    const selected = registry.getModelOfType("classifier", "openrouter", "typesafe/jev-1.14");
    const unpriced = { getModelOfType: () => ({ ...selected, cost: { input: 0, output: 0 } }), classify: registry.classify.bind(registry) };
    const adapter = createJevAdapter(unpriced, JEV_MODEL, { fetch: async () => new Response(JSON.stringify(valid())) });
    assert.equal((await adapter.classify(context, options())).usage.cost, null);
  });
  await t.test("aliases and unregistered direct models cannot silently change the selected route", async () => {
    for (const selection of ["typesafe/jev-latest", "openrouter/~typesafe/jev-latest", "typesafe/jev-1.14.0"]) {
      const adapter = createJevAdapter(registry, selection);
      assert.equal(adapter.available, false);
      const result = await adapter.classify(context, options());
      assert.equal(result.attempts, 0);
      assert.match(result.reason, /unavailable/);
    }
  });
  await t.test("native classification without the reviewed fetch hook is incomplete", async () => {
    const unsupported = { getModelOfType: registry.getModelOfType.bind(registry), classify: async () => ({ provider: "openrouter", model: "typesafe/jev-1.14", stopReason: "stop", answers: { first: { type: "bool", probability: 0 } } }) };
    const result = await createJevAdapter(unsupported).classify(context, options());
    assert.match(result.reason, /served model/);
    assert.deepEqual(result.answers, {});
  });
  await t.test("changed payloads and oversize wire requests stop before network I/O", async () => {
    const f = transport(valid());
    const small = await f.adapter.classify(context, { ...options(), maxRequestBytes: 1 });
    assert.equal(small.attempts, 0);
    assert.equal(f.calls(), 0);
    const changed = { getModelOfType: registry.getModelOfType.bind(registry), classify: (model, body, opts) => registry.classify(model, body, { ...opts, onPayload: (payload) => ({ ...payload, model: "changed" }) }) };
    const adapter = createJevAdapter(changed, JEV_MODEL);
    const result = await adapter.classify(context, options());
    assert.equal(result.attempts, 0);
    assert.deepEqual(result.answers, {});
  });
  await t.test("late transport results cannot populate a cancelled audit", async () => {
    const controller = new AbortController();
    const adapter = createJevAdapter(registry, JEV_MODEL, { fetch: async () => { controller.abort(); return new Response(JSON.stringify(valid())); } });
    const result = await adapter.classify(context, { ...options(), signal: controller.signal });
    assert.deepEqual(result.answers, {});
    assert.match(result.reason, /cancelled/);
  });
  await t.test("diagnostic CLI audits supplied text without an agent session", async () => {
    const files = { catalog: join(home, "catalog.json"), skill: join(home, "SKILL.md"), text: join(home, "reply.md"), request: join(home, "request.txt"), limits: join(home, "limits.json") };
    writeFileSync(files.catalog, JSON.stringify(makeCatalog()));
    writeFileSync(files.skill, skill);
    writeFileSync(files.text, "Fictional response.");
    writeFileSync(files.request, "Write a response.");
    writeFileSync(files.limits, JSON.stringify({ maxClassifierRequests: 1 }));
    const flags = Object.entries(files).flatMap(([flag, path]) => [`--${flag}`, path]);
    let calls = 0;
    const fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0 }])) }));
    };
    const result = await main(["audit", ...flags], { registry, fetch });
    assert.equal(result.code, 0);
    assert.equal(result.data.coverageComplete, true);
    assert.equal(calls, 1);
    writeFileSync(files.text, "Fictional—response.");
    assert.equal((await main(["audit", ...flags], { registry, fetch })).code, 1);
    assert.equal((await main(["audit", ...flags, "--model", "typesafe/jev-latest"], { registry, fetch })).data.advisoryIncomplete, true);
    writeFileSync(files.text, "Fictional response.");
    assert.equal((await main(["audit", ...flags, "--model", "typesafe/jev-latest"], { registry, fetch })).code, 2);
  });
  await t.test("corpus CLI uses native authentication and an isolated explicit writer", async () => {
    const files = { corpus: join(home, "corpus.json"), catalog: join(home, "corpus-catalog.json"), skill: join(home, "corpus-skill.md"), output: join(home, "evaluation.json"), "repair-drafts": join(home, "repair-drafts.json") };
    const corpus = importCorpus([{ id: "fixture", group: "fixture", split: "development", kind: "style", request: "Write a fictional reply.", reply: "A fixture—reply.", labels: { "em-dash": "violation" }, review: { basis: "synthetic" } }], { name: "fixture", version: "v1" });
    writeFileSync(files.corpus, JSON.stringify(corpus));
    writeFileSync(files.catalog, JSON.stringify(makeCatalog()));
    writeFileSync(files.skill, skill);
    let writes = 0;
    const writerModel = { provider: "fixture", id: "writer-1", contextWindow: 100000, maxTokens: 1000 };
    const models = { getModelOfType: (type, provider, id) => type === "chat" ? writerModel : registry.getModelOfType(type, provider, id), classify: registry.classify.bind(registry), streamSimple(_model, context, options) {
      writes++;
      assert.equal(options.toolChoice, "none");
      assert.deepEqual(context.tools, []);
      assert.equal(options.maxRetries, 0);
      return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "A fixture reply." }], provider: "fixture", model: "writer-1" }) };
    } };
    const fetch = async (_url, init) => {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fictional-test-key");
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0 }])) }));
    };
    const result = await main(["evaluate-corpus", ...Object.entries(files).flatMap(([key, path]) => [`--${key}`, path]), "--split", "development", "--allow-remote", "yes", "--writer-model", "fixture/writer-1"], { registry: models, fetch });
    assert.equal(result.code, 0);
    assert.equal(writes, 1);
    const evaluation = JSON.parse(readFileSync(files.output, "utf8"));
    assert.equal(evaluation.execution, "provider");
    assert.equal(evaluation.model.model, "typesafe/jev-1.14");
    assert.equal(evaluation.rows[0].repair.acceptedByAudit, true);
    assert.doesNotMatch(JSON.stringify(evaluation), /fictional-test-key|A fixture reply|A fixture—reply/);
    const drafts = JSON.parse(readFileSync(files["repair-drafts"], "utf8"));
    assert.equal(drafts[0].reply, "A fixture reply.");
    assert.equal(drafts[0].review.basis, "unreviewed");
  });
  await t.test("complete evaluator runs all rules through the real registry and adapter", async () => {
    const f = transport((request) => ({ model: request.model, usage: { input_tokens: 100, output_tokens: 20 }, answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: id === "fictional-9" ? 1 : 0 }])) }));
    const result = await auditCandidate({ catalog: inspectCatalog(makeCatalog(), skill), text: "Fictional response.", request: "Write a response.", adapter: f.adapter });
    assert.equal(result.coverageComplete, true);
    assert.equal(result.requests, 1);
    assert.equal(result.transportAttempts, 1);
    assert.equal(result.checks.find((check) => check.id === "fictional-9").outcome, "violation");
    assert.deepEqual(result.servedModels, ["typesafe/jev-1.14"]);
  });
});
