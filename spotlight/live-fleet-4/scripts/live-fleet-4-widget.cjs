#!/usr/bin/env node
/* Live Fleet 4 — in-place DOM updates via generic viewExportSnapshot (Option B). */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { SNAPSHOT_FILE, collect, writeSnapshot } = require('./live-fleet-4-collector.cjs');

const OUTPUT_HTML = 'live-fleet-4.html';
const POLL_MS = 15000;
const SHELL_VERSION = 12;

function resolveDaemonCommand() {
	const daemonPath = path.join(__dirname, 'live-fleet-4-daemon.mjs');
	const startPath = path.join(process.env.AGENTIDE_WORKSPACE_ROOT || process.cwd(), '.agent-hippo/scripts/start-live-fleet-4.sh');
	const workspaceRoot = (process.env.AGENTIDE_WORKSPACE_ROOT || '').trim();
	if (fs.existsSync(startPath)) {
		return `bash ${path.relative(workspaceRoot || process.cwd(), startPath).split(path.sep).join('/')}`;
	}
	if (workspaceRoot) {
		const rel = path.relative(workspaceRoot, daemonPath);
		if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
			return `node ${rel.split(path.sep).join('/')}`;
		}
	}
	return `node ${daemonPath}`;
}

function writeIfChanged(filePath, content) {
	try {
		if (fs.readFileSync(filePath, 'utf8') === content) return false;
	} catch { /* write */ }
	fs.writeFileSync(filePath, content, 'utf8');
	return true;
}

function buildShellHtml(meta, initialPayload) {
	const metaJson = JSON.stringify(meta);
	// Shell uses empty INITIAL — live data arrives via viewExportSnapshot (Option B).
	const initialJson = JSON.stringify(initialPayload || {
		generatedAt: '', totals: {}, running: [], finished: [], history: [], workflows: [],
	});
	return `<!doctype html>
<html data-live-fleet-shell="${SHELL_VERSION}">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Live Fleet 4 — Workflows</title>
<style>
:root{color-scheme:dark;--bg:#070b14;--surface:#0f172a;--surface2:#111827;--border:#1e293b;--muted:#94a3b8;--text:#e2e8f0;--orch:#34d399;--orch-bg:rgba(52,211,153,.08);--live:#4ade80}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
#header{padding:12px 16px;background:linear-gradient(180deg,#0f172a,#0b1220);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
#header h1{margin:0;font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}
.live-dot.on{background:var(--live);box-shadow:0 0 8px rgba(74,222,128,.6);animation:blink 1.4s ease infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.45}}
#header p{margin:4px 0 0;color:var(--muted);font-size:11px}
#summary{display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--surface2)}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 12px;min-width:80px}
.kpi .label{font-size:10px;color:var(--muted);text-transform:uppercase}.kpi .value{font-size:18px;font-weight:700}
#controls{display:flex;gap:8px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}
#controls input{background:#0b1220;color:var(--text);border:1px solid #334155;border-radius:6px;padding:6px 10px;flex:1;min-width:140px;max-width:280px}
.btn{background:#1e3a5f;color:#93c5fd;border:1px solid #3b82f6;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}
#msg{padding:6px 16px;color:#fbbf24;font-size:11px;min-height:16px}
#updated{margin-left:auto;color:var(--muted);font-size:11px}
#lanes{padding:12px 16px 24px;display:flex;flex-direction:column;gap:14px}
.lane{border:1px solid var(--border);border-radius:12px;overflow:hidden;background:rgba(15,23,42,.5)}
.lane-head{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--surface2);cursor:pointer;user-select:none}
.lane-head:hover{opacity:.92}
.lane-toggle{width:16px;color:var(--muted);font-size:10px}
.lane.collapsed .lane-toggle::before{content:'▶'}.lane:not(.collapsed) .lane-toggle::before{content:'▼'}
.lane-title{margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.lane.running .lane-title{color:var(--live)}.lane.finished .lane-title{color:#a78bfa}
.lane-count{color:var(--muted);font-weight:600}
.lane-body{padding:12px;display:flex;flex-direction:column;gap:12px}
.lane.collapsed .lane-body{display:none}
.wf-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.wf-card.running-wf{border-color:rgba(74,222,128,.35)}
.wf-head{padding:12px 14px 8px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.wf-title{font-size:14px;font-weight:700;margin:0}.wf-sub{font-size:11px;color:var(--muted);margin-top:2px}
.wf-meta{font-size:10px;color:var(--muted);margin-top:4px;line-height:1.5}
.wf-meta a,.step-meta a,.step-artifact a,.artifact-link{color:#93c5fd;text-decoration:none;border-bottom:1px dotted #3b82f6;background:none;border:none;padding:0;font:inherit;cursor:pointer}
.wf-meta a:hover,.step-meta a:hover,.step-artifact a:hover,.artifact-link:hover{color:#bfdbfe}
.step-meta{font-size:10px;color:var(--muted);margin-top:3px}
.step-artifact{font-size:10px;margin-top:4px}
.wf-status{font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 10px;border-radius:999px;align-self:start}
.wf-status.in_progress{background:rgba(74,222,128,.15);color:#4ade80;border:1px solid #22c55e}
.wf-status.done{background:rgba(148,163,184,.12);color:#94a3b8;border:1px solid #475569}
.orch{margin:10px 14px 0;padding:10px 12px;background:var(--orch-bg);border:1px solid rgba(52,211,153,.35);border-radius:8px;display:flex;gap:10px}
.orch-icon{width:32px;height:32px;border-radius:8px;background:rgba(52,211,153,.2);color:var(--orch);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.orch-tag{font-size:9px;font-weight:700;text-transform:uppercase;color:var(--orch)}
.orch-label{font-size:13px;font-weight:600}.orch-agent{font-size:10px;color:var(--muted)}
.orch-summary{font-size:11px;color:#cbd5e1;margin-top:4px;font-style:italic}
.pipeline{padding:10px 14px 14px}
.step{display:grid;grid-template-columns:34px 1fr auto;gap:8px;padding:8px 0;position:relative}
.step:not(:last-child)::after{content:'';position:absolute;left:16px;top:40px;bottom:0;width:2px;background:linear-gradient(180deg,var(--step-color,#334155),transparent);opacity:.45}
.step-num{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;border:2px solid var(--step-color);color:var(--step-color);background:rgba(0,0,0,.25);z-index:1;position:relative}
.step.in_progress .step-num{animation:pulse 1.5s ease infinite;box-shadow:0 0 0 3px color-mix(in srgb,var(--step-color) 30%,transparent)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}
.step-label{font-size:13px;font-weight:600}.step-agent{font-size:10px;color:var(--muted)}
.step-summary{font-size:11px;color:#cbd5e1;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.step-badge{font-size:9px;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:999px;margin-top:4px;align-self:start}
.step-badge.in_progress{background:rgba(74,222,128,.15);color:#4ade80;border:1px solid #22c55e}
.step-badge.done{background:rgba(148,163,184,.12);color:#94a3b8;border:1px solid #475569}
.step-badge.pending{background:rgba(51,65,85,.5);color:#64748b;border:1px solid #334155}
.empty{padding:20px;text-align:center;color:var(--muted);font-size:12px}
.empty code{background:#111827;padding:2px 6px;border-radius:4px;font-size:10px}
</style>
</head>
<body data-fleet-snapshot-shell="1">
<div id="header"><h1><span class="live-dot" id="live-dot"></span>Live Fleet 4</h1><p>Real-time multi-agent workflows — in-place updates, no iframe flicker</p></div>
<div id="summary"></div>
<div id="controls">
  <input id="search" type="search" placeholder="Filter workflows…" />
  <span id="updated"></span>
</div>
<div id="msg"></div>
<div id="lanes">
  <section class="lane running" data-lane="running"><div class="lane-head"><span class="lane-toggle"></span><h3 class="lane-title">Running <span class="lane-count" data-count="running">(0)</span></h3></div><div class="lane-body" data-lane-body="running"></div></section>
  <section class="lane finished" data-lane="finished"><div class="lane-head"><span class="lane-toggle"></span><h3 class="lane-title">Finished <span class="lane-count" data-count="finished">(0)</span></h3></div><div class="lane-body" data-lane-body="finished"></div></section>
</div>
<script>
const META = ${metaJson};
const INITIAL = ${initialJson};
const POLL_MS = ${POLL_MS};
let DATA = normalizePayload(INITIAL);
const laneCollapsed = { running: false, finished: false };
try{
  const saved=sessionStorage.getItem('live-fleet-4-lanes-v8');
  if(saved){const p=JSON.parse(saved);if(p&&typeof p==='object'){Object.assign(laneCollapsed,p);}}
}catch(e){}
let lastSnapshotKey='';

function persistLaneCollapse(){
  try{sessionStorage.setItem('live-fleet-4-lanes-v8',JSON.stringify(laneCollapsed));}catch(e){}
}
function snapshotKey(payload){
  const n=normalizePayload(payload);
  return JSON.stringify({totals:n.totals,running:n.running,finished:n.finished});
}
function preserveScroll(fn){
  const el=document.scrollingElement||document.documentElement;
  const top=el.scrollTop;
  fn();
  el.scrollTop=top;
}

function normalizePayload(p) {
  p = p && typeof p === 'object' ? p : {};
  const running = Array.isArray(p.running) ? p.running : (p.workflows || []).filter(w => w.status === 'in_progress');
  const history = Array.isArray(p.history) ? p.history : (p.workflows || []).filter(w => w.kind === 'history');
  const legacyFinished = Array.isArray(p.finished) ? p.finished : (p.workflows || []).filter(w => w.kind !== 'history' && w.status === 'done');
  const finished = [...history, ...legacyFinished];
  return { generatedAt: p.generatedAt || '', totals: p.totals || {}, running, finished, history, diagnostics: p.diagnostics || {} };
}
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtTime(iso){
  if(!iso)return'';
  const s=String(iso);
  const m=s.match(/\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2}(?::\d{2})?)/);
  if(m)return esc(m[1]+'-'+m[2]+' '+m[3]);
  return esc(s.slice(5,19).replace('T',' '));
}
function fmtRange(start,end){
  const a=fmtTime(start), b=fmtTime(end);
  if(a&&b)return a+' - '+b;
  return a||b||'';
}
function basename(p){return String(p||'').split('/').pop()||String(p||'');}
function openArtifact(path){if(!path)return;postToHost({type:'openArtifact',path:String(path)});}
function artifactLink(path,label){
  if(!path)return'';
  const text=esc(label||basename(path));
  return '<button type="button" class="artifact-link" data-artifact="'+esc(path)+'" title="'+esc(path)+'">'+text+'</button>';
}
function wfKey(wf){return String(wf.workflowId||'')+'::'+String(wf.runId||wf.startedAt||'');}
function statusLabel(st){if(st==='in_progress')return'Running';if(st==='done')return'Complete';return'Pending';}
function postToHost(payload){const msg=Object.assign({source:'agentide-wow-widget'},payload);try{const api=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():null;if(api){api.postMessage(msg);return;}}catch(e){}try{window.parent.postMessage(msg,'*');}catch(e){}}
function requestSnapshot(){postToHost({type:'requestViewExportSnapshot'});}

function filterList(list){
  const q=String(document.getElementById('search').value||'').trim().toLowerCase();
  if(!q)return list;
  return list.filter(wf=>{const hay=[wf.title,wf.subtitle,wf.workflowId,wf.runId,(wf.orchestrator&&wf.orchestrator.agent)].join(' ').toLowerCase();return hay.includes(q);});
}

function renderSteps(steps){
  if(!steps.length)return '<div class="empty" style="padding:8px">No steps yet</div>';
  return steps.slice().sort((a,b)=>(a.step||0)-(b.step||0)).map(s=>{
    const c=s.color||'#94a3b8', st=s.status||'pending';
    const times=fmtRange(s.startedAt,s.finishedAt);
    const art=s.artifact?'<div class="step-artifact">'+artifactLink(s.artifact,'output')+'</div>':'';
    return '<div class="step '+esc(st)+'" style="--step-color:'+esc(c)+'"><div class="step-num">'+esc(s.step)+'</div><div><div class="step-label">'+esc(s.label||s.agent)+'</div><div class="step-agent">'+esc(s.agent)+'</div>'+(times?'<div class="step-meta">'+times+'</div>':'')+(s.summary?'<div class="step-summary" title="'+esc(s.summary)+'">'+esc(s.summary)+'</div>':'')+art+'</div><span class="step-badge '+esc(st)+'">'+esc(statusLabel(st))+'</span></div>';
  }).join('');
}

function renderCardInner(wf){
  const orch=wf.orchestrator||{};
  const start=wf.startedAt||'';
  const end=wf.finishedAt||wf.archivedAt||'';
  const runArtifact=wf.artifact||wf.sourcePath||'';
  const metaParts=[wf.runId?'run '+esc(wf.runId):'',fmtRange(start,end)].filter(Boolean);
  const metaHtml=metaParts.join(' · ')+(runArtifact?('<br>'+artifactLink(runArtifact,'workflow record')):'');
  return '<div class="wf-head"><div><h2 class="wf-title">'+esc(wf.title||wf.workflowId)+'</h2>'+(wf.subtitle?'<div class="wf-sub">'+esc(wf.subtitle)+'</div>':'')+'<div class="wf-meta">'+metaHtml+'</div></div><span class="wf-status '+esc(wf.status||'pending')+'">'+esc(statusLabel(wf.status))+'</span></div><div class="orch"><div class="orch-icon">&#9670;</div><div><div class="orch-tag">Orchestrator</div><div class="orch-label">'+esc(orch.label||orch.agent||'Coordinator')+'</div><div class="orch-agent">'+esc(orch.agent||'')+'</div>'+(orch.summary?'<div class="orch-summary">'+esc(orch.summary)+'</div>':'')+'</div></div><div class="pipeline">'+renderSteps(wf.steps||[])+'</div>';
}
function wfSignature(wf){
  const orch=wf.orchestrator||{};
  const steps=(wf.steps||[]).slice().sort((a,b)=>(a.step||0)-(b.step||0)).map(s=>[s.step,s.status,s.summary,s.label,s.agent,s.startedAt,s.finishedAt,s.artifact].join(':')).join('|');
  return [wf.workflowId,wf.runId,wf.status,wf.title,wf.subtitle,wf.updatedAt,wf.startedAt,wf.finishedAt,wf.archivedAt,wf.artifact,orch.status,orch.summary,steps].join('\\n');
}
function renderWfCardElement(wf,extraClass){
  const card=document.createElement('article');
  card.className='wf-card '+esc(extraClass||'');
  card.setAttribute('data-wf-key',wfKey(wf));
  card.setAttribute('data-sig',wfSignature(wf));
  card.innerHTML=renderCardInner(wf);
  return card;
}
function updateWfCardElement(card,wf,extraClass){
  const newSig=wfSignature(wf);
  if(card.getAttribute('data-sig')===newSig)return;
  card.setAttribute('data-sig',newSig);
  card.className='wf-card '+esc(extraClass||'');
  card.innerHTML=renderCardInner(wf);
}
function syncLaneCards(bodyEl,list,emptyMsg,cardClass){
  const want=list.map(wfKey);
  const existing=new Map();
  bodyEl.querySelectorAll('[data-wf-key]').forEach(el=>existing.set(el.getAttribute('data-wf-key'),el));
  for(const [k,el] of existing){if(!want.includes(k))el.remove();}
  if(!list.length){
    if(!bodyEl.querySelector('.empty'))bodyEl.innerHTML='<div class="empty">'+emptyMsg+'</div>';
    return;
  }
  const empty=bodyEl.querySelector('.empty');if(empty)empty.remove();
  let anchor=null;
  for(const wf of list){
    const k=wfKey(wf);
    let card=existing.get(k);
    if(!card){card=renderWfCardElement(wf,cardClass);bodyEl.appendChild(card);}
    else{updateWfCardElement(card,wf,cardClass);}
    const next=anchor?anchor.nextElementSibling:bodyEl.firstElementChild;
    if(card!==next){bodyEl.insertBefore(card,anchor?anchor.nextSibling:bodyEl.firstChild);}
    anchor=card;
  }
}
function renderSummary(){
  const t=DATA.totals||{};
  const finishedCount=(DATA.finished||[]).length;
  const kpis=[['Running',t.running||0],['Finished',finishedCount],['Steps active',t.stepsActive||0]];
  const summary=document.getElementById('summary');
  const existing=summary.querySelectorAll('.kpi');
  kpis.forEach(([label,value],index)=>{
    let el=existing[index];
    if(!el){el=document.createElement('div');el.className='kpi';el.innerHTML='<div class="label"></div><div class="value"></div>';summary.appendChild(el);}
    el.querySelector('.label').textContent=label;
    el.querySelector('.value').textContent=String(value);
  });
  while(summary.children.length>kpis.length){summary.lastElementChild.remove();}
  document.getElementById('updated').textContent='Updated '+(DATA.generatedAt||'—');
  const live=((t.running||0)>0)||(DATA.diagnostics&&DATA.diagnostics.cliActive);
  document.getElementById('live-dot').classList.toggle('on',!!live);
}
function renderLanes(){
  const running=filterList(DATA.running||[]);
  const finished=filterList(DATA.finished||[]);
  document.querySelector('[data-count="running"]').textContent='('+running.length+')';
  document.querySelector('[data-count="finished"]').textContent='('+finished.length+')';
  syncLaneCards(document.querySelector('[data-lane-body="running"]'),running,'No workflows running. Start a pipeline — updates appear here in real time.','running-wf');
  syncLaneCards(document.querySelector('[data-lane-body="finished"]'),finished,'No finished runs yet. Completed workflows are archived to <code>fleet-workflows/history/</code>.','');
  for(const lane of ['running','finished']){
    document.querySelector('.lane[data-lane="'+lane+'"]').classList.toggle('collapsed',!!laneCollapsed[lane]);
  }
  const msgEl=document.getElementById('msg');
  const t=DATA.totals||{};
  const live=((t.running||0)>0)||(DATA.diagnostics&&DATA.diagnostics.cliActive);
  if(!META.daemonHint&&!live){
    msgEl.textContent='Tip: run '+ (META.daemonCommand||'start-live-fleet-4.sh') +' for background refresh every '+ (POLL_MS/1000) +'s';
  }else{msgEl.textContent='';}
}
function renderAll(){preserveScroll(function(){renderSummary();renderLanes();});}
function applySnapshot(payload){
  if(!payload||typeof payload!=='object')return;
  const key=snapshotKey(payload);
  if(key===lastSnapshotKey)return;
  lastSnapshotKey=key;
  const prevGeneratedAt=DATA.generatedAt||'';
  DATA=normalizePayload(payload);
  if(!DATA.generatedAt){DATA.generatedAt=prevGeneratedAt;}
  renderAll();
}

document.getElementById('search').addEventListener('input',renderLanes);
document.getElementById('lanes').addEventListener('click',(e)=>{
  const artLink=e.target.closest('[data-artifact]');
  if(artLink){e.preventDefault();e.stopPropagation();openArtifact(artLink.getAttribute('data-artifact'));return;}
  const head=e.target.closest('.lane-head');
  if(!head)return;
  const lane=head.closest('.lane');const id=lane&&lane.getAttribute('data-lane');
  if(!id)return;laneCollapsed[id]=!laneCollapsed[id];lane.classList.toggle('collapsed',laneCollapsed[id]);persistLaneCollapse();
});

renderAll();
requestSnapshot();
setInterval(requestSnapshot,POLL_MS);
window.addEventListener('message',(e)=>{
  const d=e.data;
  if(!d||typeof d!=='object')return;
  if(d.type!=='viewExportSnapshot'&&d.type!=='liveFleetSnapshot')return;
  applySnapshot(d.payload);
});
if(META.exportRel&&window.location.protocol==='file:'){
  const pollExport=function(){
    fetch(META.exportRel+'?t='+Date.now()).then(function(r){if(!r.ok)throw new Error('export '+r.status);return r.json();}).then(applySnapshot).catch(function(){});
  };
  pollExport();
  setInterval(pollExport,POLL_MS);
}
</script>
</body></html>`;
}

function ensureStaticShell(chartDir, meta, initialPayload) {
	const htmlPath = path.join(chartDir, OUTPUT_HTML);
	let needsRewrite = true;
	try {
		const existing = fs.readFileSync(htmlPath, 'utf8');
		needsRewrite = !existing.includes('data-live-fleet-shell="' + SHELL_VERSION + '"');
	} catch {
		needsRewrite = true;
	}
	if (!needsRewrite) {
		return false;
	}
	return writeIfChanged(htmlPath, buildShellHtml(meta, initialPayload));
}

function readSnapshot(exportDir) {
	const exportPath = path.join(exportDir, SNAPSHOT_FILE);
	try {
		return { ok: true, exportPath, payload: JSON.parse(fs.readFileSync(exportPath, 'utf8')) };
	} catch (error) {
		const isEnoent = error && (error.code === 'ENOENT' || String(error.message || '').includes('ENOENT'));
		return {
			ok: isEnoent,
			exportPath,
			payload: { generatedAt: new Date().toISOString(), totals: {}, running: [], finished: [], history: [], workflows: [] },
		};
	}
}

function runCollector(exportDir) {
	if (process.env.LIVE_FLEET_SKIP_COLLECTOR === '1') return;
	spawnSync(process.execPath, [path.join(__dirname, 'live-fleet-4-collector.cjs')], {
		env: { ...process.env, LIVE_FLEET_EXPORT_DIR: exportDir, LIVE_FLEET_SKIP_WIDGET: '1' },
		encoding: 'utf8',
		timeout: 30_000,
	});
}

function main() {
	const viewRoot = path.join(__dirname, '..');
	const chartDir = process.env.AGENTIDE_CHART_DIR || path.join(viewRoot, 'charts');
	const exportDir = process.env.AGENTIDE_EXPORT_DIR || path.join(viewRoot, 'exports');
	fs.mkdirSync(chartDir, { recursive: true });
	fs.mkdirSync(exportDir, { recursive: true });

	runCollector(exportDir);
	let snapshot = readSnapshot(exportDir);
	if (!snapshot.ok && !(snapshot.payload.workflows || []).length) {
		const payload = collect({ exportDir, workspaceRoot: process.env.AGENTIDE_WORKSPACE_ROOT });
		writeSnapshot(exportDir, payload);
		snapshot = readSnapshot(exportDir);
	}

	const payload = collect({ exportDir, workspaceRoot: process.env.AGENTIDE_WORKSPACE_ROOT });
	writeSnapshot(exportDir, payload);

	const shellMeta = {
		ok: snapshot.ok,
		exportRel: '../exports/' + SNAPSHOT_FILE,
		daemonHint: Boolean(process.env.LIVE_FLEET_DAEMON),
		daemonCommand: resolveDaemonCommand(),
		workspaceRoot: process.env.AGENTIDE_WORKSPACE_ROOT || process.cwd(),
	};
	const emptyInitial = { generatedAt: '', totals: {}, running: [], finished: [], history: [], workflows: [] };
	const shellWritten = ensureStaticShell(chartDir, shellMeta, emptyInitial);
	console.log(
		`[live-fleet-4-widget] run=${payload.totals.running} fin=${payload.totals.finished} hist=${payload.totals.history}`
		+ (shellWritten ? ` (shell v${SHELL_VERSION})` : ''),
	);
}

main();
