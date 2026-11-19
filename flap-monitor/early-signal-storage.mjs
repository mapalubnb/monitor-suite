import { createSnapshotStore, readSnapshot } from '../shared/snapshot-store.cjs';

const CHUNK_SIZE = 128;
const PREFIX = '_earlyEventChunk_';
let current;

export function readEarlySignalSnapshot(file) {
  const state = readSnapshot(file);
  if (!Object.hasOwn(state, '_earlyEventChunks')) return state;
  if (!Number.isSafeInteger(state._earlyEventChunks) || state._earlyEventChunks < 0 || state._earlyEventChunks > 20000)
    throw Error('提前信号事件分片数量无效');
  const events = {};
  for (let index = 0; index < state._earlyEventChunks; index++) {
    const key = PREFIX + index, rows = state[key];
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw Error('提前信号事件分片缺失：' + key);
    for (const [id, event] of Object.entries(rows)) {
      if (id === '__proto__' || Object.hasOwn(events, id)) throw Error('提前信号事件分片包含重复或无效 ID');
      events[id] = event;
    }
    delete state[key];
  }
  delete state._earlyEventChunks;
  return { ...state, events };
}

function partitionEvents(events, previous) {
  const ids = Object.keys(events), next = [];
  let offset = 0;
  const chunk = keys => {
    const rows = Object.fromEntries(keys.map(id => [id, events[id]]));
    return { keys, rows, json: JSON.stringify(rows) };
  };
  // Keep old boundaries across removals. New events always follow retained
  // events, so pruning an early shard does not rewrite every later shard.
  for (const old of previous) {
    const begin = offset;
    while (offset < ids.length && Object.hasOwn(old.rows, ids[offset])) offset++;
    if (offset === begin) continue;
    const keys = ids.slice(begin, offset);
    next.push(keys.length === old.keys.length
      && keys.every((id, index) => id === old.keys[index] && events[id] === old.rows[id]) ? old : chunk(keys));
  }
  const last = next.at(-1);
  if (offset < ids.length && last && last.keys.length < CHUNK_SIZE) {
    const end = Math.min(ids.length, offset + CHUNK_SIZE - last.keys.length);
    next[next.length - 1] = chunk([...last.keys, ...ids.slice(offset, end)]);
    offset = end;
  }
  for (; offset < ids.length; offset += CHUNK_SIZE) next.push(chunk(ids.slice(offset, offset + CHUNK_SIZE)));
  return next;
}

export function saveEarlySignalSnapshot(file, state) {
  if (current?.file !== file) current = { file, store: createSnapshotStore(file), chunks: [], archive: undefined };
  const { events, publicPoolArchive, ...rest } = state;
  const chunks = partitionEvents(events, current.chunks);
  const data = { ...rest, publicPoolArchive, _earlyEventChunks: chunks.length };
  for (const [index, chunk] of chunks.entries()) data[PREFIX + index] = chunk.rows;
  const archiveJson = current.archive === publicPoolArchive ? current.archiveJson : JSON.stringify(publicPoolArchive);
  current.store.write(data, (key, value) => {
    if (key.startsWith(PREFIX)) return chunks[Number(key.slice(PREFIX.length))].json;
    if (key === 'publicPoolArchive') return archiveJson;
    return JSON.stringify(value);
  });
  Object.assign(current, { chunks, archive: publicPoolArchive, archiveJson });
}
