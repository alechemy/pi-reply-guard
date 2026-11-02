import { digest } from "./catalog.mjs";

export const EXPERIMENTAL_CHECKS = Object.freeze(["formulaic-contrast", "unnecessary-qualification"]);
const canonicalId = (id) => id === "redundant-negative-clarification" ? "unnecessary-qualification" : id;

export function validateExperimentalChecks(value) {
  const ids = Array.isArray(value) ? value.map(canonicalId) : null;
  if (!ids || ids.some((id) => !EXPERIMENTAL_CHECKS.includes(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`experimentalChecks must contain unique IDs from: ${EXPERIMENTAL_CHECKS.join(", ")}.`);
  }
  return ids.sort();
}

export function withExperimentalChecks(catalog, selected = []) {
  const ids = validateExperimentalChecks(selected);
  if (!ids.length) return catalog;
  for (const id of ids) {
    const matches = catalog.checks.filter((check) => canonicalId(check.id) === id && check.kind === "semantic");
    if (!matches.length) throw new Error(`Experimental semantic check is missing from the catalog: ${id}.`);
    if (matches.length !== 1) throw new Error(`Experimental semantic check has duplicate aliases in the catalog: ${id}.`);
  }
  const checks = catalog.checks.map((check) => ids.includes(canonicalId(check.id)) && !check.stale && check.status === "advisory" && check.calibration?.state === "uncalibrated"
    ? Object.freeze({ ...check, status: "active", experimental: true, statusReason: "Explicit experimental opt-in. Accuracy is uncalibrated.", definitionDigest: digest(JSON.stringify({ definition: check.definitionDigest, experimental: true })) })
    : check);
  return Object.freeze({ ...catalog, checks: Object.freeze(checks) });
}
