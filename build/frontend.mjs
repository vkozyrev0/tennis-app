// Bundle the SPA's ES modules into one production script.
//
// The app stays build-free in development: index.html loads /app.entry.js and
// the server answers that route with this bundle when it exists, or with a
// one-line `import "/app.js"` when it does not. The Docker image runs this
// script, so the shipped app makes one script request instead of 65 while a
// local checkout keeps loading modules straight from disk.
//
//   npm run build      # -> frontend/dist/app.bundle.js (git-ignored)
//   rm -rf frontend/dist   # back to the module graph
import { build } from "esbuild";import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "frontend", "dist", "app.bundle.js");

mkdirSync(dirname(outfile), { recursive: true });
const result = await build({
  entryPoints: [join(root, "frontend", "app.js")],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
  legalComments: "none",
  metafile: true,
});

const modules = Object.keys(result.metafile.inputs).length;
const kb = (statSync(outfile).size / 1024).toFixed(1);
console.log(`bundled ${modules} modules -> ${outfile} (${kb} KB)`);
