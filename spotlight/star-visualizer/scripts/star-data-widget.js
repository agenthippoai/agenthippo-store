#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const OUTPUT_HTML = 'star-data-widget.html';

function isOutputDisabled(filename) {
	const raw = String(process.env.AGENTIDE_DISABLED_CHARTS || '').trim();
	if (!raw) {
		return false;
	}
	const disabled = new Set(
		raw
			.split(',')
			.map((entry) => path.basename(entry.trim()).toLowerCase())
			.filter(Boolean),
	);
	return disabled.has(path.basename(filename).toLowerCase());
}

function listCsvFiles(dataRoot) {
	const results = [];
	function walk(dir) {
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
				results.push(full);
			}
		}
	}
	walk(dataRoot);
	return results.sort((a, b) => a.localeCompare(b));
}

function parseMetadata(lines) {
	const meta = {};
	for (const line of lines) {
		if (!line.startsWith('#')) {
			break;
		}
		const m = line.match(/^#\s*([a-zA-Z0-9_]+)=(.*)$/);
		if (m) {
			meta[m[1]] = m[2].trim();
		}
	}
	return meta;
}

function splitCsvLine(line) {
	const out = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (ch === ',' && !inQuotes) {
			out.push(cur.trim());
			cur = '';
			continue;
		}
		cur += ch;
	}
	out.push(cur.trim());
	return out;
}

function parseCsvFile(filePath) {
	const rel = filePath;
	const raw = fs.readFileSync(filePath, 'utf8');
	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const meta = parseMetadata(lines);
	const dataLines = lines.filter((line) => !line.startsWith('#'));
	if (dataLines.length < 2) {
		return { rel, meta, columns: [], rows: [], error: 'Not enough rows' };
	}
	const columns = splitCsvLine(dataLines[0]).map((c) => c.replace(/^"|"$/g, ''));
	const rows = [];
	for (let i = 1; i < dataLines.length; i += 1) {
		const cells = splitCsvLine(dataLines[i]);
		if (cells.length !== columns.length) {
			continue;
		}
		const row = {};
		for (let c = 0; c < columns.length; c += 1) {
			const key = columns[c];
			const value = cells[c].replace(/^"|"$/g, '');
			const num = Number(value);
			row[key] = Number.isFinite(num) && value !== '' ? num : value;
		}
		rows.push(row);
	}
	return { rel, meta, columns, rows, error: null };
}

function numericColumns(columns, rows) {
	return columns.filter((col) => rows.some((row) => typeof row[col] === 'number'));
}

function labelColumn(columns, rows) {
	const preferred = ['date', 'month', 'period', 'day', 'timestamp'];
	for (const key of preferred) {
		if (columns.includes(key)) {
			return key;
		}
	}
	for (const col of columns) {
		if (rows.some((row) => typeof row[col] === 'string')) {
			return col;
		}
	}
	return columns[0] || 'index';
}

function buildFallbackHtml(message) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Star Visualizer</title></head><body style="font-family:ui-sans-serif,system-ui;background:#0b1220;color:#e2e8f0;margin:0;padding:20px;"><h2 style="margin:0 0 8px;">Star Visualizer</h2><p style="opacity:.85;">${message}</p></body></html>`;
}

function buildHtml(datasets, dataRoot, primaryColor) {
	const payload = { dataRoot, datasets, primaryColor: primaryColor || '#38bdf8' };
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Star Visualizer</title>
<style>
body{margin:0;background:#0b1220;color:#e2e8f0;font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
.wrap{padding:14px;max-width:1100px}
.title{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.title h2{margin:0;font-size:18px}
.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#132341;color:#93c5fd;border:1px solid #1d4ed8}
.controls{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:8px;margin-bottom:10px}
@media (max-width:760px){.controls{grid-template-columns:1fr}}
label{font-size:11px;color:#94a3b8;display:block;margin-bottom:4px}
select{width:100%;background:#111827;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:7px 8px}
.meta{font-size:11px;color:#94a3b8;margin:0 0 10px;min-height:16px}
.chart-card{background:#0f172a;border:1px solid #1f2937;border-radius:12px;padding:10px}
svg{width:100%;height:320px;display:block}
.axis text{fill:#94a3b8;font-size:10px}
.axis line,.axis path{stroke:#334155}
.line{fill:none;stroke-width:2.2}
.area{opacity:.18}
.point{fill:#38bdf8;stroke:#0ea5e9;stroke-width:1}
.point:hover{r:5}
.tooltip{position:fixed;pointer-events:none;background:#111827;border:1px solid #334155;border-radius:8px;padding:6px 8px;font-size:11px;color:#e2e8f0;display:none;z-index:20;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.legend span{font-size:11px;color:#cbd5e1;display:inline-flex;align-items:center;gap:5px}
.swatch{width:10px;height:10px;border-radius:999px;display:inline-block}
.empty{padding:24px;text-align:center;color:#94a3b8}
</style></head>
<body><div class="wrap">
<div class="title"><h2>Star Visualizer</h2><div class="pill">Interactive HTML</div></div>
<div class="controls">
  <div><label for="file-select">Data file</label><select id="file-select"></select></div>
  <div><label for="metric-select">Metric</label><select id="metric-select"></select></div>
  <div><label for="metric2-select">Compare (optional)</label><select id="metric2-select"><option value="">— none —</option></select></div>
</div>
<div id="meta" class="meta"></div>
<div class="chart-card"><svg id="chart" viewBox="0 0 900 320" role="img" aria-label="Data trend chart"></svg><div id="legend" class="legend"></div></div>
<div id="tooltip" class="tooltip"></div>
</div>
<script>
const data=${JSON.stringify(payload)};
const esc=(v)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fileSelect=document.getElementById('file-select');
const metricSelect=document.getElementById('metric-select');
const metric2Select=document.getElementById('metric2-select');
const metaEl=document.getElementById('meta');
const svg=document.getElementById('chart');
const legendEl=document.getElementById('legend');
const tooltip=document.getElementById('tooltip');
const colors=[data.primaryColor||'#38bdf8','#a78bfa','#34d399','#f472b6'].filter((c,i,a)=>a.indexOf(c)===i);

function relPath(full){return String(full||'').replace(data.dataRoot+'/','').replace(data.dataRoot+'\\\\','');}

function currentDataset(){
  const idx=Number(fileSelect.value||0);
  return data.datasets[idx]||null;
}

function fillFileSelect(){
  if(!data.datasets.length){
    fileSelect.innerHTML='<option value="">No CSV files in data/</option>';
    return;
  }
  fileSelect.innerHTML=data.datasets.map((d,i)=>'<option value="'+i+'">'+esc(relPath(d.rel))+' ('+d.rows.length+' rows)</option>').join('');
}

function fillMetricSelects(ds){
  const nums=ds.numericColumns||[];
  metricSelect.innerHTML=nums.map((c)=>'<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');
  metric2Select.innerHTML='<option value="">— none —</option>'+nums.map((c)=>'<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');
  if(nums.includes('cumulative_stars')) metricSelect.value='cumulative_stars';
  else if(nums.includes('new_stars')) metricSelect.value='new_stars';
  else if(nums[0]) metricSelect.value=nums[0];
}

function formatMeta(ds){
  const parts=[];
  if(ds.meta && ds.meta.repo) parts.push('repo='+ds.meta.repo);
  if(ds.meta && ds.meta.method) parts.push('method='+ds.meta.method);
  if(ds.meta && ds.meta.limitation) parts.push(ds.meta.limitation);
  if(ds.meta && ds.meta.github_total_stars) parts.push('github_total_stars='+ds.meta.github_total_stars);
  parts.push('label='+ds.labelColumn);
  return parts.join(' · ') || relPath(ds.rel);
}

function scale(values, minV, maxV, lo, hi){
  if(maxV===minV) return (lo+hi)/2;
  return lo+((values-minV)/(maxV-minV))*(hi-lo);
}

function render(){
  const ds=currentDataset();
  if(!ds || !ds.rows.length){
    svg.innerHTML='<text x="450" y="160" text-anchor="middle" fill="#94a3b8">No data to chart</text>';
    metaEl.textContent='Add CSV files under data/ (e.g. data/github-star/*-star-history.csv)';
    legendEl.innerHTML='';
    return;
  }
  const m1=metricSelect.value;
  const m2=metric2Select.value;
  const labelKey=ds.labelColumn;
  const points=ds.rows.map((row,i)=>({i,label:String(row[labelKey]??i),v1:Number(row[m1]||0),v2:m2?Number(row[m2]||0):null}));
  metaEl.textContent=formatMeta(ds);
  const pad={l:56,r:18,t:18,b:42};
  const W=900,H=320;
  const iw=W-pad.l-pad.r, ih=H-pad.t-pad.b;
  const allVals=points.flatMap((p)=>[p.v1, p.v2==null?null:p.v2]).filter((v)=>Number.isFinite(v));
  let minV=Math.min(...allVals), maxV=Math.max(...allVals);
  if(!Number.isFinite(minV)) minV=0;
  if(!Number.isFinite(maxV)) maxV=1;
  if(minV===maxV){minV-=1;maxV+=1;}
  const xStep=points.length>1?iw/(points.length-1):0;
  function xy(idx,val){return {x:pad.l+idx*xStep,y:pad.t+scale(val,maxV,minV,0,ih)};}
  const pathFor=(key,color)=>{
    const d=points.map((p,idx)=>{const v=p[key];const {x,y}=xy(idx,v);return (idx?'L':'M')+x.toFixed(1)+','+y.toFixed(1);}).join(' ');
    return {d,color};
  };
  const p1=pathFor('v1',colors[0]);
  const p2=m2?pathFor('v2',colors[1]):null;
  const yTicks=4;
  let grid='';
  for(let t=0;t<=yTicks;t+=1){
    const v=minV+(maxV-minV)*(t/yTicks);
    const y=pad.t+scale(v,maxV,minV,0,ih);
    grid+='<line x1="'+pad.l+'" y1="'+y.toFixed(1)+'" x2="'+(W-pad.r)+'" y2="'+y.toFixed(1)+'" stroke="#1f2937"/>';
    grid+='<text class="axis" x="'+(pad.l-8)+'" y="'+(y+3).toFixed(1)+'" text-anchor="end">'+v.toLocaleString(undefined,{maximumFractionDigits:2})+'</text>';
  }
  const xLabelEvery=Math.max(1,Math.ceil(points.length/8));
  let xLabels='';
  points.forEach((p,idx)=>{
    if(idx%xLabelEvery!==0 && idx!==points.length-1) return;
    const {x,y}=xy(idx,p.v1);
    xLabels+='<text class="axis" x="'+x.toFixed(1)+'" y="'+(H-12)+'" text-anchor="middle">'+esc(p.label)+'</text>';
  });
  const circles=points.map((p,idx)=>{
    const {x,y}=xy(idx,p.v1);
    return '<circle class="point" data-idx="'+idx+'" cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="3.2" fill="'+colors[0]+'"/>';
  }).join('');
  svg.innerHTML=
    '<rect width="'+W+'" height="'+H+'" fill="#0f172a" rx="10"/>'+
    grid+
    '<path class="area" d="'+p1.d+' L '+(pad.l+iw)+','+(pad.t+ih)+' L '+pad.l+','+(pad.t+ih)+' Z" fill="'+colors[0]+'"/>'+
    '<path class="line" d="'+p1.d+'" stroke="'+colors[0]+'"/>'+
    (p2?'<path class="line" d="'+p2.d+'" stroke="'+colors[1]+'"/>':'')+
    xLabels+
    circles;
  legendEl.innerHTML=
    '<span><i class="swatch" style="background:'+colors[0]+'"></i>'+esc(m1)+'</span>'+
    (m2?'<span><i class="swatch" style="background:'+colors[1]+'"></i>'+esc(m2)+'</span>':'');
  svg.querySelectorAll('.point').forEach((node)=>{
    node.addEventListener('mousemove',(ev)=>{
      const idx=Number(node.getAttribute('data-idx'));
      const p=points[idx];
      tooltip.style.display='block';
      tooltip.style.left=(ev.clientX+12)+'px';
      tooltip.style.top=(ev.clientY+12)+'px';
      tooltip.innerHTML='<strong>'+esc(p.label)+'</strong><br>'+esc(m1)+': '+p.v1.toLocaleString()+(m2?('<br>'+esc(m2)+': '+p.v2.toLocaleString()):'');
    });
    node.addEventListener('mouseleave',()=>{tooltip.style.display='none';});
  });
}

fileSelect.addEventListener('change',()=>{const ds=currentDataset();if(ds) fillMetricSelects(ds);render();});
metricSelect.addEventListener('change',render);
metric2Select.addEventListener('change',render);

fillFileSelect();
if(data.datasets.length){fillMetricSelects(data.datasets[0]);}
render();
</script>
</body></html>`;
}

function main() {
	const home = process.env.HOME || '';
	const workspaceRoot = (process.env.AGENTIDE_WORKSPACE_ROOT || process.cwd()).trim();
	const dataRoot = path.join(workspaceRoot, 'data');
	const chartDir = process.env.AGENTIDE_CHART_DIR
		|| path.join(home, '.agent-hippo', 'analytics', 'views', 'star-visualizer', 'charts');
	const outputPath = path.join(chartDir, OUTPUT_HTML);

	fs.mkdirSync(chartDir, { recursive: true });
	if (isOutputDisabled(OUTPUT_HTML)) {
		try {
			fs.unlinkSync(outputPath);
		} catch {
			// ignore
		}
		return;
	}

	if (!fs.existsSync(dataRoot)) {
		fs.writeFileSync(outputPath, buildFallbackHtml(`Data folder not found: <code>${dataRoot}</code>. Create <code>data/</code> and add CSV files.`), 'utf8');
		console.log(`Wrote fallback chart: ${outputPath}`);
		return;
	}

	const csvFiles = listCsvFiles(dataRoot);
	if (!csvFiles.length) {
		fs.writeFileSync(outputPath, buildFallbackHtml(`No CSV files under <code>${dataRoot}</code>. Add star history or other CSV data first.`), 'utf8');
		console.log(`Wrote fallback chart: ${outputPath}`);
		return;
	}

	const datasets = csvFiles.map((filePath) => {
		const parsed = parseCsvFile(filePath);
		const rel = path.relative(workspaceRoot, filePath);
		const nums = numericColumns(parsed.columns, parsed.rows);
		return {
			rel,
			meta: parsed.meta,
			columns: parsed.columns,
			numericColumns: nums,
			labelColumn: labelColumn(parsed.columns, parsed.rows),
			rows: parsed.rows,
			error: parsed.error,
		};
	}).filter((d) => d.rows.length > 0 && d.numericColumns.length > 0);

	const primaryColor = (process.env.STAR_VIZ_PRIMARY_COLOR || process.env.AGENTIDE_CHART_PRIMARY_COLOR || '').trim() || '#38bdf8';

	const html = datasets.length
		? buildHtml(datasets, dataRoot, primaryColor)
		: buildFallbackHtml('CSV files were found but none had plottable numeric columns.');

	fs.writeFileSync(outputPath, html, 'utf8');
	console.log(`Wrote ${outputPath} (${datasets.length} dataset(s), primary ${primaryColor})`);
}

main();
