import "./build-webpo.mjs";

import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(project, "dist", "firefox");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  cp(join(project, "icons"), join(output, "icons"), { recursive: true }),
  cp(join(project, "popup"), join(output, "popup"), { recursive: true }),
  cp(join(project, "src"), join(output, "src"), { recursive: true }),
  copyFile(join(project, "manifest.firefox.json"), join(output, "manifest.json")),
]);

console.log(`Firefox extension built at ${output}`);
