import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(project, "src", "webpo-page-entry.js")],
  outfile: join(project, "src", "webpo-page.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox142",
  minify: true,
  legalComments: "none",
});

console.log("Built src/webpo-page.js");
