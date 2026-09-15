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

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

function crc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crc32Table();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read every entry of a zip archive. */
export async function readZip(archive: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(archive);
  const bytes = new Uint8Array(archive);

  // The end-of-central-directory record sits at the tail, after a comment of
  // unknown length, so it is found by scanning backwards for its signature.
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('That file is not a zip archive.');

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER) throw new Error('This zip archive is damaged.');
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== LOCAL_HEADER) throw new Error('This zip archive is damaged.');
    // The local header repeats the name and carries its own extra field, whose
    // lengths differ from the central directory's; the data starts after them.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (!name.endsWith('/')) {
      if (method === STORED) entries.set(name, raw.slice());
      else if (method === DEFLATED) entries.set(name, await inflateRaw(raw));
      else throw new Error(`This zip uses a compression method Familiar cannot read (${method}).`);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Write a zip archive.
 *
 * Entries that are already compressed — the portraits are JPEG — are stored
 * rather than deflated, which is both faster and smaller than deflating them
 * again to no purpose.
 */
export async function writeZip(entries: readonly ZipEntry[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const alreadyCompressed = /\.(jpe?g|png|zip|gz)$/i.test(entry.name);
    const method = alreadyCompressed ? STORED : DEFLATED;
    const payload = method === STORED ? entry.bytes : await deflateRaw(entry.bytes);
    const checksum = crc32(entry.bytes);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true); // time
    localView.setUint16(12, 0, true); // date
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local as BlobPart, payload as BlobPart);

    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, CENTRAL_HEADER, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint16(8, 0, true);
    recordView.setUint16(10, method, true);
    recordView.setUint32(16, checksum, true);
    recordView.setUint32(20, payload.length, true);
    recordView.setUint32(24, entry.bytes.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);

    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((total, record) => total + record.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...parts, ...central.map((record) => record as BlobPart), end as BlobPart], {
    type: 'application/zip',
  });
}
