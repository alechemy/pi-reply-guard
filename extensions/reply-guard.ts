import { createHash } from "node:crypto";
import type { CustomMessageEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, DEFAULTS, NAME, SKILLS, VERDICT, loadConfig, missingSkills, promptSection, selectSpecs, type Spec } from "./config.js";
import { registerConfigCommand } from "./commands.js";
import { check, lastRequest, textOf, type Check, type DebugEvent, type Verdict } from "./jev.js";
import { registerUI, statusText } from "./ui.js";

function rewriteText(failed: Verdict[], skills: Spec[] = []): string {
	return [
		"Your last reply was hidden from the end-user because it does not adhere to the following skills:",
		...failed.map((verdict) => `- ${verdict.name}`),
		"Rewrite the reply in a manner that adheres to these skills. If you have not already read them in full, please do before proceeding.",
		...(skills.length > 0 ? ["", promptSection(skills)] : []),
	].join("\n");
}

function rewriteRequest(text: string): CustomMessageEntryDraft {
	return { type: "custom_message", customType: NAME, display: false, content: text };
}

export default function (pi: ExtensionAPI) {
	let config = DEFAULTS;
	let specs: Spec[] = [];
	let rewrites = 0;
	let configurationError: string | undefined;
	let pending: Check | undefined;
	let trace: DebugEvent[] = [];
	let generation = 0;
	let candidateSequence = 0;
	let auditController: AbortController | undefined;
	const seen = new Map<string, Check>();

	function invalidate() {
		auditController?.abort();
		generation++;
		pending = undefined;
	}

	function record(event: string, data?: unknown) {
		if (config.debug) trace.push({ event, data: typeof data === "string" ? data : JSON.stringify(data, null, 2) });
	}

	function injected(failed: Verdict[]): Spec[] {
		return specs.filter((spec) => failed.some((verdict) => verdict.name === spec.name && (config.inject || (verdict.probability ?? 1) < config.reinjectBelow)));
	}

	const ui = registerUI(pi, () => specs.length > 0 || configurationError !== undefined);
	registerConfigCommand(pi);

	pi.on("before_agent_start", (event, ctx) => {
		trace = [];
		specs = [];
		configurationError = undefined;
		try {
			config = loadConfig();
			specs = selectSpecs(event.systemPromptOptions.skills, config);
			const missing = missingSkills(config, specs);
			if (Object.keys(config.skills).length === 0) throw new Error(`No skills configured. Edit ${CONFIG_PATH}.`);
			if (missing.length) throw new Error(`Required skills not found: ${missing.join(", ")}`);
		} catch (error) {
			configurationError = error instanceof SyntaxError ? `Invalid JSON in ${CONFIG_PATH}.` : error instanceof Error ? error.message : "Configuration could not be loaded.";
			ctx.ui.notify(`${NAME}: ${configurationError}`, "error");
		}
		ui.restore(ctx);
		record("before_agent_start", { model: config.model, maxRewrites: config.maxRewrites, selectedSkills: specs.map((spec) => spec.name), configurationError });
		const loaded = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === SKILLS);
		if (configurationError || !config.preload || specs.length === 0 || loaded) return;
		const content = promptSection(specs);
		record("skill_preload", { skills: specs.map((spec) => spec.name) });
		return { message: { customType: SKILLS, content, display: true, details: specs.map((spec) => spec.name) } };
	});

	pi.on("agent_start", () => record("agent_start"));
	pi.on("turn_start", (event) => record("turn_start", { turnIndex: event.turnIndex }));
	pi.on("tool_execution_start", (event) => record("tool_execution_start", { toolName: event.toolName }));
	pi.on("tool_execution_end", (event) => record("tool_execution_end", { toolName: event.toolName, isError: event.isError }));
	pi.on("turn_end", (event) => record("turn_end", { turnIndex: event.turnIndex, outcome: event.outcome }));
	pi.on("agent_end", () => record("agent_end"));

	pi.on("input", () => invalidate());
	pi.on("session_shutdown", () => invalidate());
	pi.on("session_tree", () => invalidate());
	pi.on("message_start", (event) => {
		record("message_start", { role: event.message.role });
		if (event.message.role === "user") {
			invalidate();
			rewrites = 0;
			seen.clear();
		}
		if (event.message.role === "assistant") {
			candidateSequence++;
			pending = undefined;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		record("message_end", { role: message.role, stopReason: message.role === "assistant" ? message.stopReason : undefined });
		if (message.role !== "assistant" || message.stopReason !== "stop") return;
		if (message.content.some((block) => block.type === "toolCall")) return;
		const reply = textOf(message.content);
		if (!reply.trim()) return;

		const request = lastRequest(ctx.sessionManager.buildSessionProjection().messages);
		const currentGeneration = generation;
		const currentCandidate = candidateSequence;
		const hash = createHash("sha256").update(reply).digest("hex");
		const cached = seen.get(hash);
		record("check_started", { attempt: rewrites + 1, maxRewrites: config.maxRewrites, hash, cached: cached !== undefined });
		const controller = new AbortController();
		auditController = controller;
		let result: Check;
		try {
			result = configurationError
				? { model: config.model, ms: 0, verdicts: [], status: "incomplete", incomplete: true, error: configurationError, termination: "configuration-error" }
				: cached ?? await check(ctx, config, specs, request, reply, config.debug ? record : undefined, controller.signal);
		} finally {
			if (auditController === controller) auditController = undefined;
		}
		if (currentGeneration !== generation || currentCandidate !== candidateSequence || ctx.signal?.aborted) return;
		seen.set(hash, result);
		const content = message.content.map((block) => block.type === "text" ? { ...block, text: ui.tag(block.text) } : block);
		const hidden = ui.hide(content.flatMap((block) => block.type === "text" ? [block.text] : []));
		pending = {
			...result,
			termination: cached ? "repeated-candidate" : result.termination,
			attempt: rewrites + 1,
			showVerdicts: config.showVerdicts,
			hidden,
			reply,
		};
		return { message: { ...message, content } };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		const result = pending;
		pending = undefined;
		if (!result) return;
		const entry = { type: "custom" as const, customType: VERDICT, data: result };
		const failed = result.verdicts.filter((verdict) => verdict.failed);
		record("agent_before_settle", { outcome: event.outcome, attempt: result.attempt, failedSkills: failed.map((verdict) => verdict.name) });
		if (event.outcome !== "completed" || ctx.signal?.aborted) {
			result.termination = "cancelled";
			result.delivery = "withheld";
			result.reply = undefined;
		} else if (!result.termination) {
			if (result.status === "passed") result.termination = "passed";
			else if (failed.length === 0) result.termination = "checker-unavailable";
			else if (rewrites >= config.maxRewrites) result.termination = "rewrite-limit";
		}
		if (result.termination) {
			result.delivery ??= "released";
			ctx.ui.setStatus(NAME, result.showVerdicts !== false || result.status !== "passed" ? statusText(result) : undefined);
			record("reply_released", { status: result.status, termination: result.termination, delivery: result.delivery });
			result.trace = config.debug ? trace.splice(0) : undefined;
			return { entries: [...event.entries, entry] };
		}

		result.reply = undefined;
		ctx.ui.setStatus(NAME, statusText(result));
		rewrites++;
		const skills = injected(failed);
		if (!config.inject) for (const verdict of failed) if (skills.some((spec) => spec.name === verdict.name)) verdict.reinjectBelow = config.reinjectBelow;
		const rewrite = rewriteText(failed, skills);
		record("rewrite_requested", { nextAttempt: rewrites + 1, failedSkills: failed.map((verdict) => verdict.name) });
		result.trace = config.debug ? trace.splice(0) : undefined;
		return { entries: [...event.entries, entry, rewriteRequest(rewrite)], continue: true };
	});
}
