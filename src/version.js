import { createRequire } from "node:module";

export const VERSION = createRequire(import.meta.url)("../package.json").version;
