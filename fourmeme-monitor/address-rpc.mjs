// Select against every scope needed by a scan, not just the first head call.
// Budget pressure is advisory; the shared admission control remains authoritative.
export function addressRoundPool(pool, control) {
  if (!control) return pool;
  const stages = [ ['eth_blockNumber'], ['eth_blockNumber', 'eth_getBlockByNumber'],
    ['eth_getBlockByNumber'], ['eth_getLogs'], ['eth_getTransactionReceipt'] ]
    .map(methods => ({ payload: methods.map(method => ({ method })), history: false,
      critical: false, cost: methods.includes('eth_getLogs') ? 3 : 8 }));
  return { ...pool, acquire(excluded, options = {}) {
    return pool.acquire(excluded, {
      available: url => (!options.available || options.available(url)) && stages.every(r => !control.cooldown(url, r)),
      pressure: url => Math.max(options.pressure?.(url) || 0, ...stages.map(r => control.pressure(url, r))),
    });
  } };
}

export function addressRpcFailure(error) {
  if (error.rpcBudget) return 'budget_wait';
  if (error.rpcCooldown || error.code === 'BSC_RPC_ALL_BACKED_OFF') return 'cooldown';
  if (error.status === 429 || /429|rate.?limit|too many requests|compute units|usage limit/i.test(error.message)) return 'rate_limit';
  if (/尚未就绪|beyond current head|block.*not found|header not found|unknown block/i.test(error.message)) return 'head_not_ready';
  if (/超时|timeout|timed out/i.test(error.message) || ['TimeoutError', 'AbortError'].includes(error.name)) return 'timeout';
  return 'error';
}

// Pin one scan to one provider. Otherwise a fast provider's head can be newer
// than the provider serving the following logs/receipts at zero confirmations.
export function createAddressRoundRpc({ pool, makePool, request, control, batchSize = 8,
  signal, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), id = Date.now() }) {
  let pinnedPool = null;
  let provider = '';
  const eligiblePool = addressRoundPool(pool, control);
  return async function rpcBatch(calls) {
    const output = [];
    for (let offset = 0; offset < calls.length; offset += batchSize) {
      const chunk = calls.slice(offset, offset + batchSize);
      const payload = chunk.map((call, i) => ({ ...call, id: i + 1, jsonrpc: '2.0' }));
      let values;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        try {
          values = await request(payload, 8000, { pool: pinnedPool || eligiblePool,
            dedupeKeySuffix: `addresses-round:${id}`,
            parseResponse: async (response, url) => {
              provider = new URL(url, 'https://rpc.invalid').hostname;
              // Preserve status even when an upstream 429/403 body is empty/HTML.
              if (response.ok === false) {
                const retry = response.headers?.get?.('retry-after');
                const retryAfterMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
                throw Object.assign(Error(`地址RPC HTTP ${response.status}（${provider}）`), { status: response.status, retryAfterMs });
              }
              const rows = await response.json();
              signal?.throwIfAborted();
              if (rows?.error) throw Error(rows.error.message || '地址RPC失败');
              if (!Array.isArray(rows) || rows.length !== payload.length || new Set(rows.map(r => r.id)).size !== payload.length) throw Error('地址RPC批次不完整');
              const result = payload.map(p => {
                const row = rows.find(r => r.id === p.id);
                if (!row) throw Error('地址RPC缺少响应');
                if (row.error) throw Error(row.error.message || '地址RPC失败');
                if (row.result == null) throw Error('地址RPC头块数据尚未就绪');
                return row.result;
              });
              pinnedPool ||= makePool([url]);
              return result;
            },
          });
          break;
        } catch (error) {
          error.addressFailureKind = addressRpcFailure(error);
          error.provider = provider;
          if (error.code === 'BSC_RPC_ALL_BACKED_OFF') error.message = pinnedPool
            ? '[退避中] 本轮固定RPC暂不可用，保留游标，下一轮重新选节点'
            : '[退避中] 当前没有满足完整扫描条件的RPC，保留游标等待节点恢复';
          // A bounded 120/240ms retry reads the same target block, never head-1.
          // Genuine outages/rate limits retain the existing shared cooldown.
          if (attempt >= 2 || !/尚未就绪|beyond current head|block.*not found|header not found|unknown block/i.test(error.message)) throw error;
          await delay(120 * (attempt + 1));
        }
      }
      output.push(...values);
    }
    return output;
  };
}
