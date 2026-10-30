import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type Skill } from "@earendil-works/pi-coding-agent";

export const NAME = "reply-guard";
export const VERDICT = "reply-guard-verdict";
export const SKILLS = "reply-guard-skills";
export const CONFIG_PATH = join(getAgentDir(), `${NAME}.json`);

export interface Config {
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

export interface Spec {
	name: string;
	text: string;
	threshold: number;
}

export const DEFAULTS: Config = {
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

export function parseConfig(text: string): Config {
	const value = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
	const legacy = value.schemaVersion === undefined;
	const config = { ...DEFAULTS, ...(legacy ? { model: "openrouter/typesafe/jev-1.13", preload: true } : {}), ...value };
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

function skillBody(path: string): string {
	const text = readFileSync(path, "utf8")
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
		.trim();
	if (!text) throw new Error(`Skill is empty: ${path}`);
	return text;
}

export function selectSpecs(skills: Skill[], config: Config): Spec[] {
	return skills
		.filter((skill) => Object.hasOwn(config.skills, skill.name))
		.map((skill) => ({ name: skill.name, text: skillBody(skill.filePath), threshold: config.skills[skill.name] }));
}

export function missingSkills(config: Config, specs: Spec[]): string[] {
	return Object.keys(config.skills).filter((name) => !specs.some((spec) => spec.name === name));
}

export function promptSection(specs: Spec[]): string {
	return [
		"Every reply to the user must meet the skills below. They govern reply prose, not code, commands, or file contents.",
		...specs.map((spec) => `<skill name="${spec.name}">\n${spec.text}\n</skill>`),
	].join("\n\n");
}
