import { digest } from "./catalog.mjs";

export const JEV_MODEL = "openrouter/typesafe/jev-1.14";
export const JEV_SERVED_MODEL = "typesafe/jev-1.14-20261014";
export const TRANSPORT_VERSION = "pi-system-one-2";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function usageOf(body, model) {
  const input = body?.usage?.input_tokens;
  const output = body?.usage?.output_tokens;
  if (![input, output].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const rates = [model.cost?.input, model.cost?.output];
  const priced = rates.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) && rates.some((value) => value > 0);
  return { input, output, totalTokens: input + output, cost: priced ? (input * model.cost.input + output * model.cost.output) / 1e6 : null };
}

export function createJevAdapter(registry, selection = JEV_MODEL, { fetch: requestFetch = globalThis.fetch } = {}) {
  const [provider, ...parts] = selection.split("/");
  const id = parts.join("/");
  const supported = selection === JEV_MODEL || selection === "typesafe/jev-1.14.0";
  const selected = supported ? registry.getModelOfType("classifier", provider, id) : undefined;
  const model = selected ? structuredClone(selected) : undefined;
  const available = !!model && model.provider === provider && model.id === id && model.api === "typesafe-system-one";
  const servedModel = selection === JEV_MODEL ? JEV_SERVED_MODEL : id;
  const identity = { provider, model: servedModel, api: model?.api ?? null, endpointDigest: model?.baseUrl ? digest(model.baseUrl) : null, adapter: TRANSPORT_VERSION };
  return {
    identity,
    available,
    async classify(context, { signal, timeoutMs, maxRequestBytes, onAttempt }) {
      let body;
      let attempts = 0;
      const unavailable = (reason) => ({ answers: {}, reason, attempts, usage: usageOf(body, model ?? {}), servedModel: null });
      if (!available) return unavailable("Pinned classifier is unavailable in the Pi registry.");
      try {
        const result = await registry.classify(model, context, {
          signal, timeoutMs, maxRetries: 0,
          fetch: async (url, init) => {
            if (signal.aborted || attempts > 0) throw new Error("Classifier transport stopped.");
            const payload = JSON.parse(init.body);
            const expectedQuestions = Object.fromEntries(Object.entries(context.questions).map(([key, question]) => [key, { ...question, type: "noul" }]));
            if (String(url) !== new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`).href || init.method !== "POST" || Object.keys(payload).sort().join(",") !== "model,questions,state" || payload.model !== id || JSON.stringify(payload.state) !== JSON.stringify(context.state) || JSON.stringify(payload.questions) !== JSON.stringify(expectedQuestions) || Buffer.byteLength(init.body, "utf8") > maxRequestBytes) throw new Error("Classifier request changed after planning.");
            attempts++;
            onAttempt?.();
            const response = await requestFetch(url, { ...init, redirect: "error" });
            return new Proxy(response, { get(target, key) {
              if (key === "json") return async () => {
                const value = await target.json();
                if (target.ok && !signal.aborted) body = value;
                return value;
              };
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            } });
          },
        });
        if (signal.aborted || result.stopReason === "aborted") return unavailable("Audit cancelled or deadline reached.");
        if (result.provider !== provider || result.model !== id || !record(body) || body.model !== servedModel) return unavailable("Classifier response lacks the expected served model identity.");
        if (!record(body.answers)) return unavailable("Classifier response has no answer map.");
        const answers = {};
        for (const key of Object.keys(context.questions)) {
          const answer = body.answers[key];
          answers[key] = record(answer) && answer.type === "noul" && probability(answer.noul)
            ? { type: "bool", probability: answer.noul }
            : { error: "Missing or malformed classifier answer." };
        }
        const malformed = Object.values(answers).some((answer) => answer.error);
        if (result.stopReason !== "stop" && !(result.stopReason === "error" && malformed)) return unavailable("Classifier did not complete successfully.");
        return { answers, attempts, usage: usageOf(body, model), servedModel: body.model,
          protocolIssue: Object.keys(body.answers).some((key) => !Object.hasOwn(context.questions, key)) ? "Unexpected classifier answer IDs." : undefined };
      } catch {
        return unavailable(signal.aborted ? "Audit cancelled or deadline reached." : "Classifier transport failed.");
      }
    },
  };
}
