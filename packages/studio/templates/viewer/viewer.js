import { renderPerformance } from '/static/performance-app.js';
import {
  filterInbox, filterBriefs, visibleCount,
  encodeListHash, decodeListHash, isDrawerRoute,
  briefSegment, briefStatusTag
} from '/static/spec-inbox.js';
import { thumbHtml, setPath, getPath, getFieldDict } from '/static/data-app.js';
import {
  loadDict, renderDataStudio, renderStudioSummary,
  diffValues, matchPointer, mergeExtras,
  isCollapsed, setCollapsed, defaultAtomType, applyAtomType,
} from '/static/data-studio.js';
import {
  renderUiKitSide, renderUiKitTable, renderUiKitDetail,
  renderUiKitFilters, renderUiKitGrid, filterUiKitControls,
  parseUiKitGalleryHash, uiKitGalleryHash, ensureUiKitStyles
} from '/static/ui-kit-app.js';
const requiredTrackDocs=['INPUT.md','PRD.md','TECH.md','TASK.md','TRACE.md','REVIEW.md','TEST.md','BUG.md'];
const requiredPackageDocs=['SPEC.md','ARCH.md','GLOSSARY.md'];
const docLabels={
  'INPUT.md':'原始需求','PRD.md':'需求 · IEEE 830','TECH.md':'设计 · IEEE 1016',
  'TASK.md':'任务 · 状态机','TRACE.md':'追溯 · IEEE 29148','REVIEW.md':'评审 · IEEE 1028',
  'TEST.md':'测试 · IEEE 29119','BUG.md':'缺陷 · IEEE 1044',
  'SPEC.md':'包总览','ARCH.md':'架构 · IEEE 1016','GLOSSARY.md':'术语表'
};
let allData=[],allBriefs=[],allBugs=[],allDomains=[],allDataFiles=[],allUiKitControls=[],expanded={},currentPath='#/pulse',focusIdx=-1,mode='pulse',briefView='html';
const EXP_KEY='sv-tree-expanded';
const SIDE_KEY='sv-side-collapsed';
const MODE_KEY='sv-mode';
const PULSE_RANGE_KEY='sv-pulse-range';
const VIEW_MODES=['pulse','briefs','specs','domains','bugs','data','performance'];
let pulseKpis=null,pulseTrends=null,pulseLoading=false,pulseHighlightDay=null,pulseFilter=null;
let pulseWallRetry=0;
function trendsHasCodeRhythm(t){
  return !!(t&&t.code&&t.rhythm&&t.code.business&&t.rhythm.commitTypes);
}
let pulseRange={chip:'30d',from:'',to:'',bucket:'auto'};
let pulsePrevRange=null;
const SIGNAL_TTL=5*60*1000;
let changeSignals={};
let clickTimer=null;
let listLoadError='';
let lastList={bugs:'#/bugs?seg=new',briefs:'#/briefs?seg=draft',specs:'#/specs',domains:'#/domains',data:'#/data?seg=writable',uikit:'#/uikit'};
const APP_SEL='#apps [data-mode]';
function syncSideToggle(){
  const b=document.getElementById('sideToggle');
  if(!b)return;
  const collapsed=document.body.classList.contains('side-collapsed')&&!document.body.classList.contains('pulse-mode');
  b.hidden=!collapsed;
  b.setAttribute('aria-expanded',collapsed?'false':'true');
}
function listRoute(m){
  if(m==='bugs')return 'bugs';
  if(m==='briefs')return 'briefs';
  if(m==='domains')return 'domains';
  if(m==='specs')return 'specs';
  if(m==='data')return 'data';
  if(m==='uikit')return 'uikit';
  if(m==='performance')return 'performance';
  return 'pulse';
}
function api(url){return fetch(url).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})}
function apiPatch(url,body){
  return fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})
    .then(r=>r.json().then(j=>({http:r.status,json:j}),()=>({http:r.status,json:{ok:false,error:'bad_json'}})));
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')}
function hl(text,filter){
  const t=String(text||'');if(!filter)return esc(t);
  const i=t.toLowerCase().indexOf(filter);if(i<0)return esc(t);
  return esc(t.slice(0,i))+'<mark>'+esc(t.slice(i,i+filter.length))+'</mark>'+esc(t.slice(i+filter.length));
}
function saveExpanded(){try{sessionStorage.setItem(EXP_KEY,JSON.stringify(expanded))}catch(e){}}
function loadExpanded(){try{const r=sessionStorage.getItem(EXP_KEY);if(r)Object.assign(expanded,JSON.parse(r))}catch(e){}}
function isOpen(k){return !!expanded[k]}
function setOpen(k,v){expanded[k]=!!v;saveExpanded()}
function toggleOpen(k){setOpen(k,!isOpen(k))}
function ago(ts){
  const s=Math.max(0,Math.floor((Date.now()-ts)/1000));
  if(s<60)return s+'s';
  if(s<3600)return Math.floor(s/60)+'m';
  return Math.floor(s/3600)+'h';
}
function signalClass(ts){
  const age=Date.now()-ts;
  if(age>SIGNAL_TTL)return '';
  if(age>SIGNAL_TTL/2)return ' g-changed g-changed-fade';
  return ' g-changed';
}
function fileSignal(rel){const c=changeSignals[rel];if(!c||Date.now()-c.ts>SIGNAL_TTL)return null;return c}
function pkgRollup(pkgName){
  let best=null;
  for(const [p,c] of Object.entries(changeSignals)){
    if(!p.startsWith(pkgName+'/'))continue;
    if(Date.now()-c.ts>SIGNAL_TTL)continue;
    if(!best||c.ts>best.ts)best=c;
  }
  return best;
}
function expandForChange(rel){
  if(!rel)return;
  if(rel.startsWith('briefs/')){setMode('briefs',false);return}
  if(rel.startsWith('bugs/')){setMode('bugs',false);return}
  if(rel.includes('/domains/')){setMode('domains',false);return}
  const parts=rel.split('/');
  if(parts[0]){setMode('specs',false);setOpen('pkg_'+parts[0],true);if(parts.length===2)setOpen('pd_'+parts[0],true);if(parts.length>=3)setOpen('trk_'+parts[0]+'_'+parts[1],true)}
}
function ingestChanges(list){
  const next={};
  const now=Date.now();
  for(const c of list||[]){
    if(!c||!c.path)continue;
    if(now-(c.ts||0)>SIGNAL_TTL)continue;
    next[c.path]=c;
  }
  changeSignals=next;
}
function loadChanges(){return api('/api/changes').then(d=>{ingestChanges(Array.isArray(d)?d:(d&&d.changes)||[]);}).catch(()=>{})}
function matchPkg(p,f){
  if(pulseFilter&&pulseFilter.type==='pkg'&&p.name!==pulseFilter.key)return false;
  if(!f)return true;return p.name.toLowerCase().includes(f)||(p.description||'').toLowerCase().includes(f)||p.tracks.some(t=>t.name.toLowerCase().includes(f))
}
function matchTrack(t,f){if(!f)return true;return t.name.toLowerCase().includes(f)}
function matchBrief(b,f){
  if(pulseFilter&&pulseFilter.type==='brief'){
    const seg=briefSegment(b.status);
    if(pulseFilter.key==='other'&&seg!=='other')return false;
    if(pulseFilter.key!=='other'&&seg!==pulseFilter.key)return false;
  }
  if(!f)return true;const hay=((b.title||'')+' '+(b.id||'')+' '+(b.status||'')).toLowerCase();return hay.includes(f)
}
function matchBug(b,f){
  if(pulseFilter&&pulseFilter.type==='bug'&&String(b.status||'')!==pulseFilter.key)return false;
  if(!f)return true;const hay=((b.title||'')+' '+(b.id||'')+' '+(b.bugId||'')+' '+(b.status||'')+' '+(b.description||'')).toLowerCase();return hay.includes(f)
}
function matchDomain(d,f){
  if(pulseFilter&&pulseFilter.type==='domain'){
    if(pulseFilter.key&&d.package!==pulseFilter.key&&d.id!==pulseFilter.key)return false;
  }
  if(!f)return true;const hay=((d.title||'')+' '+(d.id||'')+' '+(d.package||'')+' '+((d.tracks||[]).join(' '))).toLowerCase();return hay.includes(f)
}
function isReady(status){return briefSegment(status)==='ready'}
function statusTag(status,kind){
  if(kind==='brief'){
    const t=briefStatusTag(status);
    return '<span class="tag '+t.cls+'">'+esc(t.label)+'</span>';
  }
  const s=status||'新';
  const cls=/关闭|已修/.test(s)?'ready':(s==='修复中'?'doing':(/新/.test(s)?'fresh':'draft'));
  return '<span class="tag '+cls+'">'+esc(s)+'</span>';
}
function groupByMonth(items){
  const map=new Map();
  for(const it of items){
    const m=it.month||'其它';
    if(!map.has(m))map.set(m,[]);
    map.get(m).push(it);
  }
  return [...map.entries()];
}
function qVal(){const el=document.getElementById('q');return el?el.value.toLowerCase().trim():''}

let dataDirty=false,dataDraft=null,dataMeta=null,dataFilePayload=null;
/* 数据页重做：基线/保存中/错误集合 */
let dataBaseline=null,dataSaving=false,dataErrors=[];

function confirmDataLeave(){
  if(!dataDirty)return true;
  return window.confirm('放弃未保存的修改？');
}

function setMode(next,navHome){
  if(navHome && !confirmDataLeave())return;
  if(navHome)pulseFilter=null;
  mode=next;
  try{sessionStorage.setItem(MODE_KEY,mode)}catch(e){}
  document.body.classList.toggle('pulse-mode',mode==='pulse');
  document.body.classList.toggle('uikit-mode',mode==='uikit');
  document.body.classList.toggle('performance-mode',mode==='performance');
  syncSideToggle();
  document.querySelectorAll(APP_SEL).forEach(b=>{
    const on=b.dataset.mode===mode;
    b.classList.toggle('active',on);
    if(on)b.setAttribute('aria-current','page');
    else b.removeAttribute('aria-current');
  });
  const ph={pulse:'搜索指挥台…',briefs:'搜索简报…',specs:'搜索包或 Track…',bugs:'搜索上报 ID / 标题…',domains:'搜索域 id / 标题…',data:'搜索数据 id / 文件…',uikit:'搜索 uk-* / 控件名…'}[mode]||'搜索…';
  const q=document.getElementById('q');if(q)q.placeholder=ph;
  renderTree(qVal());
  updateBadges();
  if(navHome){
    if(mode==='pulse')go('#/pulse');
    else if(mode==='briefs')go(encodeListHash({route:'briefs',seg:'draft'}));
    else if(mode==='bugs')go(encodeListHash({route:'bugs',seg:'new'}));
    else if(mode==='domains')go(encodeListHash({route:'domains'}));
    else if(mode==='data')go(encodeListHash({route:'data',seg:'writable'}));
    else if(mode==='uikit')go('#/uikit');
    else if(mode==='performance')go('#/performance');
    else go(encodeListHash({route:'specs'}));
  }
}

function updateBadges(){
  const f=qVal();
  const counts={
    briefs:f?allBriefs.filter(b=>matchBrief(b,f)).length:0,
    specs:f?allData.filter(p=>matchPkg(p,f)).length:0,
    bugs:f?allBugs.filter(b=>matchBug(b,f)).length:0,
    domains:f?allDomains.filter(d=>matchDomain(d,f)).length:0
  };
  document.querySelectorAll(APP_SEL).forEach(btn=>{
    const n=counts[btn.dataset.mode]||0;
    const badge=btn.querySelector('.badge');
    if(!badge)return;
    if(f&&n){badge.hidden=false;badge.textContent=String(n)}
    else{badge.hidden=true}
  });
}

function renderTree(filter){
  const t=document.getElementById('tree');
  if(!t)return;
  const d=listQuery();
  const cat=d.cat||'';
  if(mode==='pulse'){t.innerHTML='';return}
  if(mode==='performance'){t.innerHTML='<div class="tree-empty">性能证据</div>'+[['runs','运行库'],['compare','比较 / 趋势'],['integration','集成状态'],['catalog','目录 / 导入']].map(([id,label])=>'<a class="g" href="#/performance/'+id+'">'+label+'</a>').join('');return}
  if(mode==='data')t.innerHTML=renderDataCats(allDataFiles,cat,'');
  else if(mode==='uikit')t.innerHTML=renderUiKitSide(allUiKitControls,(parseHash().segs||[])[1]||'',qVal());
  else if(mode==='bugs')t.innerHTML=renderMonthCats(allBugs.filter(b=>matchBug(b,filter)),cat,'bugs');
  else if(mode==='briefs')t.innerHTML=renderMonthCats(allBriefs.filter(b=>matchBrief(b,filter)),cat,'briefs');
  else if(mode==='domains')t.innerHTML=renderDomainCats(allDomains.filter(x=>matchDomain(x,filter)),cat);
  else t.innerHTML=renderSpecTree(filter);
  syncSel();
}
function renderMonthCats(items,cat,kind){
  const groups=groupByMonth(items);
  const total=items.length;
  let h='<div class="g'+(cat?'':' sel')+'" tabindex="0" data-lv="0" data-kind="cat" data-cat="" aria-current="'+(cat?'false':'true')+'"><span class="ar e">▸</span><span class="lb">全部</span><span class="ct">'+total+'</span></div>';
  for(const [month,rows] of groups){
    const on=cat===month;
    h+='<div class="g'+(on?' sel':'')+'" tabindex="0" data-lv="0" data-kind="cat" data-cat="'+esc(month)+'" aria-current="'+(on?'true':'false')+'"><span class="ar e">▸</span><span class="lb">'+esc(month)+'</span><span class="ct">'+rows.length+'</span></div>';
  }
  if(!groups.length)h+='<div class="tree-empty">'+(kind==='bugs'?'暂无上报':'暂无简报')+'</div>';
  return h;
}
function renderDomainCats(list,cat){
  const groups=new Map();
  for(const d of list){
    const k=d.package||'pkg';
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(d);
  }
  let h='<div class="g'+(cat?'':' sel')+'" tabindex="0" data-lv="0" data-kind="cat" data-cat="" aria-current="'+(cat?'false':'true')+'"><span class="ar e">▸</span><span class="lb">全部</span><span class="ct">'+list.length+'</span></div>';
  for(const [pkg,items] of groups){
    const on=cat===pkg;
    h+='<div class="g'+(on?' sel':'')+'" tabindex="0" data-lv="0" data-kind="cat" data-cat="'+esc(pkg)+'" aria-current="'+(on?'true':'false')+'"><span class="ar e">▸</span><span class="lb">'+esc(pkg)+'</span><span class="ct">'+items.length+'</span></div>';
  }
  if(!list.length)h+='<div class="tree-empty">暂无域登记</div>';
  return h;
}
function renderPulseTree(f){
  const rows=[
    ['kpi','KPI'],['git','Git 时间轴'],['vol','体量轴'],['ents','四类趋势+饼'],['daily','日汇总']
  ];
  let h='<div class="tree-empty">指挥台</div>';
  for(const [id,label] of rows){
    if(f&&!label.toLowerCase().includes(f)&&label.indexOf(f)<0)continue;
    h+='<div class="g" tabindex="-1" data-lv="0" data-kind="pulse" data-scroll="'+id+'"><span class="ar e">▸</span><span class="nm">'+esc(label)+'</span></div>';
  }
  return h;
}

function renderBriefTree(f){
  const list=allBriefs.filter(b=>matchBrief(b,f));
  if(!list.length)return '<div class="tree-empty">'+(f?'无匹配简报':'暂无简报')+'</div>';
  const groups=groupByMonth(list);
  let h='';
  groups.forEach(([month,items],i)=>{
    const k='brm_'+month;
    if(expanded[k]===undefined)expanded[k]=i===0||!!f;
    const open=isOpen(k);
    h+='<div class="g" tabindex="-1" data-lv="0" data-kind="group" data-key="'+k+'"><span class="ar'+(open?' open':'')+'" data-toggle="1">▸</span><span class="lb">'+esc(month)+'</span><span class="ct">'+items.length+'</span></div>';
    if(!open)return;
    for(const b of items){
      const path=b.hasPreview?'#/brief/'+encodeURIComponent(b.id):'#/brief/'+encodeURIComponent(b.id)+'/md';
      h+='<div class="g" tabindex="-1" data-lv="1" data-kind="brief" data-path="'+path+'" title="'+esc(b.id)+'"><span class="ar e">▸</span><span class="nm">'+hl(b.title||b.id,f)+'</span>'+statusTag(b.status,'brief')+'</div>';
    }
  });
  return h;
}

function renderBugTree(f){
  const list=allBugs.filter(b=>matchBug(b,f));
  if(!list.length)return '<div class="tree-empty">'+(f?'无匹配上报':'game/reports/bugs 暂无上报')+'</div>';
  const groups=groupByMonth(list);
  let h='';
  groups.forEach(([month,items],i)=>{
    const k='bgm_'+month;
    if(expanded[k]===undefined)expanded[k]=i===0||!!f;
    const open=isOpen(k);
    h+='<div class="g" tabindex="-1" data-lv="0" data-kind="group" data-key="'+k+'"><span class="ar'+(open?' open':'')+'" data-toggle="1">▸</span><span class="lb">'+esc(month)+'</span><span class="ct">'+items.length+'</span></div>';
    if(!open)return;
    for(const b of items){
      const label=(b.bugId?b.bugId+' · ':'')+(b.title||b.id);
      h+='<div class="g" tabindex="-1" data-lv="1" data-kind="bug" data-path="#/bug/'+encodeURIComponent(b.id)+'" title="'+esc(b.id)+'"><span class="ar e">▸</span><span class="nm">'+hl(label,f)+'</span>'+statusTag(b.status,'bug')+'</div>';
    }
  });
  return h;
}

function renderDomainTree(f){
  const list=allDomains.filter(d=>matchDomain(d,f));
  if(!list.length)return '<div class="tree-empty">'+(f?'无匹配域':'暂无域登记（specs/*/domains/_index.yml）')+'</div>';
  const groups=new Map();
  for(const d of list){
    const k=d.package||'pkg';
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(d);
  }
  let h='';
  [...groups.entries()].forEach(([pkg,items],i)=>{
    const k='dm_'+pkg;
    if(expanded[k]===undefined)expanded[k]=i===0||!!f;
    const open=isOpen(k);
    h+='<div class="g" tabindex="-1" data-lv="0" data-kind="group" data-key="'+k+'"><span class="ar'+(open?' open':'')+'" data-toggle="1">▸</span><span class="lb">'+esc(pkg)+'</span><span class="ct">'+items.length+'</span></div>';
    if(!open)return;
    for(const d of items){
      const path='#/domain/'+encodeURIComponent(d.package)+'/'+encodeURIComponent(d.id);
      const tag=d.current?'<span class="tag ready">CURRENT</span>':'<span class="tag draft">登记</span>';
      h+='<div class="g" tabindex="-1" data-lv="1" data-kind="domain" data-path="'+path+'" title="'+esc(d.id)+'"><span class="ar e">▸</span><span class="nm">'+hl(d.title||d.id,f)+'</span>'+tag+'</div>';
    }
  });
  return h;
}

function renderSpecTree(f){
  let h='';
  let shown=0;
  for(const p of allData){
    if(!matchPkg(p,f))continue;
    shown++;
    const kPkg='pkg_'+p.name,kDocs='pd_'+p.name;
    if(f)expanded[kPkg]=true;
    const open=isOpen(kPkg);
    const pkgOk=Object.values(p.packageDocs).filter(Boolean).length;
    const roll=pkgRollup(p.name);
    const pkgSig=roll?signalClass(roll.ts):'';
    const pkgExtra=roll?(pkgSig.includes('fade')?' g-pkg-changed g-changed-fade':' g-pkg-changed'):'';
    h+='<div class="g g-pkg'+pkgExtra+'" tabindex="-1" data-lv="1" data-kind="pkg" data-key="'+kPkg+'" data-path="#/pkg/'+esc(p.name)+'" title="'+esc(p.name+(p.description?' — '+p.description:''))+'">';
    h+='<div class="g-main"><span class="ar'+(open?' open':'')+'" data-toggle="1">▸</span><span class="nm">'+hl(p.name,f)+'</span>'+(roll?'<span class="ago">'+ago(roll.ts)+'</span>':'')+'<span class="ct '+(pkgOk===3?'ok':'miss')+'">'+pkgOk+'/3</span></div>';
    h+='</div>';
    if(!open)continue;
    for(const tr of p.tracks){
      if(f&&!matchTrack(tr,f)&&!p.name.toLowerCase().includes(f)&&!(p.description||'').toLowerCase().includes(f))continue;
      const kTr='trk_'+p.name+'_'+tr.name;
      const ok=Object.values(tr.docs).filter(Boolean).length;
      let trBest=null;
      for(const d of requiredTrackDocs){const s=fileSignal(p.name+'/'+tr.name+'/'+d);if(s&&(!trBest||s.ts>trBest.ts))trBest=s}
      const trSc=trBest?(signalClass(trBest.ts).includes('fade')?' g-pkg-changed g-changed-fade':' g-pkg-changed'):'';
      h+='<div class="g'+trSc+'" tabindex="-1" data-lv="2" data-kind="track" data-key="'+kTr+'" data-path="#/pkg/'+esc(p.name)+'/'+esc(tr.name)+'"><span class="ar e">▸</span><span class="nm">'+hl(tr.name,f)+'</span>'+(trBest?'<span class="ago">'+ago(trBest.ts)+'</span>':'')+'<span class="ct '+(ok===8?'ok':'miss')+'">'+ok+'/8</span></div>';
    }
  }
  if(f&&shown===0)h+='<div class="tree-empty">无匹配的包或 Track</div>';
  if(!f&&!allData.length)h+='<div class="tree-empty">无 spec 包</div>';
  return h;
}

function visibleRows(){return [...document.querySelectorAll('#tree .g:not(.h)')]}
function syncSel(){
  document.querySelectorAll('#tree .g').forEach(e=>e.classList.remove('sel','act'));
  const rows=visibleRows();
  rows.forEach(e=>{if(e.dataset.path===currentPath)e.classList.add('sel')});
  if(focusIdx>=0&&focusIdx<rows.length){rows[focusIdx].classList.add('act');rows[focusIdx].focus({preventScroll:false})}
}

function bindTree(){
  const tree=document.getElementById('tree');
  tree.onclick=function(ev){
    const ar=ev.target.closest('.ar[data-toggle]');
    const row=ev.target.closest('.g');
    if(!row||!tree.contains(row))return;
    if(row.dataset.kind==='cat'){
      clearTimeout(clickTimer);
      ev.preventDefault();
      const nav=row.getAttribute('data-nav');
      if(nav){go(nav);return}
      const d=listQuery();
      const cat=row.getAttribute('data-cat')||'';
      go(encodeListHash({route:listRoute(mode),seg:d.seg,q:d.q,cat}));
      return;
    }
    if(ar&&row.dataset.key){clearTimeout(clickTimer);ev.preventDefault();ev.stopPropagation();toggleOpen(row.dataset.key);renderTree(qVal());return}
    if(row.dataset.key&&row.dataset.path){
      clearTimeout(clickTimer);
      const path=row.dataset.path;
      clickTimer=setTimeout(()=>go(path),220);
      return;
    }
    if(row.dataset.scroll){
      clearTimeout(clickTimer);
      const t=document.getElementById('pulse-'+row.dataset.scroll);
      if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
      return;
    }
    if(row.dataset.path){clearTimeout(clickTimer);go(row.dataset.path);return}
    if(row.dataset.key){clearTimeout(clickTimer);toggleOpen(row.dataset.key);renderTree(qVal())}
  };
  tree.ondblclick=function(ev){
    const row=ev.target.closest('.g');
    if(!row||!tree.contains(row)||!row.dataset.key)return;
    clearTimeout(clickTimer);
    ev.preventDefault();
    ev.stopPropagation();
    toggleOpen(row.dataset.key);
    renderTree(qVal());
  };
  tree.onkeydown=function(ev){
    const rows=visibleRows();if(!rows.length)return;
    if(focusIdx<0)focusIdx=Math.max(0,rows.findIndex(r=>r.classList.contains('sel')));
    if(ev.key==='ArrowDown'){ev.preventDefault();focusIdx=Math.min(rows.length-1,focusIdx+1);syncSel();return}
    if(ev.key==='ArrowUp'){ev.preventDefault();focusIdx=Math.max(0,focusIdx-1);syncSel();return}
    const row=rows[focusIdx];if(!row)return;
    if(ev.key==='ArrowRight'){ev.preventDefault();if(row.dataset.key&&!isOpen(row.dataset.key)){setOpen(row.dataset.key,true);renderTree(qVal())}else{focusIdx=Math.min(rows.length-1,focusIdx+1);syncSel()}return}
    if(ev.key==='ArrowLeft'){ev.preventDefault();if(row.dataset.key&&isOpen(row.dataset.key)){setOpen(row.dataset.key,false);renderTree(qVal())}else{focusIdx=Math.max(0,focusIdx-1);syncSel()}return}
    if(ev.key==='Enter'){ev.preventDefault();if(row.dataset.path)go(row.dataset.path)}
  };
}

function setBriefWide(on){document.body.classList.toggle('brief-wide',!!on)}

function hidePreview(){
  const fr=document.getElementById('preview');
  if(!fr)return;
  fr.hidden=true;fr.removeAttribute('src');
  const body=document.getElementById('drawer-body');
  if(body)body.classList.remove('h');
}
function showContent(){
  setBriefWide(false);
  const el=document.getElementById('content');
  el.classList.remove('h');
  el.innerHTML='';
  hidePreview();
}
function showPreview(src){
  setBriefWide(true);
  const body=document.getElementById('drawer-body');
  if(body){body.innerHTML='';body.classList.add('h')}
  const fr=document.getElementById('preview');
  if(!fr)return;
  fr.hidden=false;
  if(fr.getAttribute('src')!==src)fr.src=src;
}
function openDrawer(){
  const el=document.getElementById('drawer');
  if(!el)return;
  el.hidden=false;
  document.body.classList.add('drawer-open');
  if(window.matchMedia('(max-width:759px)').matches)document.body.classList.add('drawer-full');
  else document.body.classList.remove('drawer-full');
}
function closeDrawerUi(){
  const el=document.getElementById('drawer');
  if(el)el.hidden=true;
  document.body.classList.remove('drawer-open','drawer-full');
  hidePreview();
  const body=document.getElementById('drawer-body');
  if(body){body.classList.remove('h');body.innerHTML=''}
  const bar=document.getElementById('drawer-bar');
  if(bar)bar.innerHTML='';
  const sab=document.getElementById('sv-actionbar');if(sab)sab.remove();
  document.querySelectorAll('.inbox-row[aria-current]').forEach(r=>r.removeAttribute('aria-current'));
}
function closeDrawerNav(){
  if(!confirmDataLeave())return;
  dataDirty=false;dataDraft=null;dataMeta=null;
  const dest=lastList[mode]||encodeListHash({route:listRoute(mode)});
  closeDrawerUi();
  go(dest);
}
function drawerBar(html){
  const el=document.getElementById('drawer-bar');
  if(el)el.innerHTML=html;
}
function drawerBody(html){
  hidePreview();
  const el=document.getElementById('drawer-body');
  if(el){el.classList.remove('h');el.innerHTML=html}
}
function highlightNavRow(href){
  document.querySelectorAll('.inbox-row[aria-current]').forEach(r=>r.removeAttribute('aria-current'));
  const row=document.querySelector('.inbox-row[data-nav="'+href+'"]');
  if(row)row.setAttribute('aria-current','true');
}
function hasListPaint(){
  const c=document.getElementById('content');
  if(!c)return false;
  return !!c.querySelector('.inbox-table, .inbox-empty, .inbox-fail');
}

function barEl(html){document.getElementById('bar').innerHTML=html}

function go(path,replace){
  if(!path)path='#/pulse';
  if(path[0]!=='#')path='#'+path;
  if(replace)history.replaceState(null,'',path);
  else if(location.hash!==path)location.hash=path;
  else renderRoute();
}

function parseHash(){
  return decodeListHash(location.hash||'#/pulse');
}

function dataHash(opts){
  const o=opts||{};
  const p=new URLSearchParams();
  if(o.seg)p.set('seg',o.seg);
  if(o.q)p.set('q',o.q);
  if(o.col)p.set('col',o.col);
  let path='#/data';
  if(o.file)path+='/'+encodeURIComponent(o.file);
  if(o.id)path+='/'+encodeURIComponent(o.id);
  const qs=p.toString();
  return path+(qs?'?'+qs:'');
}
function parseDataHash(){
  const d=parseHash();
  const raw=location.hash||'';
  const qi=raw.indexOf('?');
  const params=new URLSearchParams(qi>=0?raw.slice(qi+1):'');
  return {
    file:d.segs[1]||d.cat||'',
    id:d.segs[2]||'',
    col:params.get('col')||'',
    seg:d.seg||'writable',
    q:d.q||''
  };
}
function filterDataFiles(seg,q){
  let rows=allDataFiles.slice();
  if(seg==='writable')rows=rows.filter(f=>f.writable);
  else if(seg==='readonly')rows=rows.filter(f=>!f.writable);
  if(q){
    const qq=q.toLowerCase();
    rows=rows.filter(f=>f.stem.toLowerCase().includes(qq)||(f.file||'').toLowerCase().includes(qq));
  }
  return rows;
}
function renderDataCats(files,cat,filter){
  const d=parseDataHash();
  const seg=d.seg||'writable';
  const list=filterDataFiles(seg,filter||'');
  const cur=d.file||cat||'';
  let h='<div class="g'+(cur?'':' sel')+'" tabindex="0" data-lv="0" data-kind="cat" data-cat="" data-nav="'+dataHash({seg})+'" aria-current="'+(cur?'false':'true')+'"><span class="ar e">▸</span><span class="lb">全部</span><span class="ct">'+list.length+'</span></div>';
  for(const f of list){
    const on=cur===f.stem;
    const href=f.shape==='P3'
      ?dataHash({seg,file:f.stem,id:'__doc__',q:d.q})
      :dataHash({seg,file:f.stem,q:d.q});
    h+='<div class="g'+(on?' sel':'')+'" tabindex="0" data-lv="0" data-kind="cat" data-cat="'+esc(f.stem)+'" data-nav="'+href+'" aria-current="'+(on?'true':'false')+'"><span class="ar e">▸</span><span class="lb">'+esc(f.stem)+'</span><span class="ct">'+(f.writable?'可写':'只读')+'</span></div>';
  }
  if(!list.length)h+='<div class="tree-empty">暂无 JSON 文件</div>';
  return h;
}

function renderDataHome(opts){
  const keepHash=opts&&opts.keepHash;
  showContent();
  const d=parseDataHash();
  const seg=d.seg||'writable';
  syncSearchBox(d.q);
  showInboxTools('data',seg);
  if(!keepHash){
    const next=d.file?dataHash({seg,file:d.file,q:d.q,col:d.col}):dataHash({seg,q:d.q});
    lastList.data=d.id?dataHash({seg,file:d.file,q:d.q,col:d.col}):next;
    if(!d.id&&location.hash!==next)history.replaceState(null,'',next);
  }
  renderTree(qVal());
  if(listLoadError){
    barEl('<div class="crumb"><span class="title">数据</span></div>');
    bindBar();
    document.getElementById('content').innerHTML='<div class="inbox-fail" role="status"><p>无法读取数据。</p><button type="button" class="inbox-action" data-retry>重试</button></div>';
    bindInboxNav();
    return;
  }
  if(!d.file){
    barEl('<div class="crumb"><span class="title">数据 '+filterDataFiles(seg,d.q).length+'</span></div>'+crossHintHtml());
    bindBar();
    document.getElementById('content').innerHTML=inboxEmpty('选择左侧一个 JSON 文件。','左栏是文件文件夹，不是逐条 id。');
    bindInboxNav();
    return;
  }
  const info=allDataFiles.find(f=>f.stem===d.file);
  barEl('<div class="crumb"><span class="title">数据</span><span class="muted">'+esc(d.file)+'</span></div>'+crossHintHtml());
  bindBar();
  const col=d.col;
  api('/api/data/'+encodeURIComponent(d.file)+(col?('?collection='+encodeURIComponent(col)):'')).then(payload=>{
    if(!payload||payload.ok===false){
      document.getElementById('content').innerHTML=inboxEmpty('无法读取这个文件。','');
      bindInboxNav();
      return;
    }
    dataFilePayload=payload;
    if(payload.shape==='P3'){
      document.getElementById('content').innerHTML='<div class="inbox-empty"><p>'+esc(payload.file)+'</p><p class="hint">整文件配置，点开抽屉编辑。</p></div>';
      bindInboxNav();
      return;
    }
    const cols=payload.collections||[];
    let chips='';
    if(payload.shape==='P2'||cols.length>1){
      chips='<div class="seg data-cols">'+cols.map(c=>'<button type="button" data-col="'+esc(c.key)+'"'+(payload.collection===c.key?' class="on"':'')+'>'+esc(c.label||c.key)+'</button>').join('')+'</div>';
    }
    let rows=payload.entries||[];
    const qq=(d.q||'').toLowerCase();
    if(qq)rows=rows.filter(e=>(e.id+' '+(e.label||'')+' '+(e.name||'')).toLowerCase().includes(qq));
    barEl('<div class="crumb"><span class="title">数据 '+rows.length+'</span></div>'+chips+crossHintHtml());
    bindBar();
    const colBar=document.querySelector('#bar .data-cols');
    if(colBar){
      colBar.onclick=function(ev){
        const b=ev.target.closest('[data-col]');
        if(!b)return;
        go(dataHash({seg,file:d.file,q:d.q,col:b.getAttribute('data-col')}));
      };
    }
    if(!rows.length&&qq){
      document.getElementById('content').innerHTML=inboxEmpty('没有匹配的条目。','','<button type="button" class="inbox-action" data-clear-q>清除搜索</button>');
      bindInboxNav();
      return;
    }
    let h='<table class="inbox-table"><thead><tr><th class="thumb-col">图</th><th class="st">契约</th><th class="id">id</th><th class="ttl">显示名</th><th class="date">文件</th></tr></thead><tbody>';
    for(const e of rows){
      const href=dataHash({seg,file:d.file,id:e.id,q:d.q,col:payload.collection});
      h+='<tr class="inbox-row" tabindex="0" data-nav="'+href+'">';
      h+='<td class="thumb-col">'+thumbHtml(e.sprite,'thumb')+'</td>';
      h+='<td class="st">'+esc(e.contract||'')+'</td>';
      h+='<td class="id">'+esc(e.id)+'</td>';
      h+='<td class="ttl">'+esc(e.name||e.label||e.id)+'</td>';
      h+='<td class="date">'+esc(payload.file)+'</td></tr>';
    }
    h+='</tbody></table>';
    document.getElementById('content').innerHTML=h;
    bindInboxNav();
    if(d.id)highlightNavRow(dataHash({seg,file:d.file,id:d.id,q:d.q,col:payload.collection}));
  }).catch(()=>{
    document.getElementById('content').innerHTML='<div class="inbox-fail" role="status"><p>无法读取数据。</p><button type="button" class="inbox-action" data-retry>重试</button></div>';
    bindInboxNav();
  });
}

function renderDataEntry(file,id){
  if(!hasListPaint())renderDataHome({keepHash:true});
  else {showInboxTools('data',parseDataHash().seg);renderTree(qVal())}
  const d=parseDataHash();
  const back=dataHash({seg:d.seg,file,q:d.q,col:d.col});
  lastList.data=back;
  openDrawer();
  highlightNavRow(dataHash({seg:d.seg,file,id,q:d.q,col:d.col}));
  drawerBar('<div class="crumb"><button type="button" class="ghost" data-drawer-close>数据</button><span class="sep">/</span><span class="title">'+esc(file)+'</span><span class="muted">'+esc(id)+'</span><span class="grow"></span><button type="button" class="ghost" data-drawer-close>关闭</button></div>');
  bindDrawerBodyNav();
  const colq=d.col?('?collection='+encodeURIComponent(d.col)):'';
  Promise.all([loadDict(),api('/api/data/'+encodeURIComponent(file)+'/'+encodeURIComponent(id)+colq)]).then(([,payload])=>{
    if(!payload||payload.ok===false){
      drawerBody('<div class="empty">无法读取这条。<br><button type="button" class="inbox-action" data-drawer-close>关闭</button></div>');
      return;
    }
    dataMeta=payload;
    dataDraft=JSON.parse(JSON.stringify(payload.entry||{}));
    dataBaseline=JSON.parse(JSON.stringify(payload.entry||{}));
    dataErrors=[];
    dataSaving=false;
    dataDirty=false;
    paintDataDrawer();
  }).catch(()=>{
    drawerBody('<div class="empty">无法读取这条。<br><button type="button" class="inbox-action" data-drawer-close>关闭</button></div>');
  });
}

function dataDiff(){
  if(!dataBaseline||!dataDraft)return [];
  return diffValues(dataBaseline,dataDraft);
}

function dataSiblings(){
  if(!dataFilePayload||!dataMeta||dataFilePayload.stem!==dataMeta.stem)return [];
  return (dataFilePayload.entries||[]).map(e=>({id:e.id,label:e.label||e.name||e.id}));
}

function paintDataDrawer(){
  if(!dataMeta||!dataDraft)return;
  const writable=!!dataMeta.writable;
  const schema=dataMeta.itemSchema||{type:'object',properties:{}};
  const spr=dataMeta.sprite||{};
  const sc=document.getElementById('drawer-body');
  const keep=sc?sc.scrollTop:0;
  let h='<div class="df-hero">'+thumbHtml(spr,'thumb-lg')+'<div><div class="muted">'+esc(spr.rel||(spr.missing?'缺图':'—'))+'</div>'+(spr.missing&&spr.tried?'<p class="hint">'+esc((spr.tried||[]).join(' · '))+'</p>':'')+'</div></div>';
  if(dataMeta.stem==='nature_spawn'&&Array.isArray(dataDraft.files)){
    h+='<div class="thumb-grid">'+dataDraft.files.slice(0,24).map(fn=>thumbHtml({url:'/api/sprite?path='+encodeURIComponent('nature/'+fn),missing:false},'thumb')).join('')+'</div>';
  }
  h+=renderDataStudio({
    stem:dataMeta.stem,
    id:dataMeta.id,
    file:dataMeta.file,
    collection:dataMeta.collection,
    schema,
    value:dataDraft,
    baseline:dataBaseline,
    xrefs:dataMeta.xrefs||{},
    writable,
    saving:dataSaving,
    errors:dataErrors,
    diff:dataDiff(),
    siblings:dataSiblings(),
    dict:getFieldDict()
  });
  drawerBody(h);
  bindDataForm();
  markDataErrors();
  if(sc)sc.scrollTop=keep;
}

function refreshDataPreview(){
  const pre=document.getElementById('data-json');
  if(pre)pre.textContent=JSON.stringify(dataDraft,null,2);
}

function bindDataForm(){
  const form=document.getElementById('data-form');
  const root=document.querySelector('.df2');
  if(!form||!root)return;
  form.onsubmit=function(ev){ev.preventDefault()};
  const onEdit=function(ev){
    const el=ev.target;
    if(!el||!dataDraft)return;
    if(el.hasAttribute&&el.hasAttribute('data-extras')){
      if(applyExtrasInput(el)){afterDataEdit();}
      return;
    }
    if(el.hasAttribute&&el.hasAttribute('data-df2-chip-new'))return;
    if(el.hasAttribute&&el.hasAttribute('data-atom-type')){
      // 切 type：只改 type，字段一律保留；重绘以按新 type 收敛参数（不静默丢数据）
      const ap=el.getAttribute('data-atom-type');
      setPath(dataDraft,ap,applyAtomType(getPath(dataDraft,ap)||{},el.value));
      paintDataDrawer();
      return;
    }
    if(!el.hasAttribute||!el.hasAttribute('data-path'))return;
    const path=el.getAttribute('data-path');
    if(el.type==='checkbox')setPath(dataDraft,path,el.checked);
    else if(el.hasAttribute('data-json-block')){
      try{setPath(dataDraft,path,JSON.parse(el.value))}catch(e){/* keep typing */}
    }else if(el.hasAttribute('data-json-array')){
      try{setPath(dataDraft,path,JSON.parse(el.value))}catch(e){}
    }else if(el.type==='number'){
      const n=el.value===''?0:Number(el.value);
      setPath(dataDraft,path,n);
    }else setPath(dataDraft,path,el.value);
    afterDataEdit();
  };
  form.oninput=onEdit;
  form.onchange=onEdit;
  root.onclick=function(ev){onDataClick(ev,form,root)};
  root.onkeydown=function(ev){
    if((ev.key==='s'||ev.key==='S')&&(ev.ctrlKey||ev.metaKey)){ev.preventDefault();saveDataEntry();return}
    if(ev.key==='Enter'){
      const chip=ev.target.closest&&ev.target.closest('[data-df2-chip-new]');
      if(chip){ev.preventDefault();addChip(chip.getAttribute('data-df2-chip-new'),chip.value);}
    }
  };
  updateDataChrome();
}

/* ---- 数据页重做：编辑/结构操作/保存/跳转 ---- */

function afterDataEdit(){
  refreshDataPreview();
  updateDataChrome();
}

/** 输入后只更新状态条/摘要/预览，不重绘表单（保持焦点与输入法状态）。 */
function updateDataChrome(){
  const diff=dataDiff();
  dataDirty=diff.length>0;
  const st=document.getElementById('data-dirty');
  if(st){
    st.classList.toggle('on',dataDirty);
    st.innerHTML='<span class="df2-dot" aria-hidden="true"></span>'+(dataDirty?diff.length+' 处未保存':'未修改');
  }
  const rev=document.querySelector('[data-df2-revert]');
  if(rev)rev.disabled=!dataDirty;
  const save=document.getElementById('data-save');
  if(save){
    save.disabled=!!dataSaving;
    // 只改专用 label 节点（且仅在值变化时）：避免 mousedown→mouseup 之间替换 DOM 导致点击丢失
    const label=save.querySelector('.df2-save-label');
    if(label&&label.textContent!==(dataSaving?'保存中…':'保存'))label.textContent=dataSaving?'保存中…':'保存';
    save.title=dataSaving?'保存中…':'保存（Ctrl+S）';
  }
  const sum=document.getElementById('df2-summary');
  if(sum){
    const open=!sum.hidden;
    sum.outerHTML=renderStudioSummary(diff);
    const next=document.getElementById('df2-summary');
    if(next)next.hidden=!open;
  }
}

function applyExtrasInput(el){
  const path=el.getAttribute('data-extras')||'';
  let known=[];
  try{known=JSON.parse(el.getAttribute('data-known')||'[]')}catch(e){known=[]}
  let parsed;
  try{parsed=JSON.parse(el.value||'{}')}catch(e){return false}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return false;
  if(path){
    setPath(dataDraft,path,mergeExtras(getPath(dataDraft,path),parsed,known));
  }else{
    const next=mergeExtras(dataDraft,parsed,known);
    for(const k of Object.keys(dataDraft))delete dataDraft[k];
    Object.assign(dataDraft,next);
  }
  return true;
}

function errorText(e){
  const msg=String(e&&e.message||'');
  const exp=e&&e.expected;
  if(msg==='minimum')return '必须 ≥ '+exp;
  if(msg==='maximum')return '必须 ≤ '+exp;
  if(msg==='enum')return '枚举值不在允许范围';
  if(msg==='required')return '必填';
  if(msg==='type')return '类型必须是 '+exp;
  if(msg==='minItems')return '至少 '+exp+' 项';
  if(msg==='maxItems')return '最多 '+exp+' 项';
  if(msg==='minLength')return '长度不足';
  if(msg==='additionalProperties')return '不允许的额外键';
  return msg||'校验失败';
}

function markDataErrors(){
  const form=document.getElementById('data-form');
  if(!form)return;
  form.querySelectorAll('.df2-err').forEach(e=>e.classList.remove('df2-err'));
  for(const e of dataErrors){
    if(!e||!e.path)continue;
    const el=fieldEl(e.path);
    if(!el)continue;
    const row=el.closest('.df2-atom')||el.closest('.df-row')||el.closest('.df2-sub')||el;
    row.classList.add('df2-err');
  }
}

function fieldEl(path){
  const form=document.getElementById('data-form');
  if(!form||!path)return null;
  let el=null;
  try{el=form.querySelector('[data-path="'+path+'"]')}catch(e){el=null}
  if(el)return el;
  const parts=String(path).split('.');
  while(parts.length){
    try{el=form.querySelector('[data-extras="'+parts.join('.')+'"]')}catch(e){el=null}
    if(el)return el;
    parts.pop();
  }
  return null;
}

function groupBody(sec){
  if(!sec)return null;
  for(const c of [...sec.children]){
    if(c.classList&&(c.classList.contains('df2-gb')||c.classList.contains('df2-atom-b')))return c;
  }
  return null;
}

function setGroupOpen(sec,open){
  if(!sec)return;
  const body=groupBody(sec);
  if(!body)return;
  const id=sec.getAttribute('data-grp');
  if(id)setCollapsed(id,!open);
  body.hidden=!open;
  sec.classList.toggle('closed',!open);
  sec.classList.toggle('open',open);
  const head=sec.querySelector(':scope > .df2-gh, :scope > .df2-atom-h');
  if(head){
    head.setAttribute('aria-expanded',open?'true':'false');
    const caret=head.querySelector('.df2-caret');
    if(caret)caret.textContent=open?'▾':'▸';
  }
}

function toggleGroup(sec){
  if(!sec)return;
  const body=groupBody(sec);
  setGroupOpen(sec,!!(body&&body.hidden));
}

function openAncestors(el){
  let node=el;
  while(node&&node!==document.body){
    const sec=node.closest?node.closest('[data-grp]'):null;
    if(!sec)break;
    setGroupOpen(sec,true);
    node=sec.parentElement;
  }
}

function focusField(path){
  const el=fieldEl(path);
  if(!el)return false;
  openAncestors(el);
  const row=el.closest('.df2-atom')||el.closest('.df-row')||el.closest('.df2-sub')||el;
  try{row.scrollIntoView({block:'center'})}catch(e){}
  if(el.focus)try{el.focus({preventScroll:true})}catch(e){}
  return true;
}

function jumpToFieldOrGroup(key){
  if(!key)return;
  const target=document.getElementById(key);
  if(target){
    openAncestors(target);
    try{target.scrollIntoView({block:'start'})}catch(e){}
    return;
  }
  focusField(key);
}

function addChip(path,raw){
  const val=String(raw==null?'':raw).trim();
  if(!val||!dataDraft)return;
  const arr=(Array.isArray(getPath(dataDraft,path))?getPath(dataDraft,path):[]).slice();
  if(arr.indexOf(val)<0)arr.push(val);
  setPath(dataDraft,path,arr);
  paintDataDrawer();
}

function onDataClick(ev,form,root){
  if(ev.target.closest('#data-save')){ev.preventDefault();saveDataEntry();return}
  const collapse=ev.target.closest('[data-df2-collapse]');
  if(collapse){
    const sec=collapse.closest('[data-grp]');
    if(sec){ev.preventDefault();toggleGroup(sec);return}
  }
  const all=ev.target.closest('[data-df2-all]');
  if(all){
    ev.preventDefault();
    const path=all.getAttribute('data-df2-all');
    const id='all:'+path;
    setCollapsed(id,!isCollapsed(id));
    paintDataDrawer();
    return;
  }
  const chipDel=ev.target.closest('[data-df2-chip-del]');
  if(chipDel){
    ev.preventDefault();
    const path=chipDel.getAttribute('data-df2-chip-del');
    const i=Number(chipDel.getAttribute('data-i'));
    const arr=(getPath(dataDraft,path)||[]).slice();
    arr.splice(i,1);
    setPath(dataDraft,path,arr);
    paintDataDrawer();
    return;
  }
  const chipAdd=ev.target.closest('[data-df2-chip-add]');
  if(chipAdd){
    ev.preventDefault();
    const path=chipAdd.getAttribute('data-df2-chip-add');
    const input=form.querySelector('[data-df2-chip-new="'+path+'"]');
    addChip(path,input?input.value:'');
    return;
  }
  const jump=ev.target.closest('[data-df2-jump]');
  if(jump){ev.preventDefault();jumpToFieldOrGroup(jump.getAttribute('data-df2-jump'));return}
  const ejump=ev.target.closest('[data-df2-err-jump]');
  if(ejump){ev.preventDefault();focusField(ejump.getAttribute('data-df2-err-jump'));return}
  const tocToggle=ev.target.closest('[data-df2-toc-toggle]');
  if(tocToggle){
    ev.preventDefault();
    root.classList.toggle('toc-open');
    const open=root.classList.contains('toc-open');
    tocToggle.setAttribute('aria-expanded',open?'true':'false');
    return;
  }
  if(ev.target.closest('[data-df2-expand-all]')){ev.preventDefault();setAllGroups(true);return}
  if(ev.target.closest('[data-df2-collapse-all]')){ev.preventDefault();setAllGroups(false);return}
  const sumToggle=ev.target.closest('[data-df2-summary-toggle]');
  if(sumToggle){
    ev.preventDefault();
    const sum=document.getElementById('df2-summary');
    if(sum)sum.hidden=!sum.hidden;
    return;
  }
  if(ev.target.closest('[data-df2-summary-close]')){
    ev.preventDefault();
    const sum=document.getElementById('df2-summary');
    if(sum)sum.hidden=true;
    return;
  }
  if(ev.target.closest('[data-df2-revert]')){
    ev.preventDefault();
    if(!dataBaseline||!dataDiff().length)return;
    if(!window.confirm('回滚到磁盘上的值？未保存的修改会丢失。'))return;
    dataDraft=JSON.parse(JSON.stringify(dataBaseline));
    dataErrors=[];
    paintDataDrawer();
    showToast('已回滚到磁盘上的值');
    return;
  }
  const sib=ev.target.closest('[data-df2-sibling]');
  if(sib){
    ev.preventDefault();
    if(!confirmDataLeave())return;
    const seg=parseDataHash().seg;
    const stem=(dataMeta&&dataMeta.stem)||'';
    const nextId=sib.getAttribute('data-df2-sibling');
    dataDirty=false;
    dataDraft=null;dataMeta=null;dataBaseline=null;dataErrors=[];
    dataSaving=false;
    go(dataHash({seg,file:stem,id:nextId,col:''}));
    return;
  }
  const act=ev.target.closest('[data-df2-act]');
  if(act){ev.preventDefault();dataAct(act);return}
  const add=ev.target.closest('[data-arr-add]');
  if(add){
    ev.preventDefault();
    const path=add.getAttribute('data-arr-add');
    const arr=getPath(dataDraft,path);
    const next=Array.isArray(arr)?arr.slice():[];
    next.push({});
    setPath(dataDraft,path,next);
    paintDataDrawer();
    return;
  }
  const del=ev.target.closest('[data-arr-del]');
  if(del){
    ev.preventDefault();
    const path=del.getAttribute('data-arr-del');
    const i=Number(del.getAttribute('data-i'));
    const arr=(getPath(dataDraft,path)||[]).slice();
    arr.splice(i,1);
    setPath(dataDraft,path,arr);
    paintDataDrawer();
    return;
  }
  const madd=ev.target.closest('[data-map-add]');
  if(madd){
    ev.preventDefault();
    const path=madd.getAttribute('data-map-add');
    const sel=form.querySelector('[data-map-new="'+path+'"]');
    const key=sel&&sel.value;
    if(!key)return;
    const map=Object.assign({},getPath(dataDraft,path)||{});
    if(map[key]==null)map[key]=1;
    setPath(dataDraft,path,map);
    paintDataDrawer();
    return;
  }
  const mdel=ev.target.closest('[data-map-del]');
  if(mdel){
    ev.preventDefault();
    const path=mdel.getAttribute('data-map-del');
    const key=mdel.getAttribute('data-key');
    const map=Object.assign({},getPath(dataDraft,path)||{});
    delete map[key];
    setPath(dataDraft,path,map);
    paintDataDrawer();
  }
}

function dataAct(btn){
  const act=btn.getAttribute('data-df2-act');
  const path=btn.getAttribute('data-path')||'';
  const i=Number(btn.getAttribute('data-i')||0);
  if(act==='atom-add'){
    const arr=(Array.isArray(getPath(dataDraft,path))?getPath(dataDraft,path):[]).slice();
    arr.push({type:defaultAtomType()});
    setPath(dataDraft,path,arr);
  }else if(act==='atom-del'){
    if(!window.confirm('删除动作 #'+(i+1)+'？'))return;
    const arr=(getPath(dataDraft,path)||[]).slice();
    arr.splice(i,1);
    setPath(dataDraft,path,arr);
  }else if(act==='atom-up'||act==='atom-down'){
    const arr=(getPath(dataDraft,path)||[]).slice();
    const to=act==='atom-up'?i-1:i+1;
    if(to<0||to>=arr.length)return;
    const tmp=arr[to];arr[to]=arr[i];arr[i]=tmp;
    setPath(dataDraft,path,arr);
  }else if(act==='leg-add'){
    const arr=(Array.isArray(getPath(dataDraft,path))?getPath(dataDraft,path):[]).slice();
    arr.push({atoms:[{type:defaultAtomType()}]});
    setPath(dataDraft,path,arr);
  }else if(act==='leg-del'){
    if(!window.confirm('删除腿 '+(i+1)+'？'))return;
    const arr=(getPath(dataDraft,path)||[]).slice();
    arr.splice(i,1);
    setPath(dataDraft,path,arr);
  }else if(act==='leg-up'||act==='leg-down'){
    const arr=(getPath(dataDraft,path)||[]).slice();
    const to=act==='leg-up'?i-1:i+1;
    if(to<0||to>=arr.length)return;
    const tmp=arr[to];arr[to]=arr[i];arr[i]=tmp;
    setPath(dataDraft,path,arr);
  }else return;
  paintDataDrawer();
}

function setAllGroups(open){
  const root=document.querySelector('.df2');
  if(!root)return;
  root.querySelectorAll('[data-grp]').forEach(sec=>setGroupOpen(sec,open));
}

function saveDataEntry(){
  if(!dataMeta||!dataDraft||dataSaving)return;
  if(!dataMeta.writable){showToast('该表只读，不能保存',true);return}
  dataSaving=true;
  dataErrors=[];
  updateDataChrome();
  const stem=dataMeta.stem,id=dataMeta.id;
  apiPatch('/api/data/'+encodeURIComponent(stem)+'/'+encodeURIComponent(id),{
    expectedMtime:dataMeta.mtime,
    collection:dataMeta.collection,
    entry:dataDraft
  }).then(r=>{
    if(r.http===200&&r.json&&r.json.ok){
      dataMeta.mtime=r.json.mtime;
      if(r.json.entry)dataDraft=r.json.entry;
      dataBaseline=JSON.parse(JSON.stringify(dataDraft));
      dataSaving=false;
      dataErrors=[];
      dataDirty=false;
      showToast('已保存 '+stem+' / '+id);
      paintDataDrawer();
      return;
    }
    dataSaving=false;
    if(r.http===409){
      dataErrors=[];
      paintDataDrawer();
      const errEl=document.getElementById('data-err');
      if(errEl){
        errEl.hidden=false;
        errEl.innerHTML='<div class="df2-banner-h">保存失败：文件已被外部修改（409）</div>'+
          '<p class="df2-hint">磁盘上的版本比你打开时新；先重新加载这条再保存。</p>';
      }
      updateDataChrome();
      showToast('文件冲突，未写盘',true);
      return;
    }
    const errs=(r.json&&r.json.errors)||[];
    dataErrors=errs.map(e=>({
      path:matchPointer(dataDraft,e.pointer||''),
      pointer:e.pointer||'',
      message:errorText(e)
    }));
    const msg=(r.json&&r.json.error)?String(r.json.error):'写盘失败';
    paintDataDrawer();
    if(!dataErrors.length){
      const errEl=document.getElementById('data-err');
      if(errEl){errEl.hidden=false;errEl.innerHTML='<div class="df2-banner-h">保存失败：'+esc(msg)+'</div>'}
    }
    const first=dataErrors.find(e=>e.path);
    if(first)focusField(first.path);
    updateDataChrome();
    showToast('保存失败：'+msg,true);
  }).catch(()=>{
    dataSaving=false;
    dataErrors=[];
    paintDataDrawer();
    const errEl=document.getElementById('data-err');
    if(errEl){errEl.hidden=false;errEl.innerHTML='<div class="df2-banner-h">保存失败：网络/服务不可达</div>'}
    showToast('写盘失败',true);
  });
}


/* ---- UI kit gallery: visual-first cards + group x state x search ---- */
let uikitSel={group:'',state:'',q:''};
let uikitObs=null;
const UIKIT_THUMB_BASE=1260; /* catalog embed viewport width (matches .ukit-thumb CSS width) */
function uikitControls(){return Array.isArray(allUiKitControls)?allUiKitControls:[]}
function loadUiKitControls(){
  if(uikitControls().length)return Promise.resolve();
  return api('/api/ui-kit').then(payload=>{
    allUiKitControls=Array.isArray(payload&&payload.controls)?payload.controls:[];
  });
}
function uikitGridHtml(){return renderUiKitGrid(uikitControls(),uikitSel)}
function syncUiKitHash(replace){
  const next=uiKitGalleryHash(uikitSel);
  try{if(location.hash!==next)(replace===false?go(next):history.replaceState(null,'',next))}catch(e){}
}
function setUiKitSel(patch,opts){
  uikitSel=Object.assign({},uikitSel,patch||{});
  if(!opts||!opts.soft){uiKitSwapGrid()}else{uiKitSoftFilter()}
  syncUiKitHash(!opts||opts.push!==true);
}
/* soft filter (typing): swap grid only, keep the focused input alive */
function uiKitSwapGrid(){
  // swap ONLY the grid; the filter bar (search box + chips + count) stays mounted
  const c=document.getElementById('content');
  if(!c)return;
  const old=document.querySelector('#content [data-ukit-grid], #content .ukit-empty');
  const tmp=document.createElement('div');
  tmp.innerHTML=uikitGridHtml();
  if(old)c.replaceChild(tmp.firstElementChild,old);
  else c.appendChild(tmp.firstElementChild);
  bindUiKitGrid(); observeUiKitThumbs();
}
function uiKitSoftFilter(){
  uiKitSwapGrid();
  syncUiKitQueryInput();
  const count=filterUiKitControls(uikitControls(),uikitSel).length;
  const el=document.querySelector('.ukit-count');
  if(el)el.innerHTML='显示 <b>'+count+'</b> / '+uikitControls().length;
  // keep chip pressed-state honest without a full re-render
  document.querySelectorAll('.ukit-chip[data-ukit-facet]').forEach(ch=>{
    const f=ch.getAttribute('data-ukit-facet');
    const on=(f==='group'?(uikitSel.group||''):(uikitSel.state||''))===ch.getAttribute('data-ukit-val');
    ch.classList.toggle('on',on);
    ch.setAttribute('aria-pressed',on?'true':'false');
  });
}
function uiKitThumbScale(card){
  const w=card.clientWidth; if(!w)return;
  const s=Math.max(0.12,Math.min(1,w/UIKIT_THUMB_BASE));
  card.style.setProperty('--ukit-thumb-scale',String(s));
}
function observeUiKitThumbs(){
  const grid=document.querySelector('#content [data-ukit-grid]');
  if(!grid)return;
  const cards=[...grid.querySelectorAll('.ukit-card')];
  cards.forEach((card,i)=>card.style.setProperty('--ukit-stagger',String(Math.min(i,14)*20)+'ms'));
  if(!('IntersectionObserver' in window)){cards.forEach(loadUiKitThumb);return}
  if(uikitObs)uikitObs.disconnect();
  uikitObs=new IntersectionObserver((entries,ob)=>{for(const e of entries){if(!e.isIntersecting)continue;loadUiKitThumb(e.target);ob.unobserve(e.target)}},{root:document.getElementById('content')||null,rootMargin:'260px 0px'});
  for(const card of cards)uikitObs.observe(card);
}
function loadUiKitThumb(card){
  if(!card||card.dataset.loaded==='1')return;
  card.dataset.loaded='1';
  uiKitThumbScale(card);
  const vis=card.querySelector('.ukit-visual');
  const ifr=card.querySelector('iframe.ukit-thumb');
  if(!ifr){if(vis)vis.classList.add('ready');return}
  const src=ifr.getAttribute('data-src');
  if(!src){if(vis)vis.classList.add('ready');return}
  ifr.addEventListener('load',()=>{ifr.classList.add('loaded');if(vis)vis.classList.add('ready')},{once:true});
  ifr.addEventListener('error',()=>{if(vis)vis.classList.add('ready')},{once:true});
  ifr.setAttribute('src',src);
}
function uiKitAfterGridRender(){
  bindUiKitGrid(); observeUiKitThumbs();
  if('ResizeObserver' in window){
    const cards=document.querySelectorAll('#content .ukit-card');
    if(!uiKitAfterGridRender._ro){uiKitAfterGridRender._ro=new ResizeObserver(es=>{for(const e of es)uiKitThumbScale(e.target)});window.addEventListener('resize',()=>document.querySelectorAll('#content .ukit-card').forEach(c=>uiKitThumbScale(c)))}
    cards.forEach(c=>uiKitAfterGridRender._ro.observe(c));
  }
}
function bindUiKitGrid(){
  const grid=document.querySelector('#content [data-ukit-grid]');
  if(!grid)return;
  grid.onclick=function(ev){
    const card=ev.target.closest('.ukit-card');
    if(card){go('#/uikit/'+encodeURIComponent(card.getAttribute('data-ukit-id')));return}
  };
  grid.onkeydown=function(ev){
    if(ev.key!=='Enter'&&ev.key!==' ')return;
    const card=ev.target.closest('.ukit-card');
    if(!card)return;
    ev.preventDefault();
    go('#/uikit/'+encodeURIComponent(card.getAttribute('data-ukit-id')));
  };
}
function bindUiKitFilters(){
  const wrap=document.querySelector('#content .ukit-filters');
  if(!wrap)return;
  // own search box (the appbar input is a separate control; the gallery must not depend on it)
  wrap.oninput=function(ev){
    const t=ev.target;
    if(!t||t.id!=='ukit-search')return;
    uikitSel=Object.assign({},uikitSel,{q:String(t.value||'').trim().toLowerCase()});
    syncUiKitQueryInput();
    uiKitSoftFilter();
    syncUiKitHash(true);
  };
  wrap.addEventListener('click',ev=>{
    const chip=ev.target.closest('[data-ukit-facet]');
    if(chip){const facet=chip.getAttribute('data-ukit-facet');const val=chip.getAttribute('data-ukit-val');const patch={};if(facet==='group')patch.group=val;else patch.state=val;setUiKitSel(patch,{push:true});syncUiKitQueryInput();renderTree(qVal())}
    else if(ev.target.closest('[data-ukit-clear]')){setUiKitSel({group:'',state:'',q:''});syncUiKitQueryInput();renderRoute()}
  });
}
function syncUiKitQueryInput(){const qel=document.getElementById('q');if(qel&&qel.value!==(uikitSel.q||''))qel.value=uikitSel.q||''}
function renderUiKitHome(){return loadUiKitControls().then(()=>renderUiKitGalleryHome())}
function renderUiKitGalleryHome(){
  closeDrawerUi();
  const saved=parseUiKitGalleryHash(location.hash);
  const fromGlobal=qVal();
  uikitSel={group:saved.g||'',state:saved.s||'',q:saved.q||(fromGlobal||'')};
  ensureUiKitStyles(document); syncUiKitQueryInput();
  const hits=filterUiKitControls(uikitControls(),uikitSel).length;
  barEl('<div class="crumb"><span class="title">UI 控件库</span><span class="sep">·</span><span class="muted">显示 '+hits+' / '+uikitControls().length+'</span></div>');
  document.getElementById('content').innerHTML=renderUiKitFilters(uikitControls(),uikitSel)+uikitGridHtml();
  bindBar(); bindUiKitFilters(); uiKitAfterGridRender();
  if(!saved.g&&!saved.s&&!saved.q&&(fromGlobal||''))syncUiKitHash(true);
}
function renderUiKitEntry(id){
  return loadUiKitControls().then(()=>{
    const c=uikitControls().find(x=>x.id===id);
    ensureUiKitStyles(document);
    barEl('<div class="crumb"><button type="button" class="ghost" data-nav="#/uikit">UI 控件库</button><span class="sep">/</span><span class="title">.'+esc(id)+'</span></div>');
    const t=document.getElementById('tree');
    if(t)t.innerHTML=renderUiKitSide(uikitControls(),id,id);
    document.getElementById('content').innerHTML=renderUiKitDetail(c);
    bindBar();
    drawerBar('<div class="crumb"><button type="button" class="ghost" data-drawer-close>关闭</button><span class="sep">/</span><span class="title">.'+esc(id)+'</span></div>');
    document.getElementById('drawer-body').innerHTML=renderUiKitDetail(c);
    openDrawer(); /* sets hidden=false + body.drawer-open (ESC / mask close rely on the class) */
  });
}
function renderRoute(){
  // Bare entry (no hash / '#' / '#/') must land on the default route and stay canonical.
  // init() normalizes the first load; cover same-document hashchanges here too, and make
  // sure a restricted/blocked History API (embedded webviews) cannot abort the render.
  if(location.hash===''||location.hash==='#'||location.hash==='#/'){
    try{history.replaceState(null,'','#/pulse')}catch(e){}
  }
  const d=parseHash();
  const segs=d.segs;
  const head=d.route||'pulse';
  currentPath='#'+(segs.length?'/'+segs.join('/'):'/pulse');
  if(head==='pulse'){if(mode!=='pulse')setMode('pulse',false)}
  else if(head==='briefs'||head==='brief'){if(mode!=='briefs')setMode('briefs',false)}
  else if(head==='bugs'||head==='bug'){if(mode!=='bugs')setMode('bugs',false)}
  else if(head==='domains'||head==='domain'){if(mode!=='domains')setMode('domains',false)}
  else if(head==='specs'||head==='pkg'||head==='file'){if(mode!=='specs')setMode('specs',false)}
  else if(head==='data'){if(mode!=='data')setMode('data',false)}
  else if(head==='uikit'){if(mode!=='uikit')setMode('uikit',false)}
  else if(head==='performance'){if(mode!=='performance')setMode('performance',false)}
  focusIdx=visibleRows().findIndex(r=>r.dataset.path===currentPath);
  syncSel();
  if(head==='performance'){closeDrawerUi();showInboxTools(false);showContent();barEl('<div class="crumb"><span class="title">性能</span></div>');return renderPerformance(document.getElementById('content'),{svgLine,route:segs.slice(1),query:new URLSearchParams(location.hash.split('?')[1]||'')})}
  if(head==='pulse'||head===''){closeDrawerUi();return renderPulse()}
  if(head==='brief'&&segs[1])return renderBrief(decodeURIComponent(segs[1]),segs[2]==='md'?'md':'html');
  if(head==='briefs'){closeDrawerUi();return renderBriefHome()}
  if(head==='bug'&&segs[1])return renderBug(decodeURIComponent(segs[1]));
  if(head==='bugs'){closeDrawerUi();return renderBugHome()}
  if(head==='domain'&&segs[1]&&segs[2])return renderDomain(decodeURIComponent(segs[1]),decodeURIComponent(segs[2]));
  if(head==='domains'){closeDrawerUi();return renderDomainHome()}
  if(head==='data'){
    if(segs[2])return renderDataEntry(decodeURIComponent(segs[1]),decodeURIComponent(segs[2]));
    closeDrawerUi();
    return renderDataHome();
  }
  if(head==='uikit'){
    if(segs[1])return renderUiKitEntry(decodeURIComponent(segs[1]));
    closeDrawerUi();
    return renderUiKitHome();
  }
  if(head==='specs'){closeDrawerUi();return renderSpecHome()}
  if(head==='pkg'&&segs[1]&&!segs[2])return renderPkg(decodeURIComponent(segs[1]));
  if(head==='pkg'&&segs[1]&&segs[2])return renderTrack(decodeURIComponent(segs[1]),decodeURIComponent(segs[2]));
  if(head==='file')return renderSpecFile(segs.slice(1).map(decodeURIComponent).join('/'));
  closeDrawerUi();
  renderPulse();
}

function crossHintHtml(){
  const f=qVal();
  if(!f)return '';
  const bits=[];
  const nb=allBriefs.filter(b=>matchBrief(b,f)).length;
  const ns=allData.filter(p=>matchPkg(p,f)).length;
  const ng=allBugs.filter(b=>matchBug(b,f)).length;
  const nd=allDomains.filter(d=>matchDomain(d,f)).length;
  if(mode!=='briefs'&&nb)bits.push('<button type="button" class="ghost" data-nav="#/briefs">简报 '+nb+'</button>');
  if(mode!=='specs'&&ns)bits.push('<button type="button" class="ghost" data-nav="#/specs">规格 '+ns+'</button>');
  if(mode!=='domains'&&nd)bits.push('<button type="button" class="ghost" data-nav="#/domains">域 '+nd+'</button>');
  if(mode!=='bugs'&&ng)bits.push('<button type="button" class="ghost" data-nav="#/bugs">上报 '+ng+'</button>');
  return bits.length?'<span class="hits">'+bits.join('')+'</span>':'';
}
function pinListHash(route,seg,q,cat){
  const next=encodeListHash({route,seg,q,cat});
  lastList[mode]=next;
  if(location.hash!==next)history.replaceState(null,'',next);
}
function listQuery(){
  const live=parseHash();
  const qel=document.getElementById('q');
  const typing=qel&&document.activeElement===qel;
  if(isDrawerRoute(location.hash)){
    const saved=decodeListHash(lastList[mode]||'');
    return {route:listRoute(mode),seg:saved.seg,q:typing?qel.value:saved.q,cat:saved.cat||''};
  }
  return {route:live.route,seg:live.seg,q:typing?qel.value:live.q,cat:live.cat||''};
}
function syncSearchBox(q){
  const qel=document.getElementById('q');
  if(!qel)return;
  if(document.activeElement===qel)return;
  if(qel.value!==(q||''))qel.value=q||'';
}
function showInboxTools(kind,seg){
  const tools=document.getElementById('inbox-tools');
  const segs=document.getElementById('segs');
  document.body.classList.toggle('inbox-list',!!kind);
  const ft=document.getElementById('facetToggle');
  if(ft)ft.hidden=!kind;
  if(!tools)return;
  if(!kind){tools.hidden=true;return}
  tools.hidden=false;
  if(!segs)return;
  if(kind==='bugs'){
    segs.hidden=false;
    segs.innerHTML='<button type="button" data-seg="new"'+(seg==='new'?' class="on"':'')+'>新</button>'+
      '<button type="button" data-seg="closed"'+(seg==='closed'?' class="on"':'')+'>已关闭</button>'+
      '<button type="button" data-seg="all"'+(seg==='all'?' class="on"':'')+'>全部</button>';
  }else if(kind==='briefs'){
    segs.hidden=false;
    segs.innerHTML='<button type="button" data-seg="draft"'+(seg==='draft'?' class="on"':'')+'>草稿</button>'+
      '<button type="button" data-seg="ready"'+(seg==='ready'?' class="on"':'')+'>可交</button>'+
      '<button type="button" data-seg="doing"'+(seg==='doing'?' class="on"':'')+'>实现中</button>'+
      '<button type="button" data-seg="done"'+(seg==='done'?' class="on"':'')+'>已实现</button>'+
      '<button type="button" data-seg="rejected"'+(seg==='rejected'?' class="on"':'')+'>已否决</button>'+
      '<button type="button" data-seg="all"'+(seg==='all'?' class="on"':'')+'>全部</button>';
  }else if(kind==='data'){
    segs.hidden=false;
    segs.innerHTML='<button type="button" data-seg="writable"'+(seg==='writable'?' class="on"':'')+'>可写</button>'+
      '<button type="button" data-seg="readonly"'+(seg==='readonly'?' class="on"':'')+'>只读</button>'+
      '<button type="button" data-seg="all"'+(seg==='all'?' class="on"':'')+'>全部</button>';
  }else{
    segs.hidden=true;
    segs.innerHTML='';
  }
}
function inboxEmpty(title,hint,actionHtml){
  return '<div class="inbox-empty"><p>'+title+'</p>'+(hint?'<p class="hint">'+hint+'</p>':'')+(actionHtml||'')+'</div>';
}
function inboxSkel(cols){
  let h='<table class="inbox-table inbox-skel"><thead><tr>';
  for(const c of cols)h+='<th'+(c.cls?' class="'+c.cls+'"':'')+'>'+c.label+'</th>';
  h+='</tr></thead><tbody>';
  for(let i=0;i<4;i++){
    h+='<tr class="inbox-row"><td colspan="'+cols.length+'"><span class="bone'+(i%3?' w'+(i%3+1):'')+'"></span></td></tr>';
  }
  return h+'</tbody></table>';
}
function bindInboxNav(){
  const root=document.getElementById('content');
  if(!root)return;
  root.onclick=function(ev){
    const clr=ev.target.closest('[data-clear-q]');
    if(clr){
      const qel=document.getElementById('q');
      if(qel){qel.value='';qel.dispatchEvent(new Event('input'))}
      return;
    }
    const catAll=ev.target.closest('[data-clear-cat]');
    if(catAll){
      const d=listQuery();
      go(encodeListHash({route:d.route||'bugs',seg:d.seg,q:d.q,cat:''}));
      return;
    }
    const retry=ev.target.closest('[data-retry]');
    if(retry){listLoadError='';softRefresh();return}
    const segBtn=ev.target.closest('[data-seg]');
    if(segBtn&&!segBtn.closest('#segs')){
      const d=listQuery();
      go(encodeListHash({route:d.route||'bugs',seg:segBtn.getAttribute('data-seg'),q:d.q,cat:d.cat}));
      return;
    }
    const a=ev.target.closest('[data-nav]');
    if(!a)return;
    ev.preventDefault();
    go(a.getAttribute('data-nav'));
  };
  root.onkeydown=function(ev){
    if(ev.key!=='Enter')return;
    const row=ev.target.closest('.inbox-row[data-nav]');
    if(!row)return;
    ev.preventDefault();
    go(row.getAttribute('data-nav'));
  };
}

function renderMonthGroups(items, rowFn, openAll){
  const groups=groupByMonth(items);
  let h='';
  groups.forEach(([month,rows],i)=>{
    h+='<details class="mgroup"'+(openAll||i===0?' open':'')+'><summary>'+esc(month)+'<span>'+rows.length+'</span></summary><div class="ilist">';
    for(const it of rows)h+=rowFn(it);
    h+='</div></details>';
  });
  return h;
}

function renderBriefHome(opts){
  const keepHash=opts&&opts.keepHash;
  showContent();
  const d=listQuery();
  const seg=d.seg||'draft';
  const cat=d.cat||'';
  syncSearchBox(d.q);
  showInboxTools('briefs',seg);
  const list=filterBriefs(allBriefs,{seg,q:d.q,cat});
  const n=visibleCount(list);
  if(!keepHash)pinListHash('briefs',seg,d.q,cat);
  else lastList.briefs=encodeListHash({route:'briefs',seg,q:d.q,cat});
  barEl('<div class="crumb"><span class="title">简报 '+n+'</span></div>'+crossHintHtml());
  bindBar();
  renderTree(qVal());
  if(!allBriefs.length&&!d.q){
    document.getElementById('content').innerHTML=inboxEmpty('还没有简报。','在 docs/briefs/ 新建文件夹后刷新。');
    bindInboxNav();
    return;
  }
  if(!list.length&&d.q){
    document.getElementById('content').innerHTML=inboxEmpty('没有匹配的简报。','','<button type="button" class="inbox-action" data-clear-q>清除搜索</button>');
    bindInboxNav();
    return;
  }
  if(!list.length&&cat){
    document.getElementById('content').innerHTML=inboxEmpty('这个分类下没有条目。','','<button type="button" class="inbox-action" data-clear-cat>查看全部</button>');
    bindInboxNav();
    return;
  }
  if(!list.length&&seg==='draft'){
    document.getElementById('content').innerHTML=inboxEmpty('没有草稿简报。','','<button type="button" class="inbox-action" data-seg="all">查看全部</button>');
    bindInboxNav();
    return;
  }
  if(!list.length&&seg&&seg!=='all'){
    document.getElementById('content').innerHTML=inboxEmpty('这个状态下没有简报。','','<button type="button" class="inbox-action" data-seg="all">查看全部</button>');
    bindInboxNav();
    return;
  }
  const groups=groupByMonth(list);
  let h='<table class="inbox-table"><thead><tr><th class="st">状态</th><th class="ttl">标题</th><th class="date">日期</th></tr></thead><tbody>';
  for(const [month,rows] of groups){
    h+='<tr class="inbox-group"><td colspan="3">'+esc(month)+'</td></tr>';
    for(const b of rows){
      const href=b.hasPreview?'#/brief/'+encodeURIComponent(b.id):'#/brief/'+encodeURIComponent(b.id)+'/md';
      h+='<tr class="inbox-row" tabindex="0" data-nav="'+href+'"><td class="st">'+statusTag(b.status,'brief')+'</td><td class="ttl">'+esc(b.title||b.id)+'</td><td class="date">'+esc(b.date||'')+'</td></tr>';
    }
  }
  h+='</tbody></table>';
  document.getElementById('content').innerHTML=h;
  bindInboxNav();
}

/* ===== 状态流转（brief / bug 状态 + Markdown 写回） ===== */
let writeEnabled=false;
const SV_WRITE_KEY='sv-write-mode';
const SV_META={
  brief:{
    mark_ready:{label:'标记可交',confirm:false},
    start_impl:{label:'开始实现',confirm:true},
    mark_done:{label:'标记已实现',confirm:true},
    interrupt:{label:'中断',confirm:true},
    undo:{label:'撤销',confirm:true,danger:true},
    reject:{label:'否决',confirm:true,danger:true},
    send_back:{label:'退回',confirm:true}
  },
  bug:{
    start_fix:{label:'开始制作',confirm:true},
    mark_done:{label:'标记已实现',confirm:true},
    close_false_red:{label:'关包·非缺陷',confirm:true,requires:'reason'},
    close_duplicate:{label:'关包·重复',confirm:true,requires:'masterId'},
    interrupt:{label:'中断',confirm:true},
    reopen:{label:'重开',confirm:true}
  }
};
function svSavedWrite(){try{return localStorage.getItem(SV_WRITE_KEY)==='1'}catch(e){return false}}
/* 写模式 = 前端本地开关（localStorage）＋逐操作确认。 */
function svWriteUsable(){return writeEnabled}
function svWriteTitle(){
  if(!writeEnabled)return '写模式未开启（顶栏「写模式 关」）';
  return '写模式已开启';
}
/* 写门未开启时的「下一步」文案：说清该点哪里 */
function svWriteNextStep(){
  if(!writeEnabled)return '点下方「开启写模式」按钮，或点顶栏「写模式 关」；开启后每次操作仍需二次确认';
  return '每次操作仍需二次确认';
}
/* 操作条内的写门提示：入口不 disabled，改为可见横幅 + 就地开启入口 */
function svWriteGateHtml(){
  if(!writeEnabled){
    return '<div class="sv-write-gate" role="alert"><span class="sv-write-gate-msg">'+esc(svWriteTitle())+'</span>'
      +'<button type="button" class="issue-btn primary sv-write-enable" data-sv-write-enable>开启写模式</button>'
      +'<span class="sv-write-gate-hint">'+esc(svWriteNextStep())+'</span></div>';
  }
  return '';
}
/* 就地开启写模式：与顶栏 #svWriteToggle 共用 SV_WRITE_KEY，开完两处同步刷新 */
function svEnableWrite(){
  writeEnabled=true;
  try{localStorage.setItem(SV_WRITE_KEY,'1')}catch(e){}
  svRenderWriteToggle();
  if(typeof renderRoute==='function')renderRoute();
  return true;
}
function svRenderWriteToggle(){
  const end=document.getElementById('appbar-end');if(!end)return;
  let el=document.getElementById('svWriteToggle');
  if(!el){
    el=document.createElement('button');el.id='svWriteToggle';el.type='button';el.className='sv-write-toggle';
    el.addEventListener('click',function(){
      writeEnabled=!writeEnabled;try{localStorage.setItem(SV_WRITE_KEY,writeEnabled?'1':'0')}catch(e){}svRenderWriteToggle();if(typeof renderRoute==='function')renderRoute();
    });
    end.insertBefore(el,end.firstChild);
  }
  el.textContent='写模式 '+(writeEnabled?'开':'关');
  el.classList.toggle('on',writeEnabled);
  el.title=svWriteTitle()+(writeEnabled?'':' — '+svWriteNextStep());
}
function svBoot(){
  writeEnabled=svSavedWrite();
  svRenderWriteToggle();
}
function svActionsFor(kind,status){
  const s=String(status||'');
  if(kind==='brief'){
    if(s==='草稿')return[{a:'mark_ready',label:'标记可交',confirm:false}];
    if(s==='可交 spec-engine')return[{a:'start_impl',label:'开始实现',confirm:true,primary:true},{a:'send_back',label:'退回',confirm:true},{a:'reject',label:'否决',confirm:true,danger:true}];
    if(s==='实现中')return[{a:'mark_done',label:'标记已实现',confirm:true},{a:'interrupt',label:'中断',confirm:true},{a:'undo',label:'撤销',confirm:true,danger:true},{a:'reject',label:'否决',confirm:true,danger:true}];
    if(s==='已实现')return[{a:'undo',label:'撤销',confirm:true,danger:true},{a:'interrupt',label:'中断',confirm:true}];
    if(s==='已否决')return[{a:'undo',label:'撤销',confirm:true,danger:true}];
    return[];
  }
  if(/^已关闭/.test(s))return[{a:'reopen',label:'重开',confirm:true}];
  if(s==='修复中')return[{a:'mark_done',label:'关包·已修复',confirm:true,primary:true},{a:'close_false_red',label:'关包·非缺陷',confirm:true},{a:'close_duplicate',label:'关包·重复',confirm:true},{a:'interrupt',label:'中断/撤销',confirm:true,danger:true}];
  return[{a:'start_fix',label:'开始制作',confirm:true,primary:true},{a:'mark_done',label:'标记已实现',confirm:true},{a:'close_false_red',label:'关包·非缺陷',confirm:true},{a:'close_duplicate',label:'关包·重复',confirm:true},{a:'interrupt',label:'中断',confirm:true}];
}
function svTarget(kind,action,from){
  if(kind==='brief'){
    if(action==='mark_ready')return '可交 spec-engine';
    if(action==='start_impl')return '实现中';
    if(action==='mark_done')return '已实现';
    if(action==='reject')return '已否决';
    if(action==='send_back')return '草稿';
    if(action==='interrupt')return from;
    if(action==='undo'){if(from==='已否决')return '草稿';if(from==='已实现')return '实现中';if(from==='实现中')return '可交 spec-engine'}
    return from;
  }
  if(action==='start_fix')return '修复中';
  if(action==='interrupt')return from==='修复中'?'新':from;
  if(action==='mark_done')return '已关闭';
  if(action==='close_false_red')return '已关闭 · 非缺陷';
  if(action==='close_duplicate')return '已关闭 · 重复';
  if(action==='reopen')return '新';
  return from;
}
function svInlineError(root,msg){
  if(!root)return;
  let el=root.querySelector('.sv-inline-error');
  if(!el){el=document.createElement('div');el.className='sv-inline-error';el.setAttribute('role','alert');root.appendChild(el)}
  el.textContent=msg||'';el.hidden=!msg;
}
function svRun(kind,item,action,opts,root){
  opts=opts||{};
  const body={kind:kind,id:item.id,action:action,reason:opts.reason||'',masterId:opts.masterId||''};
  svInlineError(root,'');
  const btns=root.querySelectorAll('button');btns.forEach(function(b){b.disabled=true});
  return fetch('/api/specviewer/transition',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){return{http:r.status,json:j}},function(){return{http:r.status,json:{ok:false,error:'bad_json'}}})})
    .then(function(res){
      btns.forEach(function(b){b.disabled=false});
      const j=res.json||{};
      if(!j.ok){
        const em=(j.error&&j.error.message)||j.error||('HTTP '+res.http);
        const code=(j.error&&j.error.code)||j.error||'error';
        showToast('操作失败：'+code+' — '+em,true);
        svInlineError(root,'操作失败：'+code+' — '+em+'（状态未改，可重试）');
        return;
      }
      if(j.skipped){
        showToast('无需重复操作（'+String(j.reason||'skipped')+'）；'+j.from+' → '+j.to);
      }else{
        const vv=j.vault&&j.vault.version?('（Vault v'+j.vault.version+'）'):'';
        showToast('状态已更新：'+j.from+' → '+j.to+vv);
      }
      svInlineError(root,'');
      svReload(kind,item.id);
    })
    .catch(function(e){
      btns.forEach(function(b){b.disabled=false});
      showToast('操作失败：网络错误',true);
      svInlineError(root,'操作失败：网络错误 — '+String((e&&e.message)||e));
    });
}
function svReload(kind,id){
  const url=kind==='brief'?'/api/briefs':'/api/bugs';
  return api(url).then(function(list){
    if(kind==='brief'){allBriefs=Array.isArray(list)?list:[];renderTree(qVal());updateBadges();if(allBriefs.some(function(b){return b.id===id}))renderBrief(id)}
    else{allBugs=Array.isArray(list)?list:[];renderTree(qVal());updateBadges();if(allBugs.some(function(b){return b.id===id}))renderBug(id)}
  });
}
function mountBriefActionbar(brief){
  const panel=document.getElementById('drawer-panel');if(!panel)return;
  let el=document.getElementById('sv-actionbar');
  if(!el){
    el=document.createElement('div');el.id='sv-actionbar';el.className='sv-actionbar';
    const bar=document.getElementById('drawer-bar');
    bar.insertAdjacentElement('afterend',el);
  }
  const st=brief?String(brief.status||''):'';
  const acts=brief?svActionsFor('brief',st):[];
  const wide=window.matchMedia('(min-width:760px)').matches;
  let inner=svWriteGateHtml();
  inner+='<details class="sv-ops"'+(wide?' open':'')+'><summary class="sv-ops-summary">操作▾</summary><div class="sv-ops-body">';
  for(const a of acts)inner+='<button type="button" class="issue-btn'+(a.primary?' primary':'')+(a.danger?' sv-danger':'')+'" data-sv-action="'+a.a+'" title="'+esc(svWriteTitle())+'">'+esc(a.label)+'</button>';
  inner+='</div></details><div class="sv-confirm" hidden></div><div class="sv-inline-error" hidden></div>';
  el.innerHTML=inner;
  el.onclick=function(ev){
    if(ev.target.closest('[data-sv-write-enable]')){svEnableWrite();return}
    const conf=el.querySelector('.sv-confirm');
    if(ev.target.closest('[data-sv-cancel]')){if(conf)conf.hidden=true;return}
    const btn=ev.target.closest('[data-sv-action]');
    if(btn){
      if(!svWriteUsable()){showToast(svWriteTitle(),true);svInlineError(el,svWriteTitle()+' — '+svWriteNextStep());return}
      const action=btn.getAttribute('data-sv-action');
      const meta=SV_META.brief[action];if(!meta)return;
      if(meta.confirm===false){svRun('brief',brief,action,{},el);return}
      const to=svTarget('brief',action,st);
      el.dataset.pending=action;
      conf.innerHTML='<div class="sv-confirm-lab">确认「'+esc(meta.label)+'」 · '+esc(st)+' → '+esc(to)+'</div>'
        +'<div class="sv-confirm-row"><button type="button" class="issue-btn" data-sv-cancel>取消</button><button type="button" class="issue-btn primary" data-sv-ok>确认</button></div>';
      conf.hidden=false;
      return;
    }
    if(ev.target.closest('[data-sv-ok]')){
      const action=el.dataset.pending;if(!action)return;
      svRun('brief',brief,action,{},el);
      if(conf)conf.hidden=true;
    }
  };
}

function renderBrief(id,view){
  if(!hasListPaint())renderBriefHome({keepHash:true});
  else {showInboxTools('briefs',listQuery().seg);renderTree(qVal())}
  const brief=allBriefs.find(b=>b.id===id);
  const title=brief?brief.title:id;
  const canHtml=brief?brief.hasPreview:true;
  if(view==='html'&&!canHtml)view='md';
  briefView=view;
  const htmlOn=view==='html'?' on':'';
  const mdOn=view==='md'?' on':'';
  const back=lastList.briefs||encodeListHash({route:'briefs'});
  const seg=canHtml
    ?'<div class="seg"><button type="button" class="'+htmlOn.trim()+'" data-nav="#/brief/'+encodeURIComponent(id)+'">预览</button><button type="button" class="'+mdOn.trim()+'" data-nav="#/brief/'+encodeURIComponent(id)+'/md">Markdown</button></div>'
    :'';
  openDrawer();
  drawerBar('<div class="crumb"><a data-nav="'+back+'">简报</a><span>›</span><span class="title" title="'+esc(id)+'">'+esc(title)+'</span>'+(brief?statusTag(brief.status,'brief'):'')+'</div>'+seg+'<button type="button" class="ghost" data-ext="/brief-static/'+encodeURIComponent(id)+'/preview.html"'+(canHtml?'':' hidden')+'>外开</button>');
  bindDrawerChrome();
  mountBriefActionbar(brief);
  highlightNavRow('#/brief/'+encodeURIComponent(id));
  if(view==='html'&&canHtml){
    showPreview('/brief-static/'+encodeURIComponent(id)+'/preview.html');
    return;
  }
  fetch('/brief-file/'+encodeURIComponent(id)+'/BRIEF.md').then(r=>r.text()).then(html=>{
    const patched=html
      .replace(/href="(?:\.\/)?preview\.html"/gi,'href="#/brief/'+encodeURIComponent(id)+'"')
      .replace(/href='(?:\.\/)?preview\.html'/gi,'href="#/brief/'+encodeURIComponent(id)+'"')
      .replace(/target="_blank"/gi,'');
    drawerBody(patched);
    const body=document.getElementById('drawer-body');
    body.onclick=function(ev){
      const a=ev.target.closest('a[href]');
      if(!a)return;
      const href=a.getAttribute('href')||'';
      if(href.startsWith('#/')){ev.preventDefault();go(href)}
    };
  }).catch(()=>{drawerBody('<div class="empty">无法读取这条。<br><button type="button" class="inbox-action" data-drawer-close>关闭</button></div>')});
}

function sevChip(b){
  const sev=String(b.severity||''); const pri=String(b.priority||'');
  let h='';
  if(pri)h+='<span class="lvl-pri" title="优先级">'+esc(pri)+'</span>';
  if(sev)h+='<span class="lvl-sev'+(sev==='critical'||sev==='high'?' hi':'')+'" title="严重度">'+esc(sev)+'</span>';
  return h||'<span class="lvl-none">—</span>';
}
function srcChip(b){
  const src=(b.reporter&&b.reporter.source)||'';
  if(!src)return '';
  return '<span class="src-chip" title="上报来源">'+esc(src)+'</span>';
}
function gapChip(b){
  const n=Array.isArray(b.dataGaps)?b.dataGaps.length:0;
  if(!n)return '';
  // 历史上报（修复前旧采集）缺 build/env 等；新上报采集完整，避免误读为当前缺陷。
  const legacy=(b.legacyCapture===true)||!b.build;
  const reason=(b.dataGapsReason?('原因：'+b.dataGapsReason+'；'):'');
  const tip=(legacy?'历史上报 · 旧采集缺少字段（非当前缺陷）：':'数据缺口：')+reason+(b.dataGaps||[]).join(', ');
  return '<span class="gap-chip'+(legacy?' gap-legacy':'')+'" title="'+esc(tip)+'">'+(legacy?'历史缺口 ':'缺口 ')+n+'</span>';
}
function renderBugHome(opts){
  const keepHash=opts&&opts.keepHash;
  showContent();
  const d=listQuery();
  const seg=d.seg||'new';
  const cat=d.cat||'';
  syncSearchBox(d.q);
  showInboxTools('bugs',seg);
  if(!keepHash)pinListHash('bugs',seg,d.q,cat);
  else lastList.bugs=encodeListHash({route:'bugs',seg,q:d.q,cat});
  renderTree(qVal());
  if(listLoadError){
    barEl('<div class="crumb"><span class="title">上报</span></div>');
    bindBar();
    document.getElementById('content').innerHTML='<div class="inbox-fail" role="status"><p>无法读取上报。</p><button type="button" class="inbox-action" data-retry>重试</button></div>';
    bindInboxNav();
    return;
  }
  if(!allBugs.length&&!d.q){
    barEl('<div class="crumb"><span class="title">上报 0</span></div>');
    bindBar();
    document.getElementById('content').innerHTML=inboxEmpty('还没有上报。','游戏里按 F3 会写到 game/reports/bugs/。');
    bindInboxNav();
    return;
  }
  const list=filterInbox(allBugs,{seg,q:d.q,cat});
  const n=visibleCount(list);
  barEl('<div class="crumb"><span class="title">上报 '+n+'</span><button type="button" class="inbox-action" data-sync-now title="从 Vault 立即同步（缩短 5 分钟同步窗）">同步</button></div>'+crossHintHtml());
  bindBar();
  if(!list.length&&d.q){
    document.getElementById('content').innerHTML=inboxEmpty('没有匹配的上报。','','<button type="button" class="inbox-action" data-clear-q>清除搜索</button>');
    bindInboxNav();
    return;
  }
  if(!list.length&&cat){
    document.getElementById('content').innerHTML=inboxEmpty('这个分类下没有条目。','','<button type="button" class="inbox-action" data-clear-cat>查看全部</button>');
    bindInboxNav();
    return;
  }
  if(!list.length&&seg==='new'&&allBugs.some(b=>/已关闭/.test(b.status||''))){
    document.getElementById('content').innerHTML=inboxEmpty('没有未关闭的上报。','','<button type="button" class="inbox-action" data-seg="closed">查看已关闭</button>');
    bindInboxNav();
    return;
  }
  if(!list.length){
    document.getElementById('content').innerHTML=inboxEmpty('没有上报。','');
    bindInboxNav();
    return;
  }
  const groups=groupByMonth(list);
  let h='<table class="inbox-table"><thead><tr><th class="st">状态</th><th class="lvl">分级</th><th class="num">编号</th><th class="ttl">标题</th><th class="date">日期</th></tr></thead><tbody>';
  for(const [month,rows] of groups){
    h+='<tr class="inbox-group"><td colspan="5">'+esc(month||'其它')+'</td></tr>';
    for(const b of rows){
      const id8=esc(b.bugId||'');
      h+='<tr class="inbox-row" tabindex="0" data-nav="#/bug/'+encodeURIComponent(b.id)+'" data-status="'+esc(b.status||'新')+'">';
      h+='<td class="st">'+statusTag(b.status,'bug')+'</td>';
      h+='<td class="lvl">'+sevChip(b)+'</td>';
      h+='<td class="num">'+id8+'</td>';
      h+='<td class="ttl">'+esc(b.title||b.id)+gapChip(b)+srcChip(b)+'</td>';
      h+='<td class="date">'+esc(b.date||'')+'</td></tr>';
    }
  }
  h+='</tbody></table>';
  document.getElementById('content').innerHTML=h;
  bindInboxNav();
}

function fmtObj(o){try{return JSON.stringify(o)}catch(e){return String(o)}}
function buildSummary(b){
  if(!b||typeof b!=='object')return '';
  const out=[];
  if(b.version)out.push('v'+b.version+(b.milestone?' '+b.milestone:''));
  if(b.engine&&b.engine.name)out.push(b.engine.name+' '+(b.engine.version||b.engine.build||''));
  if(b.os&&b.os.name)out.push(b.os.name+' '+(b.os.version||''));
  if(b.hw&&b.hw.cpu)out.push(b.hw.cpu);
  if(b.hw&&b.hw.gpu)out.push(b.hw.gpu);
  return out.join(' · ');
}
function renderBug(id){
  if(!hasListPaint())renderBugHome({keepHash:true});
  else {showInboxTools('bugs',listQuery().seg);renderTree(qVal())}
  const bug=allBugs.find(b=>b.id===id);
  const back=lastList.bugs||encodeListHash({route:'bugs'});
  openDrawer();
  drawerBar('<div class="crumb"><a data-nav="'+back+'">上报</a><span>›</span><span class="title">'+esc(bug?bug.title:id)+'</span>'+(bug?statusTag(bug.status,'bug'):'')+'</div>');
  bindDrawerChrome();
  highlightNavRow('#/bug/'+encodeURIComponent(id));
  if(!bug){
    drawerBody('<div class="empty issue-404">无法读取这条。<br><button type="button" class="issue-btn" data-drawer-close>关闭</button></div>');
    return;
  }
  const st=bug.status||'新';
  const desc=String(bug.description||'').trim();
  const shots=bug.shots||[];
  const logs=bug.logs||[];
  const hist=(bug.history&&bug.history.length)?bug.history:[(bug.date?'入库 · '+bug.date:'入库记录缺失')];
  const steps=Array.isArray(bug.steps)?bug.steps:[];
  const build=(bug.build&&typeof bug.build==='object')?bug.build:null;
  const legacyCapture=(bug.legacyCapture===true);
  const dataGapsReason=String(bug.dataGapsReason||'');
  const legacyCaptureInfo=(bug.legacyCaptureInfo&&typeof bug.legacyCaptureInfo==='object')?bug.legacyCaptureInfo:null;
  const worldState=(bug.worldState&&typeof bug.worldState==='object')?bug.worldState:null;
  const repro=bug.reproRate&&typeof bug.reproRate==='object'?bug.reproRate:null;
  const reporter=bug.reporter&&typeof bug.reporter==='object'?bug.reporter:null;
  const caseCtx=bug.caseContext&&typeof bug.caseContext==='object'?bug.caseContext:null;
  const dataGaps=Array.isArray(bug.dataGaps)?bug.dataGaps:[];
  const verification=(bug.verification&&typeof bug.verification==='object')?bug.verification:null;
  let h='<div class="issue" data-folder="'+esc(bug.id)+'" data-bugid="'+esc(bug.bugId||'')+'">';
  h+='<header class="issue-head">';
  h+='<h1 class="issue-title">'+esc(bug.title)+'</h1>';
  h+='<div class="issue-head-row">'+statusTag(st,'bug');
  if(bug.bugId)h+='<code class="issue-id">'+esc(bug.bugId)+'</code><button type="button" class="issue-btn ghost" data-copy-id="'+esc(bug.bugId)+'">复制</button>';
  const acts=svActionsFor('bug',st);
  for(const a of acts)h+='<button type="button" class="issue-btn'+(a.primary?' primary':'')+(a.danger?' sv-danger':'')+'" data-issue-action="'+a.a+'" title="'+esc(svWriteTitle())+'">'+esc(a.label)+'</button>';
  h+='</div>';
  h+=svWriteGateHtml();
  h+='<div class="issue-confirm" hidden><div class="issue-confirm-lab"></div>';
  h+='<input class="issue-reason" type="text" maxlength="200" placeholder="原因（非缺陷必填）/ 主号（重复必填）">';
  h+='<div class="issue-confirm-row"><button type="button" class="issue-btn" data-issue-cancel>取消</button>';
  h+='<button type="button" class="issue-btn primary" data-issue-ok>确认</button></div></div>';
  h+='<div class="sv-inline-error" hidden></div>';
  h+='</header>';
  if(dataGaps.length){
    const gapSec={build:'build',steps:'steps',worldState:'world',caseContext:'case',reproRate:'repro',reporter:'reporter'};
    const legacyGap=(legacyCapture===true)||!build;
    const sum=legacyGap
      ? '<strong>数据缺口 '+dataGaps.length+' 项</strong> · 历史上报（修复前旧采集缺少字段，非当前上报缺陷；点击展开）'
      : '<strong>数据缺口 '+dataGaps.length+' 项</strong> · 建议按缺口补采后再修复（点击展开）';
    h+='<details class="issue-gaps"><summary>'+sum+'</summary>';
    if(legacyGap){
      let note='此包为修复前旧采集上报：当时未采集分支/commit/构建/环境/步骤/世界状态/上报者等字段，dataGaps 反映历史缺字段，不是当前上报链路问题。新上报（master/isoAssets 新代码）会完整采集，正常 dataGaps 应为 0。旧包缺失字段无法精确回填，可人工补录。';
      if(dataGapsReason)note+='<br>数据缺口原因：'+esc(dataGapsReason);
      if(legacyCaptureInfo){
        if(legacyCaptureInfo.sourceWorktree)note+='<br>来源 worktree：'+esc(String(legacyCaptureInfo.sourceWorktree));
        if(Array.isArray(legacyCaptureInfo.missingFields)&&legacyCaptureInfo.missingFields.length)note+='<br>缺失字段：'+esc(legacyCaptureInfo.missingFields.join(', '));
        if(legacyCaptureInfo.capturedAt)note+='<br>采集时点：'+esc(String(legacyCaptureInfo.capturedAt));
        if(legacyCaptureInfo.note&&String(legacyCaptureInfo.note)!==dataGapsReason)note+='<br>'+esc(String(legacyCaptureInfo.note));
      }
      h+='<div class="gap-legacy-note" role="note">'+note+'</div>';
    }
    h+='<ul>';
    for(const g of dataGaps){const jump=gapSec[g];h+='<li>'+(jump?('<a href="#" data-gap-jump="'+jump+'">'+esc(g)+'</a>'):('<code>'+esc(g)+'</code>'))+' <span class="muted">缺失</span></li>';}
    h+='</ul></details>';
  }
  h+='<div class="issue-body">';
  h+='<div class="issue-main">';
  h+='<section class="issue-sec" data-sec="desc"><h2>描述</h2>';
  if(desc)h+='<p>'+esc(desc)+'</p>';
  else h+='<div class="issue-empty"><strong>未填写描述</strong><p>来自 F3 上报，描述栏为空。请看证据与标题。</p></div>';
  h+='</section>';
  if(steps.length){
    h+='<section class="issue-sec" data-sec="steps"><h2>复现步骤</h2><ol class="issue-steps">';
    for(const s of steps){
      const t=(s&&typeof s==='object')?String(s.text||''):String(s);
      if(t)h+='<li>'+esc(t)+'</li>';
    }
    h+='</ol></section>';
  }
  if(build){
    h+='<section class="issue-sec" data-sec="build"><h2>构建 / 环境</h2><dl class="issue-props">';
    if(build.version)h+='<div><dt>版本</dt><dd>'+esc(String(build.version)+(build.milestone?' · '+build.milestone:''))+'</dd></div>';
    if(build.engine)h+='<div><dt>引擎</dt><dd>'+esc([build.engine.name,build.engine.version||build.engine.build].filter(Boolean).join(' '))+'</dd></div>';
    if(build.os)h+='<div><dt>OS</dt><dd>'+esc([build.os.name,build.os.version,build.os.arch].filter(Boolean).join(' '))+'</dd></div>';
    if(build.hw)h+='<div><dt>硬件</dt><dd>'+esc([build.hw.cpu,build.hw.gpu,build.hw.ram_gb?build.hw.ram_gb+'GB':''].filter(Boolean).join(' · '))+'</dd></div>';
    h+='</dl></section>';
  }
  if(worldState){
    h+='<section class="issue-sec" data-sec="world"><h2>世界状态</h2><pre class="issue-raw">'+esc(fmtObj(worldState))+'</pre></section>';
  }
  if(caseCtx&&Object.keys(caseCtx).length){
    h+='<section class="issue-sec" data-sec="case"><h2>E2E Case</h2><details class="issue-case" open><summary>case 详情</summary><pre class="issue-raw">'+esc(fmtObj(caseCtx))+'</pre></details></section>';
  }
  if(verification&&typeof verification==='object'&&Object.keys(verification).length){
    h+='<section class="issue-sec" data-sec="verification"><h2>修复验证</h2><dl class="issue-props">';
    const v=verification;
    if(v.result)h+='<div><dt>结论</dt><dd><code>'+esc(String(v.result))+'</code></dd></div>';
    if(v.commit)h+='<div><dt>修复 commit</dt><dd class="mono">'+esc(String(v.commit))+'</dd></div>';
    if(v.branch)h+='<div><dt>修复分支</dt><dd class="mono">'+esc(String(v.branch))+'</dd></div>';
    if(v.by)h+='<div><dt>验证人</dt><dd>'+esc(String(v.by))+'</dd></div>';
    if(v.closed_reason)h+='<div><dt>关闭理由</dt><dd>'+esc(String(v.closed_reason))+'</dd></div>';
    if(Array.isArray(v.commands)&&v.commands.length)h+='<div><dt>命令</dt><dd class="mono">'+esc(v.commands.join(' · '))+'</dd></div>';
    if(v.e2e&&typeof v.e2e==='object')h+='<div><dt>E2E</dt><dd class="mono">'+esc(fmtObj(v.e2e))+'</dd></div>';
    h+='</dl></section>';
  }
  h+='<section class="issue-sec" data-sec="shots"><h2>证据</h2>';
  if(shots.length){
    h+='<div class="shots">';
    for(const s of shots){
      const src='/bug-file/'+encodeURIComponent(bug.id)+'/'+encodeURIComponent(s);
      h+='<a href="'+src+'" target="_blank" rel="noreferrer"><img src="'+src+'" alt="'+esc(s)+'"></a>';
    }
    h+='</div>';
  }else h+='<div class="issue-empty">无截图</div>';
  h+='</section>';
  h+='<section class="issue-sec" data-sec="logs"><h2>日志</h2>';
  if(logs.length){
    h+='<ul class="issue-logs">';
    for(const lg of logs){
      const href='/bug-file/'+encodeURIComponent(bug.id)+'/'+encodeURIComponent(lg);
      h+='<li><a href="'+href+'" target="_blank" rel="noreferrer">打开 '+esc(lg)+'</a> <a href="'+href+'" download="'+esc(lg)+'">下载</a></li>';
    }
    h+='</ul>';
  }else h+='<div class="issue-empty">无日志副本</div>';
  h+='</section>';
  h+='<section class="issue-sec" data-sec="hist"><h2>时间线</h2><ul class="issue-hist">';
  for(const row of hist)h+='<li>'+esc(row)+'</li>';
  h+='</ul></section>';
  h+='<details class="issue-source"><summary>源文件 Readme.md</summary><pre class="issue-raw">加载中…</pre></details>';
  h+='</div>';
  h+='<aside class="issue-rail"><h2>属性</h2><dl class="issue-props">';
  h+='<div><dt>状态</dt><dd>'+esc(st)+'</dd></div>';
  h+='<div><dt>复现时间</dt><dd>'+esc(bug.recTime||'—')+'</dd></div>';
  h+='<div><dt>目录</dt><dd class="mono">'+esc(bug.folder||bug.id)+'</dd></div>';
  h+='<div><dt>截图</dt><dd>'+shots.length+'</dd></div>';
  h+='<div><dt>日志</dt><dd>'+esc(logs.length?logs.join(', '):'无')+'</dd></div>';
  if(bug.branch)h+='<div><dt>分支</dt><dd class="mono">'+esc(bug.branch)+'</dd></div>';
  if(bug.commitSha)h+='<div><dt>commit</dt><dd class="mono">'+esc(bug.commitSha)+'</dd></div>';
  if(build&&build.version)h+='<div><dt>构建</dt><dd>'+esc(String(build.version))+'</dd></div>';
  if(reporter&&(reporter.name||reporter.source))h+='<div><dt>上报者</dt><dd>'+esc([reporter.name,reporter.source].filter(Boolean).join(' · '))+'</dd></div>';
  if(repro)h+='<div><dt>复现率</dt><dd>'+esc(String(repro.frequency||'unknown')+(repro.attempts?' ×'+repro.attempts:''))+'</dd></div>';
  if(caseCtx&&caseCtx.case_id)h+='<div><dt>E2E case</dt><dd class="mono">'+esc(caseCtx.case_id)+'</dd></div>';
  h+='</dl></aside></div></div>';
  drawerBody(h);
  bindIssue(bug);
}

function bindIssue(bug){
  const root=document.querySelector('.issue');
  if(!root)return;
  const confirm=root.querySelector('.issue-confirm');
  const lab=root.querySelector('.issue-confirm-lab');
  const reason=root.querySelector('.issue-reason');
  const okBtn=root.querySelector('[data-issue-ok]');
  const st=bug.status||'新';
  let pending='';
  function hideConfirm(){if(confirm)confirm.hidden=true;pending='';}
  root.addEventListener('click',(ev)=>{
    const gapJump=ev.target.closest('[data-gap-jump]');
    if(gapJump){
      ev.preventDefault();
      const sec=root.querySelector('.issue-sec[data-sec="'+gapJump.getAttribute('data-gap-jump')+'"]');
      if(sec){sec.scrollIntoView({block:'start',behavior:'smooth'});sec.classList.add('issue-sec-flash');setTimeout(()=>sec.classList.remove('issue-sec-flash'),1200)}
      return;
    }
    const copy=ev.target.closest('[data-copy-id]');
    if(copy){
      const id=copy.getAttribute('data-copy-id')||'';
      const done=()=>showToast('已复制 '+id);
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(id).then(done).catch(()=>showToast('复制失败',true));
      }else showToast('复制失败',true);
      return;
    }
    if(ev.target.closest('[data-sv-write-enable]')){svEnableWrite();return}
    const act=ev.target.closest('[data-issue-action]');
    if(act){
      if(!svWriteUsable()){showToast(svWriteTitle(),true);svInlineError(root,svWriteTitle()+' — '+svWriteNextStep());return}
      pending=act.getAttribute('data-issue-action')||'';
      const meta0=SV_META.bug[pending];if(!meta0)return;const meta=Object.assign({},meta0);if(act.textContent)meta.label=act.textContent.trim();
      const to=svTarget('bug',pending,st);
      if(lab)lab.textContent='确认「'+meta.label+'」 · '+st+' → '+to;
      if(reason){reason.value='';reason.placeholder=meta.requires==='masterId'?'主号（8 位）必填':(meta.requires==='reason'?'原因（必填）':'原因（可选）');reason.focus()}
      if(confirm)confirm.hidden=false;
      return;
    }
    if(ev.target.closest('[data-issue-cancel]')){hideConfirm();return}
    if(ev.target.closest('[data-issue-ok]')){
      if(!pending)return;
      const meta=SV_META.bug[pending]||{};
      const note=reason?reason.value:'';
      if(meta.requires==='reason'&&!String(note).trim()){showToast('非缺陷须填写原因',true);return}
      if(meta.requires==='masterId'&&!String(note).trim()){showToast('重复须填写主号',true);return}
      if(okBtn)okBtn.disabled=true;
      const opts={reason:meta.requires==='masterId'?'':note,masterId:meta.requires==='masterId'?note:''};
      svRun('bug',bug,pending,opts,root).then(()=>{if(okBtn)okBtn.disabled=false});
      hideConfirm();
    }
  });
  const src=root.querySelector('.issue-source');
  const pre=root.querySelector('.issue-raw');
  if(src&&pre){
    src.addEventListener('toggle',()=>{
      if(!src.open||src.dataset.loaded)return;
      fetch('/bug-file/'+encodeURIComponent(bug.id)+'/Readme.md?raw=1').then(r=>{
        if(!r.ok)return fetch('/bug-file/'+encodeURIComponent(bug.id)+'/README.md?raw=1');
        return r;
      }).then(r=>r&&r.ok?r.text():'').then(t=>{
        pre.textContent=t||'无 Readme';
        src.dataset.loaded='1';
      }).catch(()=>{pre.textContent='无法读取 Readme';});
    });
  }
}

function renderDomainHome(opts){
  const keepHash=opts&&opts.keepHash;
  showContent();
  const d=listQuery();
  const cat=d.cat||'';
  syncSearchBox(d.q);
  showInboxTools('domains');
  if(!keepHash)pinListHash('domains','',d.q,cat);
  else lastList.domains=encodeListHash({route:'domains',q:d.q,cat});
  renderTree(qVal());
  const f=(d.q||'').toLowerCase();
  const list=allDomains.filter(x=>matchDomain(x,f)).filter(x=>!cat||x.package===cat);
  const n=visibleCount(list);
  barEl('<div class="crumb"><span class="title">域 '+n+'</span></div>'+crossHintHtml());
  bindBar();
  if(!list.length){
    document.getElementById('content').innerHTML=f
      ?inboxEmpty('没有匹配的域。','','<button type="button" class="inbox-action" data-clear-q>清除搜索</button>')
      :cat
        ?inboxEmpty('这个分类下没有条目。','','<button type="button" class="inbox-action" data-clear-cat>查看全部</button>')
        :inboxEmpty('没有域登记。','在 specs/&lt;pkg&gt;/domains/_index.yml 登记后刷新。');
    bindInboxNav();
    return;
  }
  let h='<table class="inbox-table"><thead><tr><th class="pkg">包</th><th class="id">域</th><th class="ttl">标题</th><th class="num">轨数</th></tr></thead><tbody>';
  for(const x of list){
    const href='#/domain/'+encodeURIComponent(x.package)+'/'+encodeURIComponent(x.id);
    h+='<tr class="inbox-row" tabindex="0" data-nav="'+href+'"><td class="pkg">'+esc(x.package)+'</td><td class="id">'+esc(x.id)+'</td><td class="ttl">'+esc(x.title||x.id)+'</td><td class="num">'+((x.tracks||[]).length)+'</td></tr>';
  }
  h+='</tbody></table>';
  document.getElementById('content').innerHTML=h;
  bindInboxNav();
}

function renderDomain(pkg,id){
  if(!hasListPaint())renderDomainHome({keepHash:true});
  else {showInboxTools('domains');renderTree(qVal())}
  const d=allDomains.find(x=>x.package===pkg&&x.id===id);
  const back=lastList.domains||encodeListHash({route:'domains'});
  openDrawer();
  drawerBar('<div class="crumb"><a data-nav="'+back+'">域</a><span>›</span><span class="title">'+esc(d?d.title:id)+'</span></div>');
  bindDrawerChrome();
  highlightNavRow('#/domain/'+encodeURIComponent(pkg)+'/'+encodeURIComponent(id));
  if(!d){drawerBody('<div class="empty">无法读取这条。<br><button type="button" class="inbox-action" data-drawer-close>关闭</button></div>');return}
  let h='<h1>'+esc(d.title||d.id)+'</h1><div class="fm"><span>'+esc(d.package)+'</span><span>'+esc(d.id)+'</span></div>';
  h+='<p>'+(d.current?'现行信源：<code>'+esc(d.current)+'</code>':'仅登记，无 CURRENT.md（走旧路径，不挡 validate）。')+'</p>';
  if(d.tracks&&d.tracks.length){
    h+='<h2>贡献轨（RFC / 考古）</h2><ul>';
    for(const t of d.tracks)h+='<li><a data-nav="#/pkg/'+esc(d.package)+'/'+esc(t)+'">'+esc(t)+'</a></li>';
    h+='</ul>';
  }
  if(d.gut&&d.gut.length){h+='<h2>GUT glob</h2><ul>';for(const g of d.gut)h+='<li><code>'+esc(g)+'</code></li>';h+='</ul>';}
  if(d.e2e&&d.e2e.length){h+='<h2>E2E id</h2><ul>';for(const e of d.e2e)h+='<li><code>'+esc(e)+'</code></li>';h+='</ul>';}
  if(d.current){
    h+='<h2>CURRENT</h2><p><a data-nav="#/file/'+esc(d.package)+'/domains/'+esc(d.id)+'/CURRENT.md">打开 CURRENT.md</a>';
    h+=' · <a data-nav="#/file/'+esc(d.package)+'/domains/'+esc(d.id)+'/TESTS.md">TESTS.md</a>';
    h+=' · <a data-nav="#/file/'+esc(d.package)+'/domains/'+esc(d.id)+'/VISUAL.md">VISUAL.md</a></p>';
  }
  drawerBody(h);
  bindDrawerBodyNav();
}

function renderSpecHome(opts){
  const keepHash=opts&&opts.keepHash;
  showContent();
  const d=listQuery();
  syncSearchBox(d.q);
  showInboxTools('specs');
  if(!keepHash)pinListHash('specs','',d.q,d.cat);
  else lastList.specs=encodeListHash({route:'specs',q:d.q,cat:d.cat});
  renderTree(qVal());
  const f=(d.q||'').toLowerCase();
  const list=allData.filter(p=>matchPkg(p,f));
  const n=visibleCount(list);
  barEl('<div class="crumb"><span class="title">规格 '+n+'</span></div>'+crossHintHtml());
  bindBar();
  if(!list.length){
    document.getElementById('content').innerHTML=inboxEmpty('无匹配的包。','','<button type="button" class="inbox-action" data-clear-q>清除搜索</button>');
    bindInboxNav();
    return;
  }
  let h='<table class="inbox-table"><thead><tr><th class="pkg">包</th><th class="num">轨</th><th class="fit">齐套</th></tr></thead><tbody>';
  for(const p of list){
    const pkgOk=Object.values(p.packageDocs).filter(Boolean).length;
    h+='<tr class="inbox-row" tabindex="0" data-nav="#/pkg/'+esc(p.name)+'"><td class="pkg">'+esc(p.name)+'</td><td class="num">'+p.tracks.length+'</td><td class="fit">'+pkgOk+'/3</td></tr>';
  }
  h+='</tbody></table>';
  document.getElementById('content').innerHTML=h;
  bindInboxNav();
}

function renderPkg(name){
  if(!hasListPaint())renderSpecHome({keepHash:true});
  else {showInboxTools('specs');renderTree(qVal())}
  const p=allData.find(x=>x.name===name);
  const back=lastList.specs||encodeListHash({route:'specs'});
  openDrawer();
  drawerBar('<div class="crumb"><a data-nav="'+back+'">规格</a><span>›</span><span class="title">'+esc(name)+'</span></div>');
  bindDrawerChrome();
  highlightNavRow('#/pkg/'+esc(name));
  if(!p){drawerBody('<div class="empty">无法读取这条。<br><button type="button" class="inbox-action" data-drawer-close>关闭</button></div>');return}
  const pkgOk=Object.values(p.packageDocs).filter(Boolean).length;
  let h='<h1>'+esc(p.name)+'</h1><div class="fm"><span>包文档: '+pkgOk+'/'+requiredPackageDocs.length+'</span><span>Track: '+p.tracks.length+'</span></div>';
  if(p.description)h+='<p>'+esc(p.description)+'</p>';
  h+='<h2>包级文档</h2><table><tr><th>文档</th><th>状态</th></tr>';
  for(const d of requiredPackageDocs)h+='<tr><td><a data-nav="#/file/'+esc(p.name)+'/'+d+'">'+d+'</a></td><td>'+(p.packageDocs[d]?'✅':'❌')+'</td></tr>';
  h+='</table>';
  for(const t of p.tracks){
    const ok=Object.values(t.docs).filter(Boolean).length;
    h+='<h2><a data-nav="#/pkg/'+esc(p.name)+'/'+esc(t.name)+'">'+esc(t.name)+'</a></h2><div class="fm"><span>'+ok+'/8</span></div>';
  }
  drawerBody(h);
  bindDrawerBodyNav();
}

function renderTrack(pkg,name){
  if(!hasListPaint())renderSpecHome({keepHash:true});
  else {showInboxTools('specs');renderTree(qVal())}
  const p=allData.find(x=>x.name===pkg);const t=p&&p.tracks.find(x=>x.name===name);
  const back=lastList.specs||encodeListHash({route:'specs'});
  openDrawer();
  drawerBar('<div class="crumb"><a data-nav="'+back+'">规格</a><span>›</span><a data-nav="#/pkg/'+esc(pkg)+'">'+esc(pkg)+'</a><span>›</span><span class="title">'+esc(name)+'</span></div>');
  bindDrawerChrome();
  if(!t){drawerBody('<div class="empty">无法读取这条。<br><button type="button" class="inbox-action" data-drawer-close>关闭</button></div>');return}
  const ok=Object.values(t.docs).filter(Boolean).length;
  let h='<h1>'+esc(t.name)+'</h1><div class="fm"><span>'+esc(p.name)+'</span><span>'+ok+'/8</span></div><table><tr><th>文档</th><th>状态</th></tr>';
  for(const d of requiredTrackDocs)h+='<tr><td><a data-nav="#/file/'+esc(p.name)+'/'+esc(t.name)+'/'+d+'">'+d+'</a></td><td>'+(t.docs[d]?'✅':'❌')+'</td></tr>';
  h+='</table>';
  drawerBody(h);
  bindDrawerBodyNav();
}

function renderSpecFile(rel){
  if(!hasListPaint())renderSpecHome({keepHash:true});
  else {showInboxTools('specs');renderTree(qVal())}
  const parts=rel.split('/');
  const back=lastList.specs||encodeListHash({route:'specs'});
  let bc='<a data-nav="'+back+'">规格</a>';
  if(parts[0])bc+='<span>›</span><a data-nav="#/pkg/'+esc(parts[0])+'">'+esc(parts[0])+'</a>';
  if(parts[1]&&parts[2])bc+='<span>›</span><a data-nav="#/pkg/'+esc(parts[0])+'/'+esc(parts[1])+'">'+esc(parts[1])+'</a>';
  bc+='<span>›</span><span class="title">'+esc(parts[parts.length-1])+'</span>';
  openDrawer();
  drawerBar('<div class="crumb">'+bc+'</div>');
  bindDrawerChrome();
  drawerBody('<div class="inbox-skel"><span class="bone"></span></div>');
  fetch('/file/'+rel.split('/').map(encodeURIComponent).join('/')).then(r=>r.text()).then(html=>{
    drawerBody(html);
    const content=document.getElementById('drawer-body');
    mountDiffStrip('/file/'+rel, content);
    bindDrawerBodyNav();
  }).catch(()=>{drawerBody('<div class="empty">无法读取这条。<br><button type="button" class="inbox-action" data-drawer-close>关闭</button></div>')});
}

function bindBar(){
  document.getElementById('bar').onclick=function(ev){
    const ext=ev.target.closest('[data-ext]');
    if(ext){ev.preventDefault();window.open(ext.getAttribute('data-ext'),'_blank');return}
    const a=ev.target.closest('[data-nav]');
    if(a){ev.preventDefault();go(a.getAttribute('data-nav'))}
  };
}
function bindDrawerChrome(){
  const bar=document.getElementById('drawer-bar');
  if(!bar)return;
  bar.onclick=function(ev){
    if(ev.target.closest('[data-drawer-close]')){ev.preventDefault();closeDrawerNav();return}
    const ext=ev.target.closest('[data-ext]');
    if(ext){ev.preventDefault();window.open(ext.getAttribute('data-ext'),'_blank');return}
    const a=ev.target.closest('[data-nav]');
    if(a){ev.preventDefault();go(a.getAttribute('data-nav'))}
  };
}
function bindDrawerBodyNav(){
  const body=document.getElementById('drawer-body');
  if(!body)return;
  body.onclick=function(ev){
    if(ev.target.closest('[data-drawer-close]')){ev.preventDefault();closeDrawerNav();return}
    const a=ev.target.closest('[data-nav]');
    if(!a)return;
    ev.preventDefault();
    go(a.getAttribute('data-nav'));
  };
}
function bindContentNav(){
  document.getElementById('content').onclick=function(ev){
    const a=ev.target.closest('[data-nav]');
    if(!a)return;
    ev.preventDefault();
    go(a.getAttribute('data-nav'));
  };
}

function fileRelFromNav(path){
  if(!path||!path.startsWith('#/file/'))return null;
  return decodeURIComponent(path.slice(7));
}
function colorDiff(unified){
  return esc(unified).split('\n').map(line=>{
    if(line.startsWith('+++')||line.startsWith('---'))return '<span class="meta">'+line+'</span>';
    if(line.startsWith('@@'))return '<span class="hunk">'+line+'</span>';
    if(line.startsWith('+'))return '<span class="add">'+line+'</span>';
    if(line.startsWith('-'))return '<span class="del">'+line+'</span>';
    return line;
  }).join('\n');
}
function mountDiffStrip(navPath, contentEl){
  const rel=fileRelFromNav(currentPath)||(navPath&&navPath.startsWith('/file/')?decodeURIComponent(navPath.slice(6)):null);
  if(!rel||!contentEl)return;
  api('/api/diff?path='+encodeURIComponent(rel)).then(d=>{
    if(!d||d.error)return;
    const hasDiff=!!(d.baseline&&d.unified);
    const inRing=!!changeSignals[rel]||!!d.seen;
    if(!hasDiff&&!inRing)return;
    const strip=document.createElement('details');
    strip.className='diff-strip';
    strip.open=hasDiff;
    const when=d.ts?ago(d.ts):'';
    const meta=hasDiff?(when?when+' · 快照':'快照'):'无基线';
    const body=hasDiff
      ?'<div class="ds-body"><pre class="diff"><code>'+colorDiff(d.unified)+'</code></pre></div>'
      :'<div class="ds-body"><div class="ds-empty">无基线快照 — 进程启动后首次变更前无法计算 diff。</div></div>';
    strip.innerHTML='<summary><span class="ds-label">变更</span><span class="ds-meta">'+esc(rel)+' · '+esc(meta)+'</span></summary>'+body;
    contentEl.insertBefore(strip, contentEl.firstChild);
  }).catch(()=>{});
}

bindTree();
document.getElementById('q').oninput=function(){
  const qv=this.value;
  // UI kit gallery owns its own composable filter: soft-refilter the grid only
  // (a full renderRoute() here would blow away the focused input on every keystroke)
  if(String(location.hash||'').startsWith('#/uikit')){
    uikitSel=Object.assign({},uikitSel,{q:String(qv||'').trim().toLowerCase()});
    uiKitSoftFilter();
    syncUiKitHash(true);
    updateBadges();
    return;
  }
  if(isDrawerRoute(location.hash)){
    const saved=decodeListHash(lastList[mode]||'');
    lastList[mode]=encodeListHash({route:listRoute(mode),seg:saved.seg,q:qv,cat:saved.cat});
    if(mode==='bugs')renderBugHome({keepHash:true});
    else if(mode==='briefs')renderBriefHome({keepHash:true});
    else if(mode==='domains')renderDomainHome({keepHash:true});
    else if(mode==='specs')renderSpecHome({keepHash:true});
    else if(mode==='data')renderDataHome({keepHash:true});
    updateBadges();
    return;
  }
  const d=parseHash();
  if(d.route==='data'){
    const dh=parseDataHash();
    const next=dataHash({seg:dh.seg,file:dh.file,q:qv,col:dh.col,id:dh.id});
    if(location.hash!==next)history.replaceState(null,'',next);
    updateBadges();
    renderRoute();
    return;
  }
  if(['bugs','briefs','specs','domains'].includes(d.route)){
    const next=encodeListHash({route:d.route,seg:d.seg,q:qv,cat:d.cat});
    if(location.hash!==next)history.replaceState(null,'',next);
  }
  updateBadges();
  renderRoute();
};
const segsEl=document.getElementById('segs');
if(segsEl){
  segsEl.onclick=function(ev){
    const b=ev.target.closest('[data-seg]');
    if(!b)return;
    const d=listQuery();
    if(mode==='data'){
      const dh=parseDataHash();
      go(dataHash({seg:b.getAttribute('data-seg'),file:dh.file,q:dh.q,col:dh.col}));
      return;
    }
    const next=encodeListHash({route:d.route,seg:b.getAttribute('data-seg'),q:d.q,cat:d.cat});
    if(isDrawerRoute(location.hash)){
      lastList[mode]=next;
      if(mode==='bugs')renderBugHome({keepHash:true});
      else if(mode==='briefs')renderBriefHome({keepHash:true});
      return;
    }
    go(next);
  };
}
document.querySelectorAll(APP_SEL).forEach(btn=>{
  btn.onclick=()=>setMode(btn.dataset.mode,true);
});
document.getElementById('toggleSide').onclick=()=>{
  document.body.classList.toggle('side-collapsed');
  document.body.classList.remove('facet-open');
  try{sessionStorage.setItem(SIDE_KEY,document.body.classList.contains('side-collapsed')?'1':'0')}catch(e){}
  syncSideToggle();
};
const facetToggle=document.getElementById('facetToggle');
if(facetToggle){
  facetToggle.onclick=()=>{
    document.body.classList.toggle('facet-open');
    if(document.body.classList.contains('facet-open'))document.body.classList.remove('side-collapsed');
    syncSideToggle();
  };
}
const sideToggle=document.getElementById('sideToggle');
if(sideToggle){
  sideToggle.onclick=()=>{
    document.body.classList.remove('side-collapsed');
    try{sessionStorage.setItem(SIDE_KEY,'0')}catch(e){}
    syncSideToggle();
    renderTree(qVal());
  };
}
const drawerMask=document.getElementById('drawer-mask');
if(drawerMask)drawerMask.onclick=()=>closeDrawerNav();
const THEME_KEY='sv-theme';
function applyTheme(t){
  const next=t==='dark'?'dark':'light';
  document.documentElement.setAttribute('data-theme',next);
  document.documentElement.style.colorScheme=next;
  try{localStorage.setItem(THEME_KEY,next)}catch(e){}
  const b=document.getElementById('toggleTheme');
  if(b){
    const label=next==='dark'?'浅色主题':'深色主题';
    b.title=label;b.setAttribute('aria-label',label);
  }
}
const themeBtn=document.getElementById('toggleTheme');
if(themeBtn){
  themeBtn.onclick=()=>{
    const cur=document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';
    applyTheme(cur==='dark'?'light':'dark');
  };
  applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light');
}
window.addEventListener('hashchange',renderRoute);
window.addEventListener('keydown',(ev)=>{
  const inField=ev.target&&(ev.target.tagName==='INPUT'||ev.target.tagName==='TEXTAREA'||ev.target.isContentEditable);
  if((ev.key==='s'||ev.key==='S')&&(ev.ctrlKey||ev.metaKey)&&dataMeta){
    ev.preventDefault();
    if(mode==='data')saveDataEntry();
    return;
  }
  if((ev.key==='k'||ev.key==='K')&&(ev.ctrlKey||ev.metaKey)){
    ev.preventDefault();
    openPulsePalette();
    return;
  }
  if(ev.key==='Escape'){
    if(hidePulseZoom()){ev.preventDefault();return}
    if(closePulsePalette()){ev.preventDefault();return}
    if(inField&&ev.target.id==='q'){
      ev.preventDefault();
      if(ev.target.value){ev.target.value='';ev.target.dispatchEvent(new Event('input',{bubbles:true}));}
      else ev.target.blur();
      return;
    }
    if(document.body.classList.contains('drawer-open')){
      ev.preventDefault();
      closeDrawerNav();
      return;
    }
    if(document.body.classList.contains('facet-open')){
      ev.preventDefault();
      document.body.classList.remove('facet-open');
      return;
    }
  }
  if(ev.key==='['&&!ev.ctrlKey&&!ev.metaKey&&!inField){
    const st=document.getElementById('sideToggle');
    if(st&&!st.hidden&&document.body.classList.contains('side-collapsed'))st.click();
    else document.getElementById('toggleSide').click();
    return;
  }
  if(ev.key==='/'&&!ev.ctrlKey&&!ev.metaKey&&!inField){
    ev.preventDefault();
    const q=document.getElementById('q');
    const tools=document.getElementById('inbox-tools');
    if(tools)tools.hidden=false;
    if(q){q.focus();q.select()}
    return;
  }
});

function defaultPulseRange(){
  const t=new Date();
  const pad=n=>String(n).padStart(2,'0');
  const today=t.getFullYear()+'-'+pad(t.getMonth()+1)+'-'+pad(t.getDate());
  const fromD=new Date(t.getFullYear(),t.getMonth(),t.getDate()-29);
  const from=fromD.getFullYear()+'-'+pad(fromD.getMonth()+1)+'-'+pad(fromD.getDate());
  return {chip:'30d',from,to:today,bucket:'auto'};
}
function loadPulseRange(){
  try{
    const raw=sessionStorage.getItem(PULSE_RANGE_KEY);
    if(raw){
      const o=JSON.parse(raw);
      if(o&&o.from&&o.to){pulseRange={chip:o.chip||'custom',from:o.from,to:o.to,bucket:o.bucket||'auto'};return}
    }
  }catch(e){}
  pulseRange=defaultPulseRange();
}
function savePulseRange(){
  try{sessionStorage.setItem(PULSE_RANGE_KEY,JSON.stringify(pulseRange))}catch(e){}
}
function pulseQueryString(){
  const p=new URLSearchParams();
  if(pulseRange.chip&&pulseRange.chip!=='custom')p.set('window',pulseRange.chip);
  else{p.set('from',pulseRange.from);p.set('to',pulseRange.to)}
  if(pulseRange.bucket)p.set('bucket',pulseRange.bucket);
  return p.toString();
}
function showToast(msg,err){
  let el=document.getElementById('sv-toast');
  if(!el){el=document.createElement('div');el.id='sv-toast';document.body.appendChild(el)}
  el.textContent=msg;el.hidden=false;el.classList.toggle('err',!!err);
  clearTimeout(el._t);
  el._t=setTimeout(()=>{el.hidden=true},3200);
}
function spanDaysLocal(from,to){
  const a=new Date(from+'T00:00:00');const b=new Date(to+'T00:00:00');
  return Math.round((b-a)/86400000)+1;
}
function applyPulseWindow(next){
  const o=Object.assign({},pulseRange,next);
  if(o.chip&&o.chip!=='custom'){
    pulsePrevRange=Object.assign({},pulseRange);
    pulseRange=o;
    savePulseRange();
    loadPulseData();
    return true;
  }
  if(o.from&&o.to&&o.from>o.to){const t=o.from;o.from=o.to;o.to=t}
  const today=defaultPulseRange().to;
  if(o.to>today)o.to=today;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(o.from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(o.to||'')){
    showToast('日期无效');return false;
  }
  if(spanDaysLocal(o.from,o.to)>730){
    showToast('最长 2 年');return false;
  }
  pulsePrevRange=Object.assign({},pulseRange);
  pulseRange=o;
  savePulseRange();
  loadPulseData();
  return true;
}

function pulseChipMatch(){
  const d=defaultPulseRange();
  const today=d.to;
  const days=spanDaysLocal(pulseRange.from,pulseRange.to);
  if(pulseRange.to!==today)return 'custom';
  if(pulseRange.from===d.from&&days===30)return '30d';
  const ytd=today.slice(0,4)+'-01-01';
  if(pulseRange.from===ytd)return 'ytd';
  if(days===7)return '7d';
  if(days===90)return '90d';
  return pulseRange.chip||'custom';
}

function loadPulseData(){
  hidePulseTip();
  hidePulseZoom();
  pulseLoading=true;
  const q=pulseQueryString();
  Promise.all([api('/api/pulse'),api('/api/pulse/trends?'+q)]).then(([k,t])=>{
    pulseLoading=false;
    if(t&&t.ok===false){
      showToast(t.error==='too_long'?'最长 2 年':'日期无效');
      return;
    }
    if(k&&k.ok)pulseKpis=k;
    if(t&&t.from){
      pulseTrends=t;
      pulseRange.from=t.from;pulseRange.to=t.to;
      savePulseRange();
      if(!trendsHasCodeRhythm(t)&&pulseWallRetry<10){
        pulseWallRetry++;
        setTimeout(()=>{if(mode==='pulse')loadPulseData()},1500);
      }else{
        pulseWallRetry=0;
      }
    }
    if(mode==='pulse')renderPulse();
  }).catch(()=>{pulseLoading=false;if(mode==='pulse')renderPulse()});
}

const PIE_COLORS=['var(--accent)','var(--green)','var(--amber)','var(--red)','var(--fg2)','var(--yellow)','var(--fg3)'];
const STACK_KEYS=['feat','fix','test','docs','other'];
const STACK_COLORS=['var(--accent)','var(--red)','var(--green)','var(--amber)','var(--fg2)'];
const RUN_KEYS=['passed','failed'];
const RUN_COLORS=['var(--green)','var(--red)'];
const SERIES_NAME={commits:'提交',plus:'新增行',minus:'删除行',briefs:'简报',feat:'feat',fix:'fix',test:'test',docs:'docs',other:'其它',passed:'通过步',failed:'失败步',added:'新增',gutAdded:'GUT 文件+',gutDeleted:'GUT 文件−',e2eAdded:'E2E JSON+',e2eDeleted:'E2E JSON−',n:'变更量'};
const CASE_KEYS=['gutAdded','e2eAdded'];
const CASE_COLORS=['var(--green)','var(--accent)'];
const SLICE_UNIT={briefs:'份',tracks:'条',domains:'个',bugs:'个',business:'文件',json:'文件',tests:'文件',game:'文件',cases:'个 E2E JSON',lessons:'篇',specs:'文件',toolchain:'文件'};
function sliceUnit(kind){return SLICE_UNIT[kind]||'个'}
function seriesName(k){return SERIES_NAME[k]||k}
function pieSharePct(count,total){
  const n=Number(count)||0,t=Number(total)||0;
  if(!(t>0)||n<=0)return 0;
  return Math.round((n/t)*1000)/10;
}
function normalizePulseTipRow(row){
  const r=Array.isArray(row)?row:[];
  if(r.length>=3){
    return {key:r[0]==null||r[0]===''?null:r[0],label:r[1]==null?'':r[1],value:r[2]};
  }
  return {key:null,label:r[0]==null?'':r[0],value:r[1]};
}
function hidePulseTip(){
  const tip=document.getElementById('pulse-tip');
  if(!tip)return;
  tip.hidden=true;
  tip.innerHTML='';
}
function ensurePulseTip(){
  let tip=document.getElementById('pulse-tip');
  if(tip)return tip;
  tip=document.createElement('div');
  tip.id='pulse-tip';
  tip.hidden=true;
  tip.setAttribute('role','tooltip');
  document.body.appendChild(tip);
  return tip;
}
function clampPulseTip(tip,ev){
  const pad=8,off=12;
  const r=tip.getBoundingClientRect();
  let x=ev.clientX+off,y=ev.clientY+off;
  if(x+r.width>window.innerWidth-pad)x=ev.clientX-r.width-off;
  if(y+r.height>window.innerHeight-pad)y=ev.clientY-r.height-off;
  if(x<pad)x=pad;
  if(y<pad)y=pad;
  tip.style.left=x+'px';
  tip.style.top=y+'px';
}
function pulseSwatch(color){
  return '<i class="pulse-swatch" style="background:'+esc(color)+'"></i>';
}
function pulseTipHtml(el){
  const kind=el.getAttribute('data-tip-kind')||'bar';
  const rows=[];
  let title=el.getAttribute('data-day')||el.getAttribute('data-label')||'';
  const colorByKey={};
  if(kind==='bar'||kind==='volume'){
    const metric=el.getAttribute('data-metric')||'';
    const val=el.getAttribute('data-value')||'0';
    const plus=el.getAttribute('data-plus');
    const minus=el.getAttribute('data-minus');
    const plusLabel=el.getAttribute('data-plus-label')||'';
    const minusLabel=el.getAttribute('data-minus-label')||'';
    if(plusLabel||minusLabel){
      if(metric&&metric!==plusLabel)rows.push([metric,val]);
      if(plusLabel&&plus!=null&&plus!=='')rows.push([plusLabel,plus]);
      if(minusLabel&&minus!=null&&minus!=='')rows.push([minusLabel,minus]);
    }else if(metric){
      rows.push([metric,val]);
    }
  }else if(kind==='stack'){
    title=el.getAttribute('data-day')||title;
    const raw=el.getAttribute('data-stack')||'{}';
    let obj={};
    try{obj=JSON.parse(raw)}catch(e){obj={}}
    let colors=[];
    try{colors=JSON.parse(el.getAttribute('data-colors')||'[]')}catch(e){colors=[]}
    const keys=Object.keys(obj);
    let sum=0;
    keys.forEach((k,i)=>{
      rows.push([k,seriesName(k),obj[k]]);
      colorByKey[k]=colors[i]||'';
      sum+=Number(obj[k])||0;
    });
    rows.push([null,'合计',sum]);
  }else if(kind==='dot'){
    rows.push([null,seriesName(el.getAttribute('data-series')),el.getAttribute('data-value')||'0']);
  }else if(kind==='seg'){
    title=(el.getAttribute('data-from')||'')+' → '+(el.getAttribute('data-to')||'');
    rows.push([null,seriesName(el.getAttribute('data-series')),'']);
    rows.push([null,'起点',el.getAttribute('data-v0')||'0']);
    rows.push([null,'终点',el.getAttribute('data-v1')||'0']);
    rows.push([null,'Δ',el.getAttribute('data-delta')||'0']);
  }else if(kind==='slice'){
    title=el.getAttribute('data-name')||title;
    const unit=el.getAttribute('data-unit')||sliceUnit(el.getAttribute('data-pie-kind'));
    rows.push([null,unit,el.getAttribute('data-count')||'0']);
    rows.push([null,'占比',(el.getAttribute('data-pct')||'0')+'%']);
  }
  let html='<div class="pulse-tip-title">'+esc(title)+'</div>';
  for(const row of rows){
    const parts=normalizePulseTipRow(row);
    const key=parts.key;
    const lab=parts.label;
    const val=parts.value;
    const sw=key&&colorByKey[key]?pulseSwatch(colorByKey[key]):'';
    if(lab&&(val===''||val==null))html+='<div class="pulse-tip-row"><span>'+sw+esc(String(lab))+'</span><span></span></div>';
    else html+='<div class="pulse-tip-row"><span>'+sw+esc(String(lab))+'</span><b>'+esc(String(val==null?'':val))+'</b></div>';
  }
  return html;
}
function showPulseTip(el,ev){
  const tip=ensurePulseTip();
  tip.innerHTML=pulseTipHtml(el);
  tip.hidden=false;
  clampPulseTip(tip,ev);
}
function bindPulseTip(root){
  ensurePulseTip();
  hidePulseTip();
  root.addEventListener('pointermove',(ev)=>{
    const el=ev.target.closest&&ev.target.closest('.pulse-bar,.pulse-dot,.pulse-seg,.pulse-slice');
    if(!el||!root.contains(el)){hidePulseTip();return}
    showPulseTip(el,ev);
  });
  root.addEventListener('pointerleave',()=>hidePulseTip());
}

function svgBars(rows,valKey,opts){
  const w=opts&&opts.w||560,h=opts&&opts.h||140;
  const padL=36,padR=10,padT=18,padB=24;
  const vals=rows.map(r=>Number(r[valKey])||0);
  const max=Math.max(1,...vals);
  const n=Math.max(1,rows.length);
  const iw=w-padL-padR,ih=h-padT-padB;
  const gap=iw/n;
  const bw=Math.max(1,gap*0.72);
  const metric=opts&&opts.metric?opts.metric:seriesName(valKey);
  const drawLab=opts&&opts.forceLabels?true:null;
  let bars='';
  rows.forEach((r,i)=>{
    const v=vals[i];
    const bh=ih*(v/max);
    const x=padL+i*gap+(gap-bw)/2;
    const y=padT+ih-bh;
    const hi=pulseHighlightDay===r.day?' pulse-hi':'';
    const hitH=Math.max(v?bh:8,bh);
    const hitY=padT+ih-hitH;
    const label=r.day||r.key||'';
    const plus=r.plus!=null?r.plus:'';
    const minus=r.minus!=null?r.minus:'';
    const plusLab=opts&&opts.plusLabel?esc(opts.plusLabel):'';
    const minusLab=opts&&opts.minusLabel?esc(opts.minusLabel):'';
    const aria=esc(label+' '+metric+' '+v);
    const tipKind=opts&&opts.volume?'volume':'bar';
    bars+='<rect class="pulse-bar'+(v?hi:' pulse-bar-zero'+hi)+'" data-tip-kind="'+tipKind+'" data-day="'+esc(r.day||'')+'" data-label="'+esc(label)+'" data-metric="'+esc(metric)+'" data-value="'+v+'" data-plus="'+plus+'" data-minus="'+minus+'" data-plus-label="'+plusLab+'" data-minus-label="'+minusLab+'" aria-label="'+aria+'" x="'+x+'" y="'+hitY+'" width="'+bw+'" height="'+hitH+'"/>';
    if(v>0){
      bars+='<rect class="pulse-bar-fill" pointer-events="none" x="'+x+'" y="'+y+'" width="'+bw+'" height="'+Math.max(1,bh)+'"/>';
    }
    const cssW=bw;
    const show=drawLab!=null?drawLab&&v>0:(n<=31&&cssW>=12&&v>0);
    if(show){
      bars+='<text class="pulse-bar-label" pointer-events="none" x="'+(x+bw/2)+'" y="'+(y-2)+'" text-anchor="middle">'+v+'</text>';
    }
  });
  const ticks=[0,Math.floor((n-1)/2),n-1].filter((v,i,a)=>a.indexOf(v)===i&&rows[v]);
  let lab='';
  for(const i of ticks){
    const x=padL+i*gap+gap/2;
    lab+='<text class="pulse-tick" x="'+x+'" y="'+(h-6)+'" text-anchor="middle">'+esc(rows[i].day||rows[i].key||'')+'</text>';
  }
  lab+='<text class="pulse-tick" x="4" y="'+(padT+8)+'">'+max+'</text>';
  lab+='<text class="pulse-tick" x="4" y="'+(padT+ih)+'">0</text>';
  return '<svg class="pulse-svg pulse-anim" data-chart="'+(opts&&opts.chart||'bars')+'" viewBox="0 0 '+w+' '+h+'" role="img"><line class="pulse-axis" x1="'+padL+'" y1="'+(padT+ih)+'" x2="'+(w-padR)+'" y2="'+(padT+ih)+'"/>'+lab+bars+'</svg>';
}
function svgStackedBars(rows,keys,colors,opts){
  const w=opts&&opts.w||560,h=opts&&opts.h||140;
  const padL=36,padR=10,padT=18,padB=24;
  const n=Math.max(1,rows.length);
  const iw=w-padL-padR,ih=h-padT-padB;
  const gap=iw/n;
  const bw=Math.max(1,gap*0.72);
  let max=1;
  for(const r of rows){
    let s=0;for(const k of keys)s+=Number(r[k])||0;
    max=Math.max(max,s);
  }
  let bars='';
  rows.forEach((r,i)=>{
    const x=padL+i*gap+(gap-bw)/2;
    let y=padT+ih;
    const stack={};
    let sum=0;
    keys.forEach((k,ki)=>{
      const v=Number(r[k])||0;
      stack[k]=v;sum+=v;
      const bh=ih*(v/max);
      y-=bh;
      if(v>0)bars+='<rect class="pulse-stack-seg" pointer-events="none" x="'+x+'" y="'+y+'" width="'+bw+'" height="'+Math.max(1,bh)+'" fill="'+colors[ki%colors.length]+'"/>';
    });
    const hitH=Math.max(sum?ih*(sum/max):8,8);
    const payload=esc(JSON.stringify(stack));
    bars+='<rect class="pulse-bar" data-tip-kind="stack" data-day="'+esc(r.day)+'" data-stack="'+payload+'" data-colors="'+esc(JSON.stringify(colors))+'" data-value="'+sum+'" aria-label="'+esc((r.day||'')+' 合计 '+sum)+'" x="'+x+'" y="'+(padT+ih-hitH)+'" width="'+bw+'" height="'+hitH+'"/>';
    if(n<=31&&bw>=12&&sum>0){
      bars+='<text class="pulse-bar-label" pointer-events="none" x="'+(x+bw/2)+'" y="'+(padT+ih-hitH-2)+'" text-anchor="middle">'+sum+'</text>';
    }
  });
  const ticks=[0,Math.floor((n-1)/2),n-1].filter((v,i,a)=>a.indexOf(v)===i&&rows[v]);
  let lab='';
  for(const i of ticks){
    const x=padL+i*gap+gap/2;
    lab+='<text class="pulse-tick" x="'+x+'" y="'+(h-6)+'" text-anchor="middle">'+esc(rows[i].day)+'</text>';
  }
  return '<svg class="pulse-svg pulse-anim" data-chart="'+(opts&&opts.chart||'stack')+'" viewBox="0 0 '+w+' '+h+'" role="img"><line class="pulse-axis" x1="'+padL+'" y1="'+(padT+ih)+'" x2="'+(w-padR)+'" y2="'+(padT+ih)+'"/>'+lab+bars+'</svg>';
}
function svgLine(rows,keys,opts){
  const w=opts&&opts.w||560,h=opts&&opts.h||140;
  const padL=36,padR=72,padT=12,padB=24;
  const iw=w-padL-padR,ih=h-padT-padB;
  const n=Math.max(1,rows.length);
  let max=1;
  for(const r of rows)for(const k of keys)max=Math.max(max,Number(r[k])||0);
  function xy(i,v){return [padL+(n===1?iw/2:i*(iw/Math.max(1,n-1))),padT+ih-(ih*((Number(v)||0)/max))]}
  const colors=['var(--accent)','var(--green)','var(--amber)'];
  let paths='';
  keys.forEach((k,ki)=>{
    const col=colors[ki%colors.length];
    for(let i=0;i<rows.length-1;i++){
      const a=xy(i,rows[i][k]),b=xy(i+1,rows[i+1][k]);
      const v0=Number(rows[i][k])||0,v1=Number(rows[i+1][k])||0;
      const delta=v1-v0;
      paths+='<line class="pulse-seg" data-tip-kind="seg" data-series="'+esc(k)+'" data-from="'+esc(rows[i].day)+'" data-to="'+esc(rows[i+1].day)+'" data-v0="'+v0+'" data-v1="'+v1+'" data-delta="'+delta+'" aria-label="'+esc(seriesName(k)+' '+rows[i].day+' → '+rows[i+1].day+' Δ '+delta)+'" x1="'+a[0]+'" y1="'+a[1]+'" x2="'+b[0]+'" y2="'+b[1]+'" stroke="transparent" stroke-width="12"/>';
    }
    const pts=rows.map((r,i)=>xy(i,r[k]).join(',')).join(' ');
    paths+='<polyline class="pulse-line" data-series="'+esc(k)+'" fill="none" stroke="'+col+'" stroke-width="2" pointer-events="none" points="'+pts+'"/>';
    rows.forEach((r,i)=>{
      const [cx,cy]=xy(i,r[k]);
      const v=Number(r[k])||0;
      paths+='<circle class="pulse-dot" data-tip-kind="dot" data-day="'+esc(r.day)+'" data-series="'+esc(k)+'" data-value="'+v+'" aria-label="'+esc(r.day+' '+seriesName(k)+' '+v)+'" cx="'+cx+'" cy="'+cy+'" r="4" fill="'+col+'"/>';
    });
    if(rows.length){
      const last=rows[rows.length-1];
      const [lx,ly]=xy(rows.length-1,last[k]);
      if(ki<3){
        paths+='<text class="pulse-end-lab" pointer-events="none" x="'+(lx+6)+'" y="'+(ly+3)+'">'+esc(seriesName(k)+' '+(Number(last[k])||0))+'</text>';
      }
    }
  });
  const ticks=[0,Math.floor((n-1)/2),n-1].filter((v,i,a)=>a.indexOf(v)===i&&rows[v]);
  let lab='';
  for(const i of ticks){
    const x=xy(i,0)[0];
    lab+='<text class="pulse-tick" x="'+x+'" y="'+(h-6)+'" text-anchor="middle">'+esc(rows[i].day)+'</text>';
  }
  lab+='<text class="pulse-tick" x="4" y="'+(padT+8)+'">'+max+'</text>';
  return '<svg class="pulse-svg pulse-anim" data-chart="'+(opts&&opts.chart||'line')+'" viewBox="0 0 '+w+' '+h+'" role="img"><line class="pulse-axis" x1="'+padL+'" y1="'+(padT+ih)+'" x2="'+(w-padR)+'" y2="'+(padT+ih)+'"/>'+lab+paths+'</svg>';
}
function svgVolume(rows,opts){
  const n=(rows||[]).length;
  const mapped=rows.map(r=>({day:r.key,key:r.key,commits:Number(r.n)||0}));
  const side=n>24;
  return svgBars(mapped,'commits',{chart:'volume',volume:true,metric:'变更量',w:opts&&opts.w,h:opts&&opts.h||84,forceLabels:!side});
}
function svgPie(slices,kind){
  const total=(slices||[]).reduce((s,x)=>s+(Number(x.count)||0),0);
  if(!total)return '<div class="pulse-empty" data-chart="'+esc(kind)+'-pie">无数据</div>';
  const r=34,cx=48,cy=48,c=2*Math.PI*r;
  let off=0,rings='';
  slices.forEach((s,i)=>{
    const count=Number(s.count)||0;
    const pct=pieSharePct(count,total);
    const len=c*(count/total);
    const name=s.label||s.key;
    rings+='<circle class="pulse-slice" data-tip-kind="slice" data-pie-kind="'+esc(kind)+'" data-pie-key="'+esc(s.key)+'" data-name="'+esc(name)+'" data-count="'+count+'" data-pct="'+pct+'" data-unit="'+esc(sliceUnit(kind))+'" aria-label="'+esc(name+' '+count+' '+sliceUnit(kind)+' '+pct+'%')+'" cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+PIE_COLORS[i%PIE_COLORS.length]+'" stroke-width="14" stroke-dasharray="'+len+' '+(c-len)+'" stroke-dashoffset="'+(-off)+'" transform="rotate(-90 '+cx+' '+cy+')"/>';
    off+=len;
  });
  const legend=slices.map(s=>{
    const count=Number(s.count)||0;
    const pct=pieSharePct(count,total);
    return '<div class="pulse-leg"><span class="pulse-leg-name">'+esc(s.label||s.key||'')+'</span><span class="pulse-leg-n">'+count+'</span><span class="pulse-leg-pct">'+pct+'%</span></div>';
  }).join('');
  return '<div class="pulse-pie-wrap pulse-anim"><svg class="pulse-pie" data-chart="'+esc(kind)+'-pie" viewBox="0 0 96 96" role="img">'+rings+'</svg><div class="pulse-legend">'+legend+'</div></div>';
}
function stackLegendHtml(keys,colors){
  let html='<div class="pulse-stack-legend">';
  (keys||[]).forEach((k,i)=>{
    html+='<span class="pulse-leg-item">'+pulseSwatch(colors[i%colors.length])+esc(seriesName(k))+'</span>';
  });
  return html+'</div>';
}
function pulseFig(caption,body,spec){
  spec=spec||{};
  const total=spec.totalHtml?'<span class="pulse-total">'+spec.totalHtml+'</span>':'';
  const btn=spec.zoom?'<button type="button" class="pulse-zoom-btn" aria-label="放大查看详细数据">放大</button>':'';
  const extra=spec.cls?' '+spec.cls:'';
  const id=spec.id?' id="'+esc(spec.id)+'"':'';
  const zoom=spec.zoom?' data-zoom="'+esc(JSON.stringify(spec.zoom))+'"':'';
  const legend=spec.legendHtml||'';
  const cap=spec.capHtml?'<p class="pulse-cap">'+spec.capHtml+'</p>':'';
  return '<figure class="pulse-fig'+extra+'"'+id+zoom+'><figcaption><span class="pulse-fig-title">'+caption+'</span>'+total+btn+'</figcaption>'+legend+body+cap+'</figure>';
}
function pieCap(kind){
  if(kind==='cases')return '构成=现行 E2E JSON 按域，不随窗（不是 GUT func）';
  if(kind==='lessons')return '构成=现行教训篇数，不随窗';
  if(kind==='game')return '构成=HEAD 文件数：game/src 业务 · game/tests 测试 · 其它资源/工程，不随窗';
  return '构成=现状，不随窗';
}
function pieFig(slices,kind){
  const list=slices||[];
  const total=list.reduce((s,x)=>s+(Number(x.count)||0),0);
  const unit=sliceUnit(kind);
  const body=svgPie(list,kind);
  const empty=body.indexOf('pulse-empty')>=0;
  return pulseFig('构成（现状，不随窗）',body,{
    totalHtml:empty||!total?'':('现状共 '+total+' '+unit),
    capHtml:pieCap(kind),
    zoom:empty?null:{title:'构成（现状）',kind:'pie',chart:kind,slices:list,unit:unit,caption:pieCap(kind)}
  });
}
function churnTrendFig(e,chart,lab){
  const src=(e&&e.byDay)||[];
  if(!src.length)return pulseFig('趋势（窗内）','<div class="pulse-empty">无变更</div>');
  const rows=src.map(r=>({day:r.day,commits:Number(r.plus)||0,plus:Number(r.plus)||0,minus:Number(r.minus)||0}));
  const plusSum=rows.reduce((s,r)=>s+r.plus,0);
  const minusSum=rows.reduce((s,r)=>s+r.minus,0);
  const svg=svgBars(rows,'commits',{chart:chart,metric:'新增行',plusLabel:'新增行',minusLabel:'删除行'});
  return pulseFig('趋势（窗内）',svg,{
    totalHtml:'窗内合计 +'+plusSum+' 行 / −'+minusSum+' 行',
    zoom:{
      title:(lab||'')+' · 趋势',
      kind:'bars',
      chart:chart,
      rows:rows,
      valKey:'commits',
      keys:['plus','minus'],
      keyLabels:{plus:'新增行',minus:'删除行'},
      metric:'新增行',
      plusLabel:'新增行',
      minusLabel:'删除行',
      unit:'行',
      caption:'柱高=新增行。删除行见 tip / 表。时间窗内。'
    }
  });
}
function pulsePair(title,trendFig,pieFigHtml,attr){
  return '<section class="pulse-pair"'+(attr||'')+'><h3>'+title+'</h3><div class="pulse-pair-grid">'+trendFig+pieFigHtml+'</div></section>';
}
function hidePulseZoom(){
  const el=document.getElementById('pulse-zoom');
  if(!el||el.hidden)return false;
  el.hidden=true;
  const chart=el.querySelector('.pulse-zoom-chart');
  if(chart)chart.innerHTML='';
  const wrap=el.querySelector('.pulse-zoom-table-wrap');
  if(wrap)wrap.innerHTML='';
  return true;
}
function ensurePulseZoom(){
  let el=document.getElementById('pulse-zoom');
  if(el)return el;
  el=document.createElement('div');
  el.id='pulse-zoom';
  el.hidden=true;
  el.setAttribute('role','dialog');
  el.setAttribute('aria-modal','true');
  el.setAttribute('aria-labelledby','pulse-zoom-title');
  el.innerHTML='<div class="pulse-zoom-mask" data-zoom-close="1"></div><div class="pulse-zoom-panel"><header class="pulse-zoom-h"><h2 id="pulse-zoom-title"></h2><button type="button" class="pulse-zoom-close" data-zoom-close="1">关闭</button></header><p class="pulse-zoom-cap"></p><div class="pulse-zoom-chart"></div><div class="pulse-zoom-table-wrap"></div></div>';
  document.body.appendChild(el);
  el.addEventListener('click',(ev)=>{
    if(ev.target.closest('[data-zoom-close]'))hidePulseZoom();
  });
  return el;
}
function pulseZoomTable(spec){
  if(spec.kind==='pie'){
    let sum=0;
    for(const s of spec.slices||[]){
      const count=Number(s.count)||0;
      sum+=count;
    }
    let t='<table class="pulse-zoom-table"><thead><tr><th>切片</th><th>'+esc(spec.unit||'个')+'</th><th>占比</th></tr></thead><tbody>';
    let check=0;
    for(const s of spec.slices||[]){
      const count=Number(s.count)||0;
      const pct=pieSharePct(count,sum);
      check+=count;
      t+='<tr><td>'+esc(s.label||s.key||'')+'</td><td>'+count+'</td><td>'+pct+'%</td></tr>';
    }
    t+='</tbody><tfoot><tr><th>合计</th><th>'+check+'</th><th></th></tr></tfoot></table>';
    return t;
  }
  const keys=spec.keys||[spec.valKey||'commits'];
  const labels=spec.keyLabels||{};
  let t='<table class="pulse-zoom-table"><thead><tr><th>日期/键</th>';
  for(const k of keys)t+='<th>'+esc(labels[k]||seriesName(k))+'</th>';
  t+='<th>行合计</th></tr></thead><tbody>';
  const totals={};
  for(const k of keys)totals[k]=0;
  for(const r of spec.rows||[]){
    let rowSum=0;
    t+='<tr><td>'+esc(r.day||r.key||'')+'</td>';
    for(const k of keys){
      const v=Number(r[k])||0;
      totals[k]+=v;rowSum+=v;
      t+='<td>'+v+'</td>';
    }
    t+='<td>'+rowSum+'</td></tr>';
  }
  t+='</tbody><tfoot><tr><th>合计</th>';
  let grand=0;
  for(const k of keys){t+='<th>'+totals[k]+'</th>';grand+=totals[k]}
  t+='<th>'+grand+'</th></tr></tfoot></table>';
  return t;
}
function openPulseZoom(fig){
  const raw=fig&&fig.getAttribute('data-zoom');
  if(!raw)return;
  let spec;
  try{spec=JSON.parse(raw)}catch(e){return}
  hidePulseTip();
  const el=ensurePulseZoom();
  el.querySelector('#pulse-zoom-title').textContent=spec.title||'详细数据';
  el.querySelector('.pulse-zoom-cap').textContent=spec.caption||'';
  const chart=el.querySelector('.pulse-zoom-chart');
  const big={w:1000,h:spec.kind==='volume'?200:320,forceLabels:true,chart:spec.chart};
  let html='';
  if(spec.chart==='daily'){
    html='';
  }else if(spec.kind==='stack'){
    html=(spec.legendHtml||stackLegendHtml(spec.keys,spec.colors))+svgStackedBars(spec.rows||[],spec.keys,spec.colors,big);
  }else if(spec.kind==='line'){
    html=svgLine(spec.rows||[],spec.keys,big);
  }else if(spec.kind==='pie'){
    html=svgPie(spec.slices||[],spec.chart||'zoom');
  }else{
    html=svgBars(spec.rows||[],spec.valKey||'commits',Object.assign({metric:spec.metric,plusLabel:spec.plusLabel,minusLabel:spec.minusLabel,volume:spec.kind==='volume'},big));
  }
  chart.innerHTML=html;
  el.querySelector('.pulse-zoom-table-wrap').innerHTML=pulseZoomTable(spec);
  el.hidden=false;
  bindPulseTip(chart);
}

function renderPulse(){
  showInboxTools(false);
  showContent();
  hidePulseTip();
  hidePulseZoom();
  document.body.classList.add('pulse-mode');
  const live=pulseKpis&&pulseKpis.degraded&&(pulseKpis.degraded.git||pulseKpis.degraded.gate)?'DEGRADED':'LIVE';
  barEl('<div class="crumb"><span class="title">指挥台</span><span class="pulse-live" data-live="'+live+'">'+live+'</span></div>');
  bindBar();
  if(!pulseKpis&&!pulseTrends){
    document.getElementById('content').innerHTML='<div class="pulse-skel" id="pulse-root">加载中…</div>';
    loadPulseData();
    return;
  }
  const k=(pulseKpis&&pulseKpis.kpis)||{};
  const deg=(pulseKpis&&pulseKpis.degraded)||{};
  const t=pulseTrends||{git:{activity:[],cumulative:[]},volume:{byDir:[],byExt:[],totals:{}},daily:[],entities:{briefs:{byDay:[],pie:[]},tracks:{byDay:[],pie:[]},domains:{byDay:[],pie:[],note:''},bugs:{byDay:[],pie:[]}},code:{},rhythm:{}};
  const chip=pulseChipMatch();
  const chips=[['7d','7 天'],['30d','30 天'],['90d','90 天'],['ytd','今年'],['all','全部'],['custom','自定义']];
  let range='<div class="pulse-range" id="pulse-range">';
  range+='<div class="pulse-chips">';
  for(const [id,lab] of chips){
    const on=chip===id?' on':'';
    const dis=id==='custom'&&chip!=='custom'?' disabled':'';
    range+='<button type="button" class="pulse-chip'+on+'" data-win="'+id+'"'+dis+'>'+lab+'</button>';
  }
  range+='</div>';
  range+='<label class="pulse-dl">起 <input type="date" id="pulse-from" value="'+esc(pulseRange.from)+'"></label>';
  range+='<label class="pulse-dl">止 <input type="date" id="pulse-to" value="'+esc(pulseRange.to)+'"></label>';
  range+='<button type="button" class="btn pulse-apply" id="pulse-apply">应用</button>';
  range+='<label class="pulse-dl">粒度 <select id="pulse-bucket">';
  for(const b of [['auto','自动'],['day','日'],['week','周'],['month','月']]){
    range+='<option value="'+b[0]+'"'+(pulseRange.bucket===b[0]?' selected':'')+'>'+b[1]+'</option>';
  }
  range+='</select></label>';
  range+='<button type="button" class="ghost" id="pulse-reset">重置</button>';
  range+='</div>';

  let kpi='<div class="pulse-kpis" id="pulse-kpi">';
  const cards=[
    ['open','开放 TASK',k.openTasks],
    ['draft','简报草稿',k.briefsDraft],
    ['ready','简报可交',k.briefsReady],
    ['dirty','脏文件',k.dirtyFiles==null?(deg.git?'—':0):k.dirtyFiles],
    ['wt','worktree',k.worktrees==null?(deg.git?'—':0):k.worktrees],
    ['gate','门禁',k.gate||'missing']
  ];
  for(const [id,lab,val] of cards){
    kpi+='<button type="button" class="pulse-kpi" data-kpi="'+id+'"><span class="pulse-kpi-lab">'+lab+'</span><b>'+esc(String(val==null?'—':val))+'</b></button>';
  }
  kpi+='</div>';
  if(deg.git||deg.gate){
    kpi+='<div class="pulse-deg">';
    if(deg.git)kpi+='<span>git 不可用，脏计数已降级</span>';
    if(deg.gate)kpi+='<span>latest_run.txt 缺失，门禁 missing</span>';
    kpi+='</div>';
  }
  if(pulseTrends&&!trendsHasCodeRhythm(t)){
    kpi+='<div class="pulse-deg" data-stale-walls="1">实现/节奏接口未就绪：当前 serve 未加载最新 spec-pulse。保存该模块会自动重启，也可再跑 npm run serve。</div>';
  }

  const act=t.git&&t.git.activity||[];
  const cum=t.git&&t.git.cumulative||[];
  const volSrc=(t.volume&&t.volume.byDir&&t.volume.byDir.length)?t.volume.byDir:(t.volume&&t.volume.byExt)||[];
  const actSum=act.reduce((s,r)=>s+(Number(r.commits)||0),0);
  const actFig=act.length?pulseFig('日活跃（窗内 · 提交）',svgBars(act,'commits',{chart:'git-activity',metric:'提交'}),{
    totalHtml:'窗内合计 '+actSum+' 提交',
    zoom:{title:'日活跃',kind:'bars',chart:'git-activity',rows:act,valKey:'commits',keys:['commits'],metric:'提交',unit:'提交',caption:'柱=该日 git 提交次数。'}
  }):pulseFig('日活跃（窗内 · 提交）','<div class="pulse-empty">无提交</div>');
  const lastCum=cum.length?cum[cum.length-1]:null;
  const cumFig=cum.length?pulseFig('累计（提交 / 新增行 / 简报）',svgLine(cum,['commits','plus','briefs'],{chart:'git-cumulative'}),{
    totalHtml:lastCum?('终点 提交 '+ (lastCum.commits||0)+' / 新增行 '+(lastCum.plus||0)+' / 简报 '+(lastCum.briefs||0)):'',
    zoom:{title:'累计',kind:'line',chart:'git-cumulative',rows:cum,keys:['commits','plus','briefs'],caption:'折线为窗内累计终点。'}
  }):pulseFig('累计（提交 / 新增行 / 简报）','<div class="pulse-empty">无累计</div>');
  const volMapped=volSrc.map(r=>({day:r.key,key:r.key,commits:Number(r.n)||0,n:Number(r.n)||0}));
  const volSum=volMapped.reduce((s,r)=>s+r.commits,0);
  const volFig=volSrc.length?pulseFig('体量轴（左少右多 · 顶层目录）',svgVolume(volSrc,{chart:'volume'}),{
    cls:'pulse-fig-volume',
    totalHtml:'窗内合计 '+volSum+' 变更量',
    capHtml:'变更量=文本新增行+删除行；二进制文件计 1；含窗内新增后又删除的路径。game/src 与 game/tests 分桶。',
    zoom:{title:'体量',kind:'volume',chart:'volume',rows:volMapped,valKey:'commits',keys:['n'],keyLabels:{commits:'变更量',n:'变更量'},metric:'变更量',unit:'变更量',caption:'左少右多。变更量=文本行差+二进制计 1；按窗内 churn 汇总，已不在工作树的路径也会出现。'}
  }):pulseFig('体量轴（左少右多 · 顶层目录）','<div class="pulse-empty">无体量</div>',{cls:'pulse-fig-volume'});
  const overview='<section class="pulse-sec" data-sec="overview"><header class="pulse-sec-h"><h2>总览</h2><p class="pulse-sec-lead">提交活跃与累计怎么走</p></header>'+
    '<div class="pulse-overview-row" id="pulse-git">'+actFig+cumFig+'</div>'+volFig+'</section>';

  function addedTrendFig(rows,chart,lab,unit){
    if(!rows||!rows.length)return pulseFig('趋势（窗内）','<div class="pulse-empty">无变更</div>');
    const mapped=rows.map(r=>({day:r.day,commits:Number(r.added)||0,added:Number(r.added)||0}));
    const sum=mapped.reduce((s,r)=>s+r.added,0);
    return pulseFig('趋势（窗内）',svgBars(mapped,'commits',{chart:chart,metric:unit||'新增'}),{
      totalHtml:'窗内合计 '+sum+' '+(unit||'个'),
      zoom:{title:lab+' · 趋势',kind:'bars',chart:chart,rows:mapped,valKey:'commits',keys:['added'],keyLabels:{commits:unit||'新增',added:unit||'新增'},metric:unit||'新增',unit:unit||'个',caption:'柱=窗内新增。'}
    });
  }
  const code=t.code||{};
  function codeCard(key,lab){
    const e=code[key]||{byDay:[],pie:[]};
    return pulsePair(lab,churnTrendFig(e,key+'-trend',lab),pieFig(e.pie||[],key),' data-ent="'+key+'"');
  }
  const cases=code.cases||{byDay:[],pie:[],gutFuncs:0};
  const caseRows=(cases.byDay||[]).map(r=>({day:r.day,gutAdded:Number(r.gutAdded)||0,e2eAdded:Number(r.e2eAdded)||0}));
  const caseSum=caseRows.reduce((s,r)=>s+r.gutAdded+r.e2eAdded,0);
  const caseTrend=caseRows.length?pulseFig('趋势（窗内 · GUT/E2E 文件+）',svgStackedBars(caseRows,CASE_KEYS,CASE_COLORS,{chart:'cases-trend'}),{
    totalHtml:'窗内合计 '+caseSum+' 文件+',
    legendHtml:stackLegendHtml(CASE_KEYS,CASE_COLORS),
    capHtml:'柱分段=该日新增的 GUT 测试文件与 E2E JSON，不是删除。',
    zoom:{title:'用例库存 · 趋势',kind:'stack',chart:'cases-trend',rows:caseRows,keys:CASE_KEYS,colors:CASE_COLORS,legendHtml:stackLegendHtml(CASE_KEYS,CASE_COLORS),caption:'绿=GUT 测试文件+；蓝=E2E JSON+。'}
  }):pulseFig('趋势（窗内 · GUT/E2E 文件+）','<div class="pulse-empty">无变更</div>');
  const runs=code.runs||{empty:true,bars:[],latestE2e:null,latestGate:null,bugs:0,bugsValid:0,bugsFalseRed:0};
  const runBars=runs.bars||[];
  const runHas=runBars.some(r=>(Number(r.passed)||0)+(Number(r.failed)||0)+(Number(r.bugs)||0)>0);
  const runPass=runBars.reduce((s,r)=>s+(Number(r.passed)||0),0);
  const runFail=runBars.reduce((s,r)=>s+(Number(r.failed)||0),0);
  const runBugs=runBars.reduce((s,r)=>s+(Number(r.bugs)||0),0);
  const runValid=runBars.reduce((s,r)=>s+(Number(r.bugsValid)||0),0);
  const runFalse=runBars.reduce((s,r)=>s+(Number(r.bugsFalseRed)||0),0);
  function e2eBugTable(rows){
    let html='<table class="pulse-daily pulse-e2e-table"><thead><tr><th>日期</th><th>通过步</th><th>失败步</th><th>产出 bug</th><th>有效</th><th>误报</th></tr></thead><tbody>';
    let any=false;
    for(const r of rows||[]){
      const p=Number(r.passed)||0,f=Number(r.failed)||0,b=Number(r.bugs)||0,v=Number(r.bugsValid)||0,fr=Number(r.bugsFalseRed)||0;
      if(!(p||f||b))continue;
      any=true;
      html+='<tr><td>'+esc(r.day)+'</td><td>'+p+'</td><td>'+f+'</td><td>'+b+'</td><td>'+v+'</td><td>'+fr+'</td></tr>';
    }
    if(!any)html+='<tr><td colspan="6">本机无运行记录</td></tr>';
    html+='</tbody><tfoot><tr><th>合计</th><th>'+runPass+'</th><th>'+runFail+'</th><th>'+runBugs+'</th><th>'+runValid+'</th><th>'+runFalse+'</th></tr></tfoot></table>';
    return html;
  }
  let runFig;
  const runZoomKeys=['passed','failed','bugs','bugsValid','bugsFalseRed'];
  const runZoomLabels={passed:'通过步',failed:'失败步',bugs:'产出 bug',bugsValid:'有效',bugsFalseRed:'误报'};
  if(runs.empty||!runHas){
    runFig=pulseFig('本机 vlm_agent E2E（checkpoint 步）','<div class="pulse-empty" data-chart="runs">本机无运行记录</div>'+e2eBugTable([]),{
      cls:'pulse-fig-runs',
      capHtml:'柱来自本机 game/.mcp/e2e/vlm/*/report.json 的 checkpoint 步。表=产出/有效/误报（对照上报包状态）。旁路 KPI 才是最近一次 E2E / merge-gate。'
    });
  }else{
    runFig=pulseFig('本机 vlm_agent E2E（checkpoint 步）',svgStackedBars(runBars,RUN_KEYS,RUN_COLORS,{chart:'runs'})+e2eBugTable(runBars),{
      cls:'pulse-fig-runs',
      totalHtml:'窗内合计 通过 '+runPass+' 步 / 失败 '+runFail+' 步 · 产出 bug '+runBugs+' / 有效 '+runValid+' / 误报 '+runFalse,
      legendHtml:stackLegendHtml(RUN_KEYS,RUN_COLORS),
      capHtml:'绿=checkpoint 通过步；红=失败步。表列 bug：产出=submit 的 8 位；误报=已关闭 · 非缺陷；有效=其余。',
      zoom:{title:'本机 vlm_agent E2E',kind:'stack',chart:'runs',rows:runBars,keys:runZoomKeys,colors:RUN_COLORS,keyLabels:runZoomLabels,legendHtml:stackLegendHtml(RUN_KEYS,RUN_COLORS),caption:'绿=checkpoint 通过步；红=失败步。表含产出/有效/误报。'}
    });
  }
  const e2eLab=runs.latestE2e?((runs.latestE2e.ok?'ok':'fail')+' '+runs.latestE2e.passed+'/'+(runs.latestE2e.total||0)): '—';
  const gateLab=runs.latestGate&&runs.latestGate.gate?runs.latestGate.gate:'—';
  const gamePie=(code.game&&code.game.pie)||[];
  const gameIntro=pulseFig('口径','<p class="pulse-cap">game/src 是全量业务代码；game/tests 是测试代码。体量轴把这两键拆开，不再并成顶层 game。</p>',{
    capHtml:'构成饼=HEAD 文件数，不随窗。业务卡饼是 game/src 子目录（不含 data/schemas，那些在玩法 JSON）。'
  });
  const impl='<section class="pulse-sec" data-sec="code"><header class="pulse-sec-h"><h2>实现</h2><p class="pulse-sec-lead">代码、测试与用例库存</p></header>'+
    '<div class="pulse-code-top">'+codeCard('business','业务代码 <span class="pulse-note">game/src</span>')+codeCard('json','玩法 JSON')+'</div>'+
    '<div class="pulse-code-mid">'+codeCard('tests','测试代码 <span class="pulse-note">game/tests</span>')+pulsePair('用例库存 <span class="pulse-note">GUT func '+(cases.gutFuncs||0)+'（当前快照，非饼）</span>',caseTrend,pieFig(cases.pie||[],'cases'),' data-ent="cases"')+'</div>'+
    '<div class="pulse-code-game">'+pulsePair('game 代码体量',gameIntro,pieFig(gamePie,'game'),' data-ent="game"')+'</div></section>';
  const runsSec='<section class="pulse-sec" data-sec="runs"><header class="pulse-sec-h"><h2>本机 vlm_agent E2E</h2><p class="pulse-sec-lead">checkpoint 步与 bug 产出 / 有效 / 误报</p></header>'+
    '<div class="pulse-code-runs">'+runFig+
    '<div class="pulse-run-kpis"><div class="pulse-kpi"><span class="pulse-kpi-lab">最近 E2E</span><b>'+esc(e2eLab)+'</b></div>'+
    '<div class="pulse-kpi"><span class="pulse-kpi-lab">最近门禁</span><b>'+esc(gateLab)+'</b></div></div></div></section>';

  const rhy=t.rhythm||{};
  const ct=rhy.commitTypes||{byDay:[],pie:[]};
  const ctRows=ct.byDay||[];
  const ctSum=ctRows.reduce((s,r)=>s+STACK_KEYS.reduce((a,k)=>a+(Number(r[k])||0),0),0);
  const commitFig=ctRows.length?pulseFig('提交类型（窗内 · 次）',svgStackedBars(ctRows,STACK_KEYS,STACK_COLORS,{chart:'commit-types'}),{
    cls:'pulse-fig-commit',
    id:'pulse-commit-types',
    totalHtml:'窗内合计 '+ctSum+' 次',
    legendHtml:stackLegendHtml(STACK_KEYS,STACK_COLORS),
    capHtml:'色块与柱分段同色：feat / fix / test / docs / 其它。柱=Conventional 首词计数，不含 subject。',
    zoom:{title:'提交类型',kind:'stack',chart:'commit-types',rows:ctRows,keys:STACK_KEYS,colors:STACK_COLORS,legendHtml:stackLegendHtml(STACK_KEYS,STACK_COLORS),caption:'与柱同色。不含 commit subject。'}
  }):pulseFig('提交类型（窗内 · 次）','<div class="pulse-empty">无提交</div>',{cls:'pulse-fig-commit',id:'pulse-commit-types'});
  const rhythm='<section class="pulse-sec" data-sec="rhythm"><header class="pulse-sec-h"><h2>节奏</h2><p class="pulse-sec-lead">这几天在写什么类型</p></header>'+
    commitFig+
    '<div class="pulse-rhythm-row">'+
    pulsePair('教训',addedTrendFig(rhy.lessons&&rhy.lessons.byDay,'lessons-trend','教训','篇'),pieFig((rhy.lessons&&rhy.lessons.pie)||[],'lessons'),' data-ent="lessons"')+
    pulsePair('规格文档',churnTrendFig(rhy.specs,'specs-trend','规格文档'),pieFig((rhy.specs&&rhy.specs.pie)||[],'specs'),' data-ent="specs"')+
    pulsePair('工具链',churnTrendFig(rhy.toolchain,'toolchain-trend','工具链'),pieFig((rhy.toolchain&&rhy.toolchain.pie)||[],'toolchain'),' data-ent="toolchain"')+
    '</div></section>';

  let heat='<div class="pulse-heat" id="pulse-heat">';
  if(!allDomains.length)heat+='<div class="pulse-empty">无域登记</div>';
  for(const d of allDomains){
    const n=(d.tracks||[]).length;
    heat+='<button type="button" class="pulse-cell" data-domain-pkg="'+esc(d.package)+'" data-domain-id="'+esc(d.id)+'" title="'+esc(d.title)+'">'+esc(d.id)+'<small>'+n+'</small></button>';
  }
  heat+='</div>';
  const ents=t.entities||{};
  const pairs=[['briefs','简报'],['tracks','轨'],['domains','域'],['bugs','上报']];
  let wall='<section class="pulse-sec" data-sec="ents"><header class="pulse-sec-h"><h2>文档实体</h2><p class="pulse-sec-lead">简报轨域与上报构成</p>'+heat+'</header>';
  wall+='<div class="pulse-wall pulse-wall-2x2" id="pulse-ents">';
  for(const [key,lab] of pairs){
    const e=ents[key]||{byDay:[],pie:[]};
    const note=e.note?'<span class="pulse-note">'+esc(e.note)+'</span>':'';
    const addedUnit=key==='briefs'?'份':(key==='tracks'?'条':'个');
    const trend=e.byDay&&e.byDay.length?addedTrendFig(e.byDay,key+'-trend',lab,addedUnit):pulseFig('趋势（窗内）','<div class="pulse-empty">仅现状</div>');
    wall+=pulsePair(lab+note,trend,pieFig(e.pie||[],key),' data-ent="'+key+'"');
  }
  wall+='</div></section>';

  const daily=t.daily||[];
  const dTot={commits:0,plus:0,minus:0,textFiles:0,binaries:0};
  for(const row of daily){
    dTot.commits+=Number(row.commits)||0;
    dTot.plus+=Number(row.plus)||0;
    dTot.minus+=Number(row.minus)||0;
    dTot.textFiles+=Number(row.textFiles)||0;
    dTot.binaries+=Number(row.binaries)||0;
  }
  const dailyZoom={
    title:'日汇总',
    kind:'bars',
    chart:'daily',
    rows:daily.map(r=>({day:r.day,commits:r.commits,plus:r.plus,minus:r.minus,textFiles:r.textFiles,binaries:r.binaries})),
    keys:['commits','plus','minus','textFiles','binaries'],
    keyLabels:{commits:'提交',plus:'新增行',minus:'删除行',textFiles:'文本文件',binaries:'二进制'},
    caption:'点柱仍高亮这一行。指挥台不展示 commit subject。',
    unit:'—'
  };
  let table='<section class="pulse-sec" data-sec="daily"><div class="pulse-daily-wrap" id="pulse-daily" data-zoom="'+esc(JSON.stringify(dailyZoom))+'"><div class="pulse-daily-h"><h2>日汇总</h2><span class="pulse-total">窗内合计 '+dTot.commits+' 提交 / +'+dTot.plus+' 行 / −'+dTot.minus+' 行</span><button type="button" class="pulse-zoom-btn" aria-label="放大查看详细数据">放大</button></div><p class="pulse-sec-lead">点柱只高亮这一行</p><table class="pulse-daily"><thead><tr><th>日期</th><th>提交</th><th>新增行</th><th>删除行</th><th>文本</th><th>二进制</th></tr></thead><tbody>';
  for(const row of daily){
    const hi=pulseHighlightDay===row.day?' pulse-row-hi':'';
    table+='<tr class="'+hi+'" data-day="'+esc(row.day)+'" id="pulse-day-'+esc(row.day)+'"><td>'+esc(row.day)+'</td><td>'+row.commits+'</td><td>'+row.plus+'</td><td>'+row.minus+'</td><td>'+row.textFiles+'</td><td>'+row.binaries+'</td></tr>';
  }
  if(!daily.length)table+='<tr><td colspan="6">无日数据</td></tr>';
  table+='</tbody><tfoot><tr><th>合计</th><th>'+dTot.commits+'</th><th>'+dTot.plus+'</th><th>'+dTot.minus+'</th><th>'+dTot.textFiles+'</th><th>'+dTot.binaries+'</th></tr></tfoot></table></div>';
  table+='<details class="pulse-detail"><summary>明细</summary><p class="pulse-cap">提交说明与文件清单请从四视图进入。指挥台不展示 commit subject。</p></details></section>';

  document.getElementById('content').innerHTML='<div id="pulse-root">'+range+kpi+overview+wall+impl+runsSec+rhythm+table+'</div>';
  bindPulse();
}

function bindPulse(){
  const root=document.getElementById('pulse-root');
  if(!root)return;
  root.querySelectorAll('[data-win]').forEach(btn=>{
    btn.onclick=()=>{
      if(btn.dataset.win==='custom')return;
      applyPulseWindow({chip:btn.dataset.win,bucket:pulseRange.bucket});
    };
  });
  const apply=document.getElementById('pulse-apply');
  if(apply)apply.onclick=()=>{
    const from=(document.getElementById('pulse-from')||{}).value;
    const to=(document.getElementById('pulse-to')||{}).value;
    applyPulseWindow({chip:'custom',from,to,bucket:pulseRange.bucket});
  };
  const buck=document.getElementById('pulse-bucket');
  if(buck)buck.onchange=()=>{
    pulseRange.bucket=buck.value;
    savePulseRange();
    loadPulseData();
  };
  const reset=document.getElementById('pulse-reset');
  if(reset)reset.onclick=()=>{
    if(pulsePrevRange){pulseRange=Object.assign({},pulsePrevRange);savePulseRange();loadPulseData()}
    else applyPulseWindow(defaultPulseRange());
  };
  root.querySelectorAll('[data-kpi]').forEach(btn=>{
    btn.onclick=()=>{
      const id=btn.dataset.kpi;
      if(id==='draft'){pulseFilter={type:'brief',key:'draft'};go(encodeListHash({route:'briefs',seg:'draft'}))}
      else if(id==='ready'){pulseFilter={type:'brief',key:'ready'};go(encodeListHash({route:'briefs',seg:'ready'}))}
      else if(id==='open')go('#/specs');
    };
  });
  root.querySelectorAll('[data-domain-id]').forEach(btn=>{
    btn.onclick=()=>go('#/domain/'+encodeURIComponent(btn.dataset.domainPkg)+'/'+encodeURIComponent(btn.dataset.domainId));
  });
  root.querySelectorAll('.pulse-slice').forEach(el=>{
    el.style.cursor='pointer';
    el.onclick=()=>{
      const kind=el.getAttribute('data-pie-kind');
      const key=el.getAttribute('data-pie-key');
      if(kind==='briefs'){
        const seg=key==='_other'||key==='other'?'all':key;
        pulseFilter={type:'brief',key:key==='_other'?'other':key};
        go(encodeListHash({route:'briefs',seg}));
      }
      else if(kind==='bugs'){pulseFilter={type:'bug',key:key};go('#/bugs')}
      else if(kind==='tracks'){pulseFilter=null;go('#/pkg/'+encodeURIComponent(key))}
      else if(kind==='domains'){pulseFilter={type:'domain',key:key};go('#/domains')}
    };
  });
  root.querySelectorAll('[data-chart="git-activity"] .pulse-bar, [data-chart$="-trend"] .pulse-bar').forEach(bar=>{
    bar.style.cursor='pointer';
    bar.onclick=()=>{
      const day=bar.getAttribute('data-day');
      pulseHighlightDay=day;
      const row=document.getElementById('pulse-day-'+day);
      if(row)row.scrollIntoView({behavior:'smooth',block:'center'});
      root.querySelectorAll('.pulse-bar').forEach(b=>b.classList.toggle('pulse-hi',b.getAttribute('data-day')===day));
      root.querySelectorAll('.pulse-daily tbody tr').forEach(tr=>tr.classList.toggle('pulse-row-hi',tr.getAttribute('data-day')===day));
    };
  });
  bindPulseDrag(root.querySelector('[data-chart="git-activity"]'));
  bindPulseTip(root);
  root.querySelectorAll('.pulse-zoom-btn').forEach(btn=>{
    btn.onclick=(ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      const host=btn.closest('[data-zoom]');
      if(host)openPulseZoom(host);
    };
  });
}

function bindPulseDrag(svg){
  if(!svg)return;
  let down=null,mark=null;
  svg.addEventListener('mousedown',(ev)=>{
    if(ev.button!==0)return;
    const r=svg.getBoundingClientRect();
    down={x:ev.clientX-r.left,w:r.width};
    mark=document.createElementNS('http://www.w3.org/2000/svg','rect');
    mark.setAttribute('class','pulse-drag');
    mark.setAttribute('y','0');
    mark.setAttribute('height',String(svg.viewBox.baseVal.height||140));
    svg.appendChild(mark);
    ev.preventDefault();
  });
  window.addEventListener('mousemove',(ev)=>{
    if(!down||!mark)return;
    const r=svg.getBoundingClientRect();
    const x=Math.max(0,Math.min(r.width,ev.clientX-r.left));
    const x0=Math.min(down.x,x),x1=Math.max(down.x,x);
    const vb=svg.viewBox.baseVal.width||560;
    mark.setAttribute('x',String(x0/r.width*vb));
    mark.setAttribute('width',String(Math.max(1,(x1-x0)/r.width*vb)));
  });
  window.addEventListener('mouseup',(ev)=>{
    if(!down)return;
    const r=svg.getBoundingClientRect();
    const x=Math.max(0,Math.min(r.width,ev.clientX-r.left));
    const x0=Math.min(down.x,x),x1=Math.max(down.x,x);
    down=null;
    if(mark&&mark.parentNode)mark.parentNode.removeChild(mark);
    mark=null;
    if(x1-x0<8)return;
    const rows=(pulseTrends&&pulseTrends.git&&pulseTrends.git.activity)||[];
    if(rows.length<2)return;
    const i0=Math.max(0,Math.floor((x0/r.width)*rows.length));
    const i1=Math.min(rows.length-1,Math.floor((x1/r.width)*rows.length));
    const from=rows[i0].day,to=rows[i1].day;
    applyPulseWindow({chip:'custom',from,to,bucket:pulseRange.bucket});
  });
}

function ensurePalette(){
  if(document.getElementById('pulse-k'))return;
  const d=document.createElement('div');
  d.id='pulse-k';
  d.hidden=true;
  d.innerHTML='<div class="pulse-k-box"><input id="pulse-k-q" placeholder="搜索简报 / 轨 / 域 / 上报…" autocomplete="off"><div id="pulse-k-empty" class="pulse-k-empty" hidden>无匹配</div><div id="pulse-k-list"></div></div>';
  document.body.appendChild(d);
  d.addEventListener('click',(ev)=>{if(ev.target===d)closePulsePalette()});
  d.querySelector('#pulse-k-q').addEventListener('input',renderPaletteHits);
}
function openPulsePalette(){
  ensurePalette();
  const d=document.getElementById('pulse-k');
  d.hidden=false;
  const q=document.getElementById('pulse-k-q');
  q.value='';
  renderPaletteHits();
  q.focus();
}
function closePulsePalette(){
  const d=document.getElementById('pulse-k');
  if(!d||d.hidden)return false;
  d.hidden=true;
  return true;
}
function renderPaletteHits(){
  const q=((document.getElementById('pulse-k-q')||{}).value||'').toLowerCase().trim();
  const list=document.getElementById('pulse-k-list');
  const empty=document.getElementById('pulse-k-empty');
  if(!list)return;
  const hits=[];
  for(const b of allBriefs){
    const hay=((b.title||'')+' '+(b.id||'')+' '+(b.status||'')).toLowerCase();
    if(!q||hay.indexOf(q)>=0)hits.push({lab:(b.title||b.id)+' · 简报',nav:'#/brief/'+encodeURIComponent(b.id)});
  }
  for(const p of allData){
    if(!q||p.name.toLowerCase().indexOf(q)>=0)hits.push({lab:p.name+' · 包',nav:'#/pkg/'+encodeURIComponent(p.name)});
    for(const t of p.tracks||[]){
      if(!q||t.name.toLowerCase().indexOf(q)>=0)hits.push({lab:t.name+' · 轨',nav:'#/pkg/'+encodeURIComponent(p.name)+'/'+encodeURIComponent(t.name)});
    }
  }
  for(const d of allDomains){
    const hay=((d.title||'')+' '+(d.id||'')).toLowerCase();
    if(!q||hay.indexOf(q)>=0)hits.push({lab:(d.title||d.id)+' · 域',nav:'#/domain/'+encodeURIComponent(d.package)+'/'+encodeURIComponent(d.id)});
  }
  for(const b of allBugs){
    const hay=((b.title||'')+' '+(b.id||'')+' '+(b.status||'')).toLowerCase();
    if(!q||hay.indexOf(q)>=0)hits.push({lab:(b.title||b.id)+' · 上报',nav:'#/bug/'+encodeURIComponent(b.id)});
  }
  const shown=hits.slice(0,40);
  if(!shown.length){list.innerHTML='';empty.hidden=false;return}
  empty.hidden=true;
  list.innerHTML=shown.map(h=>'<button type="button" class="pulse-k-hit" data-nav="'+esc(h.nav)+'">'+esc(h.lab)+'</button>').join('');
  list.querySelectorAll('[data-nav]').forEach(btn=>{
    btn.onclick=()=>{closePulsePalette();go(btn.getAttribute('data-nav'))};
  });
}

let refreshTimer=null;
function softRefresh(hintPath){
  hidePulseTip();
  hidePulseZoom();
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(()=>{
    if(hintPath&&mode!=='pulse')expandForChange(hintPath);
    const extra=mode==='pulse'?[api('/api/pulse'),api('/api/pulse/trends?'+pulseQueryString())]:[];
    Promise.all([api('/api/packages'),api('/api/briefs'),api('/api/bugs'),api('/api/domains'),api('/api/data'),loadChanges()].concat(extra)).then((arr)=>{
      const [data,briefs,bugs,domains,dataFiles]=arr;
      allData=data;
      allBriefs=Array.isArray(briefs)?briefs:[];
      allBugs=Array.isArray(bugs)?bugs:[];
      allDomains=Array.isArray(domains)?domains:[];
      allDataFiles=Array.isArray(dataFiles)?dataFiles:[];
      if(mode==='pulse'&&arr.length>=8){
        if(arr[6]&&arr[6].ok)pulseKpis=arr[6];
        if(arr[7]&&arr[7].from){
          pulseTrends=arr[7];
          if(!trendsHasCodeRhythm(arr[7]))loadPulseData();
        }
      }
      if(mode==='data'&&dataDirty&&hintPath&&/src\/data/.test(String(hintPath))){
        showToast('文件已被外部修改。',true);
        const err=document.getElementById('data-err');
        if(err){err.hidden=false;err.textContent='文件已被外部修改。'}
        return;
      }
      renderTree(qVal());
      updateBadges();
      renderRoute();
    }).catch(()=>{listLoadError='network';renderRoute();});
  },150);
}

function init(){
  loadExpanded();
  svBoot();
  loadPulseRange();
  if(window.matchMedia('(max-width:1099px)').matches)document.body.classList.add('side-collapsed');
  syncSideToggle();
  if(!location.hash||location.hash==='#/'||location.hash==='#'){
    let saved=null;
    try{saved=sessionStorage.getItem(MODE_KEY)}catch(e){}
    const dest=(saved&&['briefs','specs','domains','bugs','data'].indexOf(saved)>=0)?(saved==='bugs'?encodeListHash({route:'bugs',seg:'new'}):saved==='briefs'?encodeListHash({route:'briefs',seg:'draft'}):saved==='data'?encodeListHash({route:'data',seg:'writable'}):'#/'+saved):'#/pulse';
    try{history.replaceState(null,'',dest)}catch(e){}
  }
  const boot=parseHash();
  if((boot.route==='bugs'||boot.route==='bug')&&!allBugs.length){
    showInboxTools('bugs',boot.seg||'new');
    barEl('<div class="crumb"><span class="title">上报</span></div>');
    const c=document.getElementById('content');
    if(c)c.innerHTML=inboxSkel([{label:'状态',cls:'st'},{label:'编号',cls:'num'},{label:'标题'},{label:'日期',cls:'date'}]);
  }
  Promise.all([api('/api/packages'),api('/api/briefs'),api('/api/bugs'),api('/api/domains'),api('/api/data'),loadChanges()]).then(([data,briefs,bugs,domains,dataFiles])=>{
    listLoadError='';
    allData=data;
    allBriefs=Array.isArray(briefs)?briefs:[];
    allBugs=Array.isArray(bugs)?bugs:[];
    allDomains=Array.isArray(domains)?domains:[];
    allDataFiles=Array.isArray(dataFiles)?dataFiles:[];
    const d=parseHash();
    const head=d.route||'pulse';
    mode=head==='pulse'?'pulse':(head==='bugs'||head==='bug'?'bugs':(head==='uikit'?'uikit':(head==='data'?'data':(head==='domains'||head==='domain'?'domains':(head==='specs'||head==='pkg'||head==='file'?'specs':'briefs')))));
    document.body.classList.toggle('pulse-mode',mode==='pulse');
    document.body.classList.toggle('uikit-mode',mode==='uikit');
    syncSideToggle();
    document.querySelectorAll(APP_SEL).forEach(b=>{
      const on=b.dataset.mode===mode;
      b.classList.toggle('active',on);
      if(on)b.setAttribute('aria-current','page');
      else b.removeAttribute('aria-current');
    });
    const q=document.getElementById('q');
    if(q)q.placeholder={pulse:'搜索指挥台…',briefs:'搜索简报…',specs:'搜索包或 Track…',bugs:'搜索上报 ID / 标题…',domains:'搜索域 id / 标题…',data:'搜索数据 id / 文件…'}[mode];
    try{sessionStorage.setItem(MODE_KEY,mode)}catch(e){}
    try{renderTree('');updateBadges();renderRoute()}catch(e){document.getElementById('content').innerHTML='<div class="empty">Render error: '+e.message+'</div>'}
  }).catch(e=>{
    listLoadError=String(e&&e.message||e);
    barEl('<div class="crumb"><span class="title">上报</span></div>');
    document.getElementById('content').innerHTML='<div class="inbox-fail" role="status"><p>无法读取上报。</p><button type="button" class="inbox-action" data-retry>重试</button></div>';
    bindInboxNav();
  });
  setInterval(()=>{
    const before=Object.keys(changeSignals).length;
    ingestChanges(Object.values(changeSignals));
    if(Object.keys(changeSignals).length!==before||before)renderTree(qVal());
  },30000);
}
setTimeout(()=>{
  try{
    const es=new EventSource('/events');
    let esEverOpen=false;
    es.onopen=()=>{
      if(esEverOpen&&mode==='pulse')loadPulseData();
      esEverOpen=true;
    };
    es.onmessage=(ev)=>{
      let hint=null;
      try{const p=JSON.parse(ev.data);if(p&&p.path)hint=p.path}catch(e){}
      softRefresh(hint);
    };
  }catch(e){}
},500);
init();

// 列表可见性刷新（30s 检测 cache 变化 + 触发 /api/sync 缩短上报可见窗；手动「同步」按钮）
(function(){
  let lastSig='';
  async function syncNow(force){
    try{
      const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({force:!!force})});
      const j=await r.json();
      if(j&&j.ok&&!j.skipped)location.reload();
      return j;
    }catch(e){return null}
  }
  document.addEventListener('click',function(ev){
    const b=ev.target.closest('[data-sync-now]');
    if(!b)return;
    b.disabled=true;b.textContent='同步中…';
    syncNow(true).finally(function(){ if(b){b.disabled=false;b.textContent='同步';} });
  });
  setInterval(async function(){
    if(!/^#\/(bugs|bug\/)/.test(location.hash))return;
    try{
      const r=await fetch('/api/bugs');
      const j=await r.json();
      const sig=(Array.isArray(j)?j:[]).map(function(b){return b.id+':'+b.status}).join('|');
      if(lastSig&&sig!==lastSig){location.reload();return;}
      lastSig=sig;
      syncNow(false);
    }catch(e){}
  },30000);
})();
