import { parseExclusions, userExclusions } from "@/lib/exclusions";
import type { KeeperPrefsPayload } from "@/lib/keeper-client";

/** Values the settings form started from. A later save compares the keeper to these. */
export type PrefsEditBaseline = {
  exclusionsKey: string;
  deadlineInvalid: boolean;
  ipoPremium: boolean;
  buyDespiteIpo: boolean;
};

export function exclusionsEditKey(raw: string): string {
  return parseExclusions(raw)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("\0");
}

export function makePrefsEditBaseline(
  exclusionsRaw: string,
  deadlineInvalid: boolean,
  ipoPremium: boolean,
  buyDespiteIpo: boolean,
): PrefsEditBaseline {
  return {
    exclusionsKey: exclusionsEditKey(exclusionsRaw),
    deadlineInvalid,
    ipoPremium,
    buyDespiteIpo,
  };
}

export type PrefsSaveDecision =
  | { kind: "unreachable" }
  | { kind: "reload"; prefs: KeeperPrefsPayload | undefined }
  | { kind: "save" };

/**
 * Just before the prefs signature. A failed public read does not sign.
 * Prefs that differ from the edit's start reload instead of posting.
 */
export function decidePrefsSave(
  fresh: { ok: boolean; prefs?: KeeperPrefsPayload | null; error?: string },
  syncedBaseline: PrefsEditBaseline | null,
): PrefsSaveDecision {
  if (!fresh.ok) return { kind: "unreachable" };
  if (!syncedBaseline) return { kind: "save" };
  const remote = baselineFromKeeperPrefs(fresh.prefs, syncedBaseline);
  if (!prefsEditBaselinesEqual(syncedBaseline, remote)) {
    return { kind: "reload", prefs: fresh.prefs ?? undefined };
  }
  return { kind: "save" };
}

export function prefsEditBaselinesEqual(
  a: PrefsEditBaseline | null,
  b: PrefsEditBaseline,
): boolean {
  if (!a) return false;
  return (
    a.exclusionsKey === b.exclusionsKey &&
    a.deadlineInvalid === b.deadlineInvalid &&
    a.ipoPremium === b.ipoPremium &&
    a.buyDespiteIpo === b.buyDespiteIpo
  );
}

/**
 * Public status prefs, with any omitted field left as the edit started.
 * Does not write localStorage.
 */
export function baselineFromKeeperPrefs(
  prefs: KeeperPrefsPayload | null | undefined,
  fallback: PrefsEditBaseline,
): PrefsEditBaseline {
  const exclusionsRaw = Array.isArray(prefs?.exclusions)
    ? userExclusions(prefs.exclusions.join(", ")).join(", ")
    : null;
  const deadline =
    typeof prefs?.deadlines_unimportant === "boolean"
      ? prefs.deadlines_unimportant
      : fallback.deadlineInvalid;
  const ipo =
    typeof prefs?.premiums_matter === "boolean"
      ? prefs.premiums_matter
      : typeof prefs?.premiums_especially_near_ipo === "boolean"
        ? prefs.premiums_especially_near_ipo
        : fallback.ipoPremium;
  const despite =
    typeof prefs?.buy_despite_ipo === "boolean"
      ? prefs.buy_despite_ipo
      : fallback.buyDespiteIpo;
  if (exclusionsRaw == null) {
    return {
      exclusionsKey: fallback.exclusionsKey,
      deadlineInvalid: deadline,
      ipoPremium: ipo,
      buyDespiteIpo: despite,
    };
  }
  return makePrefsEditBaseline(exclusionsRaw, deadline, ipo, despite);
}
