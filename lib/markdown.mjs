import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { decodeString } from "micromark-util-decode-string";
import { digest, PREPROCESSING_VERSION } from "./catalog.mjs";
import { resolveProvenance } from "./provenance.mjs";

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const offsets = (node) => ({ start: node.position.start.offset, end: node.position.end.offset });
const atom = /&(?:#[0-9]{1,7}|#x[a-f0-9]{1,6}|[a-z][a-z0-9]{1,31});|\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|\r\n|[\s\S]/giu;
const literalPatterns = [
  ["url", /\b(?:https?:\/\/|mailto:)[^\s<>"'`“”‘’]+/gu],
  ["path", /(?:^|(?<=[\s(]))(?:~\/|\.{1,2}\/|\/[\w.]|[\w.-]+\/)[^\s<>"'`“”‘’]+/gu],
  ["path", /\b[A-Za-z]:\\[^\s<>"'`“”‘’]+/gu],
  ["identifier", /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b|\b\w+_\w+\b|\b\w+\(\)|\b\w+(?:\.\w+)+\b|(?<!\w)--[A-Za-z][\w-]*|\$\{?[A-Za-z_]\w*\}?/gu],
  ["citation", /\[\d+(?:[,–-]\s*\d+)*\]|【[^】\n]+】|\uE200cite\uE202[^\uE201]+\uE201/gu],
  ["command", /^\$ [^\n]+/gm],
];

function decoded(raw, start) {
  let text = "";
  const map = [];
  for (const match of raw.matchAll(atom)) {
    const value = match[0] === "\r\n" ? "\n" : decodeString(match[0]);
    text += value;
    for (let index = 0; index < value.length; index++) map.push({ start: start + match.index, end: start + match.index + match[0].length });
  }
  return { text, map };
}

function contained(range, span) {
  return range.start >= span.start && range.end <= span.end;
}

export function createView(text, { verbatim = [], request = "", baseline } = {}) {
  if (typeof text !== "string") throw new Error("A Markdown view needs a text string.");
  const provenance = resolveProvenance(request, verbatim);
  verbatim = provenance.verbatim;
  const unresolvedSource = provenance.unresolved || Boolean(provenance.requestSource && !text.includes(provenance.requestSource.text));
  if (baseline && baseline.version !== PREPROCESSING_VERSION) throw new Error("Baseline preprocessing version is stale.");
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const protectedSpans = [];
  const uncertainSpans = unresolvedSource ? [{ start: 0, end: text.length, reason: "request-source-unresolved" }] : [];
  const wrappers = [];
  const passages = [];
  const segments = [];
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") lineStarts.push(index + 1);
  function protect(range, kind, sourceId) {
    if (range.end > range.start) protectedSpans.push({ ...range, kind, raw: text.slice(range.start, range.end), ...(sourceId ? { sourceId } : {}) });
  }
  for (const source of verbatim) {
    if (!source || typeof source.text !== "string" || !source.text || typeof source.sourceId !== "string" || !source.sourceId) throw new Error("Verbatim protection needs nonempty text and an external source ID.");
    let start = 0;
    while ((start = text.indexOf(source.text, start)) !== -1) {
      protect({ start, end: start + source.text.length }, "verbatim", source.sourceId);
      start += source.text.length;
    }
  }
  const confirmed = (range) => protectedSpans.some((span) => span.kind === "verbatim" && contained(range, span));
  function segment(node, passage, kind = "text", forceUncertain = false) {
    const range = offsets(node);
    const raw = text.slice(range.start, range.end);
    const content = node.value ?? raw;
    const afterMarker = kind === "code" && /^ {0,3}(?:`{3,}|~{3,})/.test(raw) ? raw.indexOf("\n") + 1 : kind === "inlineCode" ? raw.match(/^`+/)?.[0].length ?? 0 : 0;
    const contentStart = raw.indexOf(content, afterMarker);
    let value = ["text", "html"].includes(kind) ? decoded(raw, range.start) : { text: content, map: Array.from({ length: content.length }, (_, index) => contentStart < 0 ? range : { start: range.start + contentStart + index, end: range.start + contentStart + index + 1 }) };
    const sourceMismatch = kind === "text" && value.text !== node.value;
    if (sourceMismatch) value = { text: node.value, map: Array.from({ length: node.value.length }, () => range) };
    const result = { id: `t${segments.length + 1}`, passageId: passage.id, kind, ...range, ...value };
    segments.push(result);
    passage.segments.push(result);
    if ((forceUncertain || sourceMismatch) && !confirmed(range)) uncertainSpans.push({ ...range, reason: sourceMismatch ? "source-map-unresolved" : `${kind}-intent-unresolved` });
    if (kind === "text" && !sourceMismatch) {
      for (const [literalKind, pattern] of literalPatterns) {
        for (const match of value.text.matchAll(pattern)) {
          const literal = ["url", "path"].includes(literalKind) ? match[0].replace(/[.,;!?]+$/, "") : match[0];
          if (!literal.length) continue;
          const start = value.map[match.index].start;
          const end = value.map[match.index + literal.length - 1].end;
          protect({ start, end }, literalKind);
        }
      }
    }
  }
  function visit(node, parentPassage, quoted = false, listed = false) {
    const range = offsets(node);
    let passage = parentPassage;
    if (["paragraph", "heading", "tableCell", "code", "html"].includes(node.type) && (!parentPassage || ["paragraph", "heading", "tableCell"].includes(node.type))) {
      passage = { id: `p${passages.length + 1}`, kind: node.type, ...range, quoted, listed, segments: [] };
      passages.push(passage);
    }
    if (node.type === "blockquote") {
      wrappers.push({ ...range, kind: "blockquote", raw: text.slice(range.start, range.end) });
      quoted = true;
    }
    if (node.type === "listItem") listed = true;
    if (["code", "inlineCode", "html"].includes(node.type)) {
      const kind = node.type;
      const wrapper = { ...range, kind, raw: text.slice(range.start, range.end) };
      wrappers.push(wrapper);
      protect(range, kind);
      segment(node, passage, kind, true);
      return;
    }
    if (node.type === "text") {
      segment(node, passage, "text", quoted);
      return;
    }
    if (["definition", "footnoteReference"].includes(node.type)) {
      protect(range, node.type === "definition" ? "reference-definition" : "citation");
      return;
    }
    if (node.type === "footnoteDefinition" && node.children?.length) protect({ start: range.start, end: node.children[0].position.start.offset }, "citation-definition");
    if (["link", "linkReference"].includes(node.type) && node.children?.length) {
      protect({ start: node.children.at(-1).position.end.offset, end: range.end }, "link-destination");
    }
    if (["image", "imageReference"].includes(node.type)) {
      const raw = text.slice(range.start, range.end);
      let endLabel = -1;
      let depth = 1;
      for (let index = 2; index < raw.length; index++) {
        if (raw[index] === "\\") { index++; continue; }
        if (raw[index] === "[") depth++;
        if (raw[index] === "]" && --depth === 0) { endLabel = index; break; }
      }
      if (endLabel < 0 || !passage) {
        uncertainSpans.push({ ...range, reason: "image-label-unresolved" });
        protect(range, "image");
      } else {
        const start = range.start + 2;
        const end = range.start + endLabel;
        segment({ value: node.alt, position: { start: { offset: start }, end: { offset: end } } }, passage);
        protect({ start: end, end: range.end }, "link-destination");
      }
      return;
    }
    if (node.type === "break" && passage) {
      const entry = { id: `t${segments.length + 1}`, passageId: passage.id, kind: "break", ...range, text: "\n", map: [range] };
      segments.push(entry);
      passage.segments.push(entry);
    }
    for (const child of node.children ?? []) visit(child, passage, quoted, listed);
  }
  visit(tree);
  const verbatimSpans = protectedSpans.filter((span) => span.kind === "verbatim");
  let furthest = -1;
  const protections = protectedSpans.sort((a, b) => a.start - b.start || b.end - a.end || Number(b.kind === "verbatim") - Number(a.kind === "verbatim"))
    .filter((span) => {
      if (span.end <= furthest) return false;
      furthest = span.end;
      return true;
    });
  for (const [index, span] of protections.entries()) span.id = `protected${index + 1}`;
  for (const passage of passages) {
    passage.text = passage.segments.map((segment) => segment.text).join("");
    passage.markdown = text.slice(passage.start, passage.end);
    const sentenceRanges = [...sentenceSegmenter.segment(passage.text)];
    passage.sentences = sentenceRanges.map((sentence, index) => ({ id: `${passage.id}.s${index + 1}`, text: sentence.segment, startInPassage: sentence.index, endInPassage: sentence.index + sentence.segment.length }));
  }
  const wrapperChanges = baseline ? wrappers.filter((wrapper) => !baseline.wrappers.some((previous) => previous.kind === wrapper.kind && previous.raw === wrapper.raw)) : [];
  return { version: PREPROCESSING_VERSION, hash: digest(text), text, unresolvedSource, lineStarts, passages, segments, protections, verbatimSpans, uncertainSpans, wrappers, wrapperChanges };
}

export function location(view, start, end) {
  let low = 0;
  let high = view.lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (view.lineStarts[middle] <= start) low = middle;
    else high = middle;
  }
  return { start, end, line: low + 1, column: start - view.lineStarts[low] + 1, quote: view.text.slice(start, end) };
}

export function eligibility(view, range) {
  if (view.verbatimSpans.some((span) => contained(range, span))) return "protected";
  if (view.wrapperChanges.some((span) => contained(range, span))) return "eligible";
  if (view.uncertainSpans.some((span) => contained(range, span))) return "uncertain";
  if (view.protections.some((span) => contained(range, span))) return "protected";
  return "eligible";
}

export function compareProtected(original, revision) {
  if (original.version !== revision.version || original.version !== PREPROCESSING_VERSION) return { outcome: "unavailable", reason: "Protection maps use different or stale preprocessing versions.", semanticPreservation: "not-evaluated" };
  const reference = original.protections.map(({ kind, raw }) => ({ kind, raw }));
  const actual = revision.protections.map(({ kind, raw }) => ({ kind, raw }));
  const changed = JSON.stringify(reference) !== JSON.stringify(actual);
  const wrapperChanges = revision.wrappers.filter((wrapper) => !original.wrappers.some((previous) => previous.kind === wrapper.kind && previous.raw === wrapper.raw));
  return { outcome: changed || wrapperChanges.length ? "violation" : "clear", changed, wrapperChanges: wrapperChanges.map(({ start, end, kind }) => ({ start, end, kind })), semanticPreservation: "not-evaluated" };
}
