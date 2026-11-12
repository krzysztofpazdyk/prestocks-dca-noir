import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { APP_VERSION } from "../lib/app-version";
import {
  ceilFeeUsd,
  feeUsdForRun,
  historyFeeLabel,
  purchaseFeeEnabled,
  vaultLowCopy,
} from "../lib/fee-display";
import { translate } from "../lib/i18n";
import { setNumberLocaleForTests } from "../lib/number-format";
import { isVaultLowReason } from "../lib/vault-low-reason";

const PL_HINT =
  "Opłata za zakup = rzeczywisty koszt sieci Solana, zwykle poniżej 0,01 USD, maks. 0,10 USD.";
const EN_HINT =
  "Purchase fee = the actual Solana network cost, usually under 0.01 USD, max 0.10 USD.";

const settingsSrc = readFileSync(
  new URL("../components/SettingsView.tsx", import.meta.url),
  "utf8",
);
const overviewSrc = readFileSync(
  new URL("../components/OverviewView.tsx", import.meta.url),
  "utf8",
);
const historySrc = readFileSync(
  new URL("../components/HistoryView.tsx", import.meta.url),
  "utf8",
);
const historyEntrySrc = readFileSync(
  new URL("../components/HistoryRunEntry.tsx", import.meta.url),
  "utf8",
);
const i18nSrc = readFileSync(new URL("../lib/i18n.tsx", import.meta.url), "utf8");

type Copy = (key: string, vars?: Record<string, string | number>) => string;

function dictValues(name: "pl" | "en"): string[] {
  const start = i18nSrc.indexOf(`const ${name}: Dict`);
  const end =
    name === "pl"
      ? i18nSrc.indexOf("const en: Dict")
      : i18nSrc.indexOf("const dictionaries");
  const block = i18nSrc.slice(start, end);
  const values: string[] = [];
  const keyRe = /"(?:\\.|[^"\\])*"\s*:/g;
  while (keyRe.exec(block)) {
    let i = keyRe.lastIndex;
    while (i < block.length && /\s/.test(block[i] ?? "")) i++;
    if (block[i] !== '"') continue;
    i++;
    let value = "";
    while (i < block.length) {
      const ch = block[i];
      if (ch === "\\") {
        value += block[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') break;
      value += ch;
      i++;
    }
    values.push(value);
  }
  return values;
}

function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) walkSources(path, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(path);
  }
  return out;
}

test("APP_VERSION stays 5.0.25", () => {
  assert.equal(APP_VERSION, "5.0.25");
});

test("the fee hint is shown in settings and on deposit only when the fee is on", () => {
  assert.equal(purchaseFeeEnabled({ feeEnabled: true }), true);
  assert.equal(purchaseFeeEnabled({ feeEnabled: false }), false);
  assert.equal(purchaseFeeEnabled({}), false);
  assert.equal(purchaseFeeEnabled(null), false);
  assert.equal(purchaseFeeEnabled(undefined), false);
  assert.equal(
    purchaseFeeEnabled({ feeUsd: 0.02 } as { feeEnabled?: boolean }),
    false,
  );

  assert.equal(translate("pl", "settings.serviceFee"), PL_HINT);
  assert.equal(translate("en", "settings.serviceFee"), EN_HINT);
  assert.equal(translate("pl", "deposit.feeHint"), PL_HINT);
  assert.equal(translate("en", "deposit.feeHint"), EN_HINT);

  assert.match(settingsSrc, /purchaseFeeEnabled\(autoBuy\)\s*\?/);
  assert.match(settingsSrc, /t\("settings\.serviceFee"\)/);
  assert.match(overviewSrc, /purchaseFeeEnabled\(autoBuy\)\s*\?/);
  assert.match(overviewSrc, /t\("deposit\.feeHint"\)/);
});

test("history shows each run's actual fee and skips zero or a missing fee", () => {
  const tPl: Copy = (key, vars) => translate("pl", key, vars);
  const tEn: Copy = (key, vars) => translate("en", key, vars);
  setNumberLocaleForTests("pl-PL");
  try {
    const low = historyFeeLabel(0.0023, tPl);
    const high = historyFeeLabel(0.0041, tPl);
    assert.equal(low, "opłata 0,0023 USD");
    assert.equal(high, "opłata 0,0041 USD");
    assert.notEqual(low, high);
    assert.equal(historyFeeLabel(0, tPl), null);
    assert.equal(historyFeeLabel(undefined, tPl), null);
    assert.equal(historyFeeLabel(null, tPl), null);
  } finally {
    setNumberLocaleForTests(null);
  }
  assert.equal(historyFeeLabel(0.0023, tEn), "fee 0.0023 USD");
  assert.equal(historyFeeLabel(0.0041, tEn), "fee 0.0041 USD");
  assert.equal(ceilFeeUsd(0.0023), 0.0023);
  assert.equal(ceilFeeUsd(0.00231), 0.0024);
  assert.equal(ceilFeeUsd(0.00001), 0.0001);

  const fees = [
    { runIndex: 1, feeUsd: 0.0023 },
    { runIndex: 2, feeUsd: 0 },
    { runIndex: 4, feeUsd: 0.0041 },
  ];
  assert.equal(feeUsdForRun(fees, "1"), 0.0023);
  assert.equal(feeUsdForRun(fees, 4), 0.0041);
  assert.equal(feeUsdForRun(fees, 2), 0);
  assert.equal(feeUsdForRun(fees, 9), undefined);
  assert.equal(historyFeeLabel(feeUsdForRun(fees, 2), tEn), null);
  assert.match(historySrc, /feeUsdForRun\(/);
  assert.match(historyEntrySrc, /historyFeeLabel\(/);
  assert.match(historyEntrySrc, /feeText \?/);
});

test("vault_low uses the server need and fee, and the budget when need is absent", () => {
  const tPl: Copy = (key, vars) => translate("pl", key, vars);
  const tEn: Copy = (key, vars) => translate("en", key, vars);
  setNumberLocaleForTests("en-US");
  try {
    const withFee = vaultLowCopy({ need: 3.01, feeUsd: 0.01 }, 3, tPl);
    const noFee = vaultLowCopy({ need: 3, feeUsd: 0 }, 9, tPl);
    const missing = vaultLowCopy({}, 12.5, tPl);
    assert.equal(
      withFee,
      "Za mało środków w vaulcie (potrzeba 3.01 USDC, w tym opłata 0.01 USD).",
    );
    assert.equal(noFee, "Za mało środków w vaulcie (potrzeba 3.00 USDC).");
    assert.equal(missing.includes("?"), false);
    assert.equal(
      missing,
      "Za mało środków w vaulcie (potrzeba 12.50 USDC).",
    );
    assert.equal(
      vaultLowCopy({ need: 4.5, feeUsd: 0.0023 }, 1, tEn),
      "Not enough funds in the vault (need 4.50 USDC, including a 0.0023 USD fee).",
    );
    assert.equal(
      vaultLowCopy({ feeUsd: 0 }, 2, tEn),
      "Not enough funds in the vault (need 2.00 USDC).",
    );
  } finally {
    setNumberLocaleForTests(null);
  }
});

test("components and i18n keep 0.01 only inside the real-cost hint", () => {
  const root = new URL("..", import.meta.url).pathname;
  const files = [
    ...walkSources(join(root, "components")),
    ...walkSources(join(root, "app")),
    join(root, "lib", "i18n.tsx"),
  ];
  const allowed =
    /zwykle poniżej 0,01 USD|usually under 0\.01 USD/;
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/0,01|0\.01/.test(line)) return;
      if (allowed.test(line)) return;
      hits.push(`${file}:${index + 1}:${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("no Polish or English i18n value contains keeper", () => {
  for (const value of [...dictValues("pl"), ...dictValues("en")]) {
    assert.equal(/keeper/i.test(value), false, value);
  }
  assert.equal(i18nSrc.includes('"auto.status.keeperDown"'), true);
  assert.equal(/keeper/i.test(translate("pl", "auto.status.keeperDown")), false);
  assert.equal(/keeper/i.test(translate("en", "auto.status.keeperDown")), false);
});

test("vault-low matches the vault phrases and not a network fee", () => {
  assert.equal(isVaultLowReason("fee payer"), false);
  assert.equal(isVaultLowReason("insufficient lamports for fee"), false);
  assert.equal(isVaultLowReason("priority fee 0.01"), false);
  assert.equal(
    isVaultLowReason(
      "Za mało środków w vaulcie (potrzeba 3.01 USDC, w tym opłata 0.01 USD)",
    ),
    true,
  );
  for (const reason of [
    "vault_low",
    "insufficient vault",
    "InsufficientVault",
    "Error Number: 6002",
    "custom program error: 0x1772",
    "za mało usdc",
    "not enough funds in the vault",
  ]) {
    assert.equal(isVaultLowReason(reason), true, reason);
  }
});
