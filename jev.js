// TypeSafe Jev (System One) client — Node fetch only, zero npm deps.
// Providers:
//   1) TYPESAFE_API_KEY  → https://api.typesafe.ai/v1/systemone
//   2) OPENROUTER_API_KEY → https://openrouter.ai/api/alpha/decisions
// Docs: https://docs.typesafe.ai/ · https://openrouter.ai/~typesafe/jev-latest

const TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";
const TYPESAFE_MODEL = "jev-latest";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const OPENROUTER_MODEL = "~typesafe/jev-latest";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ROUTE_THRESHOLD = 0.45;

export class JevError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.body = body;
  }
}

export function getJevProvider() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return "typesafe";
  if (process.env.OPENROUTER_API_KEY?.trim()) return "openrouter";
  return null;
}

export function isJevConfigured() {
  return getJevProvider() !== null;
}

export function getJevConfig() {
  const provider = getJevProvider();
  const timeoutMs = Number(process.env.TYPESAFE_TIMEOUT_MS || process.env.JEV_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (provider === "typesafe") {
    return {
      provider,
      apiKey: process.env.TYPESAFE_API_KEY.trim(),
      url: `${(process.env.TYPESAFE_BASE_URL || TYPESAFE_BASE_URL).replace(/\/$/, "")}/systemone`,
      model: process.env.TYPESAFE_MODEL || TYPESAFE_MODEL,
      timeoutMs,
    };
  }
  if (provider === "openrouter") {
    return {
      provider,
      apiKey: process.env.OPENROUTER_API_KEY.trim(),
      url: process.env.OPENROUTER_DECISIONS_URL || OPENROUTER_DECISIONS_URL,
      model: process.env.OPENROUTER_JEV_MODEL || OPENROUTER_MODEL,
      timeoutMs,
      referer: process.env.OPENROUTER_HTTP_REFERER || "https://github.com/jackleeson-beep/51team",
      title: process.env.OPENROUTER_TITLE || "51team",
    };
  }
  return { provider: null, apiKey: "", url: "", model: TYPESAFE_MODEL, timeoutMs };
}

function missingKeyError() {
  return new JevError(
    "未配置 Jev。任选其一：\n" +
      "  export OPENROUTER_API_KEY=...   # OpenRouter（推荐，免排队）https://openrouter.ai/keys\n" +
      "  export TYPESAFE_API_KEY=...     # TypeSafe 原生 https://console.typesafe.ai"
  );
}

/**
 * Call Jev via TypeSafe System One or OpenRouter Decisions API.
 * @param {{ state: string|object|array, questions: object, model?: string }} input
 * @returns {Promise<{ model: string, answers: object, usage?: object, provider?: string }>}
 */
export async function systemOne({ state, questions, model } = {}) {
  if (state === undefined || state === null || state === "") {
    throw new JevError("state is required");
  }
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new JevError("questions must be a non-empty object");
  }

  const cfg = getJevConfig();
  if (!cfg.provider) throw missingKeyError();

  const payload = {
    state,
    model: model || cfg.model,
    questions,
  };

  const headers = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };
  if (cfg.provider === "openrouter") {
    if (cfg.referer) headers["HTTP-Referer"] = cfg.referer;
    if (cfg.title) headers["X-OpenRouter-Title"] = cfg.title;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let res;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new JevError(`Jev request timed out after ${cfg.timeoutMs}ms`);
    }
    throw new JevError(`Jev request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  let body;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const detail =
      body?.error?.message ||
      body?.message ||
      (typeof body?.error === "string" ? body.error : null) ||
      text ||
      res.statusText;
    throw new JevError(`Jev API ${res.status} (${cfg.provider}): ${detail}`, { status: res.status, body });
  }

  // Normalize: OpenRouter Decisions may wrap answers; prefer top-level answers.
  const answers = body.answers || body.data?.answers || body;
  const usage = body.usage || body.data?.usage;
  const usedModel = body.model || body.data?.model || payload.model;

  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new JevError(`Jev response missing answers (${cfg.provider})`, { status: res.status, body });
  }

  // If body itself was mistaken for answers (no .answers field), ensure shape looks like answer map
  const sample = Object.values(answers)[0];
  if (sample && typeof sample === "object" && !("type" in sample) && !("noul" in sample) && !("choice" in sample) && !("score" in sample)) {
    // Might have returned full body without answers — fail clearly
    if (!body.answers) {
      throw new JevError(`Unexpected Jev response shape (${cfg.provider})`, { status: res.status, body });
    }
  }

  return {
    model: usedModel,
    answers: body.answers || answers,
    usage,
    provider: cfg.provider,
  };
}

/**
 * Build per-agent Noul questions for fan-out routing.
 * @param {Array<{ name: string, role?: string }>} agents
 */
export function buildRouteQuestions(agents) {
  const questions = {};
  for (const agent of agents) {
    const roleHint = agent.role?.trim()
      ? ` Role: ${agent.role.trim()}.`
      : "";
    questions[agent.name] = {
      type: "noul",
      instructions: `Should agent "${agent.name}" receive and act on this message?${roleHint}`,
      criteria: {
        true: "This message is clearly in their domain or they need to coordinate on it",
        false: "Unrelated to their role; waking them would be noise",
      },
    };
  }
  return questions;
}

/**
 * Pick agents whose noul >= threshold. Falls back to top-1 if none clear the bar.
 * @param {object} answers - systemOne answers map
 * @param {string[]} agentNames
 * @param {number} [threshold]
 */
export function pickRouteTargets(answers, agentNames, threshold = DEFAULT_ROUTE_THRESHOLD) {
  const scored = agentNames.map((name) => {
    const ans = answers?.[name];
    const noul = typeof ans?.noul === "number" ? ans.noul : 0;
    return { name, noul };
  });
  scored.sort((a, b) => b.noul - a.noul);

  let selected = scored.filter((s) => s.noul >= threshold).map((s) => s.name);
  if (selected.length === 0 && scored.length > 0) {
    selected = [scored[0].name];
  }
  return { selected, scored };
}

/**
 * Route a message to registered agents via Jev.
 * @param {{ content: string, topic?: string, from?: string, agents: Array<{name:string,role?:string}>, threshold?: number }} opts
 */
export async function routeMessage({ content, topic, from, agents, threshold } = {}) {
  if (!content?.trim()) throw new JevError("content is required");
  if (!agents?.length) throw new JevError("no agents to route to");

  const state = {
    from: from || null,
    topic: topic || "general",
    message: content,
    available_agents: agents.map((a) => ({
      name: a.name,
      role: a.role || null,
    })),
  };

  const questions = buildRouteQuestions(agents);
  const result = await systemOne({ state, questions });
  const thr = typeof threshold === "number" ? threshold : DEFAULT_ROUTE_THRESHOLD;
  const { selected, scored } = pickRouteTargets(result.answers, agents.map((a) => a.name), thr);

  return {
    selected,
    scored,
    threshold: thr,
    model: result.model,
    answers: result.answers,
    usage: result.usage,
    provider: result.provider,
  };
}

export { DEFAULT_ROUTE_THRESHOLD, TYPESAFE_MODEL as DEFAULT_MODEL, OPENROUTER_MODEL };
