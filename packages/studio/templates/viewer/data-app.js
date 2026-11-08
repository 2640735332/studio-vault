/** Data studio form/thumb helpers. Loaded as /static/data-app.js */

const JSON_BLOCKS = new Set(['legs', 'atoms']);
const IDENTITY = new Set(['id', 'kind', 'type']);

/**
 * 中文字典。缺词条回退英文 key。
 * 由 data-studio.js / viewer.js 通过 setFieldDict 注入；未注入时等同于旧行为（纯英文 key）。
 */
let ACTIVE_DICT = null;

export function setFieldDict(dict) {
  ACTIVE_DICT = dict && typeof dict === 'object' ? dict : null;
  return ACTIVE_DICT;
}

export function getFieldDict() {
  return ACTIVE_DICT;
}

function dictGroup(name) {
  const g = ACTIVE_DICT && ACTIVE_DICT[name];
  return g && typeof g === 'object' ? g : {};
}

/** 字段中文名（缺词条 → ''）。 */
export function fieldLabel(key) {
  const zh = dictGroup('fields')[key];
  return typeof zh === 'string' ? zh : '';
}

/** 枚举值中文名（缺词条 → ''）。 */
export function enumLabel(value) {
  const zh = dictGroup('enums')[value];
  return typeof zh === 'string' ? zh : '';
}

/** 动作类型中文名（缺词条 → ''）。 */
export function atomTypeLabel(type) {
  const zh = dictGroup('atomTypes')[type];
  return typeof zh === 'string' ? zh : '';
}

/** 特定字段的取值中文映射（fieldValues[key][value]）；缺组/缺键 → null。 */
export function fieldValueMap(key) {
  const m = dictGroup('fieldValues')[key];
  return m && typeof m === 'object' ? m : null;
}

/** 条目 id 中文名（items 组：资源 / 职业 / 建筑）。缺词条 → ''。 */
export function itemLabel(id) {
  const zh = dictGroup('items')[id];
  return typeof zh === 'string' ? zh : '';
}

/** 字段标签：中文名 + 原始 key 小字；缺词条回退英文 key（不允许空白）。 */
function labelHtml(key, frozen) {
  const zh = fieldLabel(key);
  const name = zh || key;
  const tip = zh ? ' title="' + escapeAttr(key) + '"' : '';
  let h = '<label class="df-lab"' + tip + '>' + escapeAttr(name);
  if (zh) h += '<small class="df-key">' + escapeAttr(key) + '</small>';
  if (frozen) h += ' <span class="muted">身份</span>';
  return h + '</label>';
}

/** 枚举选项文案：中文（原始值）；缺词条回退原始值。 */
function enumOptionText(value) {
  const zh = enumLabel(value);
  return zh ? zh + '（' + value + '）' : String(value);
}

export function thumbHtml(sprite, cls) {
  cls = cls || 'thumb';
  if (sprite && sprite.url && !sprite.missing) {
    return '<span class="' + cls + '"><img alt="" src="' + sprite.url + '"></span>';
  }
  const tried = (sprite && sprite.tried) ? sprite.tried.slice(0, 3).join(' · ') : '';
  return '<span class="' + cls + ' thumb-missing" title="' + escapeAttr(tried) + '">缺图</span>';
}

function escapeAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function deref(root, node, seen) {
  if (!node || typeof node !== 'object' || (seen || 0) > 10) return node;
  const r = node['@ref'] || node.$ref;
  if (!r || typeof r !== 'string' || !r.startsWith('#/')) return node;
  let cur = root;
  for (const p of r.slice(2).split('/')) {
    if (!cur) return node;
    cur = cur[p];
  }
  return deref(root, cur, (seen || 0) + 1);
}

function schemaOf(root, schema, key) {
  const sch = deref(root, schema) || {};
  const props = sch.properties || {};
  return deref(root, props[key] || {});
}

function isTuple2(sch) {
  return sch && sch.type === 'array' && sch.minItems === 2 && sch.maxItems === 2;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isObjArray(sch) {
  if (!sch || sch.type !== 'array') return false;
  const items = sch.items || {};
  return items.type === 'object' || items.properties || items['@ref'] || items.$ref || (items && !items.type && sch.type === 'array');
}

function isNumMap(sch, val) {
  if (!sch || sch.type !== 'object' || sch.properties) return false;
  const ap = sch.additionalProperties;
  if (ap && typeof ap === 'object' && (ap.type === 'number' || ap.type === 'integer')) return true;
  if (!isPlainObject(val)) return false;
  const vs = Object.values(val);
  return vs.length > 0 && vs.every((v) => typeof v === 'number');
}

function nestDepth(prefix) {
  if (!prefix) return 0;
  return String(prefix).split('.').length;
}

function xrefFor(key, xrefs) {
  if (/job_id$/.test(key) || key === 'job') return (xrefs && xrefs.jobs) || [];
  if (key === 'resource' || key === 'drops' || /resource$/.test(key)) return (xrefs && xrefs.resources) || [];
  return null;
}

export function renderFields(rootSchema, schema, value, prefix, xrefs, writable) {
  const sch = deref(rootSchema, schema) || {};
  const props = sch.properties || {};
  const keys = Object.keys(props);
  const extra = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter((k) => !props[k])
    : [];
  const order = keys.concat(extra);
  let h = '';
  for (const key of order) {
    const rawVal = value ? value[key] : undefined;
    const sub = props[key] ? deref(rootSchema, props[key]) : schemaGuess(rawVal);
    h += renderField(rootSchema, sub, rawVal, prefix, key, xrefs, writable);
  }
  if (!order.length && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      h += renderField(rootSchema, schemaGuess(value[key]), value[key], prefix, key, xrefs, writable);
    }
  }
  return h || '<p class="hint">无 schema 字段。</p>';
}

function schemaGuess(val) {
  if (Array.isArray(val)) return { type: 'array' };
  if (val === null) return { type: 'null' };
  const t = typeof val;
  if (t === 'number' || t === 'boolean' || t === 'string') return { type: t };
  if (isPlainObject(val)) return { type: 'object' };
  return { type: t };
}

export function renderField(rootSchema, schema, val, prefix, key, xrefs, writable) {
  const sch = deref(rootSchema, schema) || {};
  const path = prefix ? prefix + '.' + key : key;
  const frozen = IDENTITY.has(key);
  const ro = !writable || frozen;
  const label = labelHtml(key, frozen);
  if (JSON_BLOCKS.has(key) || key === 'legs' || key === 'atoms') {
    const text = val == null ? '' : JSON.stringify(val, null, 2);
    return '<div class="df-row">' + label + '<textarea class="df-json" data-json-block data-path="' + escapeAttr(path) + '" ' + (ro ? 'readonly' : '') + '>' + escapeAttr(text) + '</textarea></div>';
  }
  if (sch.enum && Array.isArray(sch.enum)) {
    let opts = sch.enum.map((e) => '<option value="' + escapeAttr(e) + '" title="' + escapeAttr(e) + '"' + (e === val ? ' selected' : '') + '>' + escapeAttr(enumOptionText(e)) + '</option>').join('');
    return '<div class="df-row">' + label + '<select data-enum data-path="' + escapeAttr(path) + '" ' + (ro ? 'disabled' : '') + '>' + opts + '</select></div>';
  }
  if (sch.type === 'boolean') {
    return '<div class="df-row">' + label + '<input type="checkbox" data-path="' + escapeAttr(path) + '" ' + (val ? 'checked' : '') + ' ' + (ro ? 'disabled' : '') + '></div>';
  }
  if (isTuple2(sch)) {
    const a = Array.isArray(val) ? val : [1, 1];
    return '<div class="df-row">' + label + '<span class="df-tuple"><input type="number" data-path="' + escapeAttr(path) + '.0" value="' + escapeAttr(a[0]) + '" ' + (ro ? 'readonly' : '') + '><input type="number" data-path="' + escapeAttr(path) + '.1" value="' + escapeAttr(a[1]) + '" ' + (ro ? 'readonly' : '') + '></span></div>';
  }
  if (isObjArray(sch) || (Array.isArray(val) && val.length && typeof val[0] === 'object')) {
    const arr = Array.isArray(val) ? val : [];
    const itemSch = deref(rootSchema, sch.items || {});
    let rows = arr.map((row, i) => {
      return '<div class="df-arr-row" data-arr-i="' + i + '">' + renderFields(rootSchema, itemSch, row, path + '.' + i, xrefs, writable && !frozen) + (ro ? '' : '<button type="button" class="ghost" data-arr-del="' + escapeAttr(path) + '" data-i="' + i + '">删行</button>') + '</div>';
    }).join('');
    const add = ro ? '' : '<button type="button" class="ghost" data-arr-add="' + escapeAttr(path) + '">增行</button>';
    return '<div class="df-row df-arr" data-arr="' + escapeAttr(path) + '">' + label + '<div class="df-arr-body">' + rows + add + '</div></div>';
  }
  if (Array.isArray(val) && !isTuple2(sch)) {
    const text = JSON.stringify(val);
    return '<div class="df-row">' + label + '<input data-path="' + escapeAttr(path) + '" data-json-array value="' + escapeAttr(text) + '" ' + (ro ? 'readonly' : '') + '></div>';
  }
  if (isNumMap(sch, val)) {
    const map = val && typeof val === 'object' ? val : {};
    const resIds = (xrefs && xrefs.resources) || [];
    let rows = Object.entries(map).map(([k, n]) => {
      const zh = itemLabel(k);
      return '<div class="df-map-row" data-map-key="' + escapeAttr(k) + '">'
        + '<span class="df-map-key" title="' + escapeAttr(k) + '">' + escapeAttr(zh || k) + (zh ? '<small>' + escapeAttr(k) + '</small>' : '') + '</span>'
        + '<input type="number" data-path="' + escapeAttr(path) + '.' + escapeAttr(k) + '" value="' + escapeAttr(n) + '" ' + (ro ? 'readonly' : '') + '>'
        + (ro ? '<span></span>' : '<button type="button" class="df-mini" data-map-del="' + escapeAttr(path) + '" data-key="' + escapeAttr(k) + '" title="删除「' + escapeAttr(zh || k) + '">×</button>')
        + '</div>';
    }).join('');
    if (!rows) rows = '<div class="df-map-empty">暂无条目</div>';
    const add = ro || !resIds.length ? '' : '<div class="df-map-add"><select data-map-new="' + escapeAttr(path) + '">' + resIds.map((id) => '<option value="' + escapeAttr(id) + '">' + escapeAttr(itemLabel(id) ? itemLabel(id) + '（' + id + '）' : id) + '</option>').join('') + '</select><button type="button" class="df-add-btn" data-map-add="' + escapeAttr(path) + '">＋ 添加</button></div>';
    return '<div class="df-row df-map" data-map="' + escapeAttr(path) + '">' + label + '<div class="df-map-body">' + rows + add + '</div></div>';
  }
  if (isPlainObject(val) && (sch.properties || sch.type === 'object' || !sch.type)) {
    if (nestDepth(prefix) >= 8) {
      const text = val == null ? '' : JSON.stringify(val, null, 2);
      return '<div class="df-row">' + label + '<textarea class="df-json" data-json-block data-path="' + escapeAttr(path) + '" ' + (ro ? 'readonly' : '') + '>' + escapeAttr(text) + '</textarea></div>';
    }
    const innerSch = sch.properties ? sch : { type: 'object' };
    return '<div class="df-row df-obj" data-obj="' + escapeAttr(path) + '">' + label + '<div class="df-obj-body">' + renderFields(rootSchema, innerSch, val, path, xrefs, writable && !frozen) + '</div></div>';
  }
  // 值字典（schema 只声明 string 的字段，如 interrupt_policy/on_fail）：
  // option value 仍是原始英文值（保存不改数据），只翻译显示文本。
  const valueMap = fieldValueMap(key);
  if (valueMap && (typeof val === 'string' || val == null)) {
    let opts = Object.keys(valueMap).map((v) => '<option value="' + escapeAttr(v) + '"' + (v === val ? ' selected' : '') + '>' + escapeAttr(valueMap[v] + '（' + v + '）') + '</option>').join('');
    if (val && !Object.prototype.hasOwnProperty.call(valueMap, val)) opts = '<option value="' + escapeAttr(val) + '" selected>' + escapeAttr(val) + '</option>' + opts;
    if (val == null || val === '') opts = '<option value="" selected>（空）</option>' + opts;
    return '<div class="df-row">' + label + '<select data-path="' + escapeAttr(path) + '" ' + (ro ? 'disabled' : '') + '>' + opts + '</select></div>';
  }
  const xref = xrefFor(key, xrefs);
  if (xref && typeof val === 'string') {
    let opts = xref.map((e) => '<option value="' + escapeAttr(e) + '"' + (e === val ? ' selected' : '') + '>' + escapeAttr(itemLabel(e) ? itemLabel(e) + '（' + e + '）' : e) + '</option>').join('');
    if (val && xref.indexOf(val) < 0) opts = '<option value="' + escapeAttr(val) + '" selected>' + escapeAttr(val) + '</option>' + opts;
    return '<div class="df-row">' + label + '<select data-xref data-path="' + escapeAttr(path) + '" ' + (ro ? 'disabled' : '') + '>' + opts + '</select></div>';
  }
  if (sch.type === 'number' || sch.type === 'integer' || typeof val === 'number') {
    return '<div class="df-row">' + label + '<input type="number" data-path="' + escapeAttr(path) + '" value="' + escapeAttr(val == null ? '' : val) + '" ' + (ro ? 'readonly' : '') + '></div>';
  }
  if (val === null && (key === 'unlock_condition')) {
    return '<div class="df-row">' + label + '<input data-path="' + escapeAttr(path) + '" value="" placeholder="null" ' + (ro ? 'readonly' : '') + '></div>';
  }
  return '<div class="df-row">' + label + '<input data-path="' + escapeAttr(path) + '" value="' + escapeAttr(val == null ? '' : val) + '" ' + (ro ? 'readonly' : '') + '></div>';
}

export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') {
      cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  cur[last] = value;
}

export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export { schemaOf };
