// In-memory store with periodic JSON persistence and message pruning.
// Single source of truth for the central router.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_MESSAGES = 10_000;
const MAX_PERSISTED_CONTENT = 65_536; // 64KB max per message on disk
const AGENT_TTL_MS = 5 * 60 * 1000; // 5 min heartbeat timeout
const SAVE_INTERVAL_MS = 5_000;

// Persistence path: ~/.claude/51team/state.json
const STATE_DIR = join(homedir(), ".claude", "51team");
const STATE_FILE = join(STATE_DIR, "state.json");

const agents = new Map();   // name → { name, tmuxSession, registeredAt, lastHeartbeat }
const messages = [];
let dirty = false;

// ── Persistence ──

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const raw = readFileSync(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data.agents) {
      for (const [k, v] of Object.entries(data.agents)) {
        agents.set(k, v);
      }
    }
    if (data.messages) {
      messages.push(...data.messages);
      pruneMessages();
    }
    console.error(`[store] Loaded ${agents.size} agents, ${messages.length} messages from disk`);
  } catch (e) {
    console.error(`[store] Load state failed: ${e.message}`);
  }
}

function saveState() {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    const persistedMsgs = messages.slice(-MAX_MESSAGES).map((m) => ({
      ...m,
      content: m.content.length > MAX_PERSISTED_CONTENT
        ? m.content.slice(0, MAX_PERSISTED_CONTENT) + `\n... [truncated ${m.content.length - MAX_PERSISTED_CONTENT} bytes]`
        : m.content,
    }));
    const data = {
      agents: Object.fromEntries(agents),
      messages: persistedMsgs,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf8");
    dirty = false;
  } catch (e) {
    console.error(`[store] Save state failed: ${e.message}`);
  }
}

function markDirty() {
  dirty = true;
}

// Periodic save
const saveTimer = setInterval(() => {
  if (dirty) saveState();
}, SAVE_INTERVAL_MS);

// ── Message pruning ──

function pruneMessages() {
  if (messages.length > MAX_MESSAGES) {
    const removed = messages.length - MAX_MESSAGES;
    messages.splice(0, removed);
    console.error(`[store] Pruned ${removed} old messages (limit: ${MAX_MESSAGES})`);
  }
}

// ── Agent heartbeat ──

function pruneDeadAgents() {
  const now = Date.now();
  let pruned = 0;
  for (const [name, info] of agents) {
    const lastSeen = new Date(info.lastHeartbeat || info.registeredAt).getTime();
    if (now - lastSeen > AGENT_TTL_MS) {
      agents.delete(name);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.error(`[store] Pruned ${pruned} dead agents (TTL ${AGENT_TTL_MS / 1000}s)`);
    markDirty();
  }
}

const pruneTimer = setInterval(pruneDeadAgents, 30_000);

// ── Public API ──

export function getAgents() {
  const result = {};
  for (const [name, info] of agents) {
    result[name] = info;
  }
  return result;
}

export function registerAgent(name, tmuxSession) {
  const prev = agents.get(name);
  const info = {
    name,
    tmuxSession,
    registeredAt: prev?.registeredAt || new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  };
  agents.set(name, info);
  markDirty();
  return info;
}

export function unregisterAgent(name) {
  const existed = agents.delete(name);
  if (existed) markDirty();
  return existed;
}

export function heartbeat(agentName) {
  const info = agents.get(agentName);
  if (info) {
    info.lastHeartbeat = new Date().toISOString();
    markDirty();
    return true;
  }
  return false;
}

export function getMessages() {
  return messages;
}

export function sendMessage(from, to, content, topic) {
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    from,
    to,
    content,
    topic: topic || "general",
    read: false,
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);
  pruneMessages();
  markDirty();
  return msg;
}

export function getUnread(agentName) {
  return messages.filter((m) => m.to === agentName && !m.read);
}

export function markAllRead(agentName) {
  let count = 0;
  for (const m of messages) {
    if (m.to === agentName && !m.read) {
      m.read = true;
      count++;
    }
  }
  if (count > 0) markDirty();
  return count;
}

export function clearAll() {
  agents.clear();
  messages.length = 0;
  markDirty();
  saveState();
  return true;
}

export function getStats() {
  const now = Date.now();
  let onlineCount = 0;
  for (const info of agents.values()) {
    const lastSeen = new Date(info.lastHeartbeat || info.registeredAt).getTime();
    if (now - lastSeen < AGENT_TTL_MS) onlineCount++;
  }
  const topics = new Set(messages.map((m) => m.topic || "general"));
  return {
    totalAgents: agents.size,
    onlineAgents: onlineCount,
    totalMessages: messages.length,
    uniqueTopics: topics.size,
  };
}

// ── Init ──

loadState();
