// Persist partitions only, never a second proposal/cache ledger. One group per
// original scan; even a 422 must not fan out requests inside that scan.
function chunks(safes, extra = {}) {
  const groups = [];
  for (let i = 0; i < safes.length; i += 100) groups.push({ safes: safes.slice(i, i + 100), validated: false, ...extra });
  return groups;
}

export function selectQueueBatch(state, configured, eligible) {
  const allowed = new Set(configured), seen = new Set(), groups = [];
  const previous = state.queueBatch || {};
  for (const group of previous.groups || []) {
    const safes = (group.safes || []).filter(s => {
      if (!allowed.has(s) || seen.has(s)) return false;
      seen.add(s); return true;
    });
    groups.push(...chunks(safes, { validated: group.validated === true, separate: group.separate === true }));
  }
  groups.push(...chunks(configured.filter(s => !seen.has(s))));
  const cursor = (Number.isSafeInteger(previous.cursor) && previous.cursor >= 0 ? previous.cursor : 0) % Math.max(groups.length, 1);
  state.queueBatch = { ...previous, groups, cursor };
  const due = new Set(eligible);
  for (let n = 0; n < groups.length; n++) {
    const index = (cursor + n) % groups.length;
    const safes = groups[index].safes.filter(s => due.has(s));
    if (safes.length) return { index, safes, nextSafe: groups[(index + 1) % groups.length].safes[0] };
  }
  return null;
}

export function finishQueueBatch(state, selection, error = null) {
  const batch = state.queueBatch, group = batch.groups[selection.index], selected = new Set(selection.safes);
  const rest = group.safes.filter(s => !selected.has(s));
  const split = error && (error.status === 422 || error.code === 'QUEUE_PAGE_LIMIT') && selection.safes.length > 1;
  const separate = group.separate || error?.code === 'QUEUE_PAGE_LIMIT';
  const replacement = rest.length ? [{ ...group, safes: rest }] : [];
  if (split) {
    const middle = Math.ceil(selection.safes.length / 2);
    replacement.push(...chunks(selection.safes.slice(0, middle), { separate: !!separate }),
      ...chunks(selection.safes.slice(middle), { separate: !!separate }));
  } else replacement.push({ safes: selection.safes, validated: !error, separate: !!separate });
  batch.groups.splice(selection.index, 1, ...replacement);
  // Rejoin healthy groups, keeping failed/unknown groups independently retryable.
  // Page-limit splits remain separate to avoid an endless split/rejoin loop.
  const healthy = batch.groups.filter(g => g.validated && !g.separate).flatMap(g => g.safes);
  const joined = chunks(healthy, { validated: true });
  let inserted = false;
  batch.groups = batch.groups.flatMap(g => {
    if (!g.validated || g.separate) return [g];
    if (inserted) return [];
    inserted = true; return joined;
  });
  const next = batch.groups.findIndex(g => g.safes.includes(selection.nextSafe));
  batch.cursor = next < 0 ? 0 : next;
}
