const esc=v=>String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enc=encodeURIComponent;
const number=v=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(2):'未知';
async function api(route){const r=await fetch('/api/performance/'+route);const j=await r.json();if(!r.ok||j.ok===false)throw new Error(j.error||'HTTP '+r.status);return j;}
const dump=v=>'<pre>'+esc(JSON.stringify(v,null,2))+'</pre>';
function table(headers,rows){return '<div class="perf-scroll"><table><thead><tr>'+headers.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(x=>'<td>'+x+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
const tabs=[['runs','运行库'],['compare','比较 / 趋势'],['integration','集成状态'],['catalog','目录 / 导入']];
const link=(id,label)=>'<a href="#/performance/run/'+enc(id)+'">'+esc(label)+'</a>';
function peakRows(values){
  // Each bucket keeps its real maximum. The long-frame table retains exact original indices.
  const step=Math.max(1,Math.ceil(values.length/256)),rows=[];
  for(let a=0;a<values.length;a+=step){let index=a;for(let i=a+1;i<Math.min(a+step,values.length);i++)if(values[i]>values[index])index=i;rows.push({day:String(index),frame_ms:values[index]});}
  return rows;
}
export async function renderPerformance(host,{svgLine,route=[],query=new URLSearchParams()}={}){
  if(!document.getElementById('perf-css')){const el=document.createElement('link');el.id='perf-css';el.rel='stylesheet';el.href='/static/performance.css';document.head.append(el);}
  const page=route[0]||'runs',initialHash=location.hash;
  host.innerHTML='<div class="perf-app"><nav aria-label="性能页面">'+tabs.map(([id,label])=>'<a '+(page===id?'aria-current="page"':'')+' href="#/performance/'+id+'">'+label+'</a>').join('')+'</nav><p id="perf-runtime"></p><div id="perf-body" role="status">加载性能数据…</div></div>';
  api('status').then(s=>{const el=host.querySelector('#perf-runtime');if(el&&location.hash===initialHash){el.textContent=s.preview?'隔离预览：内存Vault，重启不持久。原件与本地包保留，未接入生产。':'项目 '+s.project;el.className=s.preview?'perf-note':'';}}).catch(()=>{});
  const body=host.querySelector('#perf-body');
  const set=html=>{if(location.hash===initialHash&&body.isConnected)body.innerHTML=html;};
  try{
    if(page==='runs'){
      const offset=Math.max(0,Number(query.get('offset'))||0),data=await api('runs?limit=50&offset='+offset),rows=data.items||[];
      set('<header><h1>性能运行库</h1><p>这里是导入的全流程原帧，可能包含标题和加载，未经稳态窗口认证。观察记录不自动成为基线；点开查看上传收据。</p></header><label>筛选本页 <input id="perf-filter" placeholder="用例、提交、机器、来源"></label>'+table(['用例 / 运行','提交 / 环境','帧时均值','真实 1% low','资格 / 来源'],rows.map(r=>{const m=r.manifest||{};return [link(r.report_id,m.case_id||'未知格式')+'<small>'+esc(m.run_id)+'</small>',esc(m.commit)+'<small>'+esc(m.testbed)+' / '+esc(m.profile)+'</small>',number(m.metrics?.mean_ms)+' ms',number(m.metrics?.one_pct_low_fps)+' FPS',esc(m.qualification?.status||'unknown')+'<small>'+esc(m.source)+' / '+esc(m.trust)+'</small>'];}))+'<footer><span>当前 '+rows.length+' / 总计 '+esc(data.total ?? '?')+'；每页50条</span> '+(offset?'<a href="#/performance/runs?offset='+Math.max(0,offset-50)+'">上一页</a>':'')+' '+(offset+rows.length<(data.total||0)?'<a href="#/performance/runs?offset='+(offset+50)+'">下一页</a>':'')+'</footer>'+(!rows.length?'<p class="perf-note">暂无运行。到“目录 / 导入”按现有采集工具产出原帧，再显式上传。</p>':''));
      body.querySelector('#perf-filter')?.addEventListener('input',e=>{const value=e.target.value.toLowerCase();body.querySelectorAll('tbody tr').forEach(tr=>tr.hidden=!tr.textContent.toLowerCase().includes(value));});
    }else if(page==='run'){
      const id=route[1],run=await api('runs/'+enc(id)),m=run.manifest;
      set('<h1>'+esc(m.case_id)+'</h1><p><strong>'+esc(run.state==='complete'?'证据完整（已校验收据）':'部分上传：不能作完整证据')+'</strong> · '+esc(m.source)+' · '+esc(m.trust)+'</p><p>'+esc(m.qualification?.status)+'：'+esc((m.qualification?.reasons||[]).join('；'))+'</p>'+table(['提交','环境','均值','p99','真实 1% low'],[[esc(m.commit),esc(m.testbed)+' / '+esc(m.profile),number(m.metrics?.mean_ms)+' ms',number(m.metrics?.p99_ms)+' ms',number(m.metrics?.one_pct_low_fps)+' FPS']])+'<div class="perf-grid"><section><h2>原件与预览</h2>'+table(['原件','大小','查看 / 下载'],m.files.map(f=>[esc(f.path)+'<small title="'+esc(f.sha256)+'">SHA256 '+esc(f.sha256.slice(0,16))+'…</small>',esc(f.size)+' B','<button data-preview="'+esc(f.path)+'">预览</button> <a href="/api/performance/runs/'+enc(id)+'/file?path='+enc(f.path)+'">校验下载</a>']))+'</section><section><h2>采集覆盖</h2>'+dump(m.capabilities)+'</section></div><section id="perf-preview"><p>选择原件查看。未知二进制保留专业工具入口；缺失数据不补零。</p></section><details><summary>完整身份与依赖</summary>'+dump(m)+'</details>');
      for(const button of body.querySelectorAll('[data-preview]'))button.addEventListener('click',async()=>{
        const view=body.querySelector('#perf-preview');view.innerHTML='<p>校验并加载原件…</p>';
        try{
          const preview=await api('runs/'+enc(id)+'/file?preview=1&path='+enc(button.dataset.preview));
          const frames=preview.data?.[m.stream];
          if(Array.isArray(frames)&&frames.length&&frames.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0)){
            const slow=frames.map((ms,index)=>({ms,index})).sort((a,b)=>b.ms-a.ms).slice(0,20);
            view.innerHTML='<h2>'+esc(m.stream)+' · '+frames.length+' 帧</h2><p>每桶保留最高帧时，尖峰不平均抹除。横轴为桶内峰值的原帧序号；点击图点或下方帧序号查看同次采集状态。</p><div class="perf-chart">'+svgLine(peakRows(frames),['frame_ms'],{w:900,h:220,chart:'performance'})+'</div><div id="perf-frame-selected"></div><h3>最长20帧（原件序号从0开始）</h3>'+table(['帧序号','帧时'],slow.map(x=>['<button data-frame="'+x.index+'">'+x.index+'</button>',number(x.ms)+' ms']));
            const selectFrame=index=>{
              const times=preview.data[m.stream==='post_draw_ms'?'post_draw_elapsed_s':'frame_elapsed_s'];
              const elapsed=Array.isArray(times)?times[index]:null;
              const states=Array.isArray(preview.data.states)?preview.data.states:[];
              const prior=typeof elapsed==='number'?states.filter(s=>typeof s.elapsed_s==='number'&&s.elapsed_s<=elapsed).at(-1):null;
              view.querySelector('#perf-frame-selected').innerHTML='<h3>原帧 '+index+' · '+number(frames[index])+' ms</h3><p>同次采集时间 '+(typeof elapsed==='number'?number(elapsed)+' s':'未知；不猜测时间对齐')+'</p>'+(prior?dump(prior):'<p>没有可关联的同时间状态。</p>');
            };
            for(const dot of view.querySelectorAll('[data-tip-kind="dot"]')){dot.setAttribute('tabindex','0');dot.setAttribute('role','button');dot.addEventListener('click',()=>selectFrame(Number(dot.dataset.day)));dot.addEventListener('keydown',e=>{if(e.key==='Enter')selectFrame(Number(dot.dataset.day));});}
            for(const b of view.querySelectorAll('[data-frame]'))b.addEventListener('click',()=>selectFrame(Number(b.dataset.frame)));
          }else if(preview.format==='text')view.innerHTML='<h2>文本原件</h2><pre>'+esc(preview.text)+'</pre>';
          else if(preview.format==='json')view.innerHTML='<h2>JSON摘要 / 原件</h2>'+dump(preview.data);
          else view.innerHTML='<p>此格式需 '+esc(preview.viewer)+' 查看；使用上方SHA校验下载。</p>';
        }catch(e){view.innerHTML='<p role="alert">无法预览：'+esc(e.message)+'。原件可从上方下载。</p>';}
      });
    }else if(page==='compare'){
      const data=await api('runs?limit=100'),items=data.items||[];
      const options=items.map(r=>'<option value="'+esc(r.report_id)+'">'+esc(r.manifest?.case_id)+' / '+esc(r.manifest?.run_id)+'</option>').join('');
      set('<h1>比较 / 趋势</h1><p>同用例、机器、输入、引擎与指标版本才可比。单次观察只展示差值，不能确认回归。</p><form id="perf-compare"><label>基准观察 <select name="base">'+options+'</select></label><label>候选观察 <select name="candidate">'+options+'</select></label><button '+(items.length<2?'disabled':'')+'>比较</button></form><div id="perf-comparison"></div><section><h2>Conbench趋势</h2><p class="perf-note">尚未连接经验证的Conbench服务。此处没有历史显著性或正式基线成绩。</p></section>');
      const form=body.querySelector('form');
      if(query.get('base'))form.elements.base.value=query.get('base');if(query.get('candidate'))form.elements.candidate.value=query.get('candidate');
      const compare=async()=>{const result=body.querySelector('#perf-comparison');result.innerHTML='比较中…';try{const r=await api('compare?'+new URLSearchParams(new FormData(form))),c=r.comparison;result.innerHTML='<h2>'+esc(c.comparable?'可比观察（非准出）':'不可比')+'</h2>'+(c.mismatches.length?'<p>不匹配或未知：'+esc(c.mismatches.join(', '))+'</p>':'')+table(['指标','候选帧时变化'],Object.entries(c.deltas).map(([k,v])=>[esc(k),number(v)+'%']))+'<p>'+esc(c.reason)+'</p>';}catch(e){result.innerHTML='<p role="alert">'+esc(e.message)+'</p>';}};
      form.addEventListener('submit',e=>{e.preventDefault();compare();});if(query.get('base')&&query.get('candidate'))await compare();
    }else if(page==='integration'){
      const status=await api('status');set('<h1>集成与合线状态</h1><p class="perf-note">初版观察模式：自动发布关闭。配置存在不等于Jenkins已部署或实际采样通过。</p>'+table(['能力','实际状态'],[['Vault凭据',status.vault_credentials_configured?'已配置（不代表写入验证已通过）':'未配置'],['Conbench',esc(status.conbench.state)],['正式基线晋升',esc(status.baseline_approval)],['自动提单',String(status.auto_issue)],['自动发布perf',String(status.auto_publish)]])+'<h2>计划与资源约束</h2>'+dump(status.ci)+'<h2>最近CI运行（Vault）</h2>'+dump(status.integration_error?{error:status.integration_error}:status.recent_integrations));
    }else if(page==='catalog'){
      const data=await api('catalog'),cases=data.catalog?.cases||[];set('<h1>用例目录 / 导入</h1><p>先沿现有工具采集，再在本地校验、预览并显式上传。目录登记不代表用例已标定通过。</p>'+table(['用例','入口','时长 / 必需见证','验证状态'],cases.map(c=>[esc(c.id)+'<small>'+esc(c.title)+'</small>',esc(c.runner),esc(c.seconds)+'s<small>'+esc(c.witnesses?.join(' / '))+'</small>',esc(c.status)]))+'<h2>导入与上传</h2><pre>'+esc(data.import_command)+'\nstudio perf validate --source <bundle>\nstudio perf publish --source <bundle>\nstudio perf download --id <report UUID> --out <new directory></pre><p>凭据仅在本地服务端配置；网页不保存token。F3前录尚未接入，未启用录制时没有历史帧。</p><h2>本机待同步</h2>'+dump(data.pending));
    }else set('<p>未知性能页面。</p>');
  }catch(e){set('<h1>性能数据暂不可用</h1><p role="alert">'+esc(e.message)+'</p><p>检查Vault连接与项目权限；本地证据继续保留。不要将此状态视为通过。</p><button id="perf-retry">重试</button>');body.querySelector('#perf-retry')?.addEventListener('click',()=>renderPerformance(host,{svgLine,route,query}));}
}
