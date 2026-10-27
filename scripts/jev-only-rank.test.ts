import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { translate } from "../lib/i18n";
import { LS_TYPESAFE } from "../lib/keys";
import { purchaseDisabledReasonKey } from "../lib/purchase-reason";
import type { ProductsFetchResult } from "../lib/prestocks";
import { runRankingNow } from "../lib/ranking";
import { resetRuntimeConfigForTests } from "../lib/runtime-config";
import { MINTS, type PrestocksProduct } from "../lib/universe";

const UNAVAILABLE = "Ranking Jeva jest teraz niedostępny";

function product(name: string): PrestocksProduct {
  return {
    name,
    symbol: name.toUpperCase(),
    mint: MINTS[name] ?? "",
    token_price_usd: 2,
    mark_price_usd: 2,
    premium_pct: 0,
    premium_source: "test",
    near_ipo: false,
  };
}

function productsResult(): ProductsFetchResult {
  return {
    products: ["OpenAI", "Anthropic", "Anduril"].map(product),
    totals: null,
    premiumsSource: "test",
    dataSource: "api_proxy",
    corsError: false,
    errorPl: null,
  };
}

function three() {
  return [
    { name: "OpenAI", score: 80 },
    { name: "Anthropic", score: 70 },
    { name: "Anduril", score: 60 },
  ];
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

function install(opts: { host: string; typesafe: string }) {
  const prevWindow = globalThis.window;
  const prevLocal = globalThis.localStorage;
  const prevFetch = globalThis.fetch;
  const prevApi = process.env.NEXT_PUBLIC_DCA_API_URL;
  const prevDefault = process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
  const local = memoryStorage();
  local.setItem(LS_TYPESAFE, opts.typesafe);
  globalThis.localStorage = local;
  (globalThis as { window?: Window }).window = {
    location: {
      hostname: opts.host,
      origin: `https://${opts.host}`,
    },
  } as Window;
  delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
  resetRuntimeConfigForTests();
  return {
    setFetch(fetchImpl: typeof fetch) {
      globalThis.fetch = fetchImpl;
    },
    setApi(url: string | undefined) {
      if (url == null) delete process.env.NEXT_PUBLIC_DCA_API_URL;
      else process.env.NEXT_PUBLIC_DCA_API_URL = url;
    },
    restore() {
      globalThis.fetch = prevFetch;
      if (prevWindow === undefined) delete (globalThis as { window?: Window }).window;
      else globalThis.window = prevWindow;
      if (prevLocal === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        globalThis.localStorage = prevLocal;
      }
      if (prevApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
      else process.env.NEXT_PUBLIC_DCA_API_URL = prevApi;
      if (prevDefault === undefined) {
        delete process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY;
      } else {
        process.env.NEXT_PUBLIC_TYPESAFE_DEFAULT_KEY = prevDefault;
      }
      resetRuntimeConfigForTests();
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const purchaseBlocked = {
  purchaseDisabled: true,
  sigUnresolved: false,
  buyInFlight: false,
  txPending: false,
  statusError: false,
  top3Empty: true,
  connected: true,
  onChainReady: true,
  vaultTooLow: false,
};

async function expectUnavailable(run: () => Promise<unknown>) {
  await assert.rejects(run(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, UNAVAILABLE);
    return true;
  });
  assert.equal(purchaseDisabledReasonKey(purchaseBlocked), "purchase.disabled.noRecs");
}

describe("ranking only from Jev", { concurrency: false }, () => {
  test("no TypeSafe key leaves no Top-3 and purchase stays inactive", async () => {
    const env = install({ host: "localhost", typesafe: "" });
    env.setApi(undefined);
    let calls = 0;
    env.setFetch((async () => {
      calls += 1;
      return jsonResponse({ ok: true, pipeline: ["prestocks", "jev"], top3: three() });
    }) as typeof fetch);
    try {
      await expectUnavailable(() => runRankingNow(productsResult()));
      assert.equal(calls, 0);
    } finally {
      env.restore();
    }
  });

  test("a Jev error leaves no Top-3 and purchase stays inactive", async () => {
    const env = install({ host: "localhost", typesafe: "test-key" });
    env.setApi(undefined);
    env.setFetch((async () => {
      throw new Error("timeout");
    }) as typeof fetch);
    try {
      await expectUnavailable(() => runRankingNow(productsResult()));
    } finally {
      env.restore();
    }
  });

  test("empty or incomplete Jev scores leave no Top-3 and purchase stays inactive", async () => {
    const env = install({ host: "localhost", typesafe: "test-key" });
    env.setApi(undefined);
    const bodies = [
      { answers: {} },
      { answers: { score_openai: { score: 3 }, score_anthropic: { score: 2 } } },
      {
        answers: {
          score_openai: { score: "3" },
          score_anthropic: { score: 2 },
          score_anduril: { score: 1 },
        },
      },
    ];
    try {
      for (const body of bodies) {
        env.setFetch((async () => jsonResponse(body)) as typeof fetch);
        await expectUnavailable(() => runRankingNow(productsResult()));
      }
    } finally {
      env.restore();
    }
  });

  test("/rank ok:false or without jev leaves no Top-3 and purchase stays inactive", async () => {
    const env = install({ host: "krzysztofpazdyk.github.io", typesafe: "test-key" });
    env.setApi("https://predca-api.example");
    const cases = [
      { ok: false, error: "down", pipeline: ["prestocks", "jev"], top3: three() },
      { ok: true, pipeline: ["prestocks", "metrics_rank"], top3: three() },
      { ok: true, pipeline: ["prestocks"], top3: three() },
    ];
    try {
      for (const rankBody of cases) {
        resetRuntimeConfigForTests();
        env.setFetch((async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("config.json")) {
            return jsonResponse({ dcaApiUrl: "", keeperUrl: "" });
          }
          if (url.includes("/rank")) return jsonResponse(rankBody);
          if (url.includes("/run/dry")) {
            return jsonResponse({ ok: false, error: "dry down" }, 500);
          }
          return jsonResponse({ ok: false }, 404);
        }) as typeof fetch);
        await expectUnavailable(() => runRankingNow(productsResult()));
      }
    } finally {
      env.restore();
    }
  });

  test("a Jev /rank with three numeric scores is the Top-3", async () => {
    const env = install({ host: "krzysztofpazdyk.github.io", typesafe: "test-key" });
    env.setApi("https://predca-api.example");
    env.setFetch((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("config.json")) {
        return jsonResponse({ dcaApiUrl: "", keeperUrl: "" });
      }
      if (url.includes("/rank")) {
        return jsonResponse({
          ok: true,
          pipeline: ["prestocks", "jev"],
          top3: three(),
        });
      }
      return jsonResponse({ ok: false }, 404);
    }) as typeof fetch);
    try {
      const rank = await runRankingNow(productsResult());
      assert.equal(rank.mode, "byok_ai");
      assert.equal(rank.pipeline.includes("jev"), true);
      assert.deepEqual(
        rank.top3.map((row) => row.name),
        ["OpenAI", "Anthropic", "Anduril"],
      );
      assert.equal(
        purchaseDisabledReasonKey({
          ...purchaseBlocked,
          purchaseDisabled: false,
          top3Empty: false,
        }),
        null,
      );
    } finally {
      env.restore();
    }
  });
});

test("Overview shows the Jev message in place of the Top-3 list", () => {
  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overview, /rankBlocked && rankError/);
  assert.match(overview, /text-\[#f87171\]/);
  assert.match(overview, /rank\.err\.jevUnavailable/);
  assert.doesNotMatch(overview, /rankFlat/);
  assert.doesNotMatch(overview, /isFlatFallback/);
  assert.doesNotMatch(overview, /metrics_fallback/);
  assert.doesNotMatch(overview, /Top-3 · AI \(BYOK\)/);
  assert.match(overview, /Top-3 · AI/);
  assert.equal(translate("pl", "rank.err.jevUnavailable"), UNAVAILABLE);
  assert.equal(
    translate("en", "rank.err.jevUnavailable"),
    "Jev ranking is unavailable right now",
  );
  assert.equal(translate("pl", "holdings.titleOnChain"), "Alokacja");
  assert.equal(translate("en", "holdings.titleOnChain"), "Allocation");
  assert.equal(overview.includes("lastPurchase"), false);
  assert.equal(overview.includes("Ostatni zakup"), false);
  const i18n = readFileSync(new URL("../lib/i18n.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(i18n, /Awaryjny ranking metryczny/);
  assert.doesNotMatch(i18n, /Fallback metric/);
  assert.doesNotMatch(i18n, /metryki/);
  const keeper = readFileSync(
    new URL("./weekly-vault-buy.mjs", import.meta.url),
    "utf8",
  );
  assert.match(keeper, /Jev niedostępny, zakup nie wysłany/);
  assert.doesNotMatch(keeper, /metrics_fallback/);
  assert.doesNotMatch(keeper, /latest-run-sample\.json/);
});
