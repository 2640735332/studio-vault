/**
 * Inbox chrome: segment/search/category/hash/drawer. Zero deps.
 * Used by spec-inbox.test.js and viewer.js (served as /static/spec-inbox.js).
 */

export function defaultSeg(route) {
  if (route === 'bugs') return 'new';
  if (route === 'briefs') return 'draft';
  if (route === 'data') return 'writable';
  return '';
}

/** @returns {'new'|'closed'|'other'} */
export function bugSegment(status) {
  const s = String(status || '');
  if (/已关闭/.test(s) || /关闭|非缺陷/.test(s)) return 'closed';
  // `修复中` 是未关闭缺陷，归 open 段，避免默认「新」列表把它藏掉。
  if (s === '' || s === '新' || s === '修复中') return 'new';
  return 'other';
}

/** Canonical brief statuses (BRIEF.md / INDEX / preview). */
export const BRIEF_STATUS_CANON = {
  draft: '草稿',
  ready: '可交 spec-engine',
  doing: '实现中',
  done: '已实现',
  rejected: '已否决',
};

export const BRIEF_SEG_LABEL = {
  draft: '草稿',
  ready: '可交',
  doing: '实现中',
  done: '已实现',
  rejected: '已否决',
};

export const BRIEF_LIST_SEGS = ['draft', 'ready', 'doing', 'done', 'rejected', 'all'];

/**
 * @returns {'draft'|'ready'|'doing'|'done'|'rejected'|'other'}
 */
export function briefSegment(status) {
  const s = String(status || '');
  if (/已否决|rejected/i.test(s)) return 'rejected';
  if (/已实现|implemented/i.test(s)) return 'done';
  if (/实现中|已交 spec-engine/i.test(s)) return 'doing';
  if (/可交|ready/i.test(s)) return 'ready';
  if (/草稿|draft/i.test(s) || s.trim() === '') return 'draft';
  return 'other';
}

export function briefStatusTag(status) {
  const seg = briefSegment(status);
  return {
    seg,
    cls: seg === 'other' ? 'draft' : seg,
    label: BRIEF_SEG_LABEL[seg] || String(status || '草稿').slice(0, 12),
  };
}

export function visibleCount(rows) {
  return Array.isArray(rows) ? rows.length : 0;
}

function hayBug(row) {
  return [row.title, row.id, row.bugId, row.status, row.description]
    .map((x) => String(x || ''))
    .join(' ')
    .toLowerCase();
}

function hayBrief(row) {
  return ((row.title || '') + ' ' + (row.id || '') + ' ' + (row.status || '')).toLowerCase();
}

export function filterInbox(rows, opts) {
  const seg = (opts && opts.seg) || 'new';
  const q = String((opts && opts.q) || '').toLowerCase().trim();
  const cat = String((opts && opts.cat) || '').trim();
  return (rows || []).filter((row) => {
    if (seg !== 'all') {
      const g = bugSegment(row.status);
      if (seg === 'new' && g !== 'new') return false;
      if (seg === 'closed' && g !== 'closed') return false;
    }
    if (cat && String(row.month || '') !== cat) return false;
    if (!q) return true;
    return hayBug(row).includes(q);
  });
}

export function filterBriefs(rows, opts) {
  const seg = (opts && opts.seg) || 'draft';
  const q = String((opts && opts.q) || '').toLowerCase().trim();
  const cat = String((opts && opts.cat) || '').trim();
  return (rows || []).filter((row) => {
    if (seg !== 'all') {
      const g = briefSegment(row.status);
      if (g !== seg) return false;
    }
    if (cat && String(row.month || '') !== cat) return false;
    if (!q) return true;
    return hayBrief(row).includes(q);
  });
}

export function encodeListHash(opts) {
  const o = opts || {};
  const r = String(o.route || 'bugs').replace(/^#\/?/, '').split(/[/?]/)[0];
  const params = new URLSearchParams();
  const dflt = defaultSeg(r);
  const s = o.seg == null || o.seg === '' ? dflt : String(o.seg);
  if (dflt) params.set('seg', s);
  const q = String(o.q || '').trim();
  if (q) params.set('q', q);
  const cat = String(o.cat || '').trim();
  if (cat) params.set('cat', cat);
  const qs = params.toString();
  return '#/' + r + (qs ? '?' + qs : '');
}

export function decodeListHash(hash) {
  const raw = String(hash || '#/pulse').replace(/^#/, '');
  const qIndex = raw.indexOf('?');
  const pathPart = (qIndex >= 0 ? raw.slice(0, qIndex) : raw).replace(/^\//, '');
  const query = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  const segs = pathPart.split('/').filter(Boolean);
  const route = segs[0] || 'pulse';
  const params = new URLSearchParams(query);
  let seg = params.get('seg');
  if (seg == null || seg === '') seg = defaultSeg(route);
  if (route === 'bugs' && seg !== 'new' && seg !== 'closed' && seg !== 'all') seg = 'new';
  if (route === 'briefs' && !BRIEF_LIST_SEGS.includes(seg)) seg = 'draft';
  if (route === 'data' && seg !== 'writable' && seg !== 'readonly' && seg !== 'all') seg = 'writable';
  return {
    route,
    segs,
    rest: segs.slice(1),
    seg,
    q: params.get('q') || '',
    cat: params.get('cat') || '',
  };
}

export function isDrawerRoute(hash) {
  const d = decodeListHash(hash);
  const r = d.route;
  if (r === 'bug' || r === 'brief' || r === 'file' || r === 'domain') return true;
  if (r === 'pkg') return true;
  if (r === 'data' && d.segs.length >= 3) return true;
  return false;
}
