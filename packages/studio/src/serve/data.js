/**
 * JSON config studio. Zero deps. node --test.
 * Catalog / flatten / schema walk / whitelist PATCH / sprite resolve.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve, sep, extname } from 'path';
import { isInside } from './bug-status.js';

export const DOC_ID = '__doc__';
export const JSON_BLOCK_KEYS = new Set(['legs', 'atoms']);
export const IDENTITY_KEYS = new Set(['id', 'kind', 'type']);

const P1 = (file, arrayKey, idKey = 'id') => ({
  file, shape: 'P1', writable: true, arrayKey, idKey, schema: file.replace(/\.json$/, '.schema.json'),
});
const P1MAP = (file, mapKey) => ({
  file, shape: 'P1map', writable: true, mapKey, idKey: 'id', schema: file.replace(/\.json$/, '.schema.json'),
});
const P2 = (file, collections, extra = {}) => ({
  file, shape: 'P2', writable: true, collections, schema: file.replace(/\.json$/, '.schema.json'), ...extra,
});
const P3 = (file) => ({
  file, shape: 'P3', writable: true, idKey: 'id', schema: file.replace(/\.json$/, '.schema.json'),
});
const RO = (file, shape, extra = {}) => ({
  file, shape, writable: false, schema: extra.schema || null, ...extra,
});

/** @type {Record<string, object>} */
export const FILE_REG = {
  buildings: P1('buildings.json', 'buildings'),
  npc_jobs: P1('npc_jobs.json', 'jobs'),
  resources: P1('resources.json', 'resources'),
  tools: P1('tools.json', 'tools'),
  biomes: P1('biomes.json', 'biomes'),
  status_effects: P1('status_effects.json', 'status_effects'),
  trade_prices: { file: 'trade_prices.json', shape: 'P1root', writable: true, idKey: 'id', schema: 'trade_prices.schema.json' },
  objectives_p1: { file: 'objectives_p1.json', shape: 'P1', writable: true, arrayKey: 'objectives', idKey: 'id', schema: 'objectives.schema.json' },
  renewable: P1MAP('renewable.json', 'renewable'),
  events: P2('events.json', [
    { key: 'm1_events', idKey: 'id', label: 'm1_events' },
    { key: 'm2_events', idKey: 'id', label: 'm2_events' },
  ]),
  gathering: P2('gathering.json', [
    { key: 'gathering', idKey: 'type', label: 'gathering' },
    { key: 'kinds', idKey: 'kind', label: 'kinds' },
  ]),
  wanderer_camp: P3('wanderer_camp.json'),
  npc_life_config: P3('npc_life_config.json'),
  npc_need_thresholds: P3('npc_need_thresholds.json'),
  work_recipes: P2('work_recipes.json', [
    { key: 'recipes', idKey: 'id', label: 'recipes' },
    { key: 'presentation_templates', idKey: 'id', label: 'presentation_templates' },
  ], { jsonBlocks: ['legs', 'atoms'] }),
  work_recipe_templates: P1('work_recipe_templates.json', 'templates'),
  nature_spawn: P2('nature_spawn.json', [
    { key: 'sprites', idKey: 'id', label: 'sprites', kind: 'mapArray' },
    { key: 'pools', idKey: 'id', label: 'pools', kind: 'map' },
  ], { schema: null }),
  npc_growth: P3('npc_growth.json'),
  seasons: P3('seasons.json'),
  starting_conditions: P3('starting_conditions.json'),
  roads: P1('roads.json', 'roads'),
  npc_barks: { ...P3('npc_barks.json'), schema: 'npc_barks.schema.json' },
};

export function defaultRoots(repoRoot) {
  return {
    dataDir: join(repoRoot, 'game', 'src', 'data'),
    schemaDir: join(repoRoot, 'game', 'src', 'schemas'),
    spriteDir: join(repoRoot, 'game', 'assets', 'sprites'),
  };
}

export function getInfo(stem) {
  return FILE_REG[stem] || null;
}

export function assertStem(stem) {
  const id = String(stem || '');
  if (!id || /[\\/]/.test(id) || id.includes('..') || !/^[A-Za-z0-9_]+$/.test(id)) {
    return { ok: false, status: 403, error: 'path_escape' };
  }
  if (!FILE_REG[id]) return { ok: false, status: 404, error: 'not_found' };
  return { ok: true, stem: id, info: FILE_REG[id] };
}

export function dataFilePath(roots, stem) {
  const info = FILE_REG[stem];
  if (!info) return null;
  const full = resolve(join(roots.dataDir, info.file));
  if (!isInside(roots.dataDir, full)) return null;
  return full;
}

function readText(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
}

function detectIndent(text) {
  const m = String(text).match(/\n([ \t]+)"/);
  return m ? m[1] : '  ';
}

export function loadDoc(roots, stem) {
  const full = dataFilePath(roots, stem);
  if (!full || !existsSync(full)) return { ok: false, status: 404, error: 'not_found' };
  const raw = readText(full);
  let doc;
  try { doc = JSON.parse(raw); } catch { return { ok: false, status: 400, error: 'invalid_json' }; }
  const st = statSync(full);
  return { ok: true, doc, raw, indent: detectIndent(raw), mtime: st.mtimeMs, path: full };
}

export function loadSchema(roots, info) {
  const name = info && info.schema;
  if (!name) return null;
  const full = resolve(join(roots.schemaDir, name));
  if (!isInside(roots.schemaDir, full) || !existsSync(full)) return null;
  try { return JSON.parse(readText(full)); } catch { return null; }
}

function deref(root, node, seen = 0) {
  if (!node || typeof node !== 'object' || seen > 12) return node;
  const r = node['@ref'] || node.$ref;
  if (!r || typeof r !== 'string') return node;
  if (!r.startsWith('#/')) return node;
  let cur = root;
  for (const p of r.slice(2).split('/')) {
    if (!cur || typeof cur !== 'object') return node;
    cur = cur[p];
  }
  return deref(root, cur, seen + 1);
}

export function pointerJoin(base, key) {
  const k = String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${base}/${k}`;
}

export function validateAgainst(rootSchema, schema, value, pointer, errors) {
  const sch = deref(rootSchema, schema);
  if (!sch || typeof sch !== 'object') return;
  if (value === undefined) return;
  if (sch.enum && !sch.enum.includes(value)) {
    errors.push({ pointer, message: 'enum', expected: sch.enum });
    return;
  }
  const t = sch.type;
  if (t === 'null' && value !== null) errors.push({ pointer, message: 'type', expected: 'null' });
  if (t === 'boolean' && typeof value !== 'boolean') errors.push({ pointer, message: 'type', expected: 'boolean' });
  if (t === 'string') {
    if (typeof value !== 'string') errors.push({ pointer, message: 'type', expected: 'string' });
    else if (sch.minLength != null && value.length < sch.minLength) errors.push({ pointer, message: 'minLength' });
  }
  if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || (t === 'integer' && !Number.isInteger(value) && !Number.isInteger(Math.round(value)))) {
      if (typeof value !== 'number') errors.push({ pointer, message: 'type', expected: t });
    }
    if (typeof value === 'number') {
      if (sch.minimum != null && value < sch.minimum) errors.push({ pointer, message: 'minimum', expected: sch.minimum });
      if (sch.maximum != null && value > sch.maximum) errors.push({ pointer, message: 'maximum', expected: sch.maximum });
    }
  }
  if (t === 'array') {
    if (!Array.isArray(value)) { errors.push({ pointer, message: 'type', expected: 'array' }); return; }
    if (sch.minItems != null && value.length < sch.minItems) errors.push({ pointer, message: 'minItems' });
    if (sch.maxItems != null && value.length > sch.maxItems) errors.push({ pointer, message: 'maxItems' });
    const items = sch.items;
    if (items) {
      value.forEach((v, i) => validateAgainst(rootSchema, items, v, pointerJoin(pointer, i), errors));
    }
  }
  if (t === 'object' || (t == null && sch.properties)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (t === 'object') errors.push({ pointer, message: 'type', expected: 'object' });
      return;
    }
    for (const req of sch.required || []) {
      if (value[req] === undefined) errors.push({ pointer: pointerJoin(pointer, req), message: 'required' });
    }
    const props = sch.properties || {};
    for (const [k, sub] of Object.entries(props)) {
      if (value[k] !== undefined && value[k] !== null) {
        validateAgainst(rootSchema, sub, value[k], pointerJoin(pointer, k), errors);
      }
    }
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!props[k]) errors.push({ pointer: pointerJoin(pointer, k), message: 'additionalProperties' });
      }
    }
  }
}

export function validateDoc(doc, schema) {
  const errors = [];
  if (!schema) return { ok: true, errors };
  validateAgainst(schema, schema, doc, '', errors);
  return { ok: errors.length === 0, errors };
}

export function collectionsOf(info) {
  if (info.shape === 'P2') return info.collections || [];
  if (info.shape === 'P1') return [{ key: info.arrayKey, idKey: info.idKey || 'id', label: info.arrayKey }];
  if (info.shape === 'P1root') return [{ key: 'root', idKey: info.idKey || 'id', label: 'root' }];
  if (info.shape === 'P1map') return [{ key: info.mapKey, idKey: 'id', label: info.mapKey, kind: 'map' }];
  if (info.shape === 'P3') return [{ key: DOC_ID, idKey: 'id', label: 'document', kind: 'doc' }];
  return [];
}

function rowId(row, idKey, fallback) {
  if (row && row[idKey] != null && String(row[idKey]) !== '') return String(row[idKey]);
  return String(fallback);
}

export function flattenEntries(doc, info, collection) {
  const cols = collectionsOf(info);
  if (info.shape === 'P3') {
    return { collection: DOC_ID, entries: [{ id: DOC_ID, label: info.file.replace(/\.json$/, ''), row: doc }] };
  }
  if (info.shape === 'P1root') {
    const arr = Array.isArray(doc) ? doc : [];
    const idKey = info.idKey || 'id';
    return {
      collection: 'root',
      entries: arr.map((row, i) => ({
        id: rowId(row, idKey, i),
        label: String(row.name || row.id || i),
        row,
      })),
    };
  }
  if (info.shape === 'P1') {
    const arr = Array.isArray(doc[info.arrayKey]) ? doc[info.arrayKey] : [];
    const idKey = info.idKey || 'id';
    return {
      collection: info.arrayKey,
      entries: arr.map((row, i) => ({
        id: rowId(row, idKey, i),
        label: String(row.name || row.id || i),
        row,
      })),
    };
  }
  if (info.shape === 'P1map') {
    const map = doc[info.mapKey] && typeof doc[info.mapKey] === 'object' ? doc[info.mapKey] : {};
    return {
      collection: info.mapKey,
      entries: Object.entries(map).map(([id, row]) => ({
        id,
        label: id,
        row: row && typeof row === 'object' ? { id, ...row } : { id, value: row },
      })),
    };
  }
  const colKey = collection || (cols[0] && cols[0].key);
  const col = cols.find((c) => c.key === colKey) || cols[0];
  if (!col) return { collection: '', entries: [] };
  if (col.kind === 'mapArray') {
    const map = doc[col.key] && typeof doc[col.key] === 'object' ? doc[col.key] : {};
    return {
      collection: col.key,
      entries: Object.entries(map).map(([id, arr]) => ({
        id,
        label: id,
        row: { id, files: Array.isArray(arr) ? arr : [] },
        thumbs: Array.isArray(arr) ? arr.slice(0, 8) : [],
      })),
    };
  }
  if (col.kind === 'map') {
    const map = doc[col.key] && typeof doc[col.key] === 'object' ? doc[col.key] : {};
    return {
      collection: col.key,
      entries: Object.entries(map).map(([id, row]) => ({
        id,
        label: id,
        row: row && typeof row === 'object' ? { id, ...row } : { id, value: row },
      })),
    };
  }
  const arr = Array.isArray(doc[col.key]) ? doc[col.key] : [];
  const idKey = col.idKey || 'id';
  return {
    collection: col.key,
    entries: arr.map((row, i) => ({
      id: rowId(row, idKey, i),
      label: String((row && (row.name || row[idKey])) || i),
      row,
    })),
  };
}

export function findEntry(doc, info, id, collection) {
  const flat = flattenEntries(doc, info, collection);
  return flat.entries.find((e) => e.id === String(id)) || null;
}

function mergePreserve(orig, patch) {
  if (Array.isArray(patch)) return patch;
  if (!patch || typeof patch !== 'object') return patch;
  const out = orig && typeof orig === 'object' && !Array.isArray(orig) ? { ...orig } : {};
  for (const [k, v] of Object.entries(patch)) out[k] = v;
  return out;
}

function writeDoc(path, doc, indent) {
  const body = `${JSON.stringify(doc, null, indent)}\n`;
  writeFileSync(path, body);
  return statSync(path).mtimeMs;
}

export function listCatalog(roots) {
  return Object.entries(FILE_REG).map(([stem, info]) => {
    const loaded = loadDoc(roots, stem);
    const schema = loadSchema(roots, info);
    const cols = collectionsOf(info).map((c) => ({ key: c.key, idKey: c.idKey || 'id', label: c.label || c.key }));
    let count = 0;
    if (loaded.ok) count = flattenEntries(loaded.doc, info, cols[0] && cols[0].key).entries.length;
    return {
      stem,
      file: info.file,
      shape: info.shape,
      writable: !!info.writable,
      contracted: !!schema,
      schema: info.schema || null,
      collections: cols,
      count,
      mtime: loaded.ok ? loaded.mtime : null,
    };
  });
}

export function xrefIds(roots, stem) {
  const info = FILE_REG[stem];
  if (!info) return [];
  const loaded = loadDoc(roots, stem);
  if (!loaded.ok) return [];
  return flattenEntries(loaded.doc, info).entries.map((e) => e.id);
}

function resToFs(roots, resPath) {
  let s = String(resPath || '').replace(/\\/g, '/');
  if (s.startsWith('res://')) s = s.slice('res://'.length);
  s = s.replace(/^assets\/sprites\//, '');
  s = s.replace(/^\/+/, '');
  if (!s || s.includes('..')) return { ok: false, error: 'path_escape' };
  const full = resolve(join(roots.spriteDir, s));
  if (!isInside(roots.spriteDir, full)) return { ok: false, error: 'path_escape' };
  return { ok: true, full, rel: s.replace(/\\/g, '/') };
}

function existsSprite(roots, resPath, tried) {
  tried.push(resPath);
  const r = resToFs(roots, resPath);
  if (!r.ok) return null;
  if (existsSync(r.full) && statSync(r.full).isFile()) return { url: `/api/sprite?path=${encodeURIComponent(r.rel)}`, rel: r.rel, tried };
  return null;
}

let _natureCache = { mtime: 0, sprites: null };

function natureSprites(roots) {
  const loaded = loadDoc(roots, 'nature_spawn');
  if (!loaded.ok) return {};
  if (_natureCache.mtime === loaded.mtime && _natureCache.sprites) return _natureCache.sprites;
  const sprites = (loaded.doc && loaded.doc.sprites) || {};
  _natureCache = { mtime: loaded.mtime, sprites };
  return sprites;
}

export function resolveSprite(roots, { stem, id, row }) {
  const tried = [];
  const rec = row && typeof row === 'object' ? row : {};
  if (rec.sprite) {
    const hit = existsSprite(roots, rec.sprite, tried);
    if (hit) return { ...hit, missing: false };
  }
  if (rec.icon) {
    const hit = existsSprite(roots, rec.icon, tried);
    if (hit) return { ...hit, missing: false };
  }
  const sid = String(id || rec.id || rec.type || rec.kind || '');
  if (stem === 'npc_jobs' && sid) {
    const hit = existsSprite(roots, `res://assets/sprites/npcs/npc_${sid}.png`, tried);
    if (hit) return { ...hit, missing: false };
  }
  const conventions = [
    `res://assets/sprites/buildings/${sid}.png`,
    `res://assets/sprites/items/${sid}.png`,
    `res://assets/sprites/tools/${sid}.png`,
  ];
  if (stem === 'buildings') conventions.reverse();
  for (const p of conventions) {
    const hit = existsSprite(roots, p, tried);
    if (hit) return { ...hit, missing: false };
  }
  const ns = natureSprites(roots);
  const group = ns[sid];
  if (Array.isArray(group) && group[0]) {
    const hit = existsSprite(roots, `res://assets/sprites/nature/${group[0]}`, tried);
    if (hit) return { ...hit, missing: false };
  }
  if (Array.isArray(rec.files) && rec.files[0]) {
    const hit = existsSprite(roots, `res://assets/sprites/nature/${rec.files[0]}`, tried);
    if (hit) return { ...hit, missing: false };
  }
  let dropId = '';
  if (typeof rec.drops === 'string' && rec.drops) dropId = rec.drops;
  else if (Array.isArray(rec.drops) && rec.drops[0]) {
    const d0 = rec.drops[0];
    dropId = String((d0 && d0.id) || d0 || '');
  }
  if (dropId) {
    const g = ns[dropId];
    if (Array.isArray(g) && g[0]) {
      const hit = existsSprite(roots, `res://assets/sprites/nature/${g[0]}`, tried);
      if (hit) return { ...hit, missing: false };
    }
  }
  return { url: null, rel: null, tried, missing: true };
}

export function patchEntry(roots, { stem, id, collection, entry, expectedMtime }) {
  const gate = assertStem(stem);
  if (!gate.ok) return gate;
  const info = gate.info;
  if (!info.writable) return { ok: false, status: 403, error: 'readonly' };
  const loaded = loadDoc(roots, stem);
  if (!loaded.ok) return loaded;
  if (expectedMtime != null && expectedMtime !== '' && Number(expectedMtime) !== loaded.mtime) {
    return { ok: false, status: 409, error: 'conflict', mtime: loaded.mtime };
  }
  const schema = loadSchema(roots, info);
  const wantId = String(id);
  if (info.shape === 'P3' || wantId === DOC_ID) {
    if (!entry || typeof entry !== 'object') return { ok: false, status: 400, error: 'invalid_json' };
    const next = mergePreserve(loaded.doc, entry);
    const v = validateDoc(next, schema);
    if (!v.ok) return { ok: false, status: 400, error: 'validation_failed', errors: v.errors };
    const mtime = writeDoc(loaded.path, next, loaded.indent);
    return { ok: true, status: 200, mtime, doc: next };
  }
  if (!entry || typeof entry !== 'object') return { ok: false, status: 400, error: 'invalid_json' };

  if (info.shape === 'P1root') {
    const arr = Array.isArray(loaded.doc) ? loaded.doc.slice() : [];
    const idKey = info.idKey || 'id';
    const idx = arr.findIndex((r) => String(r[idKey]) === wantId);
    if (idx < 0) return { ok: false, status: 404, error: 'not_found' };
    if (entry[idKey] != null && String(entry[idKey]) !== wantId) {
      return { ok: false, status: 400, error: 'identity_frozen' };
    }
    arr[idx] = mergePreserve(arr[idx], { ...entry, [idKey]: wantId });
    const v = validateDoc(arr, schema);
    if (!v.ok) return { ok: false, status: 400, error: 'validation_failed', errors: v.errors };
    const mtime = writeDoc(loaded.path, arr, loaded.indent);
    return { ok: true, status: 200, mtime, entry: arr[idx] };
  }

  if (info.shape === 'P1') {
    const arr = Array.isArray(loaded.doc[info.arrayKey]) ? loaded.doc[info.arrayKey].slice() : [];
    const idKey = info.idKey || 'id';
    const idx = arr.findIndex((r) => String(r[idKey]) === wantId);
    if (idx < 0) return { ok: false, status: 404, error: 'not_found' };
    if (entry[idKey] != null && String(entry[idKey]) !== wantId) {
      return { ok: false, status: 400, error: 'identity_frozen' };
    }
    arr[idx] = mergePreserve(arr[idx], { ...entry, [idKey]: wantId });
    const next = { ...loaded.doc, [info.arrayKey]: arr };
    const v = validateDoc(next, schema);
    if (!v.ok) return { ok: false, status: 400, error: 'validation_failed', errors: v.errors };
    const mtime = writeDoc(loaded.path, next, loaded.indent);
    return { ok: true, status: 200, mtime, entry: arr[idx] };
  }

  if (info.shape === 'P1map') {
    const map = { ...(loaded.doc[info.mapKey] || {}) };
    if (!(wantId in map)) return { ok: false, status: 404, error: 'not_found' };
    if (entry.id != null && String(entry.id) !== wantId) {
      return { ok: false, status: 400, error: 'identity_frozen' };
    }
    const { id: _drop, ...rest } = entry;
    map[wantId] = mergePreserve(map[wantId], rest);
    const next = { ...loaded.doc, [info.mapKey]: map };
    const v = validateDoc(next, schema);
    if (!v.ok) return { ok: false, status: 400, error: 'validation_failed', errors: v.errors };
    const mtime = writeDoc(loaded.path, next, loaded.indent);
    return { ok: true, status: 200, mtime, entry: { id: wantId, ...map[wantId] } };
  }

  const cols = collectionsOf(info);
  const colKey = collection || (cols[0] && cols[0].key);
  const col = cols.find((c) => c.key === colKey);
  if (!col) return { ok: false, status: 400, error: 'invalid_collection' };
  // map / mapArray 形态（nature_spawn）：按 key 写回单条，mapArray 直接替换数组。
  if (col.kind === 'map' || col.kind === 'mapArray') {
    const map = { ...(loaded.doc[col.key] && typeof loaded.doc[col.key] === 'object' ? loaded.doc[col.key] : {}) };
    if (!(wantId in map)) return { ok: false, status: 404, error: 'not_found' };
    let nextVal;
    if (col.kind === 'mapArray') {
      nextVal = Array.isArray(entry.files) ? entry.files : map[wantId];
    } else {
      const { id: _drop, ...rest } = entry;
      nextVal = mergePreserve(map[wantId], rest);
    }
    map[wantId] = nextVal;
    const next = { ...loaded.doc, [col.key]: map };
    const v = validateDoc(next, schema);
    if (!v.ok) return { ok: false, status: 400, error: 'validation_failed', errors: v.errors };
    const mtime = writeDoc(loaded.path, next, loaded.indent);
    return { ok: true, status: 200, mtime, entry: nextVal };
  }
  const idKey = col.idKey || 'id';
  const arr = Array.isArray(loaded.doc[col.key]) ? loaded.doc[col.key].slice() : [];
  const idx = arr.findIndex((r) => String(r[idKey]) === wantId);
  if (idx < 0) return { ok: false, status: 404, error: 'not_found' };
  if (entry[idKey] != null && String(entry[idKey]) !== wantId) {
    return { ok: false, status: 400, error: 'identity_frozen' };
  }
  arr[idx] = mergePreserve(arr[idx], { ...entry, [idKey]: wantId });
  const next = { ...loaded.doc, [col.key]: arr };
  const v = validateDoc(next, schema);
  if (!v.ok) return { ok: false, status: 400, error: 'validation_failed', errors: v.errors };
  const mtime = writeDoc(loaded.path, next, loaded.indent);
  return { ok: true, status: 200, mtime, entry: arr[idx] };
}

export function spriteFile(roots, pathQuery) {
  const r = resToFs(roots, pathQuery || '');
  if (!r.ok) return { ok: false, status: 403, error: r.error };
  if (!existsSync(r.full) || !statSync(r.full).isFile()) return { ok: false, status: 404, error: 'not_found' };
  const ext = extname(r.full).toLowerCase();
  if (ext !== '.png' && ext !== '.webp' && ext !== '.jpg' && ext !== '.jpeg') {
    return { ok: false, status: 403, error: 'path_escape' };
  }
  return { ok: true, full: r.full, rel: r.rel, mime: ext === '.png' ? 'image/png' : 'image/webp' };
}

function itemSchemaFrom(schema, info) {
  if (!schema) return null;
  if (info.shape === 'P1root' && schema.type === 'array') {
    return deref(schema, schema.items);
  }
  if (info.shape === 'P1' && schema.properties && schema.properties[info.arrayKey]) {
    const items = deref(schema, schema.properties[info.arrayKey].items);
    return items || null;
  }
  if (info.shape === 'P1map' && schema.properties && schema.properties[info.mapKey]) {
    return deref(schema, schema.properties[info.mapKey].additionalProperties || schema.properties[info.mapKey]);
  }
  return schema;
}

export function filePayload(roots, stem, collection) {
  const gate = assertStem(stem);
  if (!gate.ok) return gate;
  const loaded = loadDoc(roots, stem);
  if (!loaded.ok) return loaded;
  const info = gate.info;
  const schema = loadSchema(roots, info);
  const flat = flattenEntries(loaded.doc, info, collection);
  const xrefs = {
    jobs: xrefIds(roots, 'npc_jobs'),
    resources: xrefIds(roots, 'resources'),
    buildings: xrefIds(roots, 'buildings'),
  };
  const entries = flat.entries.map((e) => {
    const spr = resolveSprite(roots, { stem, id: e.id, row: e.row });
    return {
      id: e.id,
      label: e.label,
      name: e.row && e.row.name,
      contract: info.writable ? (schema ? 'schema' : 'open') : 'readonly',
      sprite: spr,
      thumbs: e.thumbs || null,
    };
  });
  return {
    ok: true,
    stem,
    file: info.file,
    shape: info.shape,
    writable: !!info.writable,
    contracted: !!schema,
    collections: collectionsOf(info).map((c) => ({ key: c.key, label: c.label || c.key, idKey: c.idKey || 'id' })),
    collection: flat.collection,
    mtime: loaded.mtime,
    jsonBlocks: info.jsonBlocks || [...JSON_BLOCK_KEYS],
    xrefs,
    itemSchema: itemSchemaFrom(schema, info),
    fileSchema: schema,
    entries,
  };
}

export function entryPayload(roots, stem, id, collection) {
  const gate = assertStem(stem);
  if (!gate.ok) return gate;
  const loaded = loadDoc(roots, stem);
  if (!loaded.ok) return loaded;
  const info = gate.info;
  const found = findEntry(loaded.doc, info, id, collection);
  if (!found) return { ok: false, status: 404, error: 'not_found' };
  const schema = loadSchema(roots, info);
  const spr = resolveSprite(roots, { stem, id: found.id, row: found.row });
  return {
    ok: true,
    stem,
    id: found.id,
    writable: !!info.writable,
    contracted: !!schema,
    mtime: loaded.mtime,
    collection: collection || flattenEntries(loaded.doc, info, collection).collection,
    jsonBlocks: info.jsonBlocks || [...JSON_BLOCK_KEYS],
    xrefs: {
      jobs: xrefIds(roots, 'npc_jobs'),
      resources: xrefIds(roots, 'resources'),
      buildings: xrefIds(roots, 'buildings'),
    },
    itemSchema: info.shape === 'P3' ? schema : itemSchemaFrom(schema, info),
    entry: found.row,
    sprite: spr,
  };
}
