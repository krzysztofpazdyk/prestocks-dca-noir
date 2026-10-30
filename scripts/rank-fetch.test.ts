import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rankResultFromProxy } from "../lib/dca-api";
import { emptyJupPrices, JUP_CACHE_KEY, parseJupResponse } from "../lib/jup-prices";
import { dcaApiBase, LS_XAI } from "../lib/keys";
import { fetchPrestocksProducts } from "../lib/prestocks";
import { MINTS, REFERENCE_MINTS, type PrestocksProduct } from "../lib/universe";

test("Grok in the label follows the pipeline, not a stored xAI key", () => {
  const previous = globalThis.localStorage;
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => {
      mem.set(key, value);
    },
    removeItem: (key: string) => {
      mem.delete(key);
    },
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  try {
    localStorage.setItem(LS_XAI, "xai-test-key");
    const jev = rankResultFromProxy(
      { ok: true, top3: [{ name: "OpenAI", score: 1 }], pipeline: ["prestocks", "jev"] },
      [],
      { premiumsMatter: false },
    );
    assert.equal(jev.sourceLabel.includes("Grok"), false);
    const grok = rankResultFromProxy(
      {
        ok: true,
        top3: [{ name: "OpenAI", score: 1 }],
        pipeline: ["prestocks", "grok", "jev"],
      },
      [],
      { premiumsMatter: false },
    );
    assert.equal(grok.sourceLabel.includes("Grok+Jev"), true);
  } finally {
    if (previous === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      globalThis.localStorage = previous;
    }
  }

  const api = readFileSync(new URL("../lib/dca-api.ts", import.meta.url), "utf8");
  const dry = api.slice(
    api.indexOf("export async function triggerDryRun"),
    api.indexOf("export type RankProxyResponse"),
  );
  assert.match(dry, /pipeline[\s\S]{0,160}includes\("grok"\)/);
  assert.doesNotMatch(dry, /metrics_fallback/);
  assert.doesNotMatch(dry, /dryNoByok/);
  const overview = readFileSync(new URL("../components/OverviewView.tsx", import.meta.url), "utf8");
  const title = overview.slice(
    overview.indexOf("function top3TitleFromRank"),
    overview.indexOf("const BUDGET_EPS"),
  );
  assert.match(title, /includes\("grok"\)/);
  assert.match(title, /Top-3 · AI/);
  assert.doesNotMatch(title, /BYOK/);
  assert.doesNotMatch(title, /metryki/);
  assert.doesNotMatch(title, /sourceLabel/);
  const disabled = overview.slice(
    overview.indexOf("const purchaseDisabled"),
    overview.indexOf("function fmtTile"),
  );
  assert.doesNotMatch(disabled, /rankFlat/);
  assert.doesNotMatch(disabled, /flatRanking/);
  assert.match(disabled, /top3\.length < 3/);
  const rpc = disabled.indexOf("purchase.disabled.rpcError");
  const none = disabled.indexOf("purchase.disabled.noRecs");
  assert.ok(rpc >= 0 && rpc < none);
  assert.match(overview, /productsResult\.errorPl/);
});

function sampleProducts() {
  return Object.keys(MINTS).slice(0, 3).map((name) => ({
    name,
    symbol: name.toUpperCase(),
    mint: MINTS[name],
    token_price_usd: 2,
    mark_price_usd: null,
    premium_pct: 0,
    premium_source: "api_proxy",
    near_ipo: false,
  }));
}

test("product fetch skips dead hosts off localhost and calls Jupiter once", async () => {
  const prevFetch = globalThis.fetch;
  const prevWindow = globalThis.window;
  const prevApi = process.env.NEXT_PUBLIC_DCA_API_URL;
  process.env.NEXT_PUBLIC_DCA_API_URL = "https://predca-api.example/";
  assert.equal(dcaApiBase(), "https://predca-api.example");
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/prestocks/products")) {
      return new Response(JSON.stringify({ products: sampleProducts() }), { status: 200 });
    }
    if (url.includes("lite-api.jup.ag")) {
      return new Response("{}", { status: 200 });
    }
    if (url.includes("prestocks.com")) {
      throw new Error("Failed to fetch");
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  }) as typeof fetch;

  try {
    (globalThis as { window?: Window }).window = {
      location: { hostname: "krzysztofpazdyk.github.io", origin: "https://krzysztofpazdyk.github.io" },
    } as Window;
    calls.length = 0;
    const prices = emptyJupPrices(1_700_000_000_000);
    const offHost = await fetchPrestocksProducts(prices);
    assert.equal(offHost.products.length, 3);
    assert.equal(calls.some((url) => url.includes("/api/prestocks/live/")), false);
    assert.equal(calls.some((url) => url.includes("prestocks.com")), false);
    assert.equal(calls.filter((url) => url.includes("/prestocks/products")).length, 1);
    assert.equal(calls.some((url) => url.includes("lite-api.jup.ag")), false);

    (globalThis as { window?: Window }).window = {
      location: { hostname: "localhost", origin: "http://localhost:3000" },
    } as Window;
    calls.length = 0;
    await fetchPrestocksProducts(prices);
    const liveAt = calls.findIndex((url) => url.includes("/api/prestocks/live/"));
    const directAt = calls.findIndex((url) => url.includes("prestocks.com"));
    const apiAt = calls.findIndex((url) => url.includes("/prestocks/products"));
    assert.ok(liveAt >= 0 && liveAt < directAt && directAt < apiAt);
    assert.equal(calls.some((url) => url.includes("lite-api.jup.ag")), false);

    calls.length = 0;
    await fetchPrestocksProducts();
    assert.equal(calls.filter((url) => url.includes("lite-api.jup.ag")).length, 1);
    const firstLive = calls.findIndex((url) => url.includes("/api/prestocks/live/"));
    const firstDirect = calls.findIndex((url) => url.includes("prestocks.com"));
    const firstApi = calls.findIndex((url) => url.includes("/prestocks/products"));
    assert.ok(firstLive >= 0 && firstLive < firstDirect && firstDirect < firstApi);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      globalThis.window = prevWindow;
    }
    if (prevApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
    else process.env.NEXT_PUBLIC_DCA_API_URL = prevApi;
  }
});

function hostedProduct(name: string, nearIpo: boolean): PrestocksProduct {
  return {
    name,
    symbol: name.toUpperCase(),
    mint: MINTS[name] ?? "",
    token_price_usd: 2,
    mark_price_usd: null,
    premium_pct: null,
    premium_source: "no_data",
    near_ipo: nearIpo,
  };
}

function withBrowser(run: () => Promise<void>): Promise<void> {
  const prevFetch = globalThis.fetch;
  const prevWindow = globalThis.window;
  const prevApi = process.env.NEXT_PUBLIC_DCA_API_URL;
  return run().finally(() => {
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) delete (globalThis as { window?: Window }).window;
    else globalThis.window = prevWindow;
    if (prevApi === undefined) delete process.env.NEXT_PUBLIC_DCA_API_URL;
    else process.env.NEXT_PUBLIC_DCA_API_URL = prevApi;
  });
}

test("hosted products do not keep a server near-IPO flag", async () => {
  await withBrowser(async () => {
    process.env.NEXT_PUBLIC_DCA_API_URL = "https://predca-api.example/";
    (globalThis as { window?: Window }).window = {
      location: {
        hostname: "krzysztofpazdyk.github.io",
        origin: "https://krzysztofpazdyk.github.io",
      },
    } as Window;
    const products = Object.keys(MINTS).map((name) =>
      hostedProduct(name, name === "SpaceX"),
    );
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/prestocks/products")) {
        return new Response(JSON.stringify({ products }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }) as typeof fetch;

    const got = await fetchPrestocksProducts(emptyJupPrices(1_700_000_000_000));
    assert.equal(got.products.find((row) => row.name === "SpaceX")?.near_ipo, false);
  });
});

function jupPrices(now: number) {
  const freshAt = new Date(now - 3_600_000).toISOString();
  const raw: Record<string, unknown> = {};
  for (const [name, mint] of Object.entries(MINTS)) {
    raw[mint] = {
      usdPrice: 80,
      liquidity: 80_000,
      ...(name === "Kalshi"
        ? {}
        : {
            stockData: { id: "prestocks", price: 100, updatedAt: freshAt },
          }),
    };
  }
  raw[REFERENCE_MINTS.SpaceX.primary] = {
    usdPrice: 144.46,
    stockData: { id: "xstocks", price: 167.16, updatedAt: freshAt },
  };
  return {
    quotes: parseJupResponse(raw, now),
    fetchedAt: now,
    source: "live" as const,
    suspect: [] as string[],
    carried: [] as string[],
  };
}

function emptyStorage(): Storage {
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

test("jupiter alone lists the eight names, and no jupiter or cache is an empty error", async () => {
  await withBrowser(async () => {
    delete process.env.NEXT_PUBLIC_DCA_API_URL;
    (globalThis as { window?: Window }).window = {
      location: {
        hostname: "krzysztofpazdyk.github.io",
        origin: "https://krzysztofpazdyk.github.io",
      },
    } as Window;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const now = Date.parse("2026-10-10T12:00:00Z");
    const listed = await fetchPrestocksProducts(jupPrices(now));
    assert.equal(listed.dataSource, "jupiter_only");
    assert.equal(listed.products.length, 8);
    assert.equal(listed.products.find((row) => row.name === "SpaceX")?.near_ipo, false);
    assert.equal(
      listed.products.find((row) => row.name === "SpaceX")?.premium_source,
      "jupiter_stockdata",
    );
    const anth = listed.products.find((row) => row.name === "Anthropic");
    assert.equal(anth?.token_price_usd, 80);
    assert.equal(anth?.premium_pct, -20);
    assert.equal(anth?.market_cap_usd, null);
    assert.equal(anth?.holders, null);
    const kalshi = listed.products.find((row) => row.name === "Kalshi");
    assert.equal(kalshi?.token_price_usd, 80);
    assert.equal(kalshi?.premium_pct, null);
    assert.equal(kalshi?.premium_source, "no_data");
    assert.equal(calls.some((url) => url.includes("prestocks-snapshot")), false);

    const prevStorage = globalThis.localStorage;
    const store = emptyStorage();
    const cachedAt = Date.now();
    store.setItem(
      JUP_CACHE_KEY,
      JSON.stringify({
        quotes: jupPrices(cachedAt).quotes,
        fetchedAt: cachedAt,
        priceAt: {},
      }),
    );
    globalThis.localStorage = store;
    try {
      const fromCache = await fetchPrestocksProducts(emptyJupPrices(cachedAt));
      assert.equal(fromCache.dataSource, "jupiter_only");
      assert.equal(fromCache.products.length, 8);
      assert.equal(
        fromCache.products.find((row) => row.name === "Anthropic")?.token_price_usd,
        80,
      );
      assert.equal(
        fromCache.products.find((row) => row.name === "Kalshi")?.premium_pct,
        null,
      );
    } finally {
      if (prevStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        globalThis.localStorage = prevStorage;
      }
    }
  });

  await withBrowser(async () => {
    delete process.env.NEXT_PUBLIC_DCA_API_URL;
    (globalThis as { window?: Window }).window = {
      location: {
        hostname: "krzysztofpazdyk.github.io",
        origin: "https://krzysztofpazdyk.github.io",
      },
    } as Window;
    const prevStorage = globalThis.localStorage;
    globalThis.localStorage = emptyStorage();
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    try {
      const none = await fetchPrestocksProducts();
      assert.equal(none.dataSource, "none");
      assert.equal(none.products.length, 0);
      assert.equal(none.premiumsSource, "none");
      assert.equal(none.errorKey, "prestocks.snapshotError");
    } finally {
      if (prevStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        globalThis.localStorage = prevStorage;
      }
    }
  });

  await withBrowser(async () => {
    process.env.NEXT_PUBLIC_DCA_API_URL = "https://predca-api.example/";
    (globalThis as { window?: Window }).window = {
      location: {
        hostname: "krzysztofpazdyk.github.io",
        origin: "https://krzysztofpazdyk.github.io",
      },
    } as Window;
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const checked = new Date().toISOString();
    const products = Object.keys(MINTS).map((name) => {
      const row = hostedProduct(name, name === "SpaceX");
      if (name !== "Kalshi") return row;
      return {
        ...row,
        ipoStatus: "announced",
        ipoDate: soon,
        source: "https://example.com/kalshi",
        checkedAt: checked,
      };
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/prestocks/products")) {
        return new Response(JSON.stringify({ products }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }) as typeof fetch;
    const got = await fetchPrestocksProducts(emptyJupPrices(1_700_000_000_000));
    assert.equal(got.products.find((row) => row.name === "SpaceX")?.near_ipo, false);
    assert.equal(got.products.find((row) => row.name === "Kalshi")?.near_ipo, true);
  });
});
