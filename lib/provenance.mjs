import { digest } from "./catalog.mjs";

const directive = /^\s*(?:please\s+)?(?:reproduce|copy|repeat|return|quote)(?:\s+(?:this|the following)\s+(?:text|sentence|passage|quote|policy|line))?\s+(?:exactly|verbatim|unchanged):[ \t]*(?:\r?\n)?/iu;
const possibleDirective = /\b(?:reproduce|copy|repeat|return|quote|preserve)\b[^\n:]{0,120}\b(?:exactly|verbatim|unchanged|without changes)\b/iu;

export function resolveProvenance(request = "", supplied = []) {
  if (typeof request !== "string") throw new Error("Provenance requires the consumed request text.");
  if (!Array.isArray(supplied)) throw new Error("Verbatim protection must be an array of sourced text records.");
  const match = directive.exec(request);
  const text = match ? request.slice(match[0].length) : "";
  const source = text ? { sourceId: `user-request:${digest(request)}:${match[0].length}`, text } : undefined;
  return {
    verbatim: [...supplied, ...(source ? [source] : [])],
    requestSource: source,
    unresolved: !source && !supplied.length && possibleDirective.test(request),
  };
}
