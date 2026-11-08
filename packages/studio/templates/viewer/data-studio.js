/**
 * Data studio renderer — Spec Viewer「数据」页签。
 *
 * 纯字符串构建器：模块作用域不碰 DOM，node --test 可直接 import 断言 HTML。
 * 旧渲染（data-app.js 的 renderFields）保留为叶子控件层：本模块只加
 * 「字段元数据 + 分组折叠 + atom 结构化 + 常驻保存栏」这一层。
 * 样式一律 df2- 前缀（viewer.css 末尾追加），回滚 = 去掉 viewer.js 的 import。
 */
import {
  renderField, fieldLabel, enumLabel, atomTypeLabel, setFieldDict, fieldValueMap,
} from './data-app.js';

const IDENTITY = new Set(['id', 'kind', 'type']);
const COLLAPSE_KEY = 'sv-data-collapse';

/* ---------------- 中文字典 ---------------- */

let DICT = { fields: {}, enums: {}, atomTypes: {}, fieldValues: {} };

/** 注入字典（同时写进 data-app 的叶子标签层）。 */
export function setStudioDict(dict) {
  DICT = dict && typeof dict === 'object'
    ? { fields: dict.fields || {}, enums: dict.enums || {}, atomTypes: dict.atomTypes || {}, fieldValues: dict.fieldValues || {}, items: dict.items || {} }
    : { fields: {}, enums: {}, atomTypes: {}, fieldValues: {}, items: {} };
  setFieldDict(DICT);
  return DICT;
}

export function studioDict() {
  return DICT;
}

export const DICT_URL = '/static/i18n/fields.zh.json';

let dictPromise = null;
/** 拉取 /static/i18n/fields.zh.json；失败不阻塞渲染（全部回退英文 key）。 */
export function loadDict() {
  if (!dictPromise) {
    dictPromise = fetch(DICT_URL)
      .then((r) => (r && r.ok ? r.json() : null))
      .then((j) => setStudioDict(j))
      .catch(() => setStudioDict(null));
  }
  return dictPromise;
}

/* ---------------- 折叠状态（会话内记忆） ---------------- */

let collapseMap = null;

function store() {
  if (collapseMap) return collapseMap;
  collapseMap = {};
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(COLLAPSE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) collapseMap = parsed;
      }
    }
  } catch (e) { collapseMap = {}; }
  return collapseMap;
}

function persistCollapse() {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(COLLAPSE_KEY, JSON.stringify(store()));
  } catch (e) { /* 私密模式/配额：只保留内存态 */ }
}

export function isCollapsed(id) {
  return !!store()[id];
}

export function setCollapsed(id, on) {
  const m = store();
  if (on) m[id] = 1;
  else delete m[id];
  persistCollapse();
}

export function toggleCollapsed(id) {
  setCollapsed(id, !isCollapsed(id));
  return isCollapsed(id);
}

export function resetStudioCollapse() {
  collapseMap = {};
  persistCollapse();
}

/** 折叠 id 的条目命名空间（同一条目的折叠状态独立于其它模板）。 */
let NS = '';

function cid(kind, path) {
  return NS + kind + ':' + path;
}

/* ---------------- 转义/小工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(s) {
  return esc(s).replace(/'/g, '&#39;');
}

function slug(s) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]+/g, '-');
}

export function anchorFor(kind, path) {
  return 'df2-a-' + (kind ? slug(kind) + '-' : '') + slug(path || 'root');
}

/** 'legs.0.atoms.2.duration' → 'legs[0].atoms[2].duration' */
export function prettyPath(path) {
  const p = String(path == null ? '' : path);
  if (!p) return '(根)';
  return p.split('.').reduce((acc, seg) => {
    if (/^\d+$/.test(seg)) return acc + '[' + seg + ']';
    return acc ? acc + '.' + seg : seg;
  }, '');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isEmptyCompound(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

/* ---------------- 差异（变更摘要 / 脏计数） ---------------- */

export function diffValues(before, after, prefix, out) {
  const rows = out || [];
  const p = prefix == null ? '' : prefix;
  const bArr = Array.isArray(before);
  const aArr = Array.isArray(after);
  if (bArr || aArr) {
    const a = bArr ? before : [];
    const b = aArr ? after : [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      diffValues(a[i], b[i], p ? p + '.' + i : String(i), rows);
    }
    return rows;
  }
  const bObj = isPlainObject(before);
  const aObj = isPlainObject(after);
  if (bObj || aObj) {
    const a = bObj ? before : {};
    const b = aObj ? after : {};
    const keys = [];
    for (const k of Object.keys(a)) if (keys.indexOf(k) < 0) keys.push(k);
    for (const k of Object.keys(b)) if (keys.indexOf(k) < 0) keys.push(k);
    for (const k of keys) {
      const path = p ? p + '.' + k : k;
      const hasA = Object.prototype.hasOwnProperty.call(a, k);
      const hasB = Object.prototype.hasOwnProperty.call(b, k);
      if (!hasA || !hasB) {
        rows.push({ path, before: a[k], after: b[k], kind: hasA ? 'del' : 'add' });
        continue;
      }
      diffValues(a[k], b[k], path, rows);
    }
    return rows;
  }
  if (!Object.is(before, after) && JSON.stringify(before) !== JSON.stringify(after)) {
    rows.push({ path: p || '(根)', before, after, kind: 'set' });
  }
  return rows;
}

/** 服务端 pointer（/templates/2/legs/0/atoms/3/duration）→ 草稿内路径。 */
export function matchPointer(draft, pointer) {
  const segs = String(pointer == null ? '' : pointer)
    .split('/').filter((s) => s !== '')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (let i = 0; i < segs.length; i++) {
    const cand = segs.slice(i);
    if (resolves(draft, cand)) return cand.join('.');
  }
  return '';
}

function resolves(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (cur == null || typeof cur !== 'object') return false;
    if (Array.isArray(cur)) {
      const i = Number(s);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return false;
      cur = cur[i];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, s)) return false;
      cur = cur[s];
    }
  }
  return true;
}

/* ---------------- atom 参数目录（按 type 收敛） ---------------- */

/** 每个 type 关心的参数（其余收进「全部字段」；未知键进「扩展（未识别）」）。 */
export const ATOM_TYPE_PARAMS = {
  NAV_TO: ['anchor', 'stop_dist', 'target'],
  GATE_AT: ['anchor', 'stop_dist', 'target'],
  GATE_ENTERED: ['target'],
  ENTER_INTERIOR: [],
  EXIT_INTERIOR: [],
  TAKE_ITEM: ['resource', 'amount'],
  PUT_ITEM: ['resource', 'amount'],
  TRANSFER: ['resource', 'amount'],
  TICK_SIM: ['action', 'duration'],
  TICK_CALENDAR: ['action'],
  WAIT_UNTIL: ['condition'],
  INTERACT_ENTITY: ['entity_id', 'duration'],
  FIND_NEAREST_ENTITY: ['scope'],
  UNLOAD_INVENTORY: [],
  ENSURE_HARVEST_CAPACITY: [],
  PLANT_SAPLING: [],
  DAMAGE_ENTITY: ['entity_id'],
  REQUIRE_TOOL: ['entity_id', 'tool_id'],
  USE_TOOL_ACTION: ['tool_id', 'duration'],
  MOUNT: ['target'],
  DRIVE_TO: ['target'],
  DISMOUNT: [],
  REGISTER_WORKER: ['target'],
  UNREGISTER: ['target'],
  EMIT_EVENT: ['event'],
  BRANCH: ['condition'],
  FAIL: [],
};

const ATOM_COMMON = ['requires'];
const ANCHOR_KEYS = ['kind', 'target', 'point_type', 'entity_id'];
const ANCHOR_KINDS = ['EXTERIOR_EDGE', 'INTERIOR', 'POINT', 'WORLD_ENTITY', 'FOOTPRINT_TILE'];
const GATE_TOKENS = ['at_anchor', 'gate_passed', 'tool_equipped', 'materials_complete', 'not_sleeping', 'interior_entered', 'has_carry', 'no_carry'];

/** schema 未声明 enum 但取值有限的字段：给 datalist 建议值（自由文本仍可写，不锁死数据）。 */
const ENUM_HINTS = {
  interrupt_policy: ['FINISH_LEG', 'ABORT'],
  on_fail: ['WAIT', 'FAIL', 'RETRY'],
};

const NUMERIC_PARAMS = new Set(['stop_dist', 'entity_id', 'duration', 'amount', 'priority', 'value']);
const STRING_PARAMS = new Set(['tool_id', 'event', 'condition', 'scope', 'point_type', 'action', 'resource', 'target']);

/** 该 type 显示的参数顺序（不含 type）。 */
export function atomParamKeys(type) {
  const own = ATOM_TYPE_PARAMS[type] || [];
  return ATOM_COMMON.concat(own.filter((k) => ATOM_COMMON.indexOf(k) < 0));
}

function atomSchemaKeys(atomSchema) {
  return atomSchema && atomSchema.properties ? Object.keys(atomSchema.properties) : [];
}

/** 全部可识别参数（schema ∪ 目录）；其余键 = 「扩展（未识别）」。 */
export function atomKnownKeys(atomSchema) {
  const keys = ['type'];
  for (const k of atomSchemaKeys(atomSchema)) if (keys.indexOf(k) < 0) keys.push(k);
  for (const k of ATOM_COMMON) if (keys.indexOf(k) < 0) keys.push(k);
  for (const t of Object.keys(ATOM_TYPE_PARAMS)) {
    for (const k of ATOM_TYPE_PARAMS[t]) if (keys.indexOf(k) < 0) keys.push(k);
  }
  return keys;
}

/** 切换 type 只改 type，绝不删字段（不静默丢数据）。 */
export function applyAtomType(atom, type) {
  const next = Object.assign({}, atom || {});
  next.type = type;
  return next;
}

/** 已存在但不属于该 type 的字段（提示用；仍保留在「全部字段」里）。 */
export function atomOffTypeKeys(atom, type) {
  const on = atomParamKeys(type);
  return Object.keys(atom || {}).filter((k) => k !== 'type' && on.indexOf(k) < 0 && atomKnownKeys(null).indexOf(k) >= 0);
}

export function splitExtras(obj, knownKeys) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  const known = new Set(knownKeys || []);
  for (const k of Object.keys(obj)) if (!known.has(k)) out[k] = obj[k];
  return out;
}

/** 把「扩展 JSON」合并回对象：已识别键保留现状，扩展键覆盖写入。 */
export function mergeExtras(obj, patch, knownKeys) {
  const known = new Set(knownKeys || []);
  const cur = isPlainObject(obj) ? obj : {};
  const next = {};
  for (const k of Object.keys(cur)) if (known.has(k)) next[k] = cur[k];
  if (isPlainObject(patch)) for (const k of Object.keys(patch)) next[k] = patch[k];
  return next;
}

/** 新增 atom 的默认 type（字典第一项 = NAV_TO；不改已有数据）。 */
export function defaultAtomType() {
  const keys = Object.keys(DICT.atomTypes || {});
  return keys.length ? keys[0] : 'NAV_TO';
}

export function atomTypeList(atomSchema, current) {
  const typeSch = atomSchema && atomSchema.properties && atomSchema.properties.type;
  const list = typeSch && Array.isArray(typeSch.enum) && typeSch.enum.length
    ? typeSch.enum.slice()
    : Object.keys(DICT.atomTypes || {});
  if (current && list.indexOf(current) < 0) list.unshift(current);
  return list;
}

function guessSchema(key, val) {
  if (Array.isArray(val)) return { type: 'array', items: { type: 'string' } };
  if (typeof val === 'number') return { type: 'number' };
  if (typeof val === 'boolean') return { type: 'boolean' };
  if (NUMERIC_PARAMS.has(key)) return { type: 'number' };
  if (isPlainObject(val)) return { type: 'object' };
  if (STRING_PARAMS.has(key)) return { type: 'string' };
  return { type: 'string' };
}

/* ---------------- 结构与分组 ---------------- */

/** 腿数组识别：值形状（每个元素有 atoms 数组）或 schema（key=legs / items 声明 atoms）。 */
export function detectLegsKey(schema, value) {
  const props = (schema && schema.properties) || {};
  const keys = Object.keys(props);
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) if (keys.indexOf(k) < 0) keys.push(k);
  }
  for (const k of keys) {
    const v = value ? value[k] : undefined;
    if (Array.isArray(v) && v.length && v.every((x) => isPlainObject(x) && Array.isArray(x.atoms))) return k;
  }
  for (const k of keys) {
    const sch = props[k] || {};
    const items = sch.items || {};
    if (k === 'legs' && (sch.type === 'array' || sch.items)) return k;
    if (items.properties && items.properties.atoms) return k;
  }
  if (isPlainObject(value) && Array.isArray(value.legs)) return 'legs';
  return '';
}

function isLeafField(sch, val) {
  const s = sch || {};
  if (s.enum) return true;
  if (Array.isArray(s.type)) return true;
  const t = s.type;
  if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean') return true;
  if (t === 'array') {
    const items = s.items || {};
    if (s.minItems === 2 && s.maxItems === 2) return true;
    if (items.type === 'object' || items.properties) return false;
    return true;
  }
  if (t === 'object') return false;
  if (Array.isArray(val)) return false;
  if (isPlainObject(val)) return false;
  return true;
}

/** 受限取值字段（schema 无 enum）：下拉显示中文（原始值），保存仍写原始英文值。 */
function enumHintHtml(key, val, path, o) {
  const valueMap = fieldValueMap(key) || {};
  const names = (ENUM_HINTS[key] || Object.keys(valueMap)).slice();
  const textOf = (v) => esc((valueMap[v] || enumLabel(v) || v) + '（' + v + '）');
  let opts = names.map((v) => '<option value="' + attr(v) + '"' + (v === val ? ' selected' : '') + '>' + textOf(v) + '</option>').join('');
  if (val && names.indexOf(val) < 0) opts = '<option value="' + attr(val) + '" selected>' + esc(val) + '</option>' + opts;
  if (val == null || val === '') opts = '<option value="" selected>（空）</option>' + opts;
  return '<div class="df-row">' + labelFor(key)
    + '<select data-path="' + attr(path) + '"' + (o.writable ? '' : ' disabled') + '>' + opts + '</select></div>';
}

function labelFor(key, extraClass) {
  const zh = fieldLabel(key);
  const name = zh || key;
  const tip = zh ? ' title="' + attr(key) + '"' : '';
  let h = '<label class="df-lab' + (extraClass ? ' ' + extraClass : '') + '"' + tip + '>' + esc(name);
  if (zh) h += '<small class="df-key">' + esc(key) + '</small>';
  return h + '</label>';
}

function groupHtml(o) {
  const id = o.id;
  const open = !isCollapsed(id);
  const anchor = o.anchor || '';
  const tag = o.tag ? '<span class="df2-tag">' + esc(o.tag) + '</span>' : '';
  const ops = o.ops || '';
  return '<section class="df2-group' + (open ? ' open' : ' closed') + (o.cls ? ' ' + o.cls : '') + '"'
    + (anchor ? ' id="' + attr(anchor) + '"' : '')
    + ' data-grp="' + attr(id) + '">'
    + '<div class="df2-gh" data-df2-collapse="' + attr(id) + '" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">'
    + '<span class="df2-caret" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>'
    + '<span class="df2-gt">' + esc(o.title) + '</span>'
    + tag + (o.sub ? '<span class="df2-gsub">' + esc(o.sub) + '</span>' : '')
    + '<span class="df2-grow"></span>' + ops
    + '</div>'
    + '<div class="df2-gb"' + (open ? '' : ' hidden') + '>' + o.body + '</div>'
    + '</section>';
}

function emptyState(text, extra) {
  return '<div class="df2-empty"><p class="df2-empty-t">' + esc(text) + '</p>'
    + (extra || '') + '</div>';
}

function hint(text) {
  return '<p class="df2-hint">' + esc(text) + '</p>';
}

/* ---------------- 扩展（未识别）区 ---------------- */

function extrasHtml(obj, path, knownKeys, o) {
  const extras = splitExtras(obj, knownKeys);
  const keys = Object.keys(extras);
  const text = keys.length ? JSON.stringify(extras, null, 2) : '{}';
  return '<details class="df2-extras"' + (keys.length ? ' open' : '') + '>'
    + '<summary>扩展（未识别）<span class="df2-tag">' + keys.length + '</span>'
    + '<span class="df2-gsub">' + (keys.length ? esc(keys.join(', ')) : 'schema 之外的键') + '</span></summary>'
    + '<textarea class="df2-json" data-extras="' + attr(path) + '" data-known="' + attr(JSON.stringify(knownKeys)) + '"'
    + ' spellcheck="false"' + (o.writable ? '' : ' readonly') + '>' + esc(text) + '</textarea>'
    + hint('只写 schema 之外的键；保存时与已识别字段合并，不丢数据。JSON 写错时保留输入、不写回草稿。')
    + '</details>';
}

/* ---------------- 控件 ---------------- */

function chipsHtml(atom, atomPath, key, o) {
  const arr = Array.isArray(atom[key]) ? atom[key] : [];
  const path = atomPath + '.' + key;
  const chips = arr.map((v, i) => {
    const raw = String(v);
    const zh = enumLabel(raw);
    return '<span class="df2-chip" title="' + attr(raw) + '">' + esc(zh || raw)
      + (o.writable
        ? '<button type="button" class="df2-chip-x" data-df2-chip-del="' + attr(path) + '" data-i="' + i + '" aria-label="移除">×</button>'
        : '')
      + '</span>';
  }).join('');
  const add = o.writable
    ? '<span class="df2-chip-add"><input class="df2-chip-in" data-df2-chip-new="' + attr(path) + '" list="df2-gate-tokens" placeholder="新增后回车" spellcheck="false">'
      + '<button type="button" class="df2-btn df2-mini" data-df2-chip-add="' + attr(path) + '">＋</button></span>'
    : '';
  return '<div class="df-row df2-chips-row">' + labelFor(key)
    + '<div class="df2-chips" data-df2-chips="' + attr(path) + '">' + (chips || '<span class="df2-muted">无</span>') + add + '</div></div>';
}

function anchorHtml(atom, atomPath, o) {
  const anchor = atom.anchor;
  const base = atomPath + '.anchor';
  if (anchor != null && typeof anchor !== 'object') {
    return '<div class="df-row df2-anchor-row">' + labelFor('anchor')
      + '<div><input data-path="' + attr(base) + '" value="' + attr(anchor) + '"' + (o.writable ? '' : ' readonly') + '>'
      + '<p class="df2-hint">字符串简写（等于 EXTERIOR_EDGE + 该目标）；改结构化请切到对象。</p></div></div>';
  }
  const a = isPlainObject(anchor) ? anchor : {};
  const kinds = ANCHOR_KINDS.slice();
  if (a.kind && kinds.indexOf(a.kind) < 0) kinds.unshift(String(a.kind));
  const kindOpts = kinds.map((k) => {
    const zh = enumLabel(k);
    return '<option value="' + attr(k) + '" title="' + attr(k) + '"' + (a.kind === k ? ' selected' : '') + '>'
      + esc(zh ? zh + '（' + k + '）' : k) + '</option>';
  }).join('');
  const ro = o.writable ? '' : ' readonly';
  const dis = o.writable ? '' : ' disabled';
  const extras = splitExtras(a, ANCHOR_KEYS);
  const ptMap = fieldValueMap('point_type') || {};
  const ptNames = Object.keys(ptMap);
  let ptOpts = '<option value=""' + (a.point_type == null || a.point_type === '' ? ' selected' : '') + '>（未设置）</option>'
    + ptNames.map((v) => '<option value="' + attr(v) + '"' + (v === a.point_type ? ' selected' : '') + '>' + esc(ptMap[v] + '（' + v + '）') + '</option>').join('');
  if (a.point_type && ptNames.indexOf(String(a.point_type)) < 0) ptOpts += '<option value="' + attr(a.point_type) + '" selected>' + esc(a.point_type) + '</option>';
  return '<div class="df2-sub" data-df2-anchor="' + attr(atomPath) + '">'
    + '<div class="df2-sub-h">锚点 <small class="df-key">anchor</small></div>'
    + '<div class="df-row"><label class="df-lab" title="kind">锚点类型<small class="df-key">kind</small></label>'
    + '<select data-path="' + attr(base) + '.kind"' + dis + '>' + kindOpts + '</select></div>'
    + '<div class="df-row"><label class="df-lab" title="target">目标<small class="df-key">target</small></label>'
    + '<input data-path="' + attr(base) + '.target" value="' + attr(a.target == null ? '' : a.target) + '" placeholder="target / source / dest / 建筑 id"' + ro + '></div>'
    + '<div class="df-row"><label class="df-lab" title="point_type">点位类型<small class="df-key">point_type</small></label>'
    + '<select data-path="' + attr(base) + '.point_type"' + dis + '>' + ptOpts + '</select></div>'
    + '<div class="df-row"><label class="df-lab" title="entity_id">实体 ID<small class="df-key">entity_id</small></label>'
    + '<input type="number" data-path="' + attr(base) + '.entity_id" value="' + attr(a.entity_id == null ? '' : a.entity_id) + '" placeholder="仅 WORLD_ENTITY"' + ro + '></div>'
    + (Object.keys(extras).length ? '<div class="df2-sub">' + extrasHtml(a, base, ANCHOR_KEYS, o) + '</div>' : '')
    + '</div>';
}

function atomParamHtml(atom, atomPath, key, atomSchema, o) {
  if (key === 'requires') return chipsHtml(atom, atomPath, key, o);
  if (key === 'anchor') return anchorHtml(atom, atomPath, o);
  const props = (atomSchema && atomSchema.properties) || {};
  const sub = props[key] || guessSchema(key, atom[key]);
  return renderField(atomSchema || { type: 'object', properties: {} }, sub, atom[key], atomPath, key, o.xrefs, o.writable);
}

function atomCard(atom, index, atomsPath, o) {
  const path = atomsPath + '.' + index;
  const id = cid('atom', path);
  const open = !isCollapsed(id);
  const type = atom && atom.type != null ? String(atom.type) : '';
  const zh = atomTypeLabel(type);
  const types = atomTypeList(o.atomSchema, type);
  const typeOpts = types.map((t) => {
    const label = atomTypeLabel(t);
    return '<option value="' + attr(t) + '" title="' + attr(t) + '"' + (t === type ? ' selected' : '') + '>'
      + esc(label ? label + '（' + t + '）' : t) + '</option>';
  }).join('');
  const allMode = isCollapsed('all:' + path); /* 视图开关：按路径记忆，跨条目共用 */
  const onKeys = atomParamKeys(type);
  const known = atomKnownKeys(o.atomSchema);
  const shown = allMode ? known.filter((k) => k !== 'type') : onKeys;
  let body = '<div class="df-row"><label class="df-lab" title="type">动作类型<small class="df-key">type</small></label>'
    + '<select data-atom-type="' + attr(path) + '"' + (o.writable ? '' : ' disabled') + '>' + typeOpts + '</select></div>';
  body += shown.map((k) => atomParamHtml(atom, path, k, o.atomSchema, o)).join('');
  const offType = atomOffTypeKeys(atom, type);
  if (!allMode && offType.length) {
    body += hint('已保留 ' + offType.length + ' 个不属于 ' + (type || '未设置') + ' 的字段：' + offType.join('、') + '（点「全部字段」查看，不会丢）');
  }
  if (offType.length || Object.keys(splitExtras(atom, known)).length) {
    const label = allMode ? '收起全部字段' : '全部字段（+' + Math.max(0, known.length - 1 - onKeys.length) + '）';
    body += '<button type="button" class="df2-btn df2-mini" data-df2-all="' + attr(path) + '">' + esc(label) + '</button>';
  }
  body += extrasHtml(atom, path, known, o);
  const ops = o.writable
    ? '<button type="button" class="df2-btn df2-mini" data-df2-act="atom-up" data-path="' + attr(atomsPath) + '" data-i="' + index + '" title="上移">↑</button>'
      + '<button type="button" class="df2-btn df2-mini" data-df2-act="atom-down" data-path="' + attr(atomsPath) + '" data-i="' + index + '" title="下移">↓</button>'
      + '<button type="button" class="df2-btn df2-mini df2-danger" data-df2-act="atom-del" data-path="' + attr(atomsPath) + '" data-i="' + index + '" title="删除这个动作">删</button>'
    : '';
  return '<section class="df2-atom' + (open ? ' open' : ' closed') + '" id="' + attr(anchorFor('atom', path)) + '" data-atom="' + attr(path) + '" data-grp="' + attr(id) + '">'
    + '<div class="df2-atom-h" data-df2-collapse="' + attr(id) + '" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">'
    + '<span class="df2-caret" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>'
    + '<span class="df2-type" title="' + attr(type) + '">' + esc(type || '未设置') + '</span>'
    + '<span class="df2-atom-name">' + esc(zh || '（缺词条，回退英文 key）') + '</span>'
    + '<span class="df2-atom-idx">#' + (index + 1) + '</span>'
    + '<span class="df2-grow"></span>' + ops
    + '</div>'
    + '<div class="df2-atom-b"' + (open ? '' : ' hidden') + '>' + body + '</div>'
    + '</section>';
}

function legsHtml(legsKey, legs, o) {
  const path = legsKey;
  const subject = String(legsKey) === 'legs' ? '腿' : legsKey;
  if (!Array.isArray(legs) || !legs.length) {
    return emptyState('暂无' + subject,
      o.writable ? '<button type="button" class="df2-btn" data-df2-act="leg-add" data-path="' + attr(path) + '">＋ 新增' + subject + '</button>' : '');
  }
  let h = '';
  legs.forEach((leg, i) => {
    const lp = path + '.' + i;
    const id = cid('leg', lp);
    const open = !isCollapsed(id);
    const atoms = Array.isArray(leg.atoms) ? leg.atoms : [];
    const atomsPath = lp + '.atoms';
    let body = '';
    if (!atoms.length) {
      body += emptyState('暂无动作', o.writable
        ? '<button type="button" class="df2-btn" data-df2-act="atom-add" data-path="' + attr(atomsPath) + '">＋ 新增动作</button>' : '');
    } else {
      body += atoms.map((a, j) => atomCard(a, j, atomsPath, o)).join('');
      body += o.writable
        ? '<button type="button" class="df2-btn df2-add" data-df2-act="atom-add" data-path="' + attr(atomsPath) + '">＋ 新增动作</button>'
        : '';
    }
    const legKnown = ['atoms'];
    body += extrasHtml(leg, lp, legKnown, o);
    const ops = o.writable
      ? '<button type="button" class="df2-btn df2-mini" data-df2-act="leg-up" data-path="' + attr(path) + '" data-i="' + i + '" title="上移">↑</button>'
        + '<button type="button" class="df2-btn df2-mini" data-df2-act="leg-down" data-path="' + attr(path) + '" data-i="' + i + '" title="下移">↓</button>'
        + '<button type="button" class="df2-btn df2-mini df2-danger" data-df2-act="leg-del" data-path="' + attr(path) + '" data-i="' + i + '" title="删除这条腿">删</button>'
      : '';
    h += groupHtml({
      id,
      title: subject + ' ' + (i + 1),
      tag: atoms.length + ' 个动作',
      sub: leg && leg.label != null ? String(leg.label) : '',
      anchor: anchorFor('leg', lp),
      cls: 'df2-leg',
      body,
      ops,
    });
    o.toc.push({ anchor: anchorFor('leg', lp), label: subject + ' ' + (i + 1), depth: 1 });
    atoms.forEach((a, j) => {
      const ap = atomsPath + '.' + j;
      const t = a && a.type != null ? String(a.type) : '';
      o.toc.push({ anchor: anchorFor('atom', ap), label: '#' + (j + 1) + ' ' + (atomTypeLabel(t) || t || '未设置'), depth: 2 });
    });
  });
  h += o.writable
    ? '<button type="button" class="df2-btn" data-df2-act="leg-add" data-path="' + attr(path) + '">＋ 新增' + subject + '</button>'
    : '';
  return h;
}

/* ---------------- 顶部/保存栏/摘要 ---------------- */

function errorBannerHtml(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return '<div id="data-err" class="df2-banner" role="alert" hidden></div>';
  const items = list.map((e, i) => {
    const path = e.path || '';
    const msg = e.message || '校验失败';
    return '<li><button type="button" class="df2-errjump" data-df2-err-jump="' + attr(path) + '">'
      + esc(prettyPath(path)) + '</button><span class="df2-errtxt">' + esc(msg) + '</span></li>';
  }).join('');
  return '<div id="data-err" class="df2-banner" role="alert">'
    + '<div class="df2-banner-h">保存失败：' + list.length + ' 个字段未通过校验（点路径跳转）</div>'
    + '<ul class="df2-errlist">' + items + '</ul></div>';
}

export function renderErrorBanner(errors) {
  return errorBannerHtml(errors);
}

function dirtyText(dirty) {
  return dirty ? dirty + ' 处未保存' : '未修改';
}

function saveBarHtml(o) {
  if (!o.writable) {
    return '<div class="df2-savebar df2-ro" id="df2-savebar">'
      + '<span class="df2-badge df2-ro-badge">只读</span>'
      + '<span class="df2-rotext">该表不可写（seg=readonly / 不可写目录）：输入已全部禁用，不提供保存。</span>'
      + '</div>';
  }
  const dirty = o.dirty || 0;
  return '<div class="df2-savebar" id="df2-savebar">'
    + '<span class="df2-dirty' + (dirty ? ' on' : '') + '" id="data-dirty">'
    + '<span class="df2-dot" aria-hidden="true"></span>' + dirtyText(dirty) + '</span>'
    + '<span class="df2-grow"></span>'
    + '<button type="button" class="df2-btn" data-df2-summary-toggle>变更摘要</button>'
    + '<button type="button" class="df2-btn" data-df2-revert' + (dirty ? '' : ' disabled') + '>回滚</button>'
    + '<button type="button" id="data-save" class="df2-primary"' + (o.saving ? ' disabled' : '') + '>'
    + '<span class="df2-save-label">' + (o.saving ? '保存中…' : '保存') + '</span>'
    + ' <span class="df2-kbd">Ctrl+S</span></button>'
    + '</div>';
}

function summaryRowHtml(row) {
  const kind = row.kind === 'add' ? '新增' : row.kind === 'del' ? '删除' : '修改';
  const fmt = (v) => {
    if (v === undefined) return '—';
    const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
    return s && s.length > 60 ? s.slice(0, 57) + '…' : (s == null ? String(v) : s);
  };
  return '<li><button type="button" class="df2-diffpath" data-df2-err-jump="' + attr(row.path) + '">'
    + esc(prettyPath(row.path)) + '</button>'
    + '<span class="df2-diffkind ' + attr(row.kind || 'set') + '">' + kind + '</span>'
    + '<span class="df2-diffval"><s>' + esc(fmt(row.before)) + '</s> → ' + esc(fmt(row.after)) + '</span></li>';
}

function summaryHtml(o) {
  const rows = o.diff || [];
  const body = rows.length
    ? '<ul class="df2-difflist">' + rows.slice(0, 200).map(summaryRowHtml).join('') + '</ul>'
      + (rows.length > 200 ? hint('仅显示前 200 条，共 ' + rows.length + ' 条变更。') : '')
    : '<p class="df2-muted">没有变更。改字段后这里会列出逐条差异。</p>';
  return '<aside class="df2-summary" id="df2-summary" hidden aria-label="变更摘要">'
    + '<div class="df2-summary-h"><b>变更摘要</b><span class="df2-tag">' + rows.length + '</span>'
    + '<span class="df2-grow"></span><button type="button" class="df2-btn df2-mini" data-df2-summary-close aria-label="关闭">×</button></div>'
    + '<div class="df2-summary-b">' + body
    + '<p class="df2-hint">非阻断：只读预览当前草稿与已保存在磁盘上的值的差异；关掉后照常保存。</p>'
    + '</div></aside>';
}

function tocHtml(o) {
  const entries = o.toc || [];
  const sibs = Array.isArray(o.siblings) ? o.siblings : [];
  const items = entries.map((e) => '<button type="button" class="df2-tocitem d' + (e.depth || 0) + '" data-df2-jump="'
    + attr(e.anchor) + '">' + esc(e.label) + '</button>').join('');
  const sib = sibs.length
    ? '<div class="df2-toc-h">同级条目（' + sibs.length + '）</div>'
      + sibs.map((s) => '<button type="button" class="df2-tocitem d0' + (String(s.id) === String(o.id) ? ' on' : '') + '"'
        + ' data-df2-sibling="' + attr(s.id) + '" title="' + attr(s.id) + '">' + esc(s.label || s.id) + '</button>').join('')
    : '';
  return '<nav class="df2-toc" id="df2-toc" aria-label="目录">'
    + '<div class="df2-toc-h">目录</div>' + (items || '<p class="df2-muted">无分组</p>')
    + sib
    + '<div class="df2-toc-h">折叠</div>'
    + '<button type="button" class="df2-tocitem d0" data-df2-expand-all>全部展开</button>'
    + '<button type="button" class="df2-tocitem d0" data-df2-collapse-all>全部折叠</button>'
    + '</nav>';
}

function datalistsHtml() {
  return '<datalist id="df2-gate-tokens">' + GATE_TOKENS.map((t) => '<option value="' + attr(t) + '">' + esc(enumLabel(t) || t) + '</option>').join('') + '</datalist>'
    + '<datalist id="df2-point-types">' + ['enter', 'work', 'haul'].map((t) => '<option value="' + attr(t) + '">' + esc(enumLabel(t) || t) + '</option>').join('') + '</datalist>';
}

/* ---------------- 主入口 ---------------- */

/** 条目级「已识别键」快照：无 schema 表把现有键都算已识别，避免扩展区覆盖丢键。 */
function entryKnown(fieldKeys, legsKey, untyped, value) {
  const known = (untyped ? Object.keys(value || {}) : fieldKeys).slice();
  if (legsKey && known.indexOf(legsKey) < 0) known.push(legsKey);
  return known;
}

/** 容错：误传整文件 schema（只有一个数组属性）而 value 是单条 entry ⇒ 取 items。 */
function unwrapItemSchema(schema, value) {
  const props = (schema && schema.properties) || {};
  const keys = Object.keys(props);
  if (keys.length !== 1) return schema;
  const k = keys[0];
  if (value && Object.prototype.hasOwnProperty.call(value, k)) return schema;
  const sch = props[k] || {};
  return sch.items || schema;
}

/**
 * @param {object} o {stem,id,file,collection,schema,value,baseline,xrefs,writable,saving,errors,diff,dict,siblings}
 * @returns {string} 完整数据页抽屉 body（含 #data-form / #data-save / #data-err / #data-json）
 */
export function renderDataStudio(o) {
  const d = o || {};
  setStudioDict(d.dict || DICT);
  const schema = unwrapItemSchema(d.schema && typeof d.schema === 'object' ? d.schema : { type: 'object', properties: {} }, d.value);
  const value = isPlainObject(d.value) ? d.value : {};
  NS = (d.stem || '') + '|' + (d.id || '') + '|';
  const writable = !!d.writable;
  const diff = Array.isArray(d.diff) ? d.diff : diffValues(d.baseline, value);
  const toc = [];
  const ctx = {
    xrefs: d.xrefs || {}, writable, atomSchema: null, toc,
  };
  const props = schema.properties || {};
  const schemaKeys = Object.keys(props);
  // 无 schema 的表（seasons 一类）：按值的形状猜字段，仍然逐行编辑（不退化成一整块 JSON）
  const untyped = schemaKeys.length === 0 && Object.keys(value).length > 0;
  const keys = untyped ? Object.keys(value) : schemaKeys;
  const propFor = (k) => (props[k] ? props[k] : guessSchema(k, value[k]));
  const legsKey = detectLegsKey(schema, value);
  const extrasKeys = untyped ? [] : keys.filter((k) => !props[k]);
  const identity = keys.filter((k) => IDENTITY.has(k));
  const scalar = keys.filter((k) => !IDENTITY.has(k) && k !== legsKey && isLeafField(propFor(k), value[k]));
  const compound = keys.filter((k) => !IDENTITY.has(k) && k !== legsKey && !isLeafField(propFor(k), value[k]));

  if (legsKey) {
    const legSchema = (props[legsKey] && props[legsKey].items) || {};
    const atomSch = (legSchema.properties && legSchema.properties.atoms && legSchema.properties.atoms.items) || null;
    ctx.atomSchema = atomSch;
  }

  const rowHtml = (k) => {
    const v = value[k];
    let h = ENUM_HINTS[k]
      ? enumHintHtml(k, v, k, ctx)
      : renderField(schema, propFor(k), v, '', k, ctx.xrefs, writable);
    if (isEmptyCompound(v)) h = '<div class="df2-empty-inline">暂无条目</div>' + h;
    return h;
  };

  let body = '';
  if (legsKey) {
    const legs = Array.isArray(value[legsKey]) ? value[legsKey] : [];
    const outerId = cid('tpl', '');
    const inner = identity.concat(scalar, compound).map(rowHtml).join('')
      + '<div class="df2-sub-h">腿（legs → atoms）</div>'
      + legsHtml(legsKey, legs, ctx)
      + extrasHtml(value, '', entryKnown(keys, legsKey, untyped, value), ctx);
    body = groupHtml({
      id: outerId,
      title: '模板 ' + (value.id != null ? String(value.id) : ''),
      tag: legs.length + ' 条腿',
      anchor: anchorFor('tpl', 'root'),
      cls: 'df2-tpl',
      body: inner,
      sub: d.stem || '',
    });
    toc.unshift({ anchor: anchorFor('tpl', 'root'), label: '模板 ' + (value.id != null ? String(value.id) : ''), depth: 0 });
  } else {
    if (identity.length) {
      body += groupHtml({
        id: cid('grp', 'identity'), title: '身份（只读）', tag: identity.length + ' 项',
        anchor: anchorFor('grp', 'identity'), cls: 'df2-id',
        body: identity.map(rowHtml).join(''),
      });
      toc.push({ anchor: anchorFor('grp', 'identity'), label: '身份（只读）', depth: 0 });
    }
    if (scalar.length) {
      body += groupHtml({
        id: cid('grp', 'basic'), title: '基础字段', tag: scalar.length + ' 项',
        anchor: anchorFor('grp', 'basic'), body: scalar.map(rowHtml).join(''),
      });
      toc.push({ anchor: anchorFor('grp', 'basic'), label: '基础字段', depth: 0 });
    }
    if (compound.length) {
      body += groupHtml({
        id: cid('grp', 'compound'), title: '对象与列表', tag: compound.length + ' 项',
        anchor: anchorFor('grp', 'compound'), body: compound.map(rowHtml).join(''),
      });
      toc.push({ anchor: anchorFor('grp', 'compound'), label: '对象与列表', depth: 0 });
    }
    if (!identity.length && !scalar.length && !compound.length && !extrasKeys.length) {
      body = emptyState('暂无字段', writable ? hint('该条目是空对象；保存会照原样写回 {}。') : '');
    }
    body += extrasHtml(value, '', entryKnown(keys, legsKey, untyped, value), ctx);
    toc.push({ anchor: anchorFor('grp', 'extra'), label: '扩展（未识别）', depth: 0 });
  }

  const dirty = diff.length;
  const form = '<form id="data-form" class="df df2-form" autocomplete="off" novalidate>'
    + datalistsHtml() + body + '</form>';
  const shell = '<div class="df2-shell">' + tocHtml({ toc, siblings: d.siblings, id: d.id })
    + '<div class="df2-main">' + form
    + '<div class="df2-preview" id="df2-preview"><div class="df2-preview-h">完整 JSON（即将写回）</div>'
    + '<pre id="data-json" class="df-pre">' + esc(JSON.stringify(value, null, 2)) + '</pre></div>'
    + '</div></div>';

  const head = '<div class="df2-top">'
    + '<span class="df2-badge ' + (writable ? 'ok' : 'ro') + '">' + (writable ? '可写' : '只读') + '</span>'
    + (d.collection ? '<span class="df2-badge">' + esc(d.collection) + '</span>' : '')
    + '<span class="df2-grow"></span>'
    + '<button type="button" class="df2-btn df2-toc-toggle" data-df2-toc-toggle>☰ 目录</button>'
    + '</div>';

  return '<div class="df2' + (writable ? '' : ' df2-readonly') + '" data-stem="' + attr(d.stem || '') + '" data-id="' + attr(d.id || '') + '">'
    + head
    + errorBannerHtml(d.errors)
    + shell
    + summaryHtml({ diff })
    + saveBarHtml({ writable, dirty, saving: !!d.saving })
    + '</div>';
}

export function renderStudioSummary(diff) {
  return summaryHtml({ diff: Array.isArray(diff) ? diff : [] });
}
