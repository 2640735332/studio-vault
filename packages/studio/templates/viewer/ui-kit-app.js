/** Spec Viewer — UI 控件库 app.
 *  Data source: docs/briefs/_shared/ui-kit/controls.json  (read-only)
 *  Visual source of truth: docs/briefs/_shared/ui-kit/catalog.html
 *
 *  Gallery revision:
 *   - visual-first cards (live catalog embed iframe as first child)
 *   - group x state x search composable filtering (pure fns -> machine-checkable)
 *   - full-field detail for the right-hand drawer
 *   - legacy text table kept as fallback (renderUiKitTable)
 */
export function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

export function groupControls(controls){
  const map=new Map();
  for(const c of controls||[]){
    const g=c.group||'其他';
    if(!map.has(g))map.set(g,[]);
    map.get(g).push(c);
  }
  return [...map.entries()];
}

/* ---------------------------------------------------------------- pure logic */

/** searchable blob for one control (id/name/group/states/godot/notes). */
export function controlBlob(c){
  return [c&&c.id,c&&c.name,c&&c.group,(c&&c.states||[]).join(' '),c&&c.godot,c&&c.notes]
    .filter(Boolean).join(' ').toLowerCase();
}

/** AND-filter over group + state + search. Returns [] when controls is not an array. */
export function filterUiKitControls(controls, sel){
  const s=sel||{};
  const g=s.group||''; const st=s.state||''; const q=String(s.q||'').trim().toLowerCase();
  return (Array.isArray(controls)?controls:[]).filter(c=>{
    if(g && (c.group||'')!==g) return false;
    if(st && !(c.states||[]).includes(st)) return false;
    if(q && !controlBlob(c).includes(q)) return false;
    return true;
  });
}

/** facet values: groups (declaration order) + states (frequency desc, first-seen tiebreak). */
export function uiKitFacets(controls){
  const list=Array.isArray(controls)?controls:[];
  const groups=[]; const states=new Map();
  for(const c of list){
    const g=c.group||'其他';
    if(!groups.includes(g)) groups.push(g);
    for(const st of (c.states||[])){
      if(!states.has(st)) states.set(st,0);
      states.set(st,states.get(st)+1);
    }
  }
  const stateList=[...states.entries()].sort((a,b)=>b[1]-a[1]).map(([k])=>k);
  return {groups,states:stateList,total:list.length};
}

/** parse `#/uikit?g=&s=&q=` (also tolerates `#/uikit/<id>?g=`). */
export function parseUiKitGalleryHash(hash){
  const h=String(hash||'');
  const i=h.indexOf('?');
  const out={g:'',s:'',q:''};
  if(i<0) return out;
  const params=new URLSearchParams(h.slice(i+1));
  out.g=params.get('g')||''; out.s=params.get('s')||''; out.q=params.get('q')||'';
  return out;
}

/** serialize back to a deep-link hash (empty fields omitted). */
export function uiKitGalleryHash(sel){
  const s=sel||{}; const p=new URLSearchParams();
  if(s.group)p.set('g',s.group);
  if(s.state)p.set('s',s.state);
  if(s.q)p.set('q',s.q);
  const qs=p.toString();
  return '#/uikit'+(qs?'?'+qs:'');
}

/** the 7 fields every control row must carry (AC: detail = complete fields). */
export const UI_KIT_FIELDS=['id','name','group','states','density','godot','notes'];

/** missing/malformed fields for one control ([] = complete). */
export function missingFields(c){
  const out=[];
  if(!c||typeof c!=='object')return ['<record>'];
  for(const k of UI_KIT_FIELDS){
    const v=c[k];
    if(k==='states'){ if(!Array.isArray(v)||!v.length) out.push(k); }
    else if(v===undefined||v===null||String(v).trim()==='') out.push(k);
  }
  return out;
}

/* ---------------------------------------------------------------- rendering  */

export function renderUiKitSide(controls, activeId, filter){
  const f=String(filter||'').trim().toLowerCase();
  let h='';
  for(const [g,items] of groupControls(controls)){
    const rows=items.filter(c=>{
      if(!f)return true;
      return controlBlob(c).includes(f);
    });
    if(!rows.length)continue;
    h+='<div class="tree-empty" style="opacity:.75">'+esc(g)+'</div>';
    for(const c of rows){
      const on=c.id===activeId?' on':'';
      h+='<div class="g'+on+'" tabindex="-1" data-lv="1" data-kind="uikit" data-path="#/uikit/'+encodeURIComponent(c.id)+'"><span class="ar e">·</span><span class="nm">'+esc(c.id)+'</span></div>';
    }
  }
  return h||'<div class="tree-empty">无控件</div>';
}

export function renderUiKitTable(controls, filter){
  const f=String(filter||'').trim().toLowerCase();
  const rows=(controls||[]).filter(c=>{
    if(!f)return true;
    return (c.id+' '+c.name+' '+(c.godot||'')).toLowerCase().includes(f);
  });
  let h='<table class="inbox"><thead><tr><th>uk-*</th><th>名称</th><th>分组</th><th>态</th><th>Godot</th></tr></thead><tbody>';
  for(const c of rows){
    h+='<tr data-nav="#/uikit/'+encodeURIComponent(c.id)+'" style="cursor:pointer"><td><code>.'+esc(c.id)+'</code></td><td>'+esc(c.name)+'</td><td>'+esc(c.group||'')+'</td><td>'+esc((c.states||[]).join(', '))+'</td><td class="muted">'+esc(c.godot||'')+'</td></tr>';
  }
  h+='</tbody></table>';
  if(!rows.length)h='<div class="inbox-fail" role="status"><p>没有匹配的控件。</p></div>';
  return {html:h, count:rows.length};
}

/** filter toolbar: search + group chips + state chips + live count (composable AND). */
export function renderUiKitFilters(controls, sel){
  const s=sel||{}; const f=uiKitFacets(controls);
  const hits=filterUiKitControls(controls,s).length;
  const chip=(kind,val,label,count)=>{
    const on=(kind==='group'?s.group:s.state)===val;
    return '<button type="button" class="ukit-chip'+(on?' on':'')+'" data-ukit-facet="'+kind+'" data-ukit-val="'+esc(val)+'" aria-pressed="'+(on?'true':'false')+'">'+esc(label)+(count!=null?' <span class="n">'+count+'</span>':'')+'</button>';
  };
  let groups='<button type="button" class="ukit-chip'+(s.group?'':' on')+'" data-ukit-facet="group" data-ukit-val="" aria-pressed="'+(s.group?'false':'true')+'">全部组 <span class="n">'+f.total+'</span></button>';
  for(const g of f.groups) groups+=chip('group',g,g,(controls||[]).filter(c=>(c.group||'')===g).length);
  let states='<button type="button" class="ukit-chip'+(s.state?'':' on')+'" data-ukit-facet="state" data-ukit-val="" aria-pressed="'+(s.state?'false':'true')+'">全部态</button>';
  for(const st of f.states) states+=chip('state',st,st,null);
  return [
    '<div class="ukit-filters" role="search" aria-label="控件筛选">',
    '  <div class="ukit-filter-row">',
    '    <input id="ukit-search" type="search" class="ukit-search" placeholder="搜索 uk-* / 名称 / Godot / 备注…" spellcheck="false" autocomplete="off" value="'+esc(s.q||'')+'" aria-label="搜索控件">',
    '    <span class="ukit-count" role="status" aria-live="polite">显示 <b>'+hits+'</b> / '+f.total+'</span>',
    (s.group||s.state||s.q?'    <button type="button" class="ukit-clear" data-ukit-clear>清除筛选</button>':''),
    '  </div>',
    '  <div class="ukit-filter-row ukit-chips" role="group" aria-label="分组">'+groups+'</div>',
    '  <div class="ukit-filter-row ukit-chips" role="group" aria-label="状态">'+states+'</div>',
    '  <p class="ukit-hint">组合筛选：分组 × 状态 × 搜索（AND）；点击卡片查看完整详情。</p>',
    '</div>'
  ].join('');
}

/** one visual-first card. Visual block is the FIRST child; text is below. */
export function renderUiKitCard(c){
  const st=(c.states||[]).slice(0,3).map(s=>'<span class="ukit-st">'+esc(s)+'</span>').join('');
  const more=(c.states||[]).length>3?'<span class="ukit-st more">+'+(c.states.length-3)+'</span>':'';
  const g=c.group||'其他';
  return [
    '<article class="ukit-card" data-ukit-id="'+esc(c.id)+'" data-ukit-group="'+esc(g)+'" tabindex="0" role="button" aria-label="'+esc(c.id+' '+c.name+' · '+g)+'">',
    // visual first (lazy iframe: src only set when in view)
    '  <div class="ukit-visual" data-ukit="'+esc(c.id)+'">',
    '    <iframe class="ukit-thumb" data-src="/ui-kit/catalog.html?embed=1#'+encodeURIComponent(c.id)+'" title="'+esc(c.name)+' 预览" loading="lazy" scrolling="no" tabindex="-1" aria-hidden="true"></iframe>',
    '    <span class="ukit-visual-fb">'+esc(c.id)+'</span>',
    '  </div>',
    '  <div class="ukit-meta">',
    '    <div class="ukit-title"><code>.'+esc(c.id)+'</code></div>',
    '    <div class="ukit-sub">'+esc(c.name)+' · '+esc(g)+'</div>',
    '    <div class="ukit-states">'+st+more+'</div>',
    '  </div>',
    '</article>'
  ].join('');
}

export function renderUiKitGrid(controls, sel){
  const rows=filterUiKitControls(controls,sel);
  if(!rows.length){
    return '<div class="ukit-empty inbox-fail" role="status"><p><b>没有匹配的控件。</b></p><p class="muted">换个分组 / 状态，或清空搜索。</p><button type="button" class="ukit-clear" data-ukit-clear>清除筛选</button></div>';
  }
  return '<div class="ukit-grid" data-ukit-grid>'+rows.map(renderUiKitCard).join('')+'</div>';
}

export function renderUiKitGallery(controls, sel){
  return renderUiKitFilters(controls,sel)+renderUiKitGrid(controls,sel);
}

/** full-field detail (id/name/group/states/density/godot/notes + preview + source). */
export function renderUiKitDetail(c){
  if(!c)return '<div class="inbox-fail" role="status"><p>未找到控件。</p></div>';
  const states=(c.states||[]).map(s=>'<span class="tag">'+esc(s)+'</span>').join(' ');
  const row=(k,label,v)=>'<tr><th>'+esc(label)+'</th><td>'+v+'</td></tr>';
  return [
    '<section class="uikit-detail" data-ukit-detail="'+esc(c.id)+'">',
    '<h2 style="margin:0 0 .4rem"><code>.'+esc(c.id)+'</code> — '+esc(c.name)+'</h2>',
    '<p class="muted" style="margin:0 0 .8rem">'+esc(c.notes||'')+'</p>',
    '<table class="inbox"><tbody>',
    row('id','ID','<code>.'+esc(c.id)+'</code>'),
    row('name','名称',esc(c.name)),
    row('group','分组',esc(c.group||'—')),
    row('states','态 / 变体',states||'—'),
    row('density','密度 token',esc(c.density||'—')),
    row('godot','映射 Godot',esc(c.godot||'—')),
    row('notes','用法备注',esc(c.notes||'—')),
    '</tbody></table>',
    '<h3 style="margin:1rem 0 .4rem">预览</h3>',
    '<iframe class="ukit-detail-preview" title="'+esc(c.id)+' 完整预览" src="/ui-kit/catalog.html?embed=1#'+encodeURIComponent(c.id)+'"></iframe>',
    '<h3 style="margin:1rem 0 .4rem">来源</h3>',
    '<ul class="ukit-src muted">',
    '<li><code>docs/briefs/_shared/ui-kit/controls.json</code> — 字段数据（只读）</li>',
    '<li><code>docs/briefs/_shared/ui-kit/catalog.html#'+esc(c.id)+'</code> — 视觉样例</li>',
    '<li><code>docs/briefs/_shared/ui-kit/ui-kit.css</code> — KIT_VERSION 0.7.0（运行期 SSOT 对齐）</li>',
    '</ul>',
    '</section>'
  ].join('');
}

/* ---------------------------------------------------------------- browser glue
 * Gallery styles live here (single owner) and are injected once into <head>.
 * Prefixed .ukit-* so they never collide with kit .uk-* or viewer chrome.
 * Motion: transform/opacity only (no layout thrash) + full prefers-reduced-motion downgrade.
 */
export const UI_KIT_GALLERY_CSS = [
'.ukit-filters{display:flex;flex-direction:column;gap:8px;margin:0 0 16px;padding:12px 14px;background:var(--side);border:1px solid var(--border);border-radius:var(--radius)}',
'.ukit-filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
'.ukit-chips{gap:6px}',
'.ukit-search{flex:1 1 260px;min-width:180px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;color:var(--fg);font-size:12px;outline:none}',
'.ukit-search:focus{border-color:var(--accent)}',
'.ukit-count{font-size:12px;color:var(--fg2);font-variant-numeric:tabular-nums}',
'.ukit-count b{color:var(--fg)}',
'.ukit-clear{border:1px solid var(--border);background:var(--bg);color:var(--fg2);font-size:11px;padding:4px 10px;border-radius:var(--radius-sm);cursor:pointer}',
'.ukit-clear:hover{background:var(--hover);color:var(--fg)}',
'.ukit-chip{border:1px solid var(--border);background:var(--bg);color:var(--fg2);font-size:11px;line-height:1;padding:5px 10px;border-radius:999px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease,transform .12s ease}',
'.ukit-chip:hover{border-color:var(--accent);color:var(--fg)}',
'.ukit-chip.on{background:var(--button);border-color:var(--button);color:var(--button-fg)}',
'.ukit-chip .n{opacity:.65;font-size:10px}',
'.ukit-hint{margin:0;font-size:11px;color:var(--fg3)}',
'.ukit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(560px,680px));gap:20px;align-content:start;justify-content:start}',
'.ukit-card{position:relative;display:flex;flex-direction:column;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:transform .12s cubic-bezier(.22,.61,.36,1),border-color .12s ease,box-shadow .12s ease;animation:ukit-card-in .16s cubic-bezier(.22,.61,.36,1) both;animation-delay:var(--ukit-stagger,0ms)}',
'.ukit-card:hover,.ukit-card:focus-visible{border-color:var(--accent);box-shadow:0 6px 18px rgba(0,0,0,.10);transform:translateY(-1px)}',
'.ukit-card:focus{outline:none}',
'.ukit-card:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}',
'.ukit-card.filtering{opacity:0;transform:scale(.98);transition:opacity .12s ease,transform .12s ease}',
'.ukit-card.hit{animation:ukit-card-in .12s ease both}',
'@keyframes ukit-card-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
'.ukit-visual{position:relative;order:-1;height:480px;overflow:hidden;background:var(--code);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:center;contain:paint}',
'.ukit-thumb{width:1260px;height:480px;border:0;background:transparent;transform:scale(var(--ukit-thumb-scale,.9));transform-origin:center center;pointer-events:none;flex-shrink:0;opacity:0;transition:opacity .18s ease}',
'.ukit-thumb.loaded{opacity:1}',
'.ukit-visual-fb{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:600 11px/1 ui-monospace,Consolas,monospace;color:var(--fg3);background:var(--code);opacity:1;transition:opacity .18s ease;pointer-events:none}',
'.ukit-visual.ready .ukit-visual-fb{opacity:0}',
'.ukit-meta{padding:14px 16px 16px;display:flex;flex-direction:column;gap:5px;min-width:0}',
'.ukit-title{font:700 15px/1.4 ui-monospace,Consolas,monospace;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.ukit-sub{font-size:14px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.ukit-states{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}',
'.ukit-st{font-size:12px;line-height:1.7;padding:0 9px;border-radius:999px;background:var(--pill);color:var(--fg2);border:1px solid var(--border)}',
'.ukit-st.more{color:var(--accent)}',
'.ukit-empty{margin-top:8px}',
'.ukit-empty .ukit-clear{margin-top:8px}',
'.ukit-detail-preview{width:100%;height:520px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--code)}',
'.ukit-src{margin:4px 0 0;padding-left:18px;font-size:12px}',
'.ukit-src li{margin:2px 0}',
'@media (max-width:759px){.ukit-grid{grid-template-columns:minmax(0,1fr);gap:14px}.ukit-visual{height:260px}.ukit-thumb{height:260px}}',
'@media (prefers-reduced-motion:reduce){',
'  .ukit-card,.ukit-chip,.ukit-thumb,.ukit-visual-fb{animation:none !important;transition:none !important}',
'  .ukit-card:hover,.ukit-card:focus-visible{transform:none}',
'  .ukit-card.filtering{opacity:1;transform:none}',
'}',
''].join('\n');

export function ensureUiKitStyles(doc){
  const d=doc||(typeof document!=='undefined'?document:null);
  if(!d||d.getElementById('ukit-gallery-css'))return;
  const st=d.createElement('style');
  st.id='ukit-gallery-css';
  st.textContent=UI_KIT_GALLERY_CSS;
  d.head.appendChild(st);
}
