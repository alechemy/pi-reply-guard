import { createHash, randomUUID } from "node:crypto";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { DRAFT, RESULT, hasMarker, textOf } from "../lib/delivery.mjs";
import { NAME, SKILLS, VERDICT, type Config } from "./config.js";
type LegacyCheck = { status?: string; termination?: string; reply?: string; hidden?: string[] };

type AuditCheck = { id: string; disposition: string; outcome: string; incomplete?: boolean; reason?: string; reasons?: string[]; calibration?: { state: string } };
export type Delivery = {
	mode: Config["mode"]; releasePolicy: Config["releasePolicy"]; delivery: "released" | "withheld"; termination: string; showVerdicts?: boolean; reply?: string; draft?: string; draftId?: string;
	debug?: boolean; candidates?: unknown[]; writerUsage?: unknown;
	audit?: { status: string; incomplete: boolean; advisoryIncomplete?: boolean; error?: string; checks: AuditCheck[]; catalogIssues?: unknown[] };
};
const digest = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
const staleCalibrations = (data: Delivery) => data.audit?.checks.filter((check) => check.calibration?.state === "stale").length ?? 0;
const quiet = (data: Delivery) => !staleCalibrations(data) && !data.audit?.catalogIssues?.length && data.showVerdicts === false && data.delivery === "released" && data.audit?.status === "passed" && !data.audit.incomplete && !data.audit.advisoryIncomplete && !data.audit.checks.some((check) => check.outcome === "violation");

export function statusText(data: Delivery): string {
	const audit = data.audit;
	const advisory = audit?.checks.filter((check) => check.disposition === "advisory") ?? [];
	return [
		`${data.mode}: active checks ${audit?.status ?? "unchecked"}${audit?.incomplete && audit.status !== "incomplete" ? ", incomplete" : ""}`,
		`${advisory.length} advisory (${advisory.filter((check) => check.outcome === "violation").length} flagged, ${advisory.filter((check) => check.calibration?.state === "uncalibrated").length} uncalibrated)`,
		...(audit?.advisoryIncomplete ? ["advisory coverage incomplete"] : []),
		...(staleCalibrations(data) ? [`${staleCalibrations(data)} stale calibration`] : []),
		...(audit?.catalogIssues?.length ? ["catalog stale or incomplete"] : []),
		`${data.delivery} (${data.termination})`,
	].join(" · ");
}

export function registerUI(pi: ExtensionAPI) {
	let mode = "enforce";
	const markers = new Set<string>();
	const legacyHidden = new Set<string>();
	const marked = (markdown: string) => [...markers].some((marker) => markdown.includes(marker));
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant") return markdown;
		if ((context.isStreaming && mode === "enforce") || marked(markdown) || legacyHidden.has(digest(markdown))) return "";
		return markdown;
	});
	function messages(input: MessageEndEvent["message"][]) { return input.flatMap((message) => {
		if (message.role !== "assistant") return [message];
		if (hasMarker(message, [...markers])) return [];
		return [{ ...message, content: message.content.map((block) => block.type === "text" && legacyHidden.has(digest(block.text))
			? { ...block, text: block.text.replace(/\n\n<!--reply-guard:[\da-f-]+-->$/, "") } : block) }];
	}); }
	pi.on("context", (event) => ({ messages: messages(event.messages) }));
	pi.registerEntryRenderer(DRAFT, () => new Container());
	pi.registerEntryRenderer<Delivery>(RESULT, (entry, { expanded }, theme) => {
		const content = new Container();
		const data = entry.data;
		if (!data) return content;
		if (!quiet(data)) {
			const color = data.delivery === "released" && data.audit?.status === "passed" && !data.audit.advisoryIncomplete && !staleCalibrations(data) && !data.audit.catalogIssues?.length ? "muted" : "warning";
			const lines = [`[${NAME}] ${statusText(data)}`];
			if (data.audit?.error) lines.push(data.audit.error);
			if (data.delivery === "withheld") lines.push("Inspect the stored draft with /reply-guard recover.");
			if (expanded) for (const check of data.audit?.checks ?? []) lines.push(`${check.id}: ${check.disposition}, ${check.outcome}${check.incomplete ? ", incomplete" : ""}${check.reason ? `. ${check.reason}` : ""}${check.reasons?.length ? `. ${check.reasons.join(" ")}` : ""}`);
			if (expanded && data.debug) lines.push(JSON.stringify({ candidates: data.candidates, writerUsage: data.writerUsage }, null, 2));
			content.addChild(new Text(theme.fg(color, lines.join("\n")), 1, 0));
		}
		if (data.reply !== undefined) { content.addChild(new Spacer(1)); content.addChild(new Markdown(data.reply, 1, 0, getMarkdownTheme())); }
		return content;
	});
	pi.registerEntryRenderer<LegacyCheck>(VERDICT, (entry, _options, theme) => {
		const content = new Container();
		const data = entry.data;
		if (!data) return content;
		content.addChild(new Text(theme.fg("muted", `[${NAME}] Legacy result: ${data.status ?? "unchecked"}${data.termination ? ` (${data.termination})` : ""}`), 1, 0));
		if (data.reply) content.addChild(new Markdown(data.reply, 1, 0, getMarkdownTheme()));
		return content;
	});
	pi.registerMessageRenderer<string[]>(SKILLS, (message, { expanded }, theme) => new Text(theme.fg("muted", expanded && typeof message.content === "string" ? message.content : `[${NAME}] Preloaded ${(message.details ?? []).join(", ")}.`), 1, 0));
	function status(data: Delivery, ctx: ExtensionContext) { ctx.ui.setStatus(NAME, data.mode !== mode ? `Mode: ${mode}` : quiet(data) ? undefined : statusText(data)); }
	function restore(ctx: ExtensionContext) {
		legacyHidden.clear();
		let latest: Delivery | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === DRAFT) for (const marker of (entry.data as { markers: string[] }).markers) markers.add(marker);
			if (entry.customType === VERDICT) for (const hash of (entry.data as LegacyCheck)?.hidden ?? []) legacyHidden.add(hash);
			if (entry.customType === RESULT) latest = entry.data as Delivery;
		}
		if (latest) status(latest, ctx);
		else ctx.ui.setStatus(NAME, `Mode: ${mode}`);
	}
	for (const event of ["session_start", "session_tree"] as const) pi.on(event, (_event, ctx) => restore(ctx));
	return {
		restore, status, messages,
		mode: (next: string, ctx: ExtensionContext) => { mode = next; ctx.ui.setStatus(NAME, `Mode: ${mode}`); },
		begin: (message: Extract<MessageEndEvent["message"], { role: "assistant" }>, snapshot: Config, ctx: ExtensionContext) => {
			const owned: string[] = [];
			const content = message.content.map((block) => {
				if (block.type !== "text") return block;
				const marker = `\n\n<!--reply-guard:${randomUUID()}-->`;
				owned.push(marker);
				markers.add(marker);
				return { ...block, text: block.text + marker };
			});
			const text = textOf(message.content);
			const draft = { schemaVersion: 2, id: randomUUID(), candidateHash: createHash("sha256").update(text).digest("hex"), markers: owned, text, mode: snapshot.mode, releasePolicy: snapshot.releasePolicy };
			pi.appendEntry(DRAFT, draft);
			ctx.ui.setStatus(NAME, "Checking final reply.");
			return { message: { ...message, content }, draft };
		},
	};
}
