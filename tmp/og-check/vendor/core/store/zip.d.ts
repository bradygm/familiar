/**
 * Just enough ZIP to read and write a Familiar backup in the browser.
 *
 * The bundle format is a zip because a backup should be openable by anything —
 * the learner can unzip it and look at their own data without this app. Reading
 * and writing it here uses the platform's own `DecompressionStream` and
 * `CompressionStream` rather than a library: the format needed is a small,
 * fixed subset, and a backup format should not depend on a package staying
 * available years from now.
 *
 * Supports the two compression methods Python's `zipfile` produces: stored (0)
 * and deflate (8). Anything else is rejected loudly rather than silently
 * mangled, because a half-read backup is worse than a refused one.
 */
export interface ZipEntry {
    readonly name: string;
    readonly bytes: Uint8Array;
}
export declare function crc32(bytes: Uint8Array): number;
/** Read every entry of a zip archive. */
export declare function readZip(archive: ArrayBuffer): Promise<Map<string, Uint8Array>>;
/**
 * Write a zip archive.
 *
 * Entries that are already compressed — the portraits are JPEG — are stored
 * rather than deflated, which is both faster and smaller than deflating them
 * again to no purpose.
 */
export declare function writeZip(entries: readonly ZipEntry[]): Promise<Blob>;
//# sourceMappingURL=zip.d.ts.map