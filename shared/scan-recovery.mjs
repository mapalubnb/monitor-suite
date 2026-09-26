// Preserve every unscanned interval before moving a stalled live lane forward.
export function recoverLiveCursor(state, { head, cursorKey, hashKey, maxLag = 2000, lookback = 20 }) {
  const cursor = state[cursorKey];
  if (!Number.isSafeInteger(cursor) || cursor < 0 || head - cursor <= maxLag) return false;
  const next = Math.max(cursor, head - lookback);
  const ranges = [...(state.realtimeGaps || []), { from: cursor + 1, to: next }].sort((a, b) => a.from - b.from);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  state.realtimeGaps = merged;
  state[cursorKey] = next;
  if (hashKey) state[hashKey] = '';
  state.realtimeRecoveredAt = new Date().toISOString();
  return true;
}

// The active historical cursor/end pair is itself durable. Dequeue only after
// the previous range is complete; never reset an unfinished historical scan.
export function activateHistoryGap(history, live, cursorKey, endKey) {
  if (history[cursorKey] < (history[endKey] ?? Infinity) || !live.realtimeGaps?.length) return false;
  const range = live.realtimeGaps.shift();
  history[cursorKey] = range.from - 1;
  history[endKey] = range.to;
  return true;
}
