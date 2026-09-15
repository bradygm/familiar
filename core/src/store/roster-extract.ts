/**
 * Reading a roster PDF in the browser.
 *
 * The same job `backend/app/importer.py` does natively with poppler and
 * tesseract, done here with pdf.js and tesseract.js so the hosted build — which
 * has no server — can import a class at all. The layout knowledge is not
 * duplicated: the crop geometry and the name rules both come from
 * `core/src/roster-text.ts`, which the Python side is checked against.
 *
 * The file never leaves the page. That is the point of doing it here rather
 * than uploading: a roster of student photographs is exactly the kind of thing
 * that should not travel to somebody else's machine to be processed.
 *
 * ## Why the two passes
 *
 * Whole-page OCR does badly on these rosters — photographs and table rules
 * confuse the layout analysis — so names are read from the right-hand column
 * alone. When that still misses somebody, each of the three name cells is read
 * individually, which is slower but unaffected by a bad neighbour. This mirrors
 * the native importer's fallback exactly.
 */

import { ROSTER_LAYOUT, readNameLine, type ExtractedName } from '../roster-text.js';

export interface ExtractedPerson extends ExtractedName {
  /** JPEG of the portrait beside this name, if one was found. */
  readonly portrait: Blob | null;
}

export interface ExtractionProgress {
  readonly page: number;
  readonly pages: number;
  readonly found: number;
  readonly stage: 'loading' | 'rendering' | 'reading' | 'done';
}

export interface ExtractionResult {
  readonly people: ExtractedPerson[];
  readonly pages: number;
}

type Progress = (progress: ExtractionProgress) => void;

/**
 * Where the vendored libraries live.
 *
 * Self-hosted rather than loaded from a CDN: a page that promises the roster
 * never leaves the device should not be announcing to a third party that
 * somebody is importing one.
 */
// Resolved against this module's own URL rather than the site root, so the same
// files work however the app is served: at "/" from the local server, under
// "/familiar/" on project Pages, or at the root of a custom domain.
const vendored = (path: string) => new URL(`../../${path}`, import.meta.url).href;

const VENDOR = {
  pdfWorker: vendored('pdfjs/pdf.worker.min.mjs'),
  pdfLibrary: vendored('pdfjs/pdf.min.mjs'),
  tesseractWorker: vendored('tesseract/worker.min.js'),
  tesseractCore: vendored('tesseract/tesseract-core-simd.wasm.js'),
  tesseractLibrary: vendored('tesseract/tesseract.esm.min.js'),
  languageData: vendored('tesseract'),
};

async function loadPdfLibrary(): Promise<any> {
  const pdfjs = await import(/* @vite-ignore */ VENDOR.pdfLibrary);
  pdfjs.GlobalWorkerOptions.workerSrc = VENDOR.pdfWorker;
  return pdfjs;
}

async function createReader(): Promise<any> {
  // The ESM build exposes everything on its default export rather than as named
  // exports, so reach through it, tolerating either shape.
  const module_ = await import(/* @vite-ignore */ VENDOR.tesseractLibrary);
  const createWorker = module_.createWorker ?? module_.default?.createWorker;
  if (typeof createWorker !== 'function') throw new Error('The OCR library did not load correctly.');
  // gzip:false because the vendored data is the raw .traineddata taken from the
  // installed tesseract, which is the same file the native importer reads.
  return createWorker('eng', 1, {
    workerPath: VENDOR.tesseractWorker,
    corePath: VENDOR.tesseractCore,
    langPath: VENDOR.languageData,
    gzip: false,
  });
}

function cropCanvas(source: HTMLCanvasElement, left: number, top: number, right: number, bottom: number): HTMLCanvasElement {
  const width = Math.max(1, Math.round(right - left));
  const height = Math.max(1, Math.round(bottom - top));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas
    .getContext('2d')!
    .drawImage(source, Math.round(left), Math.round(top), width, height, 0, 0, width, height);
  return canvas;
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.88));
}

/** Group recognised words into lines, keeping each line's vertical centre. */
function linesFrom(data: any): { text: string; centre: number }[] {
  const lines = data?.lines;
  if (Array.isArray(lines) && lines.length) {
    return lines.map((line: any) => ({
      text: String(line.text ?? ''),
      centre: (line.bbox.y0 + line.bbox.y1) / 2,
    }));
  }
  // Older shapes expose words only; fall back to grouping them by line number.
  const words: any[] = data?.words ?? [];
  const grouped = new Map<number, { text: string[]; tops: number[] }>();
  for (const word of words) {
    const key = Math.round((word.bbox?.y0 ?? 0) / 10);
    const entry = grouped.get(key) ?? { text: [], tops: [] };
    entry.text.push(String(word.text ?? ''));
    entry.tops.push(((word.bbox?.y0 ?? 0) + (word.bbox?.y1 ?? 0)) / 2);
    grouped.set(key, entry);
  }
  return [...grouped.values()].map((entry) => ({
    text: entry.text.join(' '),
    centre: entry.tops.reduce((total, top) => total + top, 0) / entry.tops.length,
  }));
}

/**
 * Extract everybody from a roster PDF.
 *
 * Reports progress per page, because a scanned class takes long enough that a
 * silent wait reads as a hang.
 */
export async function extractRoster(file: File, onProgress: Progress = () => {}): Promise<ExtractionResult> {
  onProgress({ page: 0, pages: 0, found: 0, stage: 'loading' });
  const pdfjs = await loadPdfLibrary();
  const document_ = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = document_.numPages;

  const reader = await createReader();
  const people: ExtractedPerson[] = [];
  const seen = new Set<string>();

  try {
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      onProgress({ page: pageNumber, pages, found: people.length, stage: 'rendering' });

      const page = await document_.getPage(pageNumber);
      // pdf.js viewports are in CSS pixels at 72 dpi; scale to the resolution
      // the native importer renders at, so the same crops mean the same thing.
      const viewport = page.getViewport({ scale: ROSTER_LAYOUT.renderDpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // pdf.js continues rendering from requestAnimationFrame by default, which
      // never fires while the tab is hidden — so a background import would stall
      // forever the moment somebody switched tabs. Driving continuation from a
      // timer instead keeps extraction going regardless, and is what this wants
      // anyway: it is a batch job, not something being displayed frame by frame.
      const task = page.render({ canvas, viewport });
      task.onContinue = (continueRendering: () => void) => setTimeout(continueRendering, 0);
      await task.promise;

      onProgress({ page: pageNumber, pages, found: people.length, stage: 'reading' });
      const detected = await readPage(reader, canvas);

      for (const person of detected) {
        const key = JSON.stringify([person.first_name, person.last_name]);
        if (seen.has(key)) continue;
        seen.add(key);
        people.push(person);
      }
      page.cleanup();
    }
  } finally {
    // Release both engines even if extraction failed, and tolerate either
    // pdf.js teardown name: a cleanup call must never mask the real error.
    await reader.terminate().catch(() => {});
    await (document_.destroy?.() ?? document_.cleanup?.() ?? Promise.resolve());
  }

  onProgress({ page: pages, pages, found: people.length, stage: 'done' });
  return { people, pages };
}

async function readPage(reader: any, canvas: HTMLCanvasElement): Promise<ExtractedPerson[]> {
  const nameColumnLeft = canvas.width * ROSTER_LAYOUT.nameColumnLeft;
  const column = cropCanvas(canvas, nameColumnLeft, 0, canvas.width, canvas.height);

  const { data } = await reader.recognize(column, {}, { blocks: true });
  const found: ExtractedPerson[] = [];
  for (const line of linesFrom(data)) {
    const name = readNameLine(line.text);
    if (name) found.push({ ...name, portrait: await portraitFor(canvas, line.centre) });
  }

  // A page should yield three people. When column OCR misses one, read each
  // name cell on its own: slower, but a weak cell no longer spoils the page.
  if (found.length < ROSTER_LAYOUT.peoplePerPage) {
    const already = new Set(found.map((person) => JSON.stringify([person.first_name, person.last_name])));
    for (const centre of ROSTER_LAYOUT.rowCentres) {
      const middle = canvas.height * centre;
      const cell = cropCanvas(
        canvas,
        nameColumnLeft,
        middle - canvas.height * ROSTER_LAYOUT.rowHalfHeight,
        canvas.width,
        middle + canvas.height * ROSTER_LAYOUT.rowHalfHeight,
      );
      const cellResult = await reader.recognize(cell);
      const name = readNameLine(String(cellResult.data?.text ?? '').split('\n')[0] ?? '');
      if (name && !already.has(JSON.stringify([name.first_name, name.last_name]))) {
        already.add(JSON.stringify([name.first_name, name.last_name]));
        found.push({ ...name, portrait: await portraitFor(canvas, middle) });
      }
    }
  }
  return found;
}

async function portraitFor(canvas: HTMLCanvasElement, nameCentre: number): Promise<Blob | null> {
  const half = canvas.height * ROSTER_LAYOUT.portraitHalfHeight;
  const crop = cropCanvas(
    canvas,
    canvas.width * ROSTER_LAYOUT.portraitLeft,
    Math.max(0, nameCentre - half),
    canvas.width * ROSTER_LAYOUT.portraitRight,
    Math.min(canvas.height, nameCentre + half),
  );
  return toJpeg(crop);
}
