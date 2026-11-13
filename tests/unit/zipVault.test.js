import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZipBuffer, parseZipBuffer } from '../../src/server/zipVault.js';

test('buildZipBuffer and parseZipBuffer roundtrip UTF-8 filenames and Turkish contents accurately', () => {
  const entries = [
    { name: 'notes/dagitik-sistemler.md', data: '# Dağıtık Sistemler\nTürkçe içerik: ğüşiöç ĞÜŞİÖÇ 🚀' },
    { name: '.tessera/boards.json', data: JSON.stringify({ boards: [{ id: 'b1', title: 'Ana Tahta' }] }) }
  ];

  const zipBuf = buildZipBuffer(entries);
  assert.ok(Buffer.isBuffer(zipBuf));
  assert.equal(zipBuf.slice(0, 2).toString('binary'), 'PK');

  const extracted = parseZipBuffer(zipBuf);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].name, 'notes/dagitik-sistemler.md');
  assert.equal(extracted[0].data.toString('utf8'), entries[0].data);
  assert.equal(extracted[1].name, '.tessera/boards.json');
  assert.equal(extracted[1].data.toString('utf8'), entries[1].data);
});
