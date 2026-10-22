/** Public https URL check shared by the app and write-runtime-config.mjs. */

const MAX_URL_LENGTH = 300;

export function acceptPublicUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return "";
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.username !== "" || parsed.password !== "") return "";
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const allowed =
    parsed.protocol === "https:" || (parsed.protocol === "http:" && local);
  if (!allowed) return "";
  let out = trimmed;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}
