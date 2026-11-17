// Address discovery and code integrity have different identities. Never compare
// bytecode across addresses, or stop watching an address while discovery flaps.
export const ADDRESS_STABLE_MS = 30_000;
const MAX_SAMPLE_GAP_MS = 10_000;
export const contractIdentity = data => `${String(data.networkCode || 'BSC').toUpperCase()}:${String(data.address || data.addr).toLowerCase()}`;

export function prepareContractObservations(previous, oldFp = {}) {
  if (previous?.version === 1) return structuredClone(previous);
  const state = { version: 1, fingerprints: {}, labels: {} };
  for (const [label, fp] of Object.entries(oldFp)) {
    const key = contractIdentity(fp);
    state.fingerprints[key] = { ...fp };
    state.labels[label] = { confirmed: key, observed: key, watched: [key], announced: [key], present: true };
  }
  return state;
}

export function contractObservationTargets(selected, state) {
  const targets = new Map();
  for (const target of selected) targets.set(contractIdentity(target), { ...target, label: contractIdentity(target) });
  for (const [key, fp] of Object.entries(state.fingerprints)) {
    if (!targets.has(key)) targets.set(key, { ...fp, label: key, addr: fp.address });
  }
  return [...targets.values()];
}

// Pure reconciliation: caller commits this state and the notification together.
export function reconcileContractObservations({ previous, oldFp, selected, sampled, now, diff }) {
  const state = prepareContractObservations(previous, oldFp);
  const changes = [];
  const selectedFp = {};
  // First check every address, including candidates and former active addresses.
  for (const [key, fp] of Object.entries(sampled)) {
    const before = state.fingerprints[key];
    const labels = Object.entries(state.labels).filter(([, entry]) => entry.watched.includes(key)).map(([label]) => label);
    const label = labels.join(' / ') || key;
    if (before) changes.push(...diff({ [label]: before }, { [label]: fp }));
    state.fingerprints[key] = { ...fp };
  }
  const present = new Set();
  for (const target of selected) {
    const key = contractIdentity(target), label = target.label;
    const fp = sampled[key];
    if (!fp) throw new Error(`合约 ${label} 未取得指纹，保留观察状态`);
    present.add(label);
    selectedFp[label] = { ...fp, source: target.source || 'static' };
    const entry = state.labels[label];
    const event = (type, oldKey, note) => changes.push({ type, label, address: fp.address,
      oldAddress: oldKey ? state.fingerprints[oldKey]?.address : undefined, source: target.source, note });
    if (!entry) {
      state.labels[label] = { confirmed: key, observed: key, watched: [key], announced: [key], present: true };
      if (oldFp) event('新合约', null, '已纳入持续监控；用途需结合 ABI 与源码核验');
      continue;
    }
    if (!entry.watched.includes(key)) entry.watched.push(key);
    // Cached discovery is useful for chain checks, never evidence of stability.
    if (target.cached || target.source === 'snapshot_seed') { entry.since = null; entry.count = 0; continue; }
    if (!entry.present) event('合约地址重新出现', null, '此前观察过的地址继续保留监控');
    entry.present = true;
    if (!String(target.source).startsWith('public_address')) {
      if (entry.confirmed !== key) event('合约地址变更', entry.confirmed, '链上/配置来源；新旧地址持续监控');
      entry.confirmed = key; entry.observed = key; entry.announced = [key];
      continue;
    }
    if (!entry.announced.includes(key)) {
      event('发现合约候选地址', entry.confirmed, '公共接口首次返回此候选；已立即纳入监控，尚未确认稳定切换');
      entry.announced.push(key);
    }
    if (entry.confirmed === key && entry.observed === key && entry.announced.length === 1 && !entry.unstable) continue;
    if (entry.observed !== key) {
      if (entry.observed !== entry.confirmed && !entry.unstable) {
        event('合约地址来源不稳定', entry.observed, '公共接口返回地址发生往返或多次切换；合并重复提醒，所有已观测地址继续检查');
        entry.unstable = true;
      }
      entry.since = now; entry.count = 1;
    } else if (entry.since == null || now - (entry.lastSampleAt ?? now) > MAX_SAMPLE_GAP_MS) {
      entry.since = now; entry.count = 1;
    } else entry.count++;
    entry.observed = key; entry.lastSampleAt = now;
    if (entry.count >= 3 && now - entry.since >= ADDRESS_STABLE_MS) {
      if (entry.confirmed !== key) event('合约地址变更（稳定确认）', entry.confirmed, '公共接口连续稳定至少30秒且至少3次成功观测；不是链上授权证明');
      else if (entry.unstable || entry.announced.length > 1) event('合约地址来源恢复稳定', null, '公共接口恢复原地址；此前候选仍持续监控');
      entry.confirmed = key; entry.unstable = false; entry.announced = [key];
      // End the episode; a future genuine switch can be reported again.
      entry.since = null; entry.count = 0;
    }
  }
  for (const [label, entry] of Object.entries(state.labels)) {
    if (present.has(label)) continue;
    if (entry.present) changes.push({ type: '合约从来源列表消失', label,
      address: state.fingerprints[entry.observed]?.address,
      note: '仅来源列表未返回，不能推断合约销毁；仍持续检查已观测地址' });
    entry.present = false; entry.since = null; entry.count = 0;
  }
  return { state, selectedFp, changes };
}
