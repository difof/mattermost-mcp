import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const sourceRoot = fileURLToPath(new URL("./src/", import.meta.url));

// Keep production-safe .js imports while source tests cross JS/TS boundaries.
// Native JS files win; only missing files inside src can resolve to legacy TS.
export default defineConfig({
  plugins: [
    {
      name: "mixed-source-extensions",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
        const candidate = resolve(dirname(importer.split("?")[0]), source);
        if (!candidate.startsWith(sourceRoot) || existsSync(candidate)) return null;
        const legacy = `${candidate.slice(0, -3)}.ts`;
        return existsSync(legacy) ? legacy : null;
      },
    },
  ],
});
