import { chmodSync, cpSync, rmSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const output = new URL("../dist/", import.meta.url);
rmSync(output, { recursive: true, force: true });
cpSync(source, output, {
  recursive: true,
  filter(path) {
    const name = relative(source, path);
    return (
      name !== "integration" && !name.startsWith(`integration${sep}`) && !name.endsWith(".test.js")
    );
  },
});
chmodSync(new URL("index.js", output), 0o755);
