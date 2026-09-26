// Card fragments must be independently renderable. Keep links/tags and Unicode
// graphemes intact; carry code fences and nested font state across boundaries.
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

function linkEnd(text, start) {
  let index = start + 1, depth = 1;
  for (; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '[') depth++;
    if (text[index] === ']' && --depth === 0) break;
  }
  if (text[index + 1] !== '(') return 0;
  depth = 1;
  for (index += 2; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '(') depth++;
    if (text[index] === ')' && --depth === 0) return index + 1;
  }
  return 0;
}

function markdownAtoms(value) {
  const atoms = [];
  let state = { fence: null, fonts: [] };
  const add = (text, after = state) => {
    atoms.push({ text, before: state, after });
    state = after;
  };
  const plain = text => { for (const { segment } of segmenter.segment(text)) add(segment); };
  for (const line of String(value ?? '').match(/[^\n]*\n|[^\n]+$/g) || []) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)\n?$/);
    if (fence && (!state.fence || (fence[1][0] === state.fence.marker[0]
      && fence[1].length >= state.fence.marker.length && !fence[2].trim()))) {
      add(line, { ...state, fence: state.fence ? null : { marker: fence[1], opener: line.trimEnd() } });
      continue;
    }
    if (state.fence) { plain(line); continue; }
    let start = 0;
    for (let index = 0; index < line.length;) {
      let end = 0;
      const rest = line.slice(index);
      if (line[index] === '\\' && index + 1 < line.length) {
        // Keep escaped markup literal, including escaped backticks/brackets.
        end = index + 1 + String.fromCodePoint(line.codePointAt(index + 1)).length;
      } else if (line[index] === '[') end = linkEnd(line, index);
      else if (line[index] === '!' && line[index + 1] === '[') end = linkEnd(line, index + 1);
      else if (line[index] === '`') {
        const marker = rest.match(/^`+/)[0];
        const close = line.indexOf(marker, index + marker.length);
        if (close >= 0) end = close + marker.length;
      } else {
        const token = rest.match(/^(?:<[^>\n]+>|https?:\/\/[^\s<>]+|\*\*|\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}:\d{2}(?:\.\d{1,9})?(?: ?(?:Z|[+-]\d{2}:?\d{2}))?)/);
        if (token) end = index + token[0].length;
      }
      if (!end) { index++; continue; }
      plain(line.slice(start, index));
      const token = line.slice(index, end);
      let after = state;
      if (/^<font\b/i.test(token)) after = { ...state, fonts: [...state.fonts, token] };
      else if (/^<\/font\s*>$/i.test(token)) after = { ...state, fonts: state.fonts.slice(0, -1) };
      add(token, after);
      start = index = end;
    }
    plain(line.slice(start));
  }
  return atoms;
}

function renderRange(atoms, start, end) {
  if (start === end) return '';
  const before = atoms[start].before, after = atoms[end - 1].after;
  const source = atoms.slice(start, end).map(atom => atom.text).join('');
  return before.fonts.join('') + (before.fence ? before.fence.opener + '\n' : '')
    + source + (after.fence ? (source.endsWith('\n') ? '' : '\n') + after.fence.marker : '')
    + '</font>'.repeat(after.fonts.length);
}

export function splitCardMarkdown(value, limit, fits = () => true) {
  const atoms = markdownAtoms(value);
  if (!atoms.length) return [''];
  const chunks = [];
  for (let start = 0; start < atoms.length;) {
    let end = start, size = 0, preferred = 0, lineEnd = 0;
    while (end < atoms.length && (size + atoms[end].text.length <= limit || end === start)) {
      size += atoms[end].text.length;
      end++;
      if (size >= limit * 0.6 && /[\s，。；、]$/.test(atoms[end - 1].text)) preferred = end;
      if (size >= limit * 0.6 && atoms[end - 1].text.endsWith('\n')) lineEnd = end;
    }
    if (end < atoms.length && (lineEnd || preferred) > start) end = lineEnd || preferred;
    let content = renderRange(atoms, start, end);
    // The final structured JSON, not source character count, decides capacity.
    while (!fits(content)) {
      if (end - start === 1) throw new Error('飞书卡片单个链接、标签或字符超过容量，无法无损分片');
      end = start + Math.max(1, Math.floor((end - start) / 2));
      content = renderRange(atoms, start, end);
    }
    chunks.push(content);
    start = end;
  }
  return chunks;
}

export function splitUnicodeText(value, limit) {
  const chunks = [];
  let current = '';
  for (const { segment } of segmenter.segment(String(value ?? ''))) {
    if (current && current.length + segment.length > limit) { chunks.push(current); current = ''; }
    current += segment;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}
