import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { coverageReport, loadCatalog } from "../lib/catalog.mjs";
import { RESULT } from "../lib/delivery.mjs";
import { createJevAdapter } from "../lib/jev.mjs";
import { EXPERIMENTAL_CHECKS, withExperimentalChecks } from "../lib/experimental.mjs";
import { CONFIG_PATH, DEFAULTS, NAME, loadConfig, migrateConfig, parseConfig, rulePaths, saveConfig, type Config } from "./config.js";

import type { Delivery } from "./ui.js";

type Controls = { skills: () => Skill[]; changed: (config: Config, previous: Config | undefined, ctx: ExtensionCommandContext) => void };

export function registerConfigCommand(pi: ExtensionAPI, controls: Controls) {
	pi.registerCommand(NAME, {
		description: "Configure modes and release policy, inspect coverage and verdicts, or recover a withheld draft",
		handler: async (args, ctx) => {
			const action = args.trim();
			try {
				if (action === "recover" || action === "verdict") {
					const results = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === RESULT ? [entry.data as Delivery] : []);
					const result = action === "recover" ? results.findLast((data) => data?.delivery === "withheld" && typeof data.draft === "string") : results.at(-1);
					if (!result) { ctx.ui.notify(action === "recover" ? "No withheld draft is stored on this branch." : "No verdict is stored on this branch.", "info"); return; }
					if (!ctx.hasUI) { ctx.ui.notify("Draft and verdict inspection requires an interactive or RPC UI.", "error"); return; }
					const { draft, reply: _reply, ...metadata } = result;
					await ctx.ui.editor(action === "recover" ? "Withheld draft (inspection only)" : "Recent verdict (inspection only)", action === "recover" ? draft : JSON.stringify(metadata, null, 2));
					return;
				}
				if (action === "status" || action === "coverage") {
					const config = loadConfig();
					const skills = controls.skills().length ? controls.skills() : ctx.getSystemPromptOptions().skills;
					if (action === "status") {
						let sources;
						try { sources = rulePaths(config, skills); } catch { sources = { sourceError: "The configured skill could not be found." }; }
						ctx.ui.notify(JSON.stringify({ configuration: CONFIG_PATH, ...Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, config[key as keyof Config]])), ...sources, classifierAvailable: createJevAdapter(ctx.modelRegistry, config.model).available }, null, 2), "info");
						return;
					}
					const paths = rulePaths(config, skills);
					const catalog = withExperimentalChecks(await loadCatalog(paths.catalogPath, paths.skillPath), config.experimentalChecks);
					const report = coverageReport(catalog);
					if (ctx.hasUI) await ctx.ui.editor("Rule coverage and calibration (inspection only)", report);
					else ctx.ui.notify(report, "info");
					return;
				}
				let original: string | undefined;
				try { original = readFileSync(CONFIG_PATH, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				if (action === "migrate") {
					if (original === undefined) throw new Error("No legacy configuration exists. Use /reply-guard to create settings.");
					const next = migrateConfig(original);
					if (!ctx.hasUI || !(await ctx.ui.confirm("Migrate reply guard settings?", "The catalog will own per-rule violation thresholds. Old compliance thresholds and injection preferences will be retained under legacyCompliance. The selected model, preload preference, budgets, and unrelated settings will be preserved."))) return;
					const backup = saveConfig(next, original);
					controls.changed(next, undefined, ctx);
					ctx.ui.notify(`Migrated settings. Previous settings: ${backup}. Verify the catalog and pinned model with /reply-guard status and /reply-guard coverage.`, "info");
					return;
				}
				let config = original === undefined ? { ...DEFAULTS } : parseConfig(original);
				function save(next: Config) {
					const validated = parseConfig(JSON.stringify(next));
					const backup = saveConfig(validated, original);
					controls.changed(validated, config, ctx);
					config = validated;
					original = `${JSON.stringify(validated, null, 2)}\n`;
					ctx.ui.notify(`Reply guard settings saved.${backup ? ` Previous settings: ${backup}` : ""}`, "info");
				}
				if (["off", "observe", "enforce"].includes(action)) { save({ ...config, mode: action as Config["mode"] }); return; }
				if (["warning", "strict"].includes(action)) { save({ ...config, releasePolicy: action as Config["releasePolicy"] }); return; }
				if (action === "trial on" || action === "trial off") {
					const next = { ...config, experimentalChecks: action === "trial on" ? [...EXPERIMENTAL_CHECKS] : [] };
					if (next.experimentalChecks.length) {
						const paths = rulePaths(next, controls.skills().length ? controls.skills() : ctx.getSystemPromptOptions().skills);
						const catalog = withExperimentalChecks(await loadCatalog(paths.catalogPath, paths.skillPath), next.experimentalChecks);
						if (!catalog.valid || next.experimentalChecks.some((id) => !catalog.checks.some((check) => check.id === id && check.status === "active" && !check.stale))) throw new Error("Trial definitions are stale or unavailable. Inspect /reply-guard coverage before enabling them.");
					}
					save(next);
					ctx.ui.notify(next.experimentalChecks.length ? `Experimental semantic checks enabled. Accuracy is uncalibrated. Current mode: ${config.mode}. Disable with /reply-guard trial off.` : "Experimental semantic checks disabled.", "info");
					return;
				}
				if (action) throw new Error("Use /reply-guard [status|coverage|verdict|recover|off|observe|enforce|warning|strict|migrate|trial on|trial off].");
				if (!ctx.hasUI) throw new Error("The settings editor requires an interactive or RPC UI.");
				while (true) {
					const options = [`Mode: ${config.mode}`, `Release policy: ${config.releasePolicy}`, `Show verdicts: ${config.showVerdicts ? "on" : "off"}`, "Edit JSON", "Save settings", "Done"];
					const selected = await ctx.ui.select("Reply guard settings", options);
					if (selected === undefined || selected === "Done") return;
					if (selected === "Edit JSON") {
						const text = await ctx.ui.editor("Reply guard configuration", JSON.stringify(config, null, 2));
						if (text !== undefined) save(parseConfig(text));
					} else if (selected === options[0]) {
						const mode = await ctx.ui.select("Operating mode", ["off", "observe", "enforce"]);
						if (mode) save({ ...config, mode: mode as Config["mode"] });
					} else if (selected === options[1]) {
						const policy = await ctx.ui.select("Release policy in enforce mode", ["warning", "strict"]);
						if (policy) save({ ...config, releasePolicy: policy as Config["releasePolicy"] });
					} else if (selected === options[2]) save({ ...config, showVerdicts: !config.showVerdicts });
					else if (selected === "Save settings") save(config);
				}
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Reply guard settings could not be loaded.", "error"); }
		},
	});
}
