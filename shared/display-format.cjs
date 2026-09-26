// Presentation only: persisted cursors, API timestamps and retry deadlines stay ISO/epoch.
function formatBeijingTime(value) {
  if (arguments.length === 0) value = Date.now();
  if (value === null || value === undefined || value === '') return '未知';
  let epoch, milliseconds;
  if (value instanceof Date || typeof value === 'number') {
    epoch = Number(value);
    milliseconds = true;
  } else {
    const text = String(value).trim();
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i);
    if (!match) return text;
    const [, y, m, d, h, min, sec, fraction, zone] = match;
    const offset = !zone ? 480 : zone.toUpperCase() === 'Z' ? 0
      : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.replace(':', '').slice(3, 5)));
    const ms = Number((fraction || '').padEnd(3, '0').slice(0, 3));
    const local = new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +sec, ms));
    if (local.getUTCFullYear() !== +y || local.getUTCMonth() !== +m - 1 || local.getUTCDate() !== +d
      || +h > 23 || +min > 59 || +sec > 59 || Math.abs(offset) >= 1440) return text;
    epoch = Number(local) - offset * 60_000;
    milliseconds = Boolean(fraction);
  }
  if (!Number.isFinite(epoch)) return String(value);
  const date = new Date(epoch + 8 * 3600_000);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    + (milliseconds ? `.${String(date.getUTCMilliseconds()).padStart(3, '0')}` : '');
}

function formatDisplayText(value) {
  // URLs are machine data. Do not rewrite a signed query or a timestamp in a link.
  return String(value ?? '').split(/(https?:\/\/[^\s<>()*]+)/g).map(part => {
    if (/^https?:\/\//.test(part)) return part;
    return part.replace(/\*\*/g, '').replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?/gi,
      timestamp => formatBeijingTime(timestamp));
  }).join('');
}

module.exports = { formatBeijingTime, formatDisplayText };
