import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../lib/mock-data";
import {
  filterDeadlines,
  filterExpired,
  filterPastDeadline,
  hasKnownDeadline,
  isDeadlinePast,
  rankPrefsForApi,
} from "../lib/rank-prefs";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const FUTURE = Date.parse("2027-03-12T23:59:00Z");
const PAST = Date.parse("2026-01-01T00:00:00Z");

type Row = {
  name: string;
  deadline_at?: number | null;
  deadline_invalid?: boolean;
};

function names(rows: Row[]): string[] {
  return rows.map((row) => row.name);
}

const none: Row = { name: "OpenAI" };
const future: Row = { name: "Kalshi", deadline_at: FUTURE, deadline_invalid: false };
const past: Row = { name: "Anduril", deadline_at: PAST, deadline_invalid: true };
const flagOnly: Row = { name: "FigureAI", deadline_invalid: true };

test("toggle default stays off and the API field keeps its name and polarity", () => {
  assert.equal(DEFAULT_SETTINGS.deadlineInvalid, false);
  const body = rankPrefsForApi({
    exclusions: [],
    exclusionsRaw: "",
    deadlinesUnimportant: true,
    premiumsMatter: true,
    premiumsEspeciallyNearIpo: true,
    deadlineInvalid: true,
    ipoPremiumMatters: true,
    buyDespiteIpo: false,
  });
  assert.equal(body.deadlines_unimportant, true);
});

test("toggle on keeps a future deadline and always drops a past one", () => {
  const onFuture = filterExpired([none, future], true, NOW);
  assert.deepEqual(names(onFuture), ["OpenAI", "Kalshi"]);

  const onPast = filterExpired([none, past], true, NOW);
  assert.deepEqual(names(onPast), ["OpenAI"]);

  const offFuture = filterExpired([none, future], false, NOW);
  assert.deepEqual(names(offFuture), ["OpenAI"]);

  const offNone = filterExpired([none], false, NOW);
  assert.deepEqual(names(offNone), ["OpenAI"]);

  const offPast = filterExpired([none, past], false, NOW);
  assert.deepEqual(names(offPast), ["OpenAI"]);

  const onFlag = filterExpired([none, flagOnly], true, NOW);
  assert.deepEqual(names(onFlag), ["OpenAI"]);
});

test("a past date beats a stale not-invalid flag, and a future date beats a stale invalid flag", () => {
  const staleOk: Row = { name: "Kalshi", deadline_at: PAST, deadline_invalid: false };
  const staleBad: Row = { name: "Kalshi", deadline_at: FUTURE, deadline_invalid: true };
  assert.equal(isDeadlinePast(staleOk, NOW), true);
  assert.equal(isDeadlinePast(staleBad, NOW), false);
  assert.equal(hasKnownDeadline(staleOk), true);
  assert.equal(hasKnownDeadline(staleBad), true);
  assert.deepEqual(names(filterExpired([staleOk], true, NOW)), []);
  assert.deepEqual(names(filterExpired([staleBad], true, NOW)), ["Kalshi"]);
  assert.deepEqual(names(filterExpired([staleBad], false, NOW)), []);
});

test("filterPastDeadline ignores the toggle and filterDeadlines is the same export", () => {
  assert.equal(filterDeadlines, filterExpired);
  assert.deepEqual(names(filterPastDeadline([none, future, past], NOW)), ["OpenAI", "Kalshi"]);
  assert.deepEqual(names(filterExpired([none, future, past], true, NOW)), ["OpenAI", "Kalshi"]);
  assert.deepEqual(names(filterExpired([none, future, past], false, NOW)), ["OpenAI"]);
});

test("manual buy and ranking re-check expiry vs now", () => {
  const overview = readFileSync(
    new URL("../components/OverviewView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(overview, /filterPastDeadline\(active\?\.top3/);
  assert.match(overview, /filterPastDeadline\(top3, Date\.now\(\)\)/);
  assert.match(overview, /buyable\.length < 3/);
  assert.match(overview, /top3\.length < 3/);

  const ranking = readFileSync(new URL("../lib/ranking.ts", import.meta.url), "utf8");
  assert.match(ranking, /filterExpired\(/);
  assert.match(ranking, /prefs\.deadlinesUnimportant,\s*now/);
  assert.match(ranking, /enforceDeadlinePrefs/);

  const settings = readFileSync(
    new URL("../components/SettingsView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(settings, /t\("settings\.deadlineInvalidHint"\)/);

  const weekly = readFileSync(
    new URL("./weekly-vault-buy.mjs", import.meta.url),
    "utf8",
  );
  assert.match(weekly, /dropPastDeadlineNames/);
  assert.match(weekly, /Token po terminie ważności/);

  const ai = readFileSync(new URL("../lib/ai-rank.ts", import.meta.url), "utf8");
  assert.match(ai, /never pick names past expiry/);
  assert.match(ai, /exclude names with a known expiry date/);
  assert.doesNotMatch(ai, /buying with expiry allowed"/);
  assert.doesNotMatch(ai, /exclude expired \/ invalid-deadline names/);
});
