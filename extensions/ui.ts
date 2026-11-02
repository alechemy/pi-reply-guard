import { createHash, randomUUID } from "node:crypto";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { DRAFT, RESULT, hasMarker, textOf } from "../lib/delivery.mjs";
import { NAME, SKILLS, VERDICT, type Config } from "./config.js";
type LegacyCheck = { status?: string; termination?: string; reply?: string; hidden?: string[] };

type AuditCheck = { id: string; disposition: string; outcome: string; experimental?: boolean; incomplete?: boolean; reason?: string; reasons?: string[]; calibration?: { state: string } };
type Audit = { status: string; incomplete: boolean; advisoryIncomplete?: boolean; error?: string; checks: AuditCheck[]; catalogIssues?: unknown[] };
type Candidate = { id: string; preserved?: boolean; audit?: Audit };
export type Delivery = {
	mode: Config["mode"]; releasePolicy: Config["releasePolicy"]; delivery: "released" | "withheld"; termination: string; showVerdicts?: boolean; reply?: string; draft?: string; draftId?: string;
	debug?: boolean; candidates?: Candidate[]; writerUsage?: unknown; rewrites?: number | null; selectedId?: string;
	audit?: Audit;
};
const digest = (text: string) => createHash("sha256").update(text.trim()).digest("hex");
const staleCalibrations = (data: Delivery) => data.audit?.checks.filter((check) => check.calibration?.state === "stale").length ?? 0;
const experimentalCount = (data: Delivery) => data.audit?.checks.filter((check) => check.experimental).length ?? 0;
const quiet = (data: Delivery, showVerdicts: boolean) => !showVerdicts && (data.rewrites ?? 0) === 0 && data.delivery === "released" && data.audit?.status === "passed" && !data.audit.incomplete && !data.audit.error && !staleCalibrations(data) && !data.audit.catalogIssues?.length;

function releaseText(data: Delivery): string {
	if (data.delivery !== "released") return data.delivery;
	const selected = data.selectedId ? data.candidates?.findIndex((candidate) => candidate.id === data.selectedId) : undefined;
	return selected === 0 ? "original released" : selected !== undefined && selected > 0 ? "rewritten reply released" : "released";
}

function rewriteDetails(data: Delivery): string | undefined {
	if (!data.rewrites) return;
	const last = data.candidates?.slice(1).at(-1);
	if (!last?.audit || last.id === data.selectedId) return;
	const checks = last.audit.checks;
	const reasons = new Set(checks.flatMap((check) => check.reasons ?? []));
	const details: string[] = [];
	if (checks.some((check) => check.id.startsWith("preserve-") && check.outcome === "violation")) details.push("meaning-preservation violation");
	if (reasons.has("Meaning-preservation confidence is inconclusive.")) details.push("preservation inconclusive");
	if (!details.length && last.preserved === false) details.push("preservation not confirmed");
	if (reasons.has("Classifier input budget reached.")) details.push("classifier input budget reached");
	if (reasons.has("Classifier request budget reached during planning.")) details.push("classifier request budget reached");
	if (reasons.has("Audit cancelled or deadline reached.")) details.push("audit cancelled or deadline reached");
	if (last.audit.incomplete && !details.length) details.push("audit incomplete");
	return details.length ? `Last audited rewrite: ${details.join(" · ")}` : undefined;
}

export function statusText(data: Delivery): string {
	const audit = data.audit;
	const advisory = audit?.checks.filter((check) => check.disposition === "advisory") ?? [];
	return [
		`${data.mode}: active checks ${audit?.status ?? "unchecked"}${audit?.incomplete && audit.status !== "incomplete" ? ", incomplete" : ""}`,
		...(data.rewrites === undefined ? [] : [data.rewrites === null ? "rewrite count unavailable" : `${data.rewrites} rewrite attempt${data.rewrites === 1 ? "" : "s"}`]),
		`${advisory.length} advisory (${advisory.filter((check) => check.outcome === "violation").length} flagged, ${advisory.filter((check) => check.calibration?.state === "uncalibrated").length} uncalibrated)`,
		...(experimentalCount(data) ? [`${experimentalCount(data)} experimental active (uncalibrated)`] : []),
		...(audit?.advisoryIncomplete ? ["advisory coverage incomplete"] : []),
		...(staleCalibrations(data) ? [`${staleCalibrations(data)} stale calibration`] : []),
		...(audit?.catalogIssues?.length ? ["catalog stale or incomplete"] : []),
		`${releaseText(data)} (${data.termination})`,
	].join(" · ");
}

export function registerUI(pi: ExtensionAPI) {
	let mode = "enforce";
	let showVerdicts = false;
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
		const showDetails = expanded || !quiet(data, showVerdicts);
		if (showDetails) {
			const color = data.delivery === "released" && data.audit?.status === "passed" && !data.audit.advisoryIncomplete && !experimentalCount(data) && !staleCalibrations(data) && !data.audit.catalogIssues?.length ? "muted" : "warning";
			const lines = [`[${NAME}] ${statusText(data)}`];
			const rewrites = rewriteDetails(data);
			if (rewrites) lines.push(rewrites);
			if (data.audit?.error) lines.push(data.audit.error);
			if (data.delivery === "withheld") lines.push("Inspect the stored draft with /reply-guard recover.");
			if (expanded) for (const check of data.audit?.checks ?? []) lines.push(`${check.id}: ${check.disposition}${check.experimental ? " (experimental)" : ""}, ${check.outcome}${check.incomplete ? ", incomplete" : ""}${check.reason ? `. ${check.reason}` : ""}${check.reasons?.length ? `. ${check.reasons.join(" ")}` : ""}`);
			if (expanded && data.debug) lines.push(JSON.stringify({ candidates: data.candidates, writerUsage: data.writerUsage }, null, 2));
			content.addChild(new Text(theme.fg(color, lines.join("\n")), 1, 0));
		}
		if (data.reply !== undefined) {
			if (showDetails) content.addChild(new Spacer(1));
			content.addChild(new Markdown(data.reply, 1, 0, getMarkdownTheme()));
		}
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
	function clearStatus(ctx: ExtensionContext) { ctx.ui.setStatus(NAME, undefined); }
	function restore(ctx: ExtensionContext) {
		legacyHidden.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === DRAFT) for (const marker of (entry.data as { markers: string[] }).markers) markers.add(marker);
			if (entry.customType === VERDICT) for (const hash of (entry.data as LegacyCheck)?.hidden ?? []) legacyHidden.add(hash);
		}
		clearStatus(ctx);
	}
	for (const event of ["session_start", "session_tree"] as const) pi.on(event, (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => clearStatus(ctx));
	return {
		restore, messages,
		configure: (config: Config) => { showVerdicts = config.showVerdicts; },
		status: (_data: Delivery, ctx: ExtensionContext) => clearStatus(ctx),
		mode: (next: string, ctx: ExtensionContext) => { mode = next; clearStatus(ctx); },
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
			ctx.ui.setStatus(NAME, "Reply guard: checking");
			return { message: { ...message, content }, draft };
		},
	};
}
