// Unit tests for Jev client helpers + mock systemOne routing.
// Run: node test-jev.js

import { strict as assert } from "node:assert";
import {
  buildRouteQuestions,
  pickRouteTargets,
  isJevConfigured,
  getJevProvider,
  JevError,
  systemOne,
  routeMessage,
  DEFAULT_ROUTE_THRESHOLD,
} from "./jev.js";

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  ✅ ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  ❌ ${name}: ${err?.message || err}`);
}

function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    fail(name, e);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e);
  }
}

function clearKeys() {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
}

console.log("\n══ test-jev ══\n");

test("buildRouteQuestions creates noul per agent", () => {
  const q = buildRouteQuestions([
    { name: "designer", role: "UI / visual design" },
    { name: "engineer" },
  ]);
  assert.equal(q.designer.type, "noul");
  assert.match(q.designer.instructions, /designer/);
  assert.match(q.designer.instructions, /UI/);
  assert.equal(q.engineer.type, "noul");
  assert.ok(q.designer.criteria.true);
  assert.ok(q.designer.criteria.false);
});

test("pickRouteTargets selects above threshold", () => {
  const answers = {
    designer: { type: "noul", noul: 0.9 },
    engineer: { type: "noul", noul: 0.2 },
    seo: { type: "noul", noul: 0.5 },
  };
  const { selected, scored } = pickRouteTargets(answers, ["designer", "engineer", "seo"], 0.45);
  assert.deepEqual(selected, ["designer", "seo"]);
  assert.equal(scored[0].name, "designer");
});

test("pickRouteTargets falls back to top-1 when none clear bar", () => {
  const answers = {
    a: { type: "noul", noul: 0.1 },
    b: { type: "noul", noul: 0.3 },
  };
  const { selected } = pickRouteTargets(answers, ["a", "b"], 0.8);
  assert.deepEqual(selected, ["b"]);
});

test("DEFAULT_ROUTE_THRESHOLD is sane", () => {
  assert.ok(DEFAULT_ROUTE_THRESHOLD > 0 && DEFAULT_ROUTE_THRESHOLD < 1);
});

await testAsync("systemOne without key throws JevError", async () => {
  const prevT = process.env.TYPESAFE_API_KEY;
  const prevO = process.env.OPENROUTER_API_KEY;
  clearKeys();
  try {
    await systemOne({
      state: "hello",
      questions: { x: { type: "noul", instructions: "yes?" } },
    });
    throw new Error("expected throw");
  } catch (e) {
    assert.ok(e instanceof JevError);
    assert.match(e.message, /OPENROUTER_API_KEY|TYPESAFE_API_KEY/);
  } finally {
    if (prevT !== undefined) process.env.TYPESAFE_API_KEY = prevT;
    if (prevO !== undefined) process.env.OPENROUTER_API_KEY = prevO;
  }
});

await testAsync("systemOne validates empty questions", async () => {
  clearKeys();
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  try {
    await systemOne({ state: "x", questions: {} });
    throw new Error("expected throw");
  } catch (e) {
    assert.ok(e instanceof JevError);
    assert.match(e.message, /questions/);
  }
});

await testAsync("routeMessage with mock fetch (typesafe)", async () => {
  clearKeys();
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /systemone/);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: "jev-latest",
        answers: {
          designer: { type: "noul", noul: 0.88 },
          engineer: { type: "noul", noul: 0.12 },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    };
  };
  try {
    const r = await routeMessage({
      content: "请重新设计首页 hero 配色",
      from: "pm",
      agents: [
        { name: "designer", role: "visual design" },
        { name: "engineer", role: "implementation" },
      ],
    });
    assert.deepEqual(r.selected, ["designer"]);
    assert.equal(r.model, "jev-latest");
    assert.equal(r.provider, "typesafe");
    assert.equal(r.scored[0].name, "designer");
  } finally {
    globalThis.fetch = origFetch;
  }
});

await testAsync("systemOne via OpenRouter Decisions API", async () => {
  clearKeys();
  process.env.OPENROUTER_API_KEY = "or-test-key";
  const origFetch = globalThis.fetch;
  let seenUrl = "";
  let seenHeaders = {};
  globalThis.fetch = async (url, opts) => {
    seenUrl = String(url);
    seenHeaders = opts.headers;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: "~typesafe/jev-latest",
        answers: {
          urgent: { type: "noul", noul: 0.95 },
        },
        usage: { prompt_tokens: 20, completion_tokens: 0 },
      }),
    };
  };
  try {
    assert.equal(getJevProvider(), "openrouter");
    const r = await systemOne({
      state: "ASAP please fix login",
      questions: { urgent: { type: "noul", instructions: "urgent?" } },
    });
    assert.match(seenUrl, /openrouter\.ai\/api\/alpha\/decisions/);
    assert.match(seenHeaders.Authorization, /Bearer or-test-key/);
    assert.equal(r.provider, "openrouter");
    assert.equal(r.answers.urgent.noul, 0.95);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await testAsync("systemOne surfaces HTTP errors", async () => {
  clearKeys();
  process.env.TYPESAFE_API_KEY = "bad";
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    text: async () => JSON.stringify({ message: "invalid key" }),
  });
  try {
    await systemOne({
      state: "x",
      questions: { a: { type: "noul", instructions: "?" } },
    });
    throw new Error("expected throw");
  } catch (e) {
    assert.ok(e instanceof JevError);
    assert.equal(e.status, 401);
    assert.match(e.message, /401/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("isJevConfigured / getJevProvider reflect env", () => {
  const prevT = process.env.TYPESAFE_API_KEY;
  const prevO = process.env.OPENROUTER_API_KEY;
  clearKeys();
  assert.equal(isJevConfigured(), false);
  assert.equal(getJevProvider(), null);

  process.env.OPENROUTER_API_KEY = " or-key ";
  assert.equal(isJevConfigured(), true);
  assert.equal(getJevProvider(), "openrouter");

  process.env.TYPESAFE_API_KEY = "ts-key";
  assert.equal(getJevProvider(), "typesafe"); // typesafe wins when both set

  clearKeys();
  if (prevT !== undefined) process.env.TYPESAFE_API_KEY = prevT;
  if (prevO !== undefined) process.env.OPENROUTER_API_KEY = prevO;
});

console.log(`\n── ${passed} passed, ${failed} failed ──\n`);
process.exit(failed > 0 ? 1 : 0);
