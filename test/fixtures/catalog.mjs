import { parseSkill, PREPROCESSING_VERSION, DETECTOR_VERSION } from "../../lib/catalog.mjs";

export const skill = "# Fictional test policy\n\nPreserve meaning.\n\n## Patterns to detect and fix\n\n" + Array.from({ length: 36 }, (_, index) => `${index + 1}. **Rule ${index + 1}.** Fictional policy ${index + 1}.\n`).join("");

export function makeCatalog() {
  const checks = Array.from({ length: 36 }, (_, index) => ({
    id: `fictional-${index + 1}`, sourceRule: index + 1, kind: "semantic", scope: "reply",
    applicability: "Eligible prose.", exceptions: "Verified source material.", repair: "Remove the fictional pattern without changing meaning.",
    status: "advisory", statusReason: "No calibration.",
    calibration: { state: "uncalibrated", threshold: 0.9, model: null, dataset: null, priority: "normal" },
    question: { type: "bool", instructions: "Does the fictional violation occur?", criteria: { true: "A violation occurs.", false: "No violation occurs." } },
    examples: ["violation", "clear", "exception"].map((label) => ({ label, request: "Write a reply.", reply: "Fictional reply.", reason: "Synthetic test data." })),
  }));
  for (const [id, sourceRule] of [["em-dash", 13], ["curly-quotes", 19]]) {
    checks.push({ ...checks[0], id, sourceRule, kind: "local", scope: "passage", status: "active", calibration: null, predicate: { id, comparison: "contains-in-eligible-prose", codePoints: id === "em-dash" ? [8212] : [8216, 8217, 8218, 8219, 8220, 8221, 8222, 8223] } });
    delete checks.at(-1).question;
  }
  return { schemaVersion: 1, rulesetVersion: "fictional-1", preprocessingVersion: PREPROCESSING_VERSION, detectorVersion: DETECTOR_VERSION, source: parseSkill(skill), protectionPolicy: "Protect literals and verified quotations.", processRequirements: [{ id: "self-audit", requirement: "Silently scan the reply.", verification: "internal-process-not-verifiable", observableChecks: ["fictional-1"] }], checks };
}
