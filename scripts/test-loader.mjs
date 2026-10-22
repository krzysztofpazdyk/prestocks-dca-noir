/**
 * Node test hooks for this package.
 * The app is not `"type": "module"`. `--experimental-strip-types` does not
 * resolve `@/` and does not turn Anchor's CJS `BN` into a named ESM export.
 * `.tsx` (the i18n module) is transpiled with the typescript devDependency.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ANCHOR_URL = "noir-test:anchor-cjs";

function candidates(base) {
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.json`];
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@coral-xyz/anchor") {
    return { url: ANCHOR_URL, shortCircuit: true };
  }
  if (specifier.startsWith("@/") || specifier.startsWith(".")) {
    const parentPath =
      context.parentURL && context.parentURL.startsWith("file:")
        ? fileURLToPath(context.parentURL)
        : join(root, "package.json");
    const base = specifier.startsWith("@/")
      ? join(root, specifier.slice(2))
      : join(dirname(parentPath), specifier);
    for (const file of candidates(base)) {
      if (existsSync(file) && statSync(file).isFile()) {
        return nextResolve(pathToFileURL(file).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === ANCHOR_URL) {
    const source = [
      'import { createRequire } from "node:module";',
      `const require = createRequire(${JSON.stringify(join(root, "package.json"))});`,
      'const anchor = require("@coral-xyz/anchor");',
      "export const BN = anchor.BN;",
      "export const AnchorProvider = anchor.AnchorProvider;",
      "export const Program = anchor.Program;",
      "export const web3 = anchor.web3;",
      "export const utils = anchor.utils;",
      "export const setProvider = anchor.setProvider;",
      "export const getProvider = anchor.getProvider;",
      "export default anchor;",
      "",
    ].join("\n");
    return { format: "module", source, shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".json")) {
    const source = `export default ${readFileSync(fileURLToPath(url), "utf8")};\n`;
    return { format: "module", source, shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const require = createRequire(join(root, "package.json"));
    const ts = require("typescript");
    const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url),
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
