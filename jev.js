// TypeSafe Jev (System One) client — Node fetch only, zero npm deps.
// Docs: https://docs.typesafe.ai/

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
const DEFAULT_MODEL = "jev-latest";
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

export function isJevConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

export function getJevConfig() {
  return {
    apiKey: process.env.TYPESAFE_API_KEY?.trim() || "",
    baseUrl: (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ""),
    model: process.env.TYPESAFE_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(process.env.TYPESAFE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Call TypeSafe System One (Jev).
 * @param {{ state: string|object|array, questions: object, model?: string }} input
 * @returns {Promise<{ model: string, answers: object, usage?: object }>}
 */
export async function systemOne({ state, questions, model } = {}) {
  if (state === undefined || state === null || state === "") {
    throw new JevError("state is required");
  }
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new JevError("questions must be a non-empty object");
  }

  const cfg = getJevConfig();
  if (!cfg.apiKey) {
    throw new JevError(
      "TYPESAFE_API_KEY 未设置。到 https://console.typesafe.ai 创建 key，再 export TYPESAFE_API_KEY=..."
    );
  }

  const payload = {
    state,
    model: model || cfg.model,
    questions,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
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
    const detail = body?.error?.message || body?.message || text || res.statusText;
    throw new JevError(`Jev API ${res.status}: ${detail}`, { status: res.status, body });
  }

  return body;
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
  };
}

export { DEFAULT_ROUTE_THRESHOLD, DEFAULT_MODEL };
