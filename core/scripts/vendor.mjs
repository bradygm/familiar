/**
 * Copy the browser's PDF and OCR libraries into frontend/vendor/.
 *
 * Vendored rather than loaded from a CDN. The hosted build promises that a
 * roster never leaves the device, and a page that fetches its OCR engine from a
 * third party is announcing to that third party that somebody is importing one.
 * It also means the app keeps working offline, which a study tool should.
 *
 * The language data is taken from whatever tesseract is already installed, so
 * the browser extractor reads with exactly the same training data as the native
 * importer rather than a different release of it.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modules = join(here, '..', 'node_modules');
const vendor = join(here, '..', '..', 'frontend', 'vendor');

const FILES = [
  ['pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
  ['tesseract.js/dist/tesseract.esm.min.js', 'tesseract/tesseract.esm.min.js'],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd.wasm.js', 'tesseract/tesseract-core-simd.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd.wasm', 'tesseract/tesseract-core-simd.wasm'],
];

// Where a system tesseract keeps its training data, in the order worth trying.
const TRAINED_DATA = [
  process.env.FAMILIAR_TESSDATA,
  '/usr/share/tesseract-ocr/5/tessdata/eng.traineddata',
  '/usr/share/tesseract-ocr/4.00/tessdata/eng.traineddata',
  '/usr/share/tessdata/eng.traineddata',
  '/opt/homebrew/share/tessdata/eng.traineddata',
  '/usr/local/share/tessdata/eng.traineddata',
].filter(Boolean);

let copied = 0;
for (const [from, to] of FILES) {
  const source = join(modules, from);
  if (!existsSync(source)) throw new Error(`Missing ${from}. Run npm install in core/ first.`);
  const target = join(vendor, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  copied += 1;
}

const trained = TRAINED_DATA.find((path) => existsSync(path));
if (!trained) {
  throw new Error(
    'Could not find eng.traineddata. Install tesseract (brew install tesseract, or apt-get install tesseract-ocr), ' +
      'or point FAMILIAR_TESSDATA at the file.',
  );
}
const target = join(vendor, 'tesseract', 'eng.traineddata');
copyFileSync(trained, target);
console.log(`vendored ${copied} library files`);
console.log(`language data from ${trained} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
