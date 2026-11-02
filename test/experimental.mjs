import assert from "node:assert/strict";
import test from "node:test";
import { coverageReport, inspectCatalog } from "../lib/catalog.mjs";
import { EXPERIMENTAL_CHECKS, validateExperimentalChecks, withExperimentalChecks } from "../lib/experimental.mjs";
import { auditCandidate } from "../lib/evaluator.mjs";
import { JudgmentCache } from "../lib/judgment-cache.mjs";
import { makeCatalog, makeTrialCatalog, skill } from "./fixtures/catalog.mjs";

const catalog = inspectCatalog(makeTrialCatalog(), skill);

test("experimental opt-in is limited to the two named semantic checks", () => {
  for (const value of [null, true, "formulaic-contrast", ["em-dash"], ["preserve-negation"], ["fictional-1"], ["formulaic-contrast", "formulaic-contrast"], [{}]]) {
    assert.throws(() => validateExperimentalChecks(value), /experimentalChecks/);
  }
  assert.deepEqual(validateExperimentalChecks([]), []);
  assert.deepEqual(validateExperimentalChecks([...EXPERIMENTAL_CHECKS].reverse()), EXPERIMENTAL_CHECKS);
  assert.throws(() => withExperimentalChecks(inspectCatalog(makeCatalog(), skill), EXPERIMENTAL_CHECKS), /missing/);
});

test("qualification rename accepts legacy settings and catalogs without duplicating enforcement", () => {
  const oldId = "redundant-negative-clarification";
  const newId = "unnecessary-qualification";
  assert.deepEqual(EXPERIMENTAL_CHECKS, ["formulaic-contrast", newId]);
  assert.deepEqual(validateExperimentalChecks([oldId]), [newId]);
  assert.throws(() => validateExperimentalChecks([oldId, newId]), /unique IDs/);
  for (const catalogId of [oldId, newId]) {
    const input = makeTrialCatalog();
    const check = input.checks.find((check) => check.id === newId);
    check.id = catalogId;
    check.calibration.threshold = 0.6;
    const parsed = inspectCatalog(input, skill);
    for (const selectedId of [oldId, newId]) {
      const active = withExperimentalChecks(parsed, [selectedId]).checks.filter((check) => check.experimental);
      assert.equal(active.length, 1);
      assert.equal(active[0].id, catalogId);
      assert.equal(active[0].status, "active");
      assert.equal(active[0].calibration.threshold, 0.6);
      assert.equal(active[0].calibration.state, "uncalibrated");
      assert.equal(withExperimentalChecks(parsed, []).checks.some((check) => check.experimental), false);
    }
  }
  const duplicate = makeTrialCatalog();
  duplicate.checks.push({ ...duplicate.checks.find((check) => check.id === newId), id: oldId });
  assert.throws(() => withExperimentalChecks(inspectCatalog(duplicate, skill), [newId]), /duplicate aliases/);
});

test("the runtime opt-in preserves the catalog and its uncalibrated evidence", () => {
  assert.equal(withExperimentalChecks(catalog), catalog);
  const before = JSON.stringify(catalog);
  const trial = withExperimentalChecks(catalog, EXPERIMENTAL_CHECKS);
  assert.equal(JSON.stringify(catalog), before);
  assert.equal(trial.catalog, catalog.catalog);
  assert.equal(trial.catalogDigest, catalog.catalogDigest);
  assert.equal(withExperimentalChecks(catalog, [...EXPERIMENTAL_CHECKS].reverse()).catalogDigest, trial.catalogDigest);
  assert.deepEqual(trial.checks.filter((check) => check.experimental).map((check) => check.id), EXPERIMENTAL_CHECKS);
  assert.equal(trial.checks.filter((check) => check.status === "active").length, 4);
  for (const check of trial.checks.filter((check) => check.experimental)) {
    assert.equal(check.calibration.state, "uncalibrated");
    assert.equal(check.calibration.threshold, 0.9);
    assert.equal(check.calibration.record, undefined);
    assert.notEqual(check.definitionDigest, catalog.checks.find((original) => original.id === check.id).definitionDigest);
    assert.throws(() => { check.status = "advisory"; }, TypeError);
  }
  const partial = withExperimentalChecks(catalog, [EXPERIMENTAL_CHECKS[0]]);
  assert.equal(partial.checks.filter((check) => check.experimental).length, 1);
  assert.match(coverageReport(trial), /active \(uncalibrated, experimental\)/);
  assert.match(coverageReport(trial), /trial off/);
  assert.doesNotMatch(coverageReport(catalog), /experimental\)/);
});

test("experimental selection cannot reactivate stale source or calibration", () => {
  const stale = inspectCatalog(makeTrialCatalog(), skill.replace("Fictional policy 9.", "Changed policy 9."));
  const trial = withExperimentalChecks(stale, EXPERIMENTAL_CHECKS);
  assert.equal(trial.checks.find((check) => check.id === "formulaic-contrast").status, "advisory");
  assert.equal(trial.checks.find((check) => check.id === "formulaic-contrast").experimental, undefined);
  const calibrated = { ...catalog, checks: catalog.checks.map((check) => check.id === "formulaic-contrast" ? { ...check, calibration: { ...check.calibration, state: "stale" } } : check) };
  assert.equal(withExperimentalChecks(calibrated, EXPERIMENTAL_CHECKS).checks.find((check) => check.id === "formulaic-contrast").status, "advisory");
});

test("experimental findings become active without reusing an advisory verdict", async () => {
  const cache = new JudgmentCache();
  let calls = 0;
  const adapter = { available: true, identity: { provider: "fixture", model: "fixture-1" }, async classify(body, options) {
    calls++;
    options.onAttempt();
    return { servedModel: "fixture-1", answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "bool", probability: EXPERIMENTAL_CHECKS.includes(id) ? 0.95 : 0 }])) };
  } };
  const input = { text: "The reply is ready.", request: "Write a reply.", cache, adapter };
  const advisory = await auditCandidate({ ...input, catalog });
  assert.equal(advisory.status, "passed");
  const active = await auditCandidate({ ...input, catalog: withExperimentalChecks(catalog, EXPERIMENTAL_CHECKS) });
  assert.equal(active.status, "failed");
  assert.equal(active.cacheHits, catalog.checks.filter((check) => check.kind === "semantic").length - EXPERIMENTAL_CHECKS.length);
  assert.ok(active.checks.filter((check) => check.experimental).every((check) => check.executed.every((range) => !range.cacheHit)));
  assert.equal(calls, 2);
  assert.ok(active.checks.filter((check) => check.experimental).every((check) => check.disposition === "active" && check.calibration.state === "uncalibrated" && check.outcome === "violation"));
  const unavailable = await auditCandidate({ ...input, cache: new JudgmentCache(), adapter: { ...adapter, available: false }, catalog: withExperimentalChecks(catalog, EXPERIMENTAL_CHECKS) });
  assert.equal(unavailable.status, "incomplete");
  assert.equal(unavailable.incomplete, true);
});
