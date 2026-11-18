// Pin one scan to one provider. Otherwise a fast provider's head can be newer
// than the provider serving the following logs/receipts at zero confirmations.
export function createAddressRoundRpc({ pool, makePool, request, batchSize = 8,
  signal, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), id = Date.now() }) {
  let pinnedPool = null;
  return async function rpcBatch(calls) {
    const output = [];
    for (let offset = 0; offset < calls.length; offset += batchSize) {
      const chunk = calls.slice(offset, offset + batchSize);
      const payload = chunk.map((call, i) => ({ ...call, id: i + 1, jsonrpc: '2.0' }));
      let values;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        try {
          values = await request(payload, 8000, { pool: pinnedPool || pool,
            dedupeKeySuffix: `addresses-round:${id}`,
            parseResponse: async (response, url) => {
              const rows = await response.json();
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
