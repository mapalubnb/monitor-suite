const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Large fields are immutable blobs. Publish their references and the small
// cursor/outbox fields together with one atomic manifest rename.
function readSnapshot(file) {
  for (let attempt = 0; ; attempt++) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    try {
      for (const [key, digest] of Object.entries(data._snapshotFields || {})) {
        if (!/^[a-f0-9]{64}$/.test(digest) || key === '__proto__') throw new Error('无效快照引用');
        const content = fs.readFileSync(path.join(file + '.parts', digest + '.json'), 'utf8');
        if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('快照内容校验失败：' + key);
        data[key] = JSON.parse(content);
      }
      delete data._snapshotFields;
      return data;
    } catch (error) {
      if (attempt >= 1 || fs.readFileSync(file, 'utf8') === raw) throw error;
    }
  }
}

function createSnapshotStore(file, { threshold = 65536, now = Date.now } = {}) {
  const directory = file + '.parts';
  let manifest = null, lastContent = '', lastGc = 0;
  const encoded = new Map();
  const written = new Set();
  const retired = new Map();
  function publish(next) {
    const content = JSON.stringify(next);
    if (content === lastContent) return false;
    const previous = manifest || (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
    fs.writeFileSync(file + '.tmp', content, 'utf8');
    fs.renameSync(file + '.tmp', file);
    manifest = next;
    lastContent = content;
    const current = new Set(Object.values(next._snapshotFields || {}));
    for (const digest of Object.values(previous._snapshotFields || {})) {
      if (current.has(digest)) continue;
      retired.set(digest, now());
      try { const date = new Date(now()); fs.utimesSync(path.join(directory, digest + '.json'), date, date); } catch {}
    }
    if (now() - lastGc > 60_000) {
      lastGc = now();
      // A reader may have opened the previous manifest just before rename.
      // Give it two minutes, and never collect a currently referenced blob.
      const keep = new Set(Object.values(next._snapshotFields || {}));
      try {
        for (const entry of fs.readdirSync(directory)) {
          const digest = entry.replace(/\.json$/, '');
          if (!/^[a-f0-9]{64}\.json$/.test(entry) || keep.has(digest)) continue;
          const target = path.join(directory, entry);
          if (now() - Math.max(fs.statSync(target).mtimeMs, retired.get(digest) || 0) > 120_000) {
            fs.unlinkSync(target); written.delete(digest); retired.delete(digest);
          }
        }
      } catch { /* Garbage collection must not turn a committed write into a failure. */ }
    }
    return true;
  }
  function put(next, key, json) {
    if (key === '_snapshotFields') return;
    delete next._snapshotFields[key];
    delete next[key];
    if (json === undefined) return;
    if (Buffer.byteLength(json) < threshold) { next[key] = JSON.parse(json); return; }
    let cached = encoded.get(key);
    if (cached?.json !== json) cached = { json, digest: createHash('sha256').update(json).digest('hex') };
    encoded.set(key, cached);
    const blob = path.join(directory, cached.digest + '.json');
    if (!written.has(cached.digest)) {
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.existsSync(blob)) {
        fs.writeFileSync(blob + '.tmp', json, 'utf8');
        fs.renameSync(blob + '.tmp', blob);
      }
      written.add(cached.digest);
    }
    next._snapshotFields[key] = cached.digest;
  }
  return {
    read: () => readSnapshot(file),
    write(data, encode = (_key, value) => JSON.stringify(value)) {
      const next = { _snapshotFields: {} };
      for (const [key, value] of Object.entries(data)) put(next, key, encode(key, value));
      for (const key of encoded.keys()) if (!(key in data)) encoded.delete(key);
      return publish(next);
    },
    update(fields) {
      if (!manifest) {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Migrate the old monolithic file before a partial update.
        if (!manifest._snapshotFields) this.write(manifest);
      }
      const next = { ...manifest, _snapshotFields: { ...manifest._snapshotFields } };
      for (const [key, value] of Object.entries(fields)) put(next, key, JSON.stringify(value));
      return publish(next);
    },
  };
}
module.exports = { readSnapshot, createSnapshotStore };
