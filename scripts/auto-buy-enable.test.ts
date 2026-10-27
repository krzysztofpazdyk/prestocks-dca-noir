import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { canPostAutoEnable, shouldCommitAutoBuyEnabled } from "../lib/auto-weekly-buy";
import { applyAutoBuyActionStatus, nextAutoBuyEnabled } from "../lib/keeper-enabled";
import { translate } from "../lib/i18n";
import {
  KEEPER_SESSION_PREFIX,
  clearStatusAuthCache,
  keeperDisable,
  keeperEnable,
  keeperPublicStatus,
  keeperPushPrefs,
} from "../lib/keeper-client";
import {
  baselineFromKeeperPrefs,
  decidePrefsSave,
  makePrefsEditBaseline,
  prefsEditBaselinesEqual,
} from "../lib/keeper-prefs-sync";
import { LS_TYPESAFE } from "../lib/keys";
import { resetRuntimeConfigForTests } from "../lib/runtime-config";

const NAMES = ["A", "B", "C"];

test("busy skip does not commit enabled", () => {
  assert.equal(
    shouldCommitAutoBuyEnabled({
      ok: true,
      skipped: true,
    }),
    false,
  );
});

test("a real purchase commits enabled", () => {
  assert.equal(
    shouldCommitAutoBuyEnabled({
      ok: true,
      skipped: false,
      signature: "sig",
      names: NAMES,
    }),
    true,
  );
});

test("skipped purchase with a signature still does not commit", () => {
  assert.equal(
    shouldCommitAutoBuyEnabled({
      ok: true,
      skipped: true,
      signature: "sig",
      names: NAMES,
    }),
    false,
  );
});

test("success without three names does not commit", () => {
  assert.equal(
    shouldCommitAutoBuyEnabled({
      ok: true,
      signature: "sig",
      names: ["A", "B"],
    }),
    false,
  );
});

test("a failed enable does not commit", () => {
  assert.equal(
    shouldCommitAutoBuyEnabled({
      ok: false,
      signature: "sig",
      names: NAMES,
    }),
    false,
  );
});

const DUMMY_KEY = "ts_test_dummy";
const OWNER = "Owner111111111111111111111111111111111111111";

type Captured = {
  url: string;
  method: string;
  body: string;
  headers: string;
};

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

async function withKeeper(
  key: string,
  run: (calls: Captured[], logs: string[]) => Promise<void>,
): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const previousDefault = process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
  const previousKeeper = process.env.NEXT_PUBLIC_KEEPER_URL;
  const previousApi = process.env.NEXT_PUBLIC_DCA_API_URL;
  delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
  delete process.env.NEXT_PUBLIC_KEEPER_URL;
  delete process.env.NEXT_PUBLIC_DCA_API_URL;
  const store = new Map<string, string>([[LS_TYPESAFE, key]]);
  const storage = {
    getItem: (item: string) => (store.has(item) ? store.get(item)! : null),
    setItem: (item: string, value: string) => {
      store.set(item, value);
    },
    removeItem: (item: string) => {
      store.delete(item);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  const calls: Captured[] = [];
  const logs: string[] = [];
  const consoleMethods = ["log", "debug", "info", "warn", "error"] as const;
  const previousConsole = new Map<(typeof consoleMethods)[number], (...args: unknown[]) => void>();
  for (const method of consoleMethods) {
    previousConsole.set(method, console[method]);
    console[method] = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      headers: headerText(init?.headers),
    });
    if (url.includes("config.json")) {
      return new Response(JSON.stringify({ dcaApiUrl: "", keeperUrl: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        skipped: false,
        signature: "sig",
        names: ["A", "B", "C"],
        prefs: { exclusions: ["xAI"] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  resetRuntimeConfigForTests();
  try {
    await run(calls, logs);
  } finally {
    resetRuntimeConfigForTests();
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      globalThis.localStorage = previousStorage;
    }
    if (previousDefault === undefined) delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
    else process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY = previousDefault;
    if (previousKeeper === undefined) delete process.env.NEXT_PUBLIC_KEEPER_URL;
    else process.env.NEXT_PUBLIC_KEEPER_URL = previousKeeper;
    if (previousApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
    else process.env.NEXT_PUBLIC_DCA_API_URL = previousApi;
    for (const method of consoleMethods) {
      console[method] = previousConsole.get(method)!;
    }
  }
}

function posts(calls: Captured[], path: string): Captured[] {
  return calls.filter((call) => {
    if (call.method !== "POST") return false;
    try {
      return new URL(call.url).pathname.endsWith(path);
    } catch {
      return call.url.split("?")[0].endsWith(path);
    }
  });
}

test("an empty Jev key does not post /enable", () => {
  assert.equal(canPostAutoEnable(""), false);
  assert.equal(canPostAutoEnable("   "), false);
  assert.equal(canPostAutoEnable(null), false);
  assert.equal(canPostAutoEnable(undefined), false);
  assert.equal(canPostAutoEnable(DUMMY_KEY), true);

  const hook = readFileSync(
    new URL("../lib/hooks/useAutoWeeklyBuy.tsx", import.meta.url),
    "utf8",
  );
  const gate = hook.indexOf("if (!canPostAutoEnable(readTypesafeKey()))");
  const lock = hook.indexOf("if (!shouldSendEnable(cycleInFlight)) return;");
  const post = hook.indexOf("await keeperEnable");
  assert.ok(gate > 0 && lock > gate && post > lock);
  const block = hook.slice(gate, lock);
  assert.match(block, /return;/);
  assert.match(block, /auto\.error\.jevNoKey/);
  assert.match(block, /setEnabledState\(false\)/);
  assert.match(block, /writeAutoWeeklyBuy\(false/);
  assert.doesNotMatch(block, /keeperEnable|keeperFetch|\/enable/);

  const settings = readFileSync(
    new URL("../components/SettingsView.tsx", import.meta.url),
    "utf8",
  );
  const saveAt = settings.indexOf("async function signAndSavePrefs");
  const storeAt = settings.indexOf(
    "localStorage.setItem(LS_TYPESAFE, nextTypesafe)",
    saveAt,
  );
  const pushAt = settings.indexOf("keeperPushPrefs(", saveAt);
  assert.ok(saveAt > 0 && storeAt > saveAt && pushAt > storeAt);
});

describe("keeper posts carry the Jev key in the body only", { concurrency: false }, () => {
  test("enable body has typesafe_key and the URL does not", async () => {
    await withKeeper(DUMMY_KEY, async (calls, logs) => {
      const sign = async () => new Uint8Array([1, 2, 3]);
      const result = await keeperEnable(OWNER, true, sign, { exclusions: ["xAI"] });
      assert.equal(result.ok, true);
      const enableCalls = posts(calls, "/enable");
      assert.equal(enableCalls.length, 1);
      const call = enableCalls[0];
      assert.equal(call.url.includes(DUMMY_KEY), false);
      assert.equal(call.url.includes("typesafe_key"), false);
      assert.equal(call.headers.toLowerCase().includes("typesafe"), false);
      assert.equal(call.headers.includes(DUMMY_KEY), false);
      const body = JSON.parse(call.body) as {
        typesafe_key?: string;
        prefs?: { typesafe_key?: string; exclusions?: string[] };
      };
      assert.equal(body.typesafe_key, DUMMY_KEY);
      assert.equal(body.prefs?.typesafe_key, undefined);
      assert.deepEqual(body.prefs?.exclusions, ["xAI"]);
      assert.equal(logs.some((line) => line.includes(DUMMY_KEY)), false);
    });
  });

  test("an empty field omits typesafe_key from the enable body", async () => {
    await withKeeper("", async (calls, logs) => {
      const sign = async () => new Uint8Array([1, 2, 3]);
      await keeperEnable(OWNER, true, sign, { exclusions: ["xAI"] });
      const enableCalls = posts(calls, "/enable");
      assert.equal(enableCalls.length, 1);
      const body = JSON.parse(enableCalls[0].body) as { typesafe_key?: string };
      assert.equal("typesafe_key" in body, false);
      assert.equal(enableCalls[0].url.includes("typesafe_key"), false);
      assert.equal(logs.some((line) => line.includes(DUMMY_KEY)), false);
    });
  });

  test("prefs push sends the current key beside prefs", async () => {
    await withKeeper(DUMMY_KEY, async (calls) => {
      const sign = async () => new Uint8Array([4, 5, 6]);
      const result = await keeperPushPrefs({ exclusions: ["OpenAI"] }, OWNER, sign);
      assert.equal(result.ok, true);
      const prefsCalls = posts(calls, "/prefs");
      assert.equal(prefsCalls.length, 1);
      assert.equal(prefsCalls[0].url.includes(DUMMY_KEY), false);
      assert.equal(prefsCalls[0].url.includes("typesafe_key"), false);
      const body = JSON.parse(prefsCalls[0].body) as {
        typesafe_key?: string;
        prefs?: { typesafe_key?: string; exclusions?: string[] };
      };
      assert.equal(body.typesafe_key, DUMMY_KEY);
      assert.equal(body.prefs?.typesafe_key, undefined);
      assert.deepEqual(body.prefs?.exclusions, ["OpenAI"]);
    });
  });
});

function hookSource(): string {
  return readFileSync(new URL("../lib/hooks/useAutoWeeklyBuy.tsx", import.meta.url), "utf8");
}

function settingsSource(): string {
  return readFileSync(new URL("../components/SettingsView.tsx", import.meta.url), "utf8");
}

test("status is a public read and there is no Sign bar", () => {
  const hook = hookSource();
  const settings = settingsSource();
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const banner = hook.slice(hook.indexOf("export function AutoWeeklyBuyBanner"));
  for (const source of [hook, settings, layout, banner]) {
    assert.equal(source.includes("KeeperSessionSignPrompt"), false);
    assert.equal(source.includes("unlockStatus"), false);
    assert.equal(source.includes("interactive: true"), false);
    assert.equal(source.includes("auto.status.sign"), false);
    assert.equal(source.includes("autoBuySignInBar"), false);
  }
  assert.equal(hook.includes("POST /status"), false);
  assert.equal(settings.includes('t("auto.status.sign")'), false);

  const startCycle = hook.slice(
    hook.indexOf("const startCycle = useCallback"),
    hook.indexOf("const tick = useCallback"),
  );
  assert.match(startCycle, /await keeperPublicStatus\(cycleOwner\)/);
  assert.match(startCycle, /await keeperEnable\(/);
  assert.match(startCycle, /applyAutoBuyActionStatus\(true, st\)/);
  assert.match(startCycle, /sign_rejected/);
  const catchBlock = startCycle.slice(
    startCycle.indexOf("} catch (e) {"),
    startCycle.indexOf("} finally {"),
  );
  assert.doesNotMatch(catchBlock, /keeperPublicStatus|keeperStatus/);
  const forceOff = startCycle.slice(
    startCycle.indexOf("const forceOff"),
    startCycle.indexOf("const pollPendingEnable"),
  );
  assert.doesNotMatch(forceOff, /keeperPublicStatus|keeperStatus|interactive:\s*true/);

  const setEnabled = hook.slice(
    hook.indexOf("const setEnabled = useCallback"),
    hook.indexOf("const startCycle = useCallback"),
  );
  assert.match(setEnabled, /await keeperDisable\(/);
  assert.match(setEnabled, /applyAutoBuyActionStatus\(false, st\)/);
  assert.match(setEnabled, /keeperPublicStatus\(owner\)/);
  assert.match(setEnabled, /sign_rejected/);

  const saveAt = settings.indexOf("async function signAndSavePrefs");
  const readAt = settings.indexOf("keeperPublicStatus(owner)", saveAt);
  const pushAt = settings.indexOf("keeperPushPrefs(", saveAt);
  const reloadAt = settings.indexOf('t("settings.prefsKeeperChanged")', saveAt);
  assert.ok(saveAt > 0 && readAt > saveAt && reloadAt > readAt && pushAt > reloadAt);

  assert.match(settings, /t\("settings\.autoBuyKeeperUnreachable"\)/);
  assert.match(settings, /t\("settings\.jevKeySaved"\)/);
  assert.match(settings, /disabled=\{!prefsReady\}/);
  assert.equal(settings.includes("value={typesafeKey}"), true);
  assert.equal(
    translate("pl", "settings.prefsKeeperChanged"),
    "Ustawienia w keeperze zmieniły się – wczytano je, sprawdź i zapisz ponownie",
  );
  assert.equal(
    translate("en", "settings.prefsKeeperChanged"),
    "Keeper settings changed – reloaded, review and save again",
  );
  assert.equal(translate("pl", "settings.jevKeySaved"), "Klucz zapisany w keeperze");
  assert.equal(translate("en", "settings.jevKeySaved"), "Key saved in keeper");
  assert.equal(
    translate("pl", "settings.autoBuyKeeperUnreachable"),
    "Auto-zakup: keeper nieosiągalny, stan nieznany",
  );
  assert.equal(
    translate("en", "settings.autoBuyKeeperUnreachable"),
    "Auto-buy: keeper unreachable, status unknown",
  );
});

test("a prefs save is skipped when the keeper copy changed since the edit started", () => {
  const start = makePrefsEditBaseline("OpenAI", false, true, false);
  const same = {
    ok: true,
    prefs: {
      exclusions: ["OpenAI"],
      deadlines_unimportant: false,
      premiums_matter: true,
      premiums_especially_near_ipo: true,
      buy_despite_ipo: false,
    },
  };
  assert.equal(decidePrefsSave(same, start).kind, "save");
  assert.equal(
    prefsEditBaselinesEqual(start, baselineFromKeeperPrefs(same.prefs, start)),
    true,
  );
  const changed = decidePrefsSave(
    {
      ok: true,
      prefs: {
        exclusions: ["Kalshi"],
        deadlines_unimportant: false,
        premiums_matter: true,
        buy_despite_ipo: false,
      },
    },
    start,
  );
  assert.equal(changed.kind, "reload");
  if (changed.kind === "reload") {
    assert.equal(prefsEditBaselinesEqual(start, baselineFromKeeperPrefs(changed.prefs, start)), false);
    assert.deepEqual(changed.prefs?.exclusions, ["Kalshi"]);
  }
  assert.equal(decidePrefsSave({ ok: false, error: "keeper_unreachable" }, start).kind, "unreachable");
  assert.equal(decidePrefsSave({ ok: false, error: "public_status_unavailable" }, start).kind, "unreachable");
});

test("a silent miss keeps the action bit and only asks for a signature", () => {
  const on = applyAutoBuyActionStatus(true, { error: "session_required" });
  assert.equal(on.enabled, true);
  assert.equal(on.needsSignature, true);
  assert.equal(on.touchStatusResolved, false);

  const off = applyAutoBuyActionStatus(false, { error: "session_required" });
  assert.equal(off.enabled, false);
  assert.equal(off.needsSignature, true);
  assert.equal(off.touchStatusResolved, false);

  const seen = applyAutoBuyActionStatus(true, { error: undefined });
  assert.equal(seen.enabled, true);
  assert.equal(seen.needsSignature, false);
  assert.equal(seen.touchStatusResolved, true);
  assert.equal(seen.statusResolved, true);

  const down = applyAutoBuyActionStatus(false, { error: "keeper_unreachable" });
  assert.equal(down.enabled, false);
  assert.equal(down.needsSignature, false);
  assert.equal(down.statusResolved, true);
});

function makeMemoryStorage() {
  const store = new Map<string, string>();
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

describe("enable and disable sign once", { concurrency: false }, () => {
  test("success signs once with a tab session and without one", async () => {
    for (const withSession of [true, false]) {
      const previousFetch = globalThis.fetch;
      const previousWindow = globalThis.window;
      const previousLocal = globalThis.localStorage;
      const previousSession = globalThis.sessionStorage;
      const previousDefault = process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
      const previousKeeper = process.env.NEXT_PUBLIC_KEEPER_URL;
      const previousApi = process.env.NEXT_PUBLIC_DCA_API_URL;
      delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
      delete process.env.NEXT_PUBLIC_KEEPER_URL;
      delete process.env.NEXT_PUBLIC_DCA_API_URL;
      const local = makeMemoryStorage();
      const session = makeMemoryStorage();
      local.setItem(LS_TYPESAFE, DUMMY_KEY);
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
      Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
      clearStatusAuthCache();
      const owner = OWNER;
      if (withSession) {
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        session.setItem(
          `${KEEPER_SESSION_PREFIX}${owner}`,
          JSON.stringify({ token: "tab-session", expiresAt, owner }),
        );
      }
      const keptSession = session.getItem(`${KEEPER_SESSION_PREFIX}${owner}`);
      let signs = 0;
      const sign = async () => {
        signs += 1;
        return Uint8Array.of(signs);
      };
      let enabledBit = false;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("config.json")) {
          return new Response(JSON.stringify({ dcaApiUrl: "", keeperUrl: "" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const method = init?.method ?? "GET";
        if (method === "POST" && url.includes("/enable")) {
          enabledBit = true;
          return new Response(
            JSON.stringify({
              ok: true,
              skipped: false,
              signature: "sig",
              names: NAMES,
              enabled: true,
              sessionToken: "response-token-ignored",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "POST" && url.includes("/disable")) {
          enabledBit = false;
          return new Response(JSON.stringify({ ok: true, enabled: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/status")) {
          return new Response(
            JSON.stringify({ ok: true, enabled: enabledBit, owner }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      resetRuntimeConfigForTests();
      try {
        const enabled = await keeperEnable(owner, true, sign, { exclusions: ["xAI"] });
        assert.equal(enabled.ok, true);
        assert.equal(signs, 1);
        const afterEnable = await keeperPublicStatus(owner);
        assert.equal(signs, 1, withSession ? "session enable" : "no-session enable");
        assert.equal(afterEnable.ok, true);
        assert.equal(afterEnable.enabled, true);
        const on = applyAutoBuyActionStatus(true, afterEnable);
        assert.equal(on.enabled, true);
        assert.equal(on.needsSignature, false);
        assert.equal(on.touchStatusResolved, true);
        assert.equal(session.getItem(`${KEEPER_SESSION_PREFIX}${owner}`), keptSession);

        signs = 0;
        const disabled = await keeperDisable(owner, sign);
        assert.equal(disabled.ok, true);
        assert.equal(signs, 1);
        const afterDisable = await keeperPublicStatus(owner);
        assert.equal(signs, 1, withSession ? "session disable" : "no-session disable");
        assert.equal(afterDisable.enabled, false);
        const off = applyAutoBuyActionStatus(false, afterDisable);
        assert.equal(off.enabled, false);
        assert.equal(off.needsSignature, false);
      } finally {
        resetRuntimeConfigForTests();
        clearStatusAuthCache();
        globalThis.fetch = previousFetch;
        if (previousWindow === undefined) delete (globalThis as { window?: Window }).window;
        else globalThis.window = previousWindow;
        if (previousLocal === undefined) {
          delete (globalThis as { localStorage?: Storage }).localStorage;
        } else globalThis.localStorage = previousLocal;
        if (previousSession === undefined) {
          delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
        } else globalThis.sessionStorage = previousSession;
        if (previousDefault === undefined) delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
        else process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY = previousDefault;
        if (previousKeeper === undefined) delete process.env.NEXT_PUBLIC_KEEPER_URL;
        else process.env.NEXT_PUBLIC_KEEPER_URL = previousKeeper;
        if (previousApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
        else process.env.NEXT_PUBLIC_DCA_API_URL = previousApi;
      }
    }
  });

  test("a rejected enable or disable does not sign again", async () => {
    const previousFetch = globalThis.fetch;
    const previousWindow = globalThis.window;
    const previousLocal = globalThis.localStorage;
    const previousSession = globalThis.sessionStorage;
    delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
    delete process.env.NEXT_PUBLIC_KEEPER_URL;
    delete process.env.NEXT_PUBLIC_DCA_API_URL;
    const local = makeMemoryStorage();
    const session = makeMemoryStorage();
    local.setItem(LS_TYPESAFE, DUMMY_KEY);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    clearStatusAuthCache();
    let signs = 0;
    let statusGets = 0;
    const sign = async () => {
      signs += 1;
      return Uint8Array.of(signs);
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("config.json")) {
        return new Response(JSON.stringify({ dcaApiUrl: "", keeperUrl: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/status")) statusGets += 1;
      return new Response(JSON.stringify({ ok: false, error: "signature_rejected" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    resetRuntimeConfigForTests();
    try {
      const enabled = await keeperEnable(OWNER, true, sign, { exclusions: ["xAI"] });
      assert.equal(enabled.ok, false);
      assert.equal(signs, 1);
      assert.equal(statusGets, 0);
      signs = 0;
      const disabled = await keeperDisable(OWNER, sign);
      assert.equal(disabled.ok, false);
      assert.equal(signs, 1);
      assert.equal(statusGets, 0);
      const silent = await keeperPublicStatus(OWNER);
      assert.equal(signs, 1);
      assert.equal(silent.ok, false);
      assert.equal(typeof silent.enabled, "undefined");
      assert.equal(statusGets, 1);
      const patch = applyAutoBuyActionStatus(false, { error: "keeper_unreachable" });
      assert.equal(patch.needsSignature, false);
      assert.equal(patch.enabled, false);
      assert.equal(patch.touchStatusResolved, true);
    } finally {
      resetRuntimeConfigForTests();
      clearStatusAuthCache();
      globalThis.fetch = previousFetch;
      if (previousWindow === undefined) delete (globalThis as { window?: Window }).window;
      else globalThis.window = previousWindow;
      if (previousLocal === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else globalThis.localStorage = previousLocal;
      if (previousSession === undefined) {
        delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
      } else globalThis.sessionStorage = previousSession;
    }
  });
});

test("enable, disable, and prefs each sign once and omit session:status", async () => {
  await withKeeper(DUMMY_KEY, async (calls) => {
    const actions: string[] = [];
    const sign = async (message: Uint8Array) => {
      const text = new TextDecoder().decode(message);
      const action = /^Predca keeper authorization\naction:(\w+)\nowner:/m.exec(text)?.[1];
      assert.equal(typeof action, "string");
      assert.equal(text.includes("session:"), false);
      actions.push(action ?? "");
      return Uint8Array.of(actions.length);
    };
    const enabled = await keeperEnable(OWNER, true, sign, { exclusions: ["xAI"] });
    const disabled = await keeperDisable(OWNER, sign);
    const pushed = await keeperPushPrefs({ exclusions: ["OpenAI"] }, OWNER, sign);
    assert.equal(enabled.ok, true);
    assert.equal(disabled.ok, true);
    assert.equal(pushed.ok, true);
    assert.deepEqual(actions, ["enable", "disable", "prefs"]);
    assert.equal(posts(calls, "/enable").length, 1);
    assert.equal(posts(calls, "/disable").length, 1);
    assert.equal(posts(calls, "/prefs").length, 1);
    assert.equal(posts(calls, "/status").length, 0);
    assert.equal(posts(calls, "/session").length, 0);
    const reads = calls.filter(
      (call) => call.method === "GET" && call.url.includes("/public/status?owner="),
    );
    assert.equal(reads.length, 3);
  });
});

test("a rejected wallet signature sends no keeper request", async () => {
  await withKeeper(DUMMY_KEY, async (calls) => {
    const sign = async () => {
      throw new Error("User rejected the request.");
    };
    const enabled = await keeperEnable(OWNER, true, sign, { exclusions: ["xAI"] });
    const disabled = await keeperDisable(OWNER, sign);
    const pushed = await keeperPushPrefs({ exclusions: ["OpenAI"] }, OWNER, sign);
    assert.match(enabled.error ?? "", /^sign_rejected:/);
    assert.match(disabled.error ?? "", /^sign_rejected:/);
    assert.match(pushed.error ?? "", /^sign_rejected:/);
    assert.equal(enabled.ok, false);
    assert.equal(disabled.ok, false);
    assert.equal(pushed.ok, false);
    assert.equal(calls.length, 0);
  });
});

test("a changed public prefs read does not sign or post", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousKeeper = process.env.NEXT_PUBLIC_KEEPER_URL;
  const previousApi = process.env.NEXT_PUBLIC_DCA_API_URL;
  delete process.env.NEXT_PUBLIC_KEEPER_URL;
  delete process.env.NEXT_PUBLIC_DCA_API_URL;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  const calls: Captured[] = [];
  let signs = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      headers: headerText(init?.headers),
    });
    if (url.includes("config.json")) {
      return new Response(JSON.stringify({ dcaApiUrl: "", keeperUrl: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      return new Response(JSON.stringify({ ok: false, error: "should_not_post" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        enabled: true,
        owner: OWNER,
        phase: "idle",
        hasJevKey: true,
        prefs: {
          exclusions: ["Kalshi"],
          deadlines_unimportant: true,
          premiums_matter: false,
          buy_despite_ipo: true,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  resetRuntimeConfigForTests();
  try {
    const start = makePrefsEditBaseline("OpenAI", false, true, false);
    const fresh = await keeperPublicStatus(OWNER);
    const decision = decidePrefsSave(fresh, start);
    assert.equal(decision.kind, "reload");
    if (decision.kind === "reload") {
      assert.deepEqual(decision.prefs?.exclusions, ["Kalshi"]);
      assert.equal(decision.prefs?.deadlines_unimportant, true);
      assert.equal(
        prefsEditBaselinesEqual(start, baselineFromKeeperPrefs(decision.prefs, start)),
        false,
      );
    }
    assert.equal(signs, 0);
    assert.equal(posts(calls, "/prefs").length, 0);
    assert.equal(posts(calls, "/enable").length, 0);
    assert.equal(posts(calls, "/disable").length, 0);
    assert.equal(calls.some((call) => call.method === "POST"), false);
  } finally {
    resetRuntimeConfigForTests();
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete (globalThis as { window?: Window }).window;
    else globalThis.window = previousWindow;
    if (previousKeeper === undefined) delete process.env.NEXT_PUBLIC_KEEPER_URL;
    else process.env.NEXT_PUBLIC_KEEPER_URL = previousKeeper;
    if (previousApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
    else process.env.NEXT_PUBLIC_DCA_API_URL = previousApi;
  }
});

test("a transitional public read keeps enable on and disable off", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousLocal = globalThis.localStorage;
  const previousDefault = process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
  const previousKeeper = process.env.NEXT_PUBLIC_KEEPER_URL;
  const previousApi = process.env.NEXT_PUBLIC_DCA_API_URL;
  delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
  delete process.env.NEXT_PUBLIC_KEEPER_URL;
  delete process.env.NEXT_PUBLIC_DCA_API_URL;
  const store = new Map<string, string>([[LS_TYPESAFE, DUMMY_KEY]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (item: string) => (store.has(item) ? store.get(item)! : null),
      setItem: (item: string, value: string) => {
        store.set(item, value);
      },
      removeItem: (item: string) => {
        store.delete(item);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  let phase = "buying";
  let signs = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("config.json")) {
      return new Response(JSON.stringify({ dcaApiUrl: "", keeperUrl: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" && url.includes("/enable")) {
      return new Response(
        JSON.stringify({
          ok: true,
          enabled: true,
          signature: "buy-sig",
          names: NAMES,
          phase: "ok",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (method === "POST" && url.includes("/disable")) {
      return new Response(JSON.stringify({ ok: true, enabled: false, phase: "off" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        enabled: false,
        phase,
        owner: OWNER,
        jev_key: "ZZSECRETVALUEZZ",
        rpc: "https://rpc.example/?api-key=ZZSECRETVALUEZZ",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  resetRuntimeConfigForTests();
  try {
    const sign = async () => Uint8Array.of(++signs);
    const enabled = await keeperEnable(OWNER, true, sign, { exclusions: ["xAI"] });
    assert.equal(signs, 1);
    assert.equal(enabled.ok, true);
    assert.equal(enabled.enabled, true);
    assert.equal(JSON.stringify(enabled).includes("ZZSECRETVALUEZZ"), false);
    assert.equal(nextAutoBuyEnabled(true, enabled, OWNER), true);
    phase = "off";
    const disabled = await keeperDisable(OWNER, sign);
    assert.equal(signs, 2);
    assert.equal(disabled.ok, true);
    assert.equal(disabled.enabled, false);
    assert.equal(nextAutoBuyEnabled(false, disabled, OWNER), false);
    assert.equal(JSON.stringify(disabled).includes("ZZSECRETVALUEZZ"), false);
  } finally {
    resetRuntimeConfigForTests();
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete (globalThis as { window?: Window }).window;
    else globalThis.window = previousWindow;
    if (previousLocal === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else globalThis.localStorage = previousLocal;
    if (previousDefault === undefined) delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
    else process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY = previousDefault;
    if (previousKeeper === undefined) delete process.env.NEXT_PUBLIC_KEEPER_URL;
    else process.env.NEXT_PUBLIC_KEEPER_URL = previousKeeper;
    if (previousApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
    else process.env.NEXT_PUBLIC_DCA_API_URL = previousApi;
  }
});
