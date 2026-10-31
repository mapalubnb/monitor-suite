export const LEGACY_URLS = ['https://flap.sh/bnb/CAstore?lang=zh', 'https://flap.sh/launch?chain=bnb&lang=zh', 'https://flap.sh/create?chain=bnb&lang=zh'];

export function assertAllowedUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'flap.sh' || host.endsWith('.flap.sh')) throw Error('旧域名已停用，禁止请求');
  if (!['https:', 'http:'].includes(url.protocol)) throw Error('不支持的请求协议');
  return url;
}

// 手动核验每次跳转，禁止跨域跳转携带请求或凭证。
export async function fetchSite(url, options = {}, fetchFn = globalThis.fetch) {
  let current = assertAllowedUrl(url);
  let requestUrl = String(url);
  for (let n = 0; n < 6; n++) {
    const response = await fetchFn(requestUrl, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw Error('重定向缺少目标');
    const next = assertAllowedUrl(new URL(location, current));
    if (next.origin !== current.origin) throw Error('禁止跨域重定向');
    current = next;
    requestUrl = next.href;
  }
  throw Error('重定向次数超限');
}

export function migrateSitePages(data, keyOf) {
  data.pages ||= {};
  for (const oldUrl of LEGACY_URLS) {
    const newUrl = oldUrl.replace('flap.sh', 'flap.cool');
    const old = data.pages[keyOf(oldUrl)] || data.pages[keyOf(oldUrl.split('?')[0])];
    if (old && !data.pages[keyOf(newUrl)]) data.pages[keyOf(newUrl)] = structuredClone(old);
  }
  data.legacySiteMonitor = { urls: LEGACY_URLS, enabled: false, reason: '保留配置与旧快照；禁止访问旧域名' };
  return data;
}
