import assert from "node:assert/strict";
import test from "node:test";
import { inspectCatalog } from "../lib/catalog.mjs";
import { createView, compareProtected } from "../lib/markdown.mjs";
import { evaluateLocal } from "../lib/local-checks.mjs";
import { repairReply } from "../lib/repair.mjs";
import { makeCatalog, skill } from "./fixtures/catalog.mjs";

const catalog = inspectCatalog(makeCatalog(), skill);
const remote = { available: true, identity: { provider: "fixture", model: "classifier" }, async classify(body, options) {
  options.onAttempt();
  return { servedModel: "classifier", answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "bool", probability: 0 }])) };
} };

test("explicit reproduction binds exact request bytes and leaves other prose eligible", () => {
  for (const directive of ["Reproduce exactly", "Reproduce this sentence exactly", "Copy verbatim", "Repeat unchanged", "Please quote this text exactly"]) {
    const request = `${directive}: Keep—this.`;
    const view = createView("Keep—this.\n\nOther—prose.", { request });
    assert.equal(view.verbatimSpans.length, 1);
    assert.match(view.verbatimSpans[0].sourceId, /^user-request:/);
    assert.equal(view.verbatimSpans[0].raw, "Keep—this.");
    const check = evaluateLocal(catalog, view).checks.find((check) => check.id === "em-dash");
    assert.equal(check.findings.length, 1);
    assert.equal(check.omitted.length, 1);
  }
  const view = createView("Keep—this.\r\n“Enabled”.", { request: "Reproduce exactly:\r\nKeep—this.\r\n“Enabled”." });
  assert.equal(evaluateLocal(catalog, view).status, "passed");
});

test("ambiguous or normalized reproduction sources remain incomplete", async () => {
  for (const [request, text] of [
    ["Reproduce the previous answer exactly.", "Keep—this."],
    ["Reproduce the previous answer exactly.", "Plain text."],
    ["Reproduce exactly: Keep—this.", "Keep&mdash;this."],
    ["Explain the request 'Reproduce exactly: Keep—this.'", "Keep—this."],
  ]) {
    const view = createView(text, { request });
    assert.equal(view.verbatimSpans.length, 0);
    assert.equal(evaluateLocal(catalog, view).status, "incomplete");
    const result = await repairReply({ catalog, text, request, adapter: remote, writer: () => assert.fail("Unresolved source intent must not trigger repair") });
    assert.equal(result.termination, "checker-unavailable");
    assert.equal(result.selected.text, text);
  }
  assert.equal(evaluateLocal(catalog, createView("Keep—this.", { request: "Write an instruction." })).status, "failed");
  const trusted = createView("Keep—this.", { request: "Reproduce the previous answer exactly.", verbatim: [{ sourceId: "verified-history:1", text: "Keep—this." }] });
  assert.equal(evaluateLocal(catalog, trusted).status, "passed");
});

test("request provenance survives the original baseline and every revision", async () => {
  const request = "Reproduce exactly: Keep—this.";
  const original = "Keep—this.\n\nOther—prose.";
  const baseline = createView(original, { request });
  assert.equal(compareProtected(baseline, createView("Keep this.\n\nOther prose.", { request, baseline })).outcome, "violation");
  let writes = 0;
  const result = await repairReply({ catalog, text: original, request, adapter: remote, writer: async (feedback) => {
    assert.equal(feedback.original, original);
    assert.equal(feedback.verbatim[0].text, "Keep—this.");
    return { text: ++writes === 1 ? "Keep this.\n\nOther prose." : "Keep—this.\n\nOther prose." };
  } });
  assert.equal(writes, 2);
  assert.equal(result.candidates[1].preserved, false);
  assert.equal(result.termination, "passed");
  assert.equal(result.selected.text, "Keep—this.\n\nOther prose.");
  assert.equal(result.selected.audit.checks.find((check) => check.id === "preserve-literals").outcome, "clear");
});
