import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { nextAutoBuyEnabled } from "../lib/keeper-enabled";
import {
  KEEPER_SESSION_PREFIX,
  clearStatusAuthCache,
  keeperGetPrefs,
  keeperPublicStatus,
  keeperStatus,
} from "../lib/keeper-client";
import { resetRuntimeConfigForTests } from "../lib/runtime-config";

const OWNER = "ownerA";
const OTHER = "ownerB";
const SECRET = "ZZSECRETVALUEZZ";

const localStore = new Map<string, string>();
const sessionStore = new Map<string, string>();

function makeStorage(store: Map<string, string>) {
  return {
    get length() {
      return store.size;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

function installStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: makeStorage(localStore),
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: makeStorage(sessionStore),
  });
  if (typeof globalThis.window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
}

function sessionKey(owner: string): string {
  return `${KEEPER_SESSION_PREFIX}${owner}`;
}

function writeSession(owner: string, token: string): void {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sessionStorage.setItem(
    sessionKey(owner),
    JSON.stringify({ token, expiresAt, owner }),
  );
}

type Captured = { url: string; method: string; headers: string };

function headerText(headers: HeadersInit | undefined): string {
  if (!headers) return "";
  if (headers instanceof Headers) {
    return [...headers.entries()].map(([name, value]) => `${name}:${value}`).join("\n");
  }
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => `${name}:${value}`).join("\n");
  }
  return Object.entries(headers)
    .map(([name, value]) => `${name}:${String(value)}`)
    .join("\n");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withFetch(
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  run: (calls: Captured[]) => Promise<void>,
): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousKeeper = process.env.NEXT_PUBLIC_KEEPER_URL;
  const previousApi = process.env.NEXT_PUBLIC_DCA_API_URL;
  delete process.env.NEXT_PUBLIC_KEEPER_URL;
  delete process.env.NEXT_PUBLIC_DCA_API_URL;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: headerText(init?.headers),
    });
    if (url.includes("config.json")) {
      return jsonResponse(200, { dcaApiUrl: "", keeperUrl: "" });
    }
    return respond(url, init);
  }) as typeof fetch;
  resetRuntimeConfigForTests();
  try {
    await run(calls);
  } finally {
    resetRuntimeConfigForTests();
    globalThis.fetch = previousFetch;
    if (previousKeeper === undefined) delete process.env.NEXT_PUBLIC_KEEPER_URL;
    else process.env.NEXT_PUBLIC_KEEPER_URL = previousKeeper;
    if (previousApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
    else process.env.NEXT_PUBLIC_DCA_API_URL = previousApi;
  }
}

function publicGets(calls: Captured[]): Captured[] {
  return calls.filter(
    (call) => call.method === "GET" && call.url.includes("/public/status?"),
  );
}

function authHeaders(call: Captured): boolean {
  const text = call.headers.toLowerCase();
  return text.includes("authorization") || text.includes("bearer") || text.includes(SECRET.toLowerCase());
}

describe("public keeper status", { concurrency: false }, () => {
  beforeEach(() => {
    localStore.clear();
    sessionStore.clear();
    installStorage();
  });

  afterEach(() => {
    clearStatusAuthCache();
  });

  test("a connected wallet reads public status once and does not sign", async () => {
    for (const enabled of [true, false]) {
      await withFetch(
        (url) => {
          assert.match(url, /\/public\/status\?owner=ownerA$/);
          return jsonResponse(200, {
            ok: true,
            enabled,
            owner: OWNER,
            phase: enabled ? "idle" : "off",
            hasJevKey: true,
            prefs: {
              exclusions: ["OpenAI"],
              deadlines_unimportant: false,
              premiums_matter: true,
              buy_despite_ipo: false,
            },
          });
        },
        async (calls) => {
          const status = await keeperPublicStatus(OWNER);
          assert.equal(publicGets(calls).length, 1);
          assert.equal(calls.some((call) => call.method === "POST"), false);
          assert.equal(authHeaders(publicGets(calls)[0]), false);
          assert.equal(status.ok, true);
          assert.equal(status.enabled, enabled);
          assert.equal(status.hasJevKey, true);
          assert.deepEqual(status.prefs?.exclusions, ["OpenAI"]);
          assert.equal(nextAutoBuyEnabled(null, status, OWNER), enabled);
          const prefs = await keeperGetPrefs(OWNER);
          assert.equal(prefs.ok, true);
          assert.deepEqual(prefs.prefs?.exclusions, ["OpenAI"]);
          assert.equal(prefs.hasJevKey, true);
          assert.equal(publicGets(calls).length, 2);
        },
      );
    }
  });

  test("a public payload drops secrets and keeps hasJevKey", async () => {
    await withFetch(
      () =>
        jsonResponse(200, {
          ok: true,
          enabled: true,
          owner: OWNER,
          phase: "idle",
          hasJevKey: true,
          prefs: {
            exclusions: ["OpenAI"],
            premiums_matter: true,
            typesafe_key: SECRET,
          },
          jev_key: SECRET,
          typesafe_key: SECRET,
          rpc: `https://rpc.example/?api-key=${SECRET}`,
          port: 8792,
          keeper: SECRET,
          program: SECRET,
          sessionToken: SECRET,
          error: `rpc failed https://rpc.example/?api-key=${SECRET}`,
          spendLimits: { path: SECRET, start_usd: 1 },
        }),
      async () => {
        const status = await keeperPublicStatus(OWNER);
        const blob = JSON.stringify(status);
        assert.equal(blob.includes(SECRET), false);
        assert.equal(blob.includes("https://"), false);
        assert.equal(blob.includes("api-key"), false);
        assert.equal(status.hasJevKey, true);
        assert.equal(status.enabled, true);
        assert.deepEqual(status.prefs?.exclusions, ["OpenAI"]);
        assert.equal(
          (status.prefs as { typesafe_key?: string } | undefined)?.typesafe_key,
          undefined,
        );
        assert.equal(status.error?.includes(SECRET), false);
        assert.equal("port" in status, false);
        assert.equal("rpc" in status, false);
        assert.equal("sessionToken" in status, false);
      },
    );
  });

  test("404 and a dead keeper are unknown, not off, and do not sign", async () => {
    await withFetch(
      () => jsonResponse(404, { ok: false, enabled: false, jev_key: SECRET }),
      async (calls) => {
        const status = await keeperPublicStatus(OWNER);
        assert.equal(status.ok, false);
        assert.equal(status.error, "public_status_unavailable");
        assert.equal(typeof status.enabled, "undefined");
        assert.equal(JSON.stringify(status).includes(SECRET), false);
        assert.equal(nextAutoBuyEnabled(null, status, OWNER), null);
        assert.equal(calls.some((call) => call.method === "POST"), false);
      },
    );
    await withFetch(
      () => jsonResponse(502, { ok: false, enabled: false, error: SECRET, rpc: SECRET }),
      async () => {
        const status = await keeperPublicStatus(OWNER);
        assert.equal(status.error, "keeper_unreachable");
        assert.equal(typeof status.enabled, "undefined");
        assert.equal(JSON.stringify(status).includes(SECRET), false);
        assert.equal(nextAutoBuyEnabled(null, status, OWNER), null);
      },
    );
    await withFetch(
      () => {
        throw new Error("offline");
      },
      async () => {
        const status = await keeperPublicStatus(OWNER);
        assert.equal(status.ok, false);
        assert.equal(status.error, "keeper_unreachable");
        assert.equal(typeof status.enabled, "undefined");
      },
    );
  });

  test("an error URL in a 4xx body does not keep the key", async () => {
    await withFetch(
      () =>
        jsonResponse(400, {
          ok: false,
          enabled: false,
          error: `https://rpc.example/path?api-key=${SECRET}&token=${SECRET}`,
        }),
      async () => {
        const status = await keeperPublicStatus(OWNER);
        assert.equal(status.ok, false);
        assert.equal(typeof status.enabled, "undefined");
        const blob = JSON.stringify(status);
        assert.equal(blob.includes(SECRET), false);
        assert.equal(blob.includes("https://"), false);
      },
    );
  });

  test("missing or blank owner does not fetch", async () => {
    await withFetch(
      () => jsonResponse(200, { ok: true, enabled: true }),
      async (calls) => {
        const missing = await keeperPublicStatus("  ");
        assert.equal(missing.error, "wallet_required");
        assert.equal(typeof missing.enabled, "undefined");
        assert.equal(publicGets(calls).length, 0);
        const silent = await keeperStatus(undefined);
        assert.equal(silent.error, "wallet_required");
        assert.equal(publicGets(calls).length, 0);
      },
    );
  });

  test("leftover session tokens are deleted and never sent", async () => {
    writeSession(OWNER, SECRET);
    writeSession(OTHER, SECRET);
    localStorage.setItem(sessionKey(OWNER), SECRET);
    localStorage.setItem("unrelated", "keep");
    const read = localStorage.getItem.bind(localStorage);
    localStorage.getItem = (key: string) => {
      if (key.startsWith(KEEPER_SESSION_PREFIX)) {
        throw new Error("legacy session key was read");
      }
      return read(key);
    };
    await withFetch(
      () => jsonResponse(200, { ok: true, enabled: true, owner: OWNER, phase: "idle" }),
      async (calls) => {
        const before = await keeperPublicStatus(OWNER);
        assert.equal(before.ok, true);
        assert.equal(sessionStorage.getItem(sessionKey(OWNER)) !== null, true);
        const status = await keeperStatus(OWNER);
        assert.equal(status.ok, true);
        assert.equal(status.enabled, true);
        assert.equal(sessionStorage.getItem(sessionKey(OWNER)), null);
        assert.equal(sessionStorage.getItem(sessionKey(OTHER)), null);
        assert.equal(localStore.has(sessionKey(OWNER)), false);
        assert.equal(localStore.get("unrelated"), "keep");
        assert.equal(
          calls.some((call) => call.headers.toLowerCase().includes("authorization")),
          false,
        );
        assert.equal(calls.some((call) => call.url.includes(SECRET)), false);
        clearStatusAuthCache(OWNER);
        writeSession(OWNER, SECRET);
        writeSession(OTHER, SECRET);
        clearStatusAuthCache();
        assert.equal(sessionStorage.getItem(sessionKey(OWNER)), null);
        assert.equal(sessionStorage.getItem(sessionKey(OTHER)), null);
      },
    );
  });
});

test("automatic status reads are public and do not post a session", () => {
  const auto = readFileSync(
    new URL("../lib/hooks/useAutoWeeklyBuy.tsx", import.meta.url),
    "utf8",
  );
  const settings = readFileSync(
    new URL("../components/SettingsView.tsx", import.meta.url),
    "utf8",
  );
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.equal(auto.includes("keeperPublicStatus(ownerKey)"), true);
  assert.equal(auto.includes("keeperPublicStatus(wallet)"), true);
  assert.equal(settings.includes("keeperPublicStatus(wallet)"), true);
  assert.equal(auto.includes("interactive: true"), false);
  assert.equal(settings.includes("interactive: true"), false);
  assert.equal(layout.includes("KeeperSessionSignPrompt"), false);
  assert.equal(auto.includes("POST /status"), false);
  assert.equal(auto.includes("POST /session"), false);
  assert.equal(settings.includes("POST /status"), false);
  assert.equal(settings.includes("POST /session"), false);
  const hydrateEnd = settings.indexOf("setHydratedOwner(ownerKeyAtStart)");
  const hydrate = settings.slice(settings.indexOf("keeperPublicStatus(wallet)"), hydrateEnd);
  assert.match(hydrate, /if \(!status\.ok\) return/);
});
