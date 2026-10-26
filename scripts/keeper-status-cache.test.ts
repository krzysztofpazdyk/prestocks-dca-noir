import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  KEEPER_SESSION_PREFIX,
  clearStatusAuthCache,
  getStatusAuth,
  keeperStatus,
} from "../lib/keeper-client";

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

function jsonResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function prefixKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(KEEPER_SESSION_PREFIX)) keys.push(key);
  }
  return keys;
}

describe("keeper session cache", { concurrency: false }, () => {
  beforeEach(() => {
    localStore.clear();
    sessionStore.clear();
    installStorage();
    clearStatusAuthCache();
  });

  afterEach(() => {
    clearStatusAuthCache();
  });

  test("clearStatusAuthCache(owner) drops that signature and session only", async () => {
    let signsA = 0;
    let signsB = 0;
    const signA = async () => Uint8Array.of(++signsA);
    const signB = async () => Uint8Array.of(++signsB);
    await getStatusAuth("ownerA", signA);
    await getStatusAuth("ownerB", signB);
    writeSession("ownerA", "bearer-a");
    writeSession("ownerB", "bearer-b");

    await getStatusAuth("ownerA", signA);
    assert.equal(signsA, 1);

    clearStatusAuthCache("ownerA");
    assert.equal(sessionStorage.getItem(sessionKey("ownerA")), null);
    assert.equal(sessionStorage.getItem(sessionKey("ownerB")) !== null, true);

    await getStatusAuth("ownerA", signA);
    await getStatusAuth("ownerB", signB);
    assert.equal(signsA, 2);
    assert.equal(signsB, 1);
  });

  test("clearStatusAuthCache() drops every owner", async () => {
    let signsA = 0;
    let signsB = 0;
    await getStatusAuth("ownerA", async () => Uint8Array.of(++signsA));
    await getStatusAuth("ownerB", async () => Uint8Array.of(++signsB));
    writeSession("ownerA", "bearer-a");
    writeSession("ownerB", "bearer-b");

    clearStatusAuthCache();
    assert.equal(sessionStorage.getItem(sessionKey("ownerA")), null);
    assert.equal(sessionStorage.getItem(sessionKey("ownerB")), null);

    await getStatusAuth("ownerA", async () => Uint8Array.of(++signsA));
    await getStatusAuth("ownerB", async () => Uint8Array.of(++signsB));
    assert.equal(signsA, 2);
    assert.equal(signsB, 2);
  });

  test("an in-flight status sign cannot refill the cache after clear", async () => {
    let release: (bytes: Uint8Array) => void = () => {};
    let signs = 0;
    const first = getStatusAuth("ownerA", () => {
      signs += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    clearStatusAuthCache("ownerA");
    const second = getStatusAuth("ownerA", async () => {
      signs += 1;
      return Uint8Array.of(7);
    });
    release(Uint8Array.of(1));
    const stale = await first;
    const fresh = await second;
    assert.equal(signs, 2);
    assert.notEqual(stale.signature, fresh.signature);
    const before = signs;
    const reused = await getStatusAuth("ownerA", async () => {
      signs += 1;
      return Uint8Array.of(9);
    });
    assert.equal(signs, before);
    assert.equal(reused.signature, fresh.signature);
  });

  test("silent mode without a token does not sign", async () => {
    let signs = 0;
    let statusCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/status")) statusCalls += 1;
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    try {
      const status = await keeperStatus("ownerA", async () => {
        signs += 1;
        return Uint8Array.of(1);
      });
      assert.equal(status.ok, false);
      assert.equal(status.error, "session_required");
      assert.equal(signs, 0);
      assert.equal(statusCalls, 0);
      assert.deepEqual(prefixKeys(localStorage), []);
      assert.deepEqual(prefixKeys(sessionStorage), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("silent 401 clears the session and does not sign", async () => {
    let signs = 0;
    const sign = async () => Uint8Array.of(++signs);
    await getStatusAuth("ownerA", sign);
    writeSession("ownerA", "bearer-old");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (!String(input).includes("/status")) return jsonResponse(200, {});
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }) as unknown as typeof fetch;
    try {
      const status = await keeperStatus("ownerA", sign);
      assert.equal(status.ok, false);
      assert.equal(status.error, "session_required");
      assert.equal(signs, 1);
      assert.equal(sessionStorage.getItem(sessionKey("ownerA")), null);
      assert.deepEqual(prefixKeys(localStorage), []);
      await getStatusAuth("ownerA", sign);
      assert.equal(signs, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("interactive 401 signs exactly once", async () => {
    writeSession("ownerA", "bearer-old");
    let signs = 0;
    let posts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/status")) return jsonResponse(200, {});
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        posts += 1;
        return jsonResponse(401, { ok: false, error: "unauthorized" });
      }
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }) as unknown as typeof fetch;
    try {
      const status = await keeperStatus("ownerA", async () => Uint8Array.of(++signs), {
        interactive: true,
      });
      assert.equal(signs, 1);
      assert.equal(posts, 1);
      assert.equal(status.ok, false);
      assert.equal(sessionStorage.getItem(sessionKey("ownerA")), null);
      assert.deepEqual(prefixKeys(localStorage), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("interactive mint stores the token in sessionStorage only", async () => {
    let signs = 0;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/status")) return jsonResponse(200, {});
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        return jsonResponse(200, {
          ok: true,
          enabled: true,
          owner: "ownerA",
          sessionToken: "minted",
          sessionExpiresAt: expiresAt,
        });
      }
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }) as unknown as typeof fetch;
    try {
      const status = await keeperStatus(
        "ownerA",
        async () => Uint8Array.of(++signs),
        { interactive: true },
      );
      assert.equal(status.ok, true);
      assert.equal(signs, 1);
      const raw = sessionStorage.getItem(sessionKey("ownerA"));
      assert.equal(typeof raw, "string");
      const parsed = JSON.parse(raw ?? "{}") as { owner?: string; token?: string };
      assert.equal(parsed.owner, "ownerA");
      assert.equal(typeof parsed.token, "string");
      assert.equal((parsed.token ?? "").length > 0, true);
      assert.deepEqual(prefixKeys(localStorage), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a token for another address is not used", async () => {
    writeSession("ownerB", "bearer-b");
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    sessionStorage.setItem(
      sessionKey("ownerA"),
      JSON.stringify({ token: "bearer-b", expiresAt, owner: "ownerB" }),
    );
    let signs = 0;
    let statusCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/status")) statusCalls += 1;
      return jsonResponse(200, { ok: true, enabled: true, owner: "ownerA" });
    }) as unknown as typeof fetch;
    try {
      const status = await keeperStatus("ownerA", async () => {
        signs += 1;
        return Uint8Array.of(1);
      });
      assert.equal(status.error, "session_required");
      assert.equal(signs, 0);
      assert.equal(statusCalls, 0);
      assert.equal(sessionStorage.getItem(sessionKey("ownerB")) !== null, true);
      assert.equal(sessionStorage.getItem(sessionKey("ownerA")), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("legacy localStorage session keys are deleted and not read", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem(
      sessionKey("ownerA"),
      JSON.stringify({ token: "legacy", expiresAt, owner: "ownerA" }),
    );
    localStorage.setItem("unrelated", "keep");
    const read = localStorage.getItem.bind(localStorage);
    localStorage.getItem = (key: string) => {
      if (key.startsWith(KEEPER_SESSION_PREFIX)) {
        throw new Error("legacy session key was read");
      }
      return read(key);
    };
    let signs = 0;
    let statusCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/status")) statusCalls += 1;
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    try {
      const status = await keeperStatus("ownerA", async () => {
        signs += 1;
        return Uint8Array.of(1);
      });
      assert.equal(status.error, "session_required");
      assert.equal(signs, 0);
      assert.equal(statusCalls, 0);
      assert.equal(localStore.has(sessionKey("ownerA")), false);
      assert.equal(localStore.get("unrelated"), "keep");
      assert.equal(sessionStore.has(sessionKey("ownerA")), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("automatic keeper status reads stay silent", () => {
  const auto = readFileSync(
    new URL("../lib/hooks/useAutoWeeklyBuy.tsx", import.meta.url),
    "utf8",
  );
  const settings = readFileSync(
    new URL("../components/SettingsView.tsx", import.meta.url),
    "utf8",
  );
  const autoCalls = auto.match(/keeperStatus\([^;\n]*\)/g) ?? [];
  const settingsCalls = settings.match(/keeperStatus\([^;\n]*\)/g) ?? [];
  assert.ok(autoCalls.length >= 5);
  for (const call of autoCalls) {
    assert.match(call, /interactive:\s*(true|false)/);
  }
  const silent = autoCalls.filter((call) => /interactive:\s*false/.test(call));
  const prompted = autoCalls.filter((call) => /interactive:\s*true/.test(call));
  assert.ok(silent.length >= 4);
  assert.ok(prompted.length >= 1);
  assert.ok(settingsCalls.length >= 1);
  for (const call of settingsCalls) {
    assert.match(call, /interactive:\s*false/);
  }
  assert.equal(settings.includes("interactive: true"), false);
  assert.equal(
    auto.includes("keeperStatus(ownerKey, sign ?? undefined, { interactive: false })"),
    true,
  );
  assert.equal(
    auto.includes("keeperStatus(wallet ?? undefined, sign ?? undefined, { interactive: false })"),
    true,
  );
  assert.equal(
    settings.includes("keeperStatus(wallet ?? undefined, sign, { interactive: false })"),
    true,
  );
});
