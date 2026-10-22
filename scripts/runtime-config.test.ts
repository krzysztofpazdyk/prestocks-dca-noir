import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dcaApiBase } from "../lib/keys";
import { keeperUrl } from "../lib/keeper-client";
import { acceptPublicUrl as acceptPublicUrlFromScript } from "../lib/public-url.mjs";
import {
  RUNTIME_CONFIG_TIMEOUT_MS,
  acceptPublicUrl,
  loadRuntimeConfig,
  parseRuntimeConfig,
  resetRuntimeConfigForTests,
  runtimeDcaApiUrl,
} from "../lib/runtime-config";

const SCRIPT = fileURLToPath(
  new URL("./write-runtime-config.mjs", import.meta.url),
);
const TEMPLATE = fileURLToPath(new URL("../public/config.json", import.meta.url));

const TUNNEL = "https://example-tunnel.trycloudflare.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("runtime config", { concurrency: 1 }, () => {
  const prevWarn = console.warn;
  let warnings: string[] = [];
  const envKeys = [
    "NEXT_PUBLIC_DCA_API_URL",
    "NEXT_PUBLIC_KEEPER_URL",
    "NEXT_PUBLIC_BASE_PATH",
  ] as const;
  const prevEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    resetRuntimeConfigForTests();
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    for (const key of envKeys) prevEnv.set(key, process.env[key]);
  });

  afterEach(() => {
    console.warn = prevWarn;
    resetRuntimeConfigForTests();
    for (const key of envKeys) {
      const value = prevEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("the script and the app share one URL check", () => {
    assert.equal(acceptPublicUrl, acceptPublicUrlFromScript);
  });

  test("parseRuntimeConfig accepts a public https config and strips a trailing slash", () => {
    assert.deepEqual(
      parseRuntimeConfig({
        dcaApiUrl: `${TUNNEL}/`,
        keeperUrl: `${TUNNEL}/keeper/`,
        updatedAt: "2026-10-18T12:00:00.000Z",
        note: "ignored",
      }),
      {
        dcaApiUrl: TUNNEL,
        keeperUrl: `${TUNNEL}/keeper`,
      },
    );
  });

  test("parseRuntimeConfig keeps empty fields empty", () => {
    assert.deepEqual(parseRuntimeConfig({ dcaApiUrl: "", keeperUrl: "  ", updatedAt: "" }), {
      dcaApiUrl: "",
      keeperUrl: "",
    });
    assert.deepEqual(parseRuntimeConfig({}), { dcaApiUrl: "", keeperUrl: "" });
  });

  test("parseRuntimeConfig rejects http except localhost and 127.0.0.1", () => {
    assert.equal(acceptPublicUrl("http://example.com"), "");
    assert.equal(acceptPublicUrl("http://example.com/keeper"), "");
    assert.equal(acceptPublicUrl("HTTP://example.com"), "");
    assert.equal(acceptPublicUrl("http://localhost:8792/"), "http://localhost:8792");
    assert.equal(acceptPublicUrl("http://127.0.0.1:8792/"), "http://127.0.0.1:8792");
    assert.equal(acceptPublicUrl("http://192.168.1.1:8792"), "");
  });

  test("parseRuntimeConfig rejects userinfo, non-text, overlong URLs, and unknown shapes", () => {
    assert.equal(acceptPublicUrl("https://user:pass@example.com/keeper"), "");
    assert.equal(acceptPublicUrl("https://user@example.com"), "");
    assert.equal(acceptPublicUrl(12), "");
    assert.equal(acceptPublicUrl({ href: TUNNEL }), "");
    assert.equal(acceptPublicUrl(null), "");
    assert.equal(acceptPublicUrl(true), "");
    const base = "https://example.com/";
    const ok = base + "a".repeat(300 - base.length);
    assert.equal(ok.length, 300);
    assert.equal(acceptPublicUrl(ok), ok);
    assert.equal(acceptPublicUrl(`${ok}a`), "");
    assert.deepEqual(parseRuntimeConfig(null), { dcaApiUrl: "", keeperUrl: "" });
    assert.deepEqual(parseRuntimeConfig("https://example.com"), {
      dcaApiUrl: "",
      keeperUrl: "",
    });
    assert.deepEqual(parseRuntimeConfig([TUNNEL]), { dcaApiUrl: "", keeperUrl: "" });
  });

  test("one invalid field does not clear the other, and unknown fields are dropped", () => {
    const parsed = parseRuntimeConfig({
      dcaApiUrl: "http://evil.example",
      keeperUrl: `${TUNNEL}/keeper/`,
      apiKey: "not-a-url-field",
      rpc: "https://example.com/?api-key=1",
    });
    assert.deepEqual(parsed, { dcaApiUrl: "", keeperUrl: `${TUNNEL}/keeper` });
    assert.deepEqual(Object.keys(parsed), ["dcaApiUrl", "keeperUrl"]);
  });

  test("loadRuntimeConfig reads https URLs and ignores extra JSON fields", async () => {
    const result = await loadRuntimeConfig(async () =>
      jsonResponse({
        dcaApiUrl: `${TUNNEL}/`,
        keeperUrl: `${TUNNEL}/keeper/`,
        updatedAt: "stamp",
        token: "do-not-keep",
      }),
    );
    assert.deepEqual(result, {
      dcaApiUrl: TUNNEL,
      keeperUrl: `${TUNNEL}/keeper`,
    });
    assert.equal(warnings.length, 0);
  });

  test("loadRuntimeConfig falls back on 404, network errors, and invalid JSON", async () => {
    const missing = await loadRuntimeConfig(async () => new Response("missing", { status: 404 }));
    assert.deepEqual(missing, { dcaApiUrl: "", keeperUrl: "" });
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /\?t=/);
    assert.doesNotMatch(warnings[0], /missing/);

    resetRuntimeConfigForTests();
    warnings.length = 0;
    const broken = await loadRuntimeConfig(async () => {
      throw new Error("network down");
    });
    assert.deepEqual(broken, { dcaApiUrl: "", keeperUrl: "" });
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /network down/);

    resetRuntimeConfigForTests();
    warnings.length = 0;
    const badJson = await loadRuntimeConfig(
      async () => new Response("SECRET_BODY {{", { status: 200 }),
    );
    assert.deepEqual(badJson, { dcaApiUrl: "", keeperUrl: "" });
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /SECRET_BODY/);
  });

  test("a fetch that never answers settles at the timeout and does not hang", async () => {
    const started = Date.now();
    const result = await loadRuntimeConfig(() => new Promise<Response>(() => {}), {
      timeoutMs: 40,
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { dcaApiUrl: "", keeperUrl: "" });
    assert.ok(elapsed < 1000, `elapsed ${elapsed}`);
    assert.equal(RUNTIME_CONFIG_TIMEOUT_MS, 5000);
    assert.equal(warnings.length, 1);
  });

  test("many loadRuntimeConfig calls share one promise and one request", async () => {
    let calls = 0;
    let release: ((response: Response) => void) | undefined;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const first = loadRuntimeConfig(fetchImpl);
    const second = loadRuntimeConfig(async () => {
      throw new Error("second fetch");
    });
    assert.equal(first, second);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.ok(release);
    release(jsonResponse({ dcaApiUrl: TUNNEL, keeperUrl: `${TUNNEL}/keeper` }));
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    await loadRuntimeConfig(async () => {
      throw new Error("later");
    });
    assert.equal(calls, 1);
  });

  test("the config request is no-store and cache-busted, and skips localStorage", async () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    const writes: string[] = [];
    const previous = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: (key: string, value: string) => {
          writes.push(`${key}=${value}`);
        },
        removeItem: () => {
          writes.push("remove");
        },
        clear: () => {
          writes.push("clear");
        },
        key: () => null,
        length: 0,
      },
    });
    let seenUrl = "";
    let seenCache = "";
    try {
      await loadRuntimeConfig(
        async (input, init) => {
          seenUrl = String(input);
          seenCache = init?.cache ?? "";
          return jsonResponse({ dcaApiUrl: TUNNEL, keeperUrl: "" });
        },
        { now: 12345 },
      );
      assert.match(seenUrl, /\/prestocks-dca-noir\/config\.json\?t=12345$/);
      assert.equal(seenCache, "no-store");
      assert.deepEqual(writes, []);
      assert.equal(runtimeDcaApiUrl(), TUNNEL);
    } finally {
      if (previous === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: previous,
        });
      }
    }
  });

  test("rejected loads do not surface as unhandled rejections", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await loadRuntimeConfig(async () => {
        throw new Error("boom");
      });
      resetRuntimeConfigForTests();
      await loadRuntimeConfig(() => new Promise<Response>(() => {}), { timeoutMs: 20 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(unhandled.length, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("dcaApiBase and keeperUrl prefer runtime, then build-time, then defaults", async () => {
    delete process.env.NEXT_PUBLIC_DCA_API_URL;
    delete process.env.NEXT_PUBLIC_KEEPER_URL;
    assert.equal(dcaApiBase(), "");
    assert.equal(keeperUrl(), "http://127.0.0.1:8792");

    process.env.NEXT_PUBLIC_DCA_API_URL = "https://build-api.example/";
    assert.equal(dcaApiBase(), "https://build-api.example");
    assert.equal(keeperUrl(), "https://build-api.example/keeper");

    process.env.NEXT_PUBLIC_KEEPER_URL = "https://build-keeper.example/";
    assert.equal(keeperUrl(), "https://build-keeper.example");

    await loadRuntimeConfig(async () =>
      jsonResponse({ dcaApiUrl: "https://runtime-api.example/", keeperUrl: "" }),
    );
    assert.equal(dcaApiBase(), "https://runtime-api.example");
    assert.equal(keeperUrl(), "https://runtime-api.example/keeper");

    resetRuntimeConfigForTests();
    process.env.NEXT_PUBLIC_DCA_API_URL = "https://build-api.example/";
    process.env.NEXT_PUBLIC_KEEPER_URL = "https://build-keeper.example/";
    await loadRuntimeConfig(async () =>
      jsonResponse({
        dcaApiUrl: "https://runtime-api.example",
        keeperUrl: "https://runtime-keeper.example/custom/",
      }),
    );
    assert.equal(dcaApiBase(), "https://runtime-api.example");
    assert.equal(keeperUrl(), "https://runtime-keeper.example/custom");

    resetRuntimeConfigForTests();
    await loadRuntimeConfig(async () =>
      jsonResponse({ dcaApiUrl: "http://not-local.example", keeperUrl: "https://user:pass@keeper.example" }),
    );
    assert.equal(dcaApiBase(), "https://build-api.example");
    assert.equal(keeperUrl(), "https://build-keeper.example");
  });

  test("public/config.json is an empty template with only the three public fields", () => {
    const raw = readFileSync(TEMPLATE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ["dcaApiUrl", "keeperUrl", "updatedAt"]);
    assert.equal(parsed.dcaApiUrl, "");
    assert.equal(parsed.keeperUrl, "");
    assert.equal(parsed.updatedAt, "");
    assert.doesNotMatch(raw, /https?:\/\//);
    assert.doesNotMatch(raw, /trycloudflare|api[_-]?key|secret|privy|typesafe|bearer/i);
  });

  test("call sites do not cache the API or keeper URL at import time", () => {
    const files = [
      "../lib/dca-api.ts",
      "../lib/ranking.ts",
      "../lib/prestocks.ts",
      "../lib/keeper-client.ts",
      "../lib/keys.ts",
      "../components/SettingsView.tsx",
    ];
    for (const file of files) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.doesNotMatch(
        src,
        /^(export )?const \w+ = (dcaApiBase|keeperUrl|getKeeperBaseUrl)\(/m,
        file,
      );
    }
  });
});

function runScript(args: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TYPESAFE_API_KEY: "should-not-leak",
    NEXT_PUBLIC_DCA_API_URL: "https://should-not-be-read.example",
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

test("write-runtime-config writes the tunnel address and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "noir3-cfg-"));
  try {
    mkdirSync(join(dir, "public"));
    const result = runScript([`${TUNNEL}/`], dir);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(
      result.stdout.split("\n").filter((line) => line.length > 0),
      [TUNNEL, "public/config.json"],
    );
    assert.doesNotMatch(result.stdout, /should-not-leak|should-not-be-read/);
    const parsed = JSON.parse(readFileSync(join(dir, "public/config.json"), "utf8")) as {
      dcaApiUrl: string;
      keeperUrl: string;
      updatedAt: string;
    };
    assert.deepEqual(Object.keys(parsed), ["dcaApiUrl", "keeperUrl", "updatedAt"]);
    assert.equal(parsed.dcaApiUrl, TUNNEL);
    assert.equal(parsed.keeperUrl, `${TUNNEL}/keeper`);
    assert.match(parsed.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.now() - Date.parse(parsed.updatedAt)) < 60_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write-runtime-config rejects http, userinfo, and empty input without creating a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "noir3-cfg-"));
  const cases = ["http://example.com", "https://user:pass@example.com", ""];
  try {
    for (const address of cases) {
      const dest = join(dir, `out-${cases.indexOf(address)}.json`);
      const result = runScript([address, dest], dir);
      assert.notEqual(result.status, 0, address);
      assert.equal(existsSync(dest), false, address);
      assert.equal(result.stdout, "", address);
      assert.equal(result.stderr, "", address);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /user:pass|should-not-leak/);
    }
    const missing = runScript([], dir);
    assert.notEqual(missing.status, 0);
    assert.equal(existsSync(join(dir, "public/config.json")), false);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
