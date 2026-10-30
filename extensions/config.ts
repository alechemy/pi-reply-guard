import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, type Skill } from "@earendil-works/pi-coding-agent";
import { validateExperimentalChecks } from "../lib/experimental.mjs";

export const NAME = "reply-guard";
export const VERDICT = "reply-guard-verdict";
export const SKILLS = "reply-guard-skills";
export const CONFIG_PATH = join(getAgentDir(), `${NAME}.json`);

interface LegacyConfig {
	schemaVersion: 1;
	thresholdMeaning: "compliance";
	auditDeadlineMs: number;
	classifierConcurrency: number;
	maxClassifierRequests: number;
	maxInputTokens: number;
	skills: Record<string, number>;
	model: string;
	maxRewrites: number;
	inject: boolean;
	reinjectBelow: number;
	preload: boolean;
	debug: boolean;
	showVerdicts: boolean;
}

const LEGACY_DEFAULTS: LegacyConfig = {
	schemaVersion: 1,
	thresholdMeaning: "compliance",
	auditDeadlineMs: 5000,
	classifierConcurrency: 2,
	maxClassifierRequests: 8,
	maxInputTokens: 64000,
	skills: {},
	model: "openrouter/typesafe/jev-1.14",
	maxRewrites: 2,
	inject: false,
	reinjectBelow: 0,
	preload: false,
	debug: false,
	showVerdicts: true,
};

function parseObject(text: string) {
	try { return JSON.parse(text); }
	catch { throw new Error(`Invalid JSON in ${CONFIG_PATH}. Existing bytes were preserved.`); }
}

function parseLegacyConfig(text: string): LegacyConfig {
	const value = parseObject(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
	const legacy = value.schemaVersion === undefined;
	const config = { ...LEGACY_DEFAULTS, ...(legacy ? { model: "openrouter/typesafe/jev-1.13", preload: true } : {}), ...value };
	if (config.schemaVersion !== 1) throw new Error("Unsupported schemaVersion. This configuration reader supports version 1.");
	if (config.thresholdMeaning !== "compliance") throw new Error("Version 1 skill thresholds measure compliance, not violations.");
	for (const key of ["auditDeadlineMs", "classifierConcurrency", "maxClassifierRequests", "maxInputTokens"] as const) {
		if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive safe integer.`);
	}
	if (!config.skills || typeof config.skills !== "object" || Array.isArray(config.skills)) throw new Error("Skills must map names to thresholds.");
	if (Object.entries(config.skills).some(([name, threshold]) => !name.trim() || typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
		throw new Error("Each skill needs a name and a threshold from 0 to 1.");
	}
	if (typeof config.model !== "string" || !/^[^/]+\/.+/.test(config.model)) throw new Error("Model must use provider/id.");
	if (!Number.isSafeInteger(config.maxRewrites) || config.maxRewrites < 0) throw new Error("maxRewrites must be a nonnegative integer.");
	if (typeof config.reinjectBelow !== "number" || !Number.isFinite(config.reinjectBelow) || config.reinjectBelow < 0 || config.reinjectBelow > 1) throw new Error("reinjectBelow must be a number from 0 to 1.");
	if (typeof config.inject !== "boolean" || typeof config.preload !== "boolean" || typeof config.debug !== "boolean" || typeof config.showVerdicts !== "boolean") {
		throw new Error("inject, preload, debug, and showVerdicts must be booleans.");
	}
	return config;
}

export interface Config {
	schemaVersion: 2;
	thresholdMeaning: "violation";
	mode: "off" | "observe" | "enforce";
	experimentalChecks: string[];
	releasePolicy: "warning" | "strict";
	skill: string;
	skillPath?: string;
	catalogPath?: string;
	model: string;
	maxRewrites: number;
	writerDeadlineMs: number;
	auditDeadlineMs: number;
	classifierConcurrency: number;
	maxClassifierRequests: number;
	maxInputTokens: number;
	preload: boolean;
	debug: boolean;
	showVerdicts: boolean;
}

export const DEFAULTS: Config = {
	schemaVersion: 2, thresholdMeaning: "violation", mode: "enforce", experimentalChecks: [], releasePolicy: "warning", skill: "unslop",
	model: "openrouter/typesafe/jev-1.14", maxRewrites: 2, writerDeadlineMs: 60000,
	auditDeadlineMs: 5000, classifierConcurrency: 2, maxClassifierRequests: 8, maxInputTokens: 64000,
	preload: false, debug: false, showVerdicts: false,
};

export function parseConfig(text: string): Config {
	const value = parseObject(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
	if (value.schemaVersion === undefined || value.schemaVersion === 1) throw new Error("Legacy compliance settings require /reply-guard migrate. Existing bytes were preserved.");
	if (value.schemaVersion !== 2) throw new Error("Unsupported schemaVersion. This reader supports version 2.");
	if (["skills", "inject", "reinjectBelow"].some((key) => Object.hasOwn(value, key))) throw new Error("Legacy settings require explicit migration and belong under legacyCompliance.");
	const config = { ...DEFAULTS, ...value };
	config.experimentalChecks = validateExperimentalChecks(config.experimentalChecks);
	if (config.thresholdMeaning !== "violation") throw new Error("Version 2 catalog thresholds measure violations.");
	if (!["off", "observe", "enforce"].includes(config.mode)) throw new Error("Mode must be off, observe, or enforce.");
	if (!["warning", "strict"].includes(config.releasePolicy)) throw new Error("Release policy must be warning or strict.");
	if (typeof config.skill !== "string" || !config.skill.trim()) throw new Error("A catalog-backed skill name is required.");
	for (const key of ["skillPath", "catalogPath"] as const) {
		if (config[key] !== undefined && (typeof config[key] !== "string" || !isAbsolute(config[key]))) throw new Error(`${key} must be an absolute path.`);
	}
	for (const key of ["auditDeadlineMs", "classifierConcurrency", "maxClassifierRequests", "maxInputTokens", "writerDeadlineMs"] as const) {
		if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive safe integer.`);
	}
	if (!Number.isSafeInteger(config.maxRewrites) || config.maxRewrites < 0) throw new Error("maxRewrites must be a nonnegative integer.");
	if (typeof config.model !== "string" || !/^[^/]+\/.+/.test(config.model)) throw new Error("Model must use provider/id.");
	for (const key of ["preload", "debug", "showVerdicts"] as const) if (typeof config[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
	return config;
}

export function migrateConfig(text: string): Config {
	const legacy = parseLegacyConfig(text);
	const { schemaVersion: _version, thresholdMeaning: _meaning, skills, inject, reinjectBelow, ...settings } = legacy;
	const names = Object.keys(skills);
	if (names.length !== 1) throw new Error("Migration requires one catalog-backed skill. Existing configuration was preserved.");
	return parseConfig(JSON.stringify({ ...DEFAULTS, ...settings, skill: names[0], legacyCompliance: { thresholdMeaning: "compliance", skills, inject, reinjectBelow } }));
}

export function rulePaths(config: Config, skills: Skill[]) {
	const skillPath = config.skillPath ?? skills.find((skill) => skill.name === config.skill)?.filePath;
	if (!skillPath) throw new Error(`Required skill not found: ${config.skill}.`);
	return { skillPath, catalogPath: config.catalogPath ?? join(dirname(skillPath), "reply-guard.rules.json") };
}

export function loadConfig(): Config {
	return parseConfig(readFileSync(CONFIG_PATH, "utf8"));
}

export function saveConfig(config: Config, expected: string | undefined): string | undefined {
	const text = `${JSON.stringify(parseConfig(JSON.stringify(config)), null, 2)}\n`;
	const lock = `${CONFIG_PATH}.lock`;
	try { mkdirSync(lock, { mode: 0o700 }); } catch {
		throw new Error(`Cannot acquire configuration lock at ${lock}. Close other editors and inspect a leftover lock before retrying.`);
	}
	try {
		return replaceConfig(text, expected);
	} finally {
		rmdirSync(lock);
	}
}

function replaceConfig(text: string, expected: string | undefined): string | undefined {
	let previous: string | undefined;
	try {
		if (!lstatSync(CONFIG_PATH).isFile()) throw new Error("Configuration must be a regular file, not a symlink.");
		previous = readFileSync(CONFIG_PATH, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (previous !== expected) throw new Error("Configuration changed while the editor was open. Reopen /reply-guard.");
	if (previous === text) return;
	const temporary = `${CONFIG_PATH}.${randomUUID()}.tmp`;
	const backup = previous === undefined ? undefined : `${CONFIG_PATH}.${randomUUID()}.bak`;
	try {
		if (backup) writeFileSync(backup, previous!, { mode: 0o600, flag: "wx" });
		writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		renameSync(temporary, CONFIG_PATH);
	} finally {
		try { unlinkSync(temporary); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return backup;
}
