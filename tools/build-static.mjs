/**
 * Build the hosted, serverless copy of Familiar.
 *
 * There is no bundler and no framework here on purpose. The app is already a
 * directory of files with relative paths, so publishing it is mostly copying —
 * the one real difference between the two builds is which store the UI talks
 * to, and that is a single line.
 *
 *     node tools/build-static.mjs [--out dist]
 *
 * Run `npm run build` in core/ first: this copies its output rather than
 * producing it, so that the published bundle is the same artifact the local
 * build was tested against.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');
const outIndex = process.argv.indexOf('--out');
const out = join(root, outIndex === -1 ? 'dist' : process.argv[outIndex + 1]);

if (!existsSync(join(frontend, 'vendor', 'core', 'index.js'))) {
  throw new Error('core/ is not built. Run: cd core && npm run build');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(frontend, out, { recursive: true });

// The only code difference between the builds. Marked rather than guessed at,
// so a rename in app.js fails the build instead of silently publishing a bundle
// that tries to reach an API that is not there.
const appPath = join(out, 'app.js');
const app = readFileSync(appPath, 'utf8');
const marked = /const store = createStore\('http'\); \/\/ STORE/;
if (!marked.test(app)) {
  throw new Error('Could not find the store selection line in app.js. Has it been renamed?');
}
writeFileSync(appPath, app.replace(marked, "const store = createStore('indexeddb'); // STORE"));

// GitHub Pages serves anything under a directory beginning with an underscore
// through Jekyll, which would strip files it does not recognise.
writeFileSync(join(out, '.nojekyll'), '');

// The custom domain has to travel inside the artifact. This workflow publishes
// dist/ rather than a branch, so a CNAME at the repository root would never be
// served, and the domain would fall back to the user site's /familiar/ path.
writeFileSync(join(out, 'CNAME'), 'familiar.bradymoon.com\n');

let files = 0;
let bytes = 0;
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      files += 1;
      bytes += statSync(path).size;
    }
  }
};
walk(out);

console.log(`built ${out}`);
console.log(`${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log('store: indexeddb (no HTTP client reachable from the UI)');
