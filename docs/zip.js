// Minimal streaming zip reader for the browser (no dependencies).
// Reads only the central directory plus the entries we ask for, so a multi-GB
// Instagram export with photos/videos never has to be loaded into memory.
// Supports stored + deflate entries and ZIP64. Uses the native DecompressionStream.

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_U32 = 0xffffffff;

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

export async function listZip(blob) {
  const tailSize = Math.min(blob.size, 65557 + 20);
  const tail = await view(blob, blob.size - tailSize, blob.size);

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("Not a zip file");
  }

  let count = tail.getUint16(eocd + 10, true);
  let directorySize = tail.getUint32(eocd + 12, true);
  let directoryOffset = tail.getUint32(eocd + 16, true);

  if (count === 0xffff || directorySize === MAX_U32 || directoryOffset === MAX_U32) {
    const locator = eocd - 20;
    if (locator >= 0 && tail.getUint32(locator, true) === SIG_ZIP64_LOCATOR) {
      const recordOffset = Number(tail.getBigUint64(locator + 8, true));
      const record = await view(blob, recordOffset, recordOffset + 56);
      count = Number(record.getBigUint64(32, true));
      directorySize = Number(record.getBigUint64(40, true));
      directoryOffset = Number(record.getBigUint64(48, true));
    }
  }

  const directory = await view(blob, directoryOffset, directoryOffset + directorySize);
  const decoder = new TextDecoder();
  const entries = [];
  let p = 0;
  while (p + 46 <= directory.byteLength && directory.getUint32(p, true) === SIG_CENTRAL && entries.length < count) {
    const flags = directory.getUint16(p + 8, true);
    const method = directory.getUint16(p + 10, true);
    let compressedSize = directory.getUint32(p + 20, true);
    let size = directory.getUint32(p + 24, true);
    const nameLength = directory.getUint16(p + 28, true);
    const extraLength = directory.getUint16(p + 30, true);
    const commentLength = directory.getUint16(p + 32, true);
    let offset = directory.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(directory.buffer, directory.byteOffset + p + 46, nameLength));

    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = directory.getUint16(e, true);
      const length = directory.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === MAX_U32) {
          size = Number(directory.getBigUint64(q, true));
          q += 8;
        }
        if (compressedSize === MAX_U32) {
          compressedSize = Number(directory.getBigUint64(q, true));
          q += 8;
        }
        if (offset === MAX_U32) {
          offset = Number(directory.getBigUint64(q, true));
        }
      }
      e += 4 + length;
    }

    entries.push({ name, method, compressedSize, size, offset, encrypted: Boolean(flags & 1) });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function readEntryText(blob, entry) {
  if (entry.encrypted) {
    throw new Error(`${entry.name} is password-protected`);
  }
  const header = await view(blob, entry.offset, entry.offset + 30);
  if (header.getUint32(0, true) !== SIG_LOCAL) {
    throw new Error(`Corrupt zip entry: ${entry.name}`);
  }
  const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const data = blob.slice(start, start + entry.compressedSize);
  if (entry.method === 0) {
    return data.text();
  }
  if (entry.method === 8) {
    const stream = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }
  throw new Error(`Unsupported zip compression (${entry.method}) in ${entry.name}`);
}
