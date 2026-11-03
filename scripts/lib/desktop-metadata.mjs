import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export async function readAsarText(installation, path) {
  const handle = await open(join(installation, 'resources/app.asar'), 'r');
  try {
    const prefix = Buffer.alloc(8); assert.equal((await handle.read(prefix, 0, 8, 0)).bytesRead, 8);
    const size = prefix.readUInt32LE(4); assert.ok(size > 8 && size < 8 * 1024 * 1024, 'Unexpected application archive header');
    const header = Buffer.alloc(size); assert.equal((await handle.read(header, 0, size, 8)).bytesRead, size);
    const textSize = header.readUInt32LE(4); assert.ok(textSize <= size - 8);
    let entry = JSON.parse(header.subarray(8, 8 + textSize).toString());
    for (const component of path.split('/')) entry = entry.files?.[component];
    assert.ok(entry && !entry.unpacked && !entry.link && Number.isSafeInteger(entry.size) && entry.size <= 65536 && /^\d+$/.test(entry.offset), 'Required installed metadata is missing');
    const offset = 8 + size + Number(entry.offset); assert.ok(Number.isSafeInteger(offset));
    const bytes = Buffer.alloc(entry.size); assert.equal((await handle.read(bytes, 0, bytes.length, offset)).bytesRead, bytes.length);
    return bytes.toString();
  } finally { await handle.close(); }
}
