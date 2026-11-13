import zlib from 'node:zlib';

/**
 * Pure Node.js ZIP builder and parser using built-in node:zlib (deflateRawSync / inflateRawSync)
 * with full UTF-8 filename flag (bit 11 = 0x0800) and IEEE 802.3 CRC32 verification.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZipBuffer(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name), 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(rawBuf);
    const compressed = zlib.deflateRawSync(rawBuf);
    const useStore = compressed.length >= rawBuf.length;
    const method = useStore ? 0 : 8;
    const payload = useStore ? rawBuf : compressed;

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5421, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localChunks.push(localHeader, nameBuf, payload);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuf);
    offset += 30 + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

export function parseZipBuffer(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Find End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP archive: EOCD signature not found');
  }

  const totalEntries = data.readUInt16LE(eocdOffset + 10);
  const cdOffset = data.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (data.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: Central directory mismatch');
    }
    const method = data.readUInt16LE(ptr + 10);
    const expectedCrc = data.readUInt32LE(ptr + 16);
    const compSize = data.readUInt32LE(ptr + 20);
    const nameLen = data.readUInt16LE(ptr + 28);
    const extraLen = data.readUInt16LE(ptr + 30);
    const commentLen = data.readUInt16LE(ptr + 32);
    const localOffset = data.readUInt32LE(ptr + 42);
    const name = data.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    if (data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid local header for entry ${name}`);
    }
    const localNameLen = data.readUInt16LE(localOffset + 26);
    const localExtraLen = data.readUInt16LE(localOffset + 28);
    const payloadStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = data.subarray(payloadStart, payloadStart + compSize);

    let outData;
    if (method === 0) {
      outData = Buffer.from(compData);
    } else if (method === 8) {
      outData = zlib.inflateRawSync(compData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }

    if (crc32(outData) !== expectedCrc) {
      throw new Error(`CRC32 checksum mismatch for ${name}`);
    }
    entries.push({ name, data: outData });
  }

  return entries;
}
