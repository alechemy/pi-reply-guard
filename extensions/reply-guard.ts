import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { loadCatalog } from "../lib/catalog.mjs";
import { createJevAdapter } from "../lib/jev.mjs";
import { withExperimentalChecks } from "../lib/experimental.mjs";
import { registerRepairLifecycle } from "../lib/repair-lifecycle.mjs";
import { loadConfig, rulePaths, SKILLS } from "./config.js";
import { registerConfigCommand } from "./commands.js";
import { registerUI } from "./ui.js";

export default function (pi: ExtensionAPI) {
	let skills: Skill[] = [];
	const ui = registerUI(pi);
	async function snapshot(ctx: ExtensionContext) {
		const config = loadConfig();
		if (config.mode === "off") return config;
		try {
			const paths = rulePaths(config, skills);
			const catalog = withExperimentalChecks(await loadCatalog(paths.catalogPath, paths.skillPath), config.experimentalChecks);
			return { ...config, catalog, adapter: createJevAdapter(ctx.modelRegistry, config.model),
				limits: { auditDeadlineMs: config.auditDeadlineMs, classifierConcurrency: config.classifierConcurrency, maxClassifierRequests: config.maxClassifierRequests, maxInputTokens: config.maxInputTokens },
			};
		} catch {
			return { ...config, error: "Required skill or rule catalog could not be loaded. Inspect /reply-guard status and /reply-guard coverage." };
		}
	}
	const lifecycle = registerRepairLifecycle(pi, snapshot, ui);
	registerConfigCommand(pi, { skills: () => skills, changed: (config, previous, ctx) => {
		if (config.mode !== previous?.mode || config.releasePolicy !== previous?.releasePolicy || JSON.stringify(config.experimentalChecks) !== JSON.stringify(previous?.experimentalChecks ?? [])) lifecycle.changeMode(config.mode, ctx);
	} });
	for (const event of ["session_start", "session_tree"] as const) pi.on(event, (_event, ctx) => {
		try { ui.mode(loadConfig().mode, ctx); } catch { ui.mode("enforce", ctx); }
	});
	pi.on("before_agent_start", (event, ctx) => {
		skills = event.systemPromptOptions.skills;
		try {
			const config = loadConfig();
			if (config.mode === "off" || !config.preload) return;
			const paths = rulePaths(config, skills);
			const content = readFileSync(paths.skillPath, "utf8");
			if (!content.trim()) return;
			if (ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === SKILLS && entry.content === content)) return;
			return { message: { customType: SKILLS, content, display: true, details: [config.skill] } };
		} catch { return; }
	});
}
