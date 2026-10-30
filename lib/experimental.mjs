import { digest } from "./catalog.mjs";

export const EXPERIMENTAL_CHECKS = Object.freeze(["formulaic-contrast", "redundant-negative-clarification"]);

export function validateExperimentalChecks(value) {
  if (!Array.isArray(value) || value.some((id) => !EXPERIMENTAL_CHECKS.includes(id)) || new Set(value).size !== value.length) {
    throw new Error(`experimentalChecks must contain unique IDs from: ${EXPERIMENTAL_CHECKS.join(", ")}.`);
  }
  return [...value].sort();
}

export function withExperimentalChecks(catalog, selected = []) {
  const ids = validateExperimentalChecks(selected);
  if (!ids.length) return catalog;
  for (const id of ids) {
    if (!catalog.checks.some((check) => check.id === id && check.kind === "semantic")) throw new Error(`Experimental semantic check is missing from the catalog: ${id}.`);
  }
  const checks = catalog.checks.map((check) => ids.includes(check.id) && !check.stale && check.status === "advisory" && check.calibration?.state === "uncalibrated"
    ? Object.freeze({ ...check, status: "active", experimental: true, statusReason: "Explicit experimental opt-in. Accuracy is uncalibrated.", definitionDigest: digest(JSON.stringify({ definition: check.definitionDigest, experimental: true })) })
    : check);
  return Object.freeze({ ...catalog, checks: Object.freeze(checks) });
}
