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
import { type ExtractedName } from '../roster-text.js';
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
 * Extract everybody from a roster PDF.
 *
 * Reports progress per page, because a scanned class takes long enough that a
 * silent wait reads as a hang.
 */
export declare function extractRoster(file: File, onProgress?: Progress): Promise<ExtractionResult>;
export {};
//# sourceMappingURL=roster-extract.d.ts.map