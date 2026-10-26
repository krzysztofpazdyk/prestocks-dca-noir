import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { canPostAutoEnable, shouldCommitAutoBuyEnabled } from "../lib/auto-weekly-buy";
import { keeperEnable, keeperPushPrefs } from "../lib/keeper-client";
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
