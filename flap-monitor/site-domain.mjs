export const LEGACY_URLS = ['https://flap.sh/bnb/CAstore?lang=zh', 'https://flap.sh/launch?chain=bnb&lang=zh', 'https://flap.sh/create?chain=bnb&lang=zh'];

export function assertAllowedUrl(value) {
  const url = new URL(value);
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
    if (next.origin !== current.origin) {
      const headers = new Headers(options.headers);
      const publicSiteReturn = current.origin === 'https://flap.cool' && next.origin === 'https://flap.sh'
        && ['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())
        && !options.body && !headers.has('authorization') && !headers.has('cookie')
        && !headers.has('x-api-key') && options.credentials !== 'include';
      if (!publicSiteReturn) throw Error('禁止跨域重定向');
    }
    current = next;
    requestUrl = next.href;
  }
  throw Error('重定向次数超限');
}

export function migrateSitePages(data, keyOf) {
  data.pages ||= {};
  // The cool baseline is newer than the retained sh baseline. Copy exactly once,
  // retain both, and never overwrite a refreshed sh baseline on later restarts.
  if (!data.siteDomainRestoredAt) {
    for (const url of LEGACY_URLS) {
      const cool = url.replace('flap.sh', 'flap.cool');
      const baseline = data.pages[keyOf(cool)] || data.pages[keyOf(cool.split('?')[0])];
      if (baseline) data.pages[keyOf(url)] = structuredClone(baseline);
    }
    data.siteDomainRestoredAt = '2026/11/3';
  }
  data.legacySiteMonitor = { urls: LEGACY_URLS, enabled: true, reason: '用户确认域名恢复；flap.cool 基线保留' };
  return data;
}
