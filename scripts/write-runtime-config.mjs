/**
 * Write public config.json for a Cloudflare quick-tunnel host.
 * Usage: node scripts/write-runtime-config.mjs <tunnel-url> [output-path]
 * Validates with the same rules as the app. Does not read environment secrets.
 */
import { writeFileSync } from "node:fs";
import { acceptPublicUrl } from "../lib/public-url.mjs";

const raw = process.argv[2] ?? "";
const outPath = process.argv[3] ?? "public/config.json";
const dcaApiUrl = acceptPublicUrl(raw);
const keeperUrl = dcaApiUrl ? acceptPublicUrl(`${dcaApiUrl}/keeper`) : "";

if (!dcaApiUrl || !keeperUrl) {
  process.exit(1);
}

const body = {
  dcaApiUrl,
  keeperUrl,
  updatedAt: new Date().toISOString(),
};

try {
  writeFileSync(outPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
} catch {
  process.exit(1);
}

process.stdout.write(`${dcaApiUrl}\n${outPath}\n`);
