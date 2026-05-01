import { execSync } from "node:child_process";

const TMUX = findTmux();

function findTmux() {
  try {
    return execSync("command -v tmux 2>/dev/null || which tmux 2>/dev/null", {
      encoding: "utf8", timeout: 2000,
    }).trim();
  } catch {
    // fallback paths
    for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
      try {
        execSync(`test -x ${p}`);
        return p;
      } catch {}
    }
    return "tmux"; // last resort
  }
}

export function sessionExists(sessionName) {
  try {
    execSync(`${TMUX} has-session -t ${escapeSession(sessionName)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

export function sendKeys(sessionName, text) {
  if (!sessionName) return false;
  try {
    execSync(
      `${TMUX} send-keys -t ${escapeSession(sessionName)} ${escapeShell(text)} Enter`,
      { timeout: 3000 }
    );
    return true;
  } catch (e) {
    console.error(`[tmux] send-keys to ${sessionName} failed:`, e.message);
    return false;
  }
}

export function notifyAgent(sessionName, fromAgent, topic, preview) {
  // Single-line, capped at ~100 chars to avoid terminal wrapping.
  // Claude Code reads one line = one input, so multi-line breaks the flow.
  const head = `[51team] ${fromAgent}: ${topic || "general"}`;
  const suffix = " | check_messages 查看详情";
  const maxBody = 90 - head.length - suffix.length;
  const body = truncate(preview || "", Math.max(maxBody, 15));
  const line = `${head} — ${body}${suffix}`;
  return sendKeys(sessionName, line);
}

function escapeShell(text) {
  // Single-quote escaping: close quoting, escape single quote, reopen
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

function escapeSession(name) {
  return `'${String(name).replace(/'/g, "'\\''")}'`;
}

function truncate(str, len) {
  const s = String(str);
  return s.length > len ? s.slice(0, len - 3) + "..." : s;
}
