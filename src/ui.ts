export function uiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram</title>
<style>
:root{--bg:#fbfaf8;--panel:#ffffff;--ink:#1c1b19;--muted:#6d6a64;--line:#e7e3dc;--accent:#3b5bdb;--accent-ink:#ffffff;--warn:#b54708;--ok:#2f7d4f;--chip:#f1eee8}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--panel:#1d1c1a;--ink:#ecebe7;--muted:#9b978f;--line:#2f2d2a;--accent:#7c9cff;--accent-ink:#0d0d0c;--warn:#f0a35e;--ok:#6fcf97;--chip:#27251f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2;flex-wrap:wrap}
h1{font-size:16px;margin:0;letter-spacing:.02em}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav button{background:none;border:0;color:var(--muted);padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit}
nav button.on{background:var(--chip);color:var(--ink)}
main{max-width:980px;margin:0 auto;padding:16px 20px 60px}
.bar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
input,select,textarea{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
input[type=search]{flex:1;min-width:200px}
textarea{width:100%;min-height:90px}
button.b{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer}
button.p{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.meta{display:flex;gap:6px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-bottom:6px;align-items:center}
.chip{background:var(--chip);border-radius:999px;padding:1px 8px}
.k-profile{color:#8e44ad}.k-preference{color:var(--accent)}.k-decision{color:var(--ok)}.k-procedure{color:var(--warn)}
.title{font-weight:600;margin-bottom:2px}
.body{white-space:pre-wrap;word-break:break-word}
.acts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.acts button{font-size:12px;padding:3px 9px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.stat b{display:block;font-size:22px}
.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.empty{color:var(--muted);padding:30px;text-align:center}
@media (max-width:600px){main{padding:12px 16px 60px}header{padding:12px 16px}}
</style>
</head>
<body>
<header><h1>engram</h1><nav id="nav"></nav><span class="muted" id="status"></span></header>
<main id="main"></main>
<script>
const tabs=['Memories','Inbox','Conversations','Activity','Stats','Add'];
let tab=location.hash.slice(1)||'Memories';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,o={}){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});if(!r.ok)throw new Error(await r.text());return r.json()}
function nav(){$('#nav').innerHTML=tabs.map(t=>'<button class="'+(t===tab?'on':'')+'" onclick="go(\\''+t+'\\')">'+t+'</button>').join('')}
function go(t){tab=t;location.hash=t;nav();render()}
function card(m,extra=''){return '<div class="card" id="c_'+m.id+'"><div class="meta"><span class="chip k-'+m.kind+'">'+m.kind+'</span><span class="chip">'+esc(m.scope)+'</span><span>'+esc(m.trust)+'</span><span>imp '+m.importance+'</span><span>'+esc((m.updated||'').slice(0,10))+'</span>'+(m.pinned?'<span class="chip">pinned</span>':'')+(m.sensitive?'<span class="chip">sensitive</span>':'')+(m.status!=='active'?'<span class="chip">'+m.status+'</span>':'')+'<span class="muted">'+m.id+'</span></div><div class="title">'+esc(m.title)+'</div><div class="body">'+esc(m.body)+'</div>'+(m.source&&m.source.evidence?'<div class="muted" style="margin-top:6px">evidence: "'+esc(m.source.evidence)+'"</div>':'')+'<div class="acts">'+extra+'</div></div>'}
function memActs(m){return '<button class="b" onclick="edit(\\''+m.id+'\\')">Edit</button><button class="b" onclick="patch(\\''+m.id+'\\',{pinned:'+(!m.pinned)+'})">'+(m.pinned?'Unpin':'Pin')+'</button><button class="b" onclick="patch(\\''+m.id+'\\',{status:\\'outdated\\'})">Outdated</button><button class="b" onclick="forget(\\''+m.id+'\\')">Forget</button>'}
async function render(){const el=$('#main');try{
if(tab==='Memories'){el.innerHTML='<div class="bar"><input type="search" id="q" placeholder="Search memories" onkeydown="if(event.key===\\'Enter\\')render()"><select id="kind" onchange="render()"><option value="">all kinds</option>'+['profile','preference','fact','decision','procedure','episode','reference'].map(k=>'<option>'+k+'</option>').join('')+'</select></div><div id="list" class="muted">Loading</div>';
 const q=sessionStorage.getItem('q')||'',k=sessionStorage.getItem('k')||'';$('#q').value=q;$('#kind').value=k;$('#q').oninput=e=>sessionStorage.setItem('q',e.target.value);$('#kind').onchange=e=>{sessionStorage.setItem('k',e.target.value);render()};
 let ms;if(q){const r=await api('/v1/search',{method:'POST',body:JSON.stringify({query:q,kinds:k?[k]:undefined,limit:30})});ms=r.memories}else{ms=(await api('/v1/memories?limit=200'+(k?'&kind='+k:''))).memories}
 $('#list').innerHTML=ms.length?ms.map(m=>card(m,memActs(m))).join(''):'<div class="empty">Nothing here yet.</div>';$('#list').className=''}
if(tab==='Inbox'){const r=await api('/v1/inbox');el.innerHTML='<p class="muted">Changes that need your OK: quarantined writes and machine edits to things you stated yourself.</p>'+(r.pending.length?r.pending.map(m=>card(m,'<button class="b p" onclick="inbox(\\''+m.id+'\\',\\'approve\\')">Approve</button><button class="b" onclick="inbox(\\''+m.id+'\\',\\'reject\\')">Reject</button>'+(m.flags&&m.flags.length?'<span class="muted">'+esc(m.flags.join(', '))+'</span>':''))).join(''):'<div class="empty">Inbox is empty.</div>')}
if(tab==='Conversations'){const r=await api('/v1/sessions?limit=80');el.innerHTML='<table><tr><th>When</th><th>Harness</th><th>Title</th><th>Turns</th><th>Extracted</th></tr>'+r.sessions.map(s=>'<tr><td>'+esc(s.last_seen_at.slice(0,16).replace('T',' '))+'</td><td>'+esc(s.harness)+'</td><td>'+esc(s.title||s.key)+'<div class="muted">'+esc(s.scope)+'</div></td><td>'+s.turn_count+'</td><td>'+esc(s.extract_state)+'</td></tr>').join('')+'</table>'}
if(tab==='Activity'){const r=await api('/v1/ops?limit=150');el.innerHTML='<table><tr><th>When</th><th>Op</th><th>Memory</th><th>By</th><th>Why</th><th></th></tr>'+r.ops.map(o=>'<tr><td>'+esc(o.ts.slice(0,16).replace('T',' '))+'</td><td>'+esc(o.op)+'</td><td>'+esc(o.memory_id||'')+'</td><td>'+esc(o.actor||'')+'</td><td>'+esc(o.reason||'')+'</td><td>'+(o.undone?'<span class="muted">undone</span>':['undo','purge'].includes(o.op)?'':'<button class="b" onclick="undo('+o.id+')">Undo</button>')+'</td></tr>').join('')+'</table>'}
if(tab==='Stats'){const s=await api('/v1/stats');const n=(a,k)=>a.reduce((x,y)=>x+(y[k]||0),0);const st=Object.fromEntries(s.byStatus.map(x=>[x.status,x.n]));
 el.innerHTML='<div class="stats"><div class="stat"><b>'+(st.active||0)+'</b>active memories</div><div class="stat"><b>'+(st.pending||0)+'</b>pending review</div><div class="stat"><b>'+s.sessions+'</b>sessions</div><div class="stat"><b>'+s.turns+'</b>conversation turns</div><div class="stat"><b>'+s.ops+'</b>ops logged</div><div class="stat"><b>'+s.unembedded+'</b>awaiting embedding</div></div><div class="card"><div class="title">By kind</div>'+s.byKind.map(x=>esc(x.kind)+': '+x.n).join(' · ')+'</div><div class="card"><div class="title">By scope</div>'+s.byScope.map(x=>esc(x.scope)+': '+x.n).join('<br>')+'</div><div class="card"><div class="title">Jobs</div>'+(s.jobs.map(x=>esc(x.status)+': '+x.n).join(' · ')||'none')+'<div class="muted">last consolidate '+esc(s.last_consolidate||'never')+' · last backup '+esc(s.last_backup||'never')+' · last scan '+esc(s.last_scan||'never')+'</div></div>'}
if(tab==='Add'){el.innerHTML='<div class="card"><div class="title">Remember something</div><textarea id="t" placeholder="One fact, preference, decision or procedure"></textarea><div class="bar" style="margin-top:8px"><select id="ak"><option value="">infer kind</option>'+['profile','preference','fact','decision','procedure','reference'].map(k=>'<option>'+k+'</option>').join('')+'</select><input id="as" placeholder="scope (global or project path)" value="global"><button class="b p" onclick="add()">Save</button></div><div id="ar" class="muted"></div></div>'}
}catch(e){el.innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
async function patch(id,b){await api('/v1/memories/'+id,{method:'PATCH',body:JSON.stringify(b)});render()}
async function forget(id){await api('/v1/memories/'+id+'?reason=forgotten+in+ui',{method:'DELETE'});render()}
async function inbox(id,a){await api('/v1/inbox/'+id+'/'+a,{method:'POST'});render()}
async function undo(id){await api('/v1/undo/'+id,{method:'POST'});render()}
async function add(){const r=await api('/v1/memories',{method:'POST',body:JSON.stringify({text:$('#t').value,kind:$('#ak').value||undefined,scope:$('#as').value,trust:'user',harness:'ui'})});$('#ar').textContent=r.message;$('#t').value=''}
function edit(id){const c=$('#c_'+id);const b=c.querySelector('.body');const t=document.createElement('textarea');t.value=b.textContent;b.replaceWith(t);const acts=c.querySelector('.acts');acts.innerHTML='<button class="b p">Save</button><button class="b">Cancel</button>';acts.children[0].onclick=()=>patch(id,{text:t.value});acts.children[1].onclick=render}
api('/healthz').then(h=>$('#status').textContent='up '+h.uptime_s+'s · '+(h.embedder_loaded?'semantic on':'semantic loading')).catch(()=>{});
nav();render();
</script>
</body>
</html>`;
}
