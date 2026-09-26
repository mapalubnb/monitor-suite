import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshotStore, readSnapshot } from './snapshot-store.cjs';

test('legacy migration, partial cursor writes and restart preserve the complete snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-store-')), file = join(dir, 'snapshot.json');
  try {
    const state = { pages: { text: 'x'.repeat(200000) }, registryMonitor: { lastBlock: 10 }, _notificationOutbox: [{ id: 'pending' }] };
    writeFileSync(file, JSON.stringify(state));
    const store = createSnapshotStore(file);
    store.update({ registryMonitor: { lastBlock: 11 } });
    assert.ok(readFileSync(file).length < 1000);
    const blobs = readdirSync(file + '.parts');
    store.update({ registryMonitor: { lastBlock: 12 } });
    assert.deepEqual(readdirSync(file + '.parts'), blobs);
    assert.deepEqual(readSnapshot(file), { ...state, registryMonitor: { lastBlock: 12 } });
    const restarted = createSnapshotStore(file);
    restarted.update({ _notificationOutbox: [] });
    assert.deepEqual(readSnapshot(file)._notificationOutbox, []);
    assert.equal(readSnapshot(file).pages.text, state.pages.text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed manifest publish retains the previous cursor and notification queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-store-')), file = join(dir, 'snapshot.json');
  try {
    const store = createSnapshotStore(file, { threshold: 30 });
    const initial = { page: 'old'.repeat(100), cursor: 10, outbox: [{ id: 'one' }] };
    store.write(initial);
    mkdirSync(file + '.tmp');
    assert.throws(() => store.write({ page: 'new'.repeat(100), cursor: 11, outbox: [] }));
    assert.deepEqual(readSnapshot(file), initial);
    rmSync(file + '.tmp', { recursive: true });
    store.write({ page: 'new'.repeat(100), cursor: 11, outbox: [] });
    assert.equal(readSnapshot(file).cursor, 11);
    const manifest = JSON.parse(readFileSync(file));
    writeFileSync(join(file + '.parts', manifest._snapshotFields.page + '.json'), '"corrupt"');
    assert.throws(() => readSnapshot(file), /校验失败/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unchanged data does not rewrite the manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-store-')), file = join(dir, 'snapshot.json');
  try {
    const store = createSnapshotStore(file);
    assert.equal(store.write({ cursor: 1 }), true);
    assert.equal(store.write({ cursor: 1 }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
