// SVG charts drawn ONLY from the CSV files in results/ (never from in-memory numbers), so every chart can be
// re-made from the committed data:   node eval/charts.js index results/stage6-index-bench
//                                     node eval/charts.js eval results/<run-id>
// Plain SVG, no library. Colours: the first two slots of a colour-blind-checked categorical palette, with a
// light and a dark variant (prefers-color-scheme); every mark has a <title>, shown as a tooltip on hover.
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./meta');

const STYLE = `<style>
  svg { --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --grid:#e4e3df; --s1:#2a78d6; --s2:#eb6834; }
  @media (prefers-color-scheme: dark) { svg { --surface:#1a1a19; --ink:#f0efec; --ink2:#c3c2b7; --grid:#383835; --s1:#3987e5; --s2:#d95926; } }
  .bg { fill: var(--surface); } .t { fill: var(--ink); font: 600 15px system-ui, sans-serif; }
  .st { fill: var(--ink2); font: 12px system-ui, sans-serif; } .lb { fill: var(--ink2); font: 11px system-ui, sans-serif; }
  .ph { fill: var(--ink); font: 600 12px system-ui, sans-serif; } .g { stroke: var(--grid); stroke-width: 1; }
  .s1 { stroke: var(--s1); fill: var(--s1); } .s2 { stroke: var(--s2); fill: var(--s2); } .ax { stroke: var(--ink2); stroke-width: 1; }
</style>`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toPrecision(3)}`);
const log10 = Math.log10;

function svgDoc(width, height, title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}">
${STYLE}
<rect class="bg" width="${width}" height="${height}"/>
<text class="t" x="16" y="26">${esc(title)}</text>
<text class="st" x="16" y="46">${esc(subtitle)}</text>
${body}
</svg>
`;
}

// Log-log small multiples: one panel per query, x = memories, y = metric, series "no index" and "indexed"
function smallMultiples(rows, { metric, title, subtitle, unit }) {
  const queries = [...new Set(rows.map((r) => r.query))];
  const sizes = [...new Set(rows.map((r) => Number(r.memories)))].sort((a, b) => a - b);
  const values = rows.map((r) => Number(r[metric])).filter((v) => Number.isFinite(v) && v > 0);
  if (!values.length) return null;
  const yMin = 10 ** Math.floor(log10(Math.min(...values)));
  const yMax = 10 ** Math.ceil(log10(Math.max(...values)));
  const cols = 3;
  const pw = 250;
  const ph = 150;
  const gap = 28;
  const top = 84;
  const width = 16 + cols * (pw + gap);
  const height = top + Math.ceil(queries.length / cols) * (ph + 54) + 10;
  const xs = (n) => (sizes.length === 1 ? pw / 2 : ((log10(n) - log10(sizes[0])) / (log10(sizes[sizes.length - 1]) - log10(sizes[0]))) * (pw - 50) + 40);
  const ys = (v) => ph - ((log10(Math.max(v, yMin)) - log10(yMin)) / (log10(yMax) - log10(yMin) || 1)) * (ph - 10);
  let body = `<g transform="translate(16,58)"><rect class="s2" x="0" y="0" width="14" height="3"/><text class="lb" x="20" y="6">no secondary index</text><rect class="s1" x="150" y="0" width="14" height="3"/><text class="lb" x="170" y="6">with the schema's indexes</text></g>`;
  queries.forEach((q, i) => {
    const x0 = 16 + (i % cols) * (pw + gap);
    const y0 = top + Math.floor(i / cols) * (ph + 54);
    let panel = `<text class="ph" x="0" y="0">${esc(q)}</text><g transform="translate(0,10)">`;
    for (let e = log10(yMin); e <= log10(yMax); e += 1) {
      panel += `<line class="g" x1="40" x2="${pw}" y1="${ys(10 ** e)}" y2="${ys(10 ** e)}"/><text class="lb" x="34" y="${ys(10 ** e) + 4}" text-anchor="end">${fmt(10 ** e)}</text>`;
    }
    for (const n of sizes) panel += `<text class="lb" x="${xs(n)}" y="${ph + 16}" text-anchor="middle">${fmt(n)}</text>`;
    for (const [indexed, cls, name] of [['no', 's2', 'no index'], ['yes', 's1', 'indexed']]) {
      const pts = sizes
        .map((n) => rows.find((r) => r.query === q && Number(r.memories) === n && r.indexes === indexed))
        .filter((r) => r && Number.isFinite(Number(r[metric])) && r[metric] !== '')
        .map((r) => ({ x: xs(Number(r.memories)), y: ys(Number(r[metric])), r }));
      if (pts.length > 1) panel += `<polyline fill="none" class="${cls}" stroke-width="2" points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}"/>`;
      for (const p of pts) {
        panel += `<circle class="${cls}" cx="${p.x}" cy="${p.y}" r="4.5" stroke="var(--surface)" stroke-width="2"><title>${esc(`${q}, ${name}, ${p.r.memories} memories: ${p.r[metric]} ${unit}`)}</title></circle>`;
      }
      if (indexed === 'no' && pts.length === 0) panel += `<text class="lb" x="${pw / 2}" y="${ph / 2}" text-anchor="middle">cannot run without a text index</text>`;
    }
    body += `<g transform="translate(${x0},${y0})">${panel}</g></g>`;
  });
  body += `<text class="lb" x="16" y="${height - 6}">x: memories in the collection (log scale). y: ${esc(unit)} (log scale). Values below ${fmt(yMin)} are drawn at ${fmt(yMin)}.</text>`;
  return svgDoc(width, height + 8, title, subtitle, body);
}

function indexCharts(prefix) {
  const rows = parseCsv(fs.readFileSync(`${prefix}.csv`, 'utf8'));
  const sub = 'SYNTHETIC data, performance only. Source: ' + path.basename(prefix) + '.csv';
  const charts = [
    ['p50_ms', 'Median query time, with and without indexes', 'ms (wall-clock p50)', '-p50.svg'],
    ['avg_docs_examined', 'Documents examined per query (explain executionStats)', 'documents examined', '-docs.svg'],
  ];
  const written = [];
  for (const [metric, title, unit, suffix] of charts) {
    const svg = smallMultiples(rows, { metric, title, subtitle: sub, unit });
    if (svg) {
      fs.writeFileSync(`${prefix}${suffix}`, svg);
      written.push(`${prefix}${suffix}`);
    }
  }
  console.log(`Charts: ${written.join(', ')}`);
  return written;
}

// Horizontal bars: one value per system (e.g. accuracy), with an optional [low, high] whisker
function barChart(items, { title, subtitle, unit, max }) {
  const width = 640;
  const left = 210;
  const barH = 18;
  const rowH = 30;
  const top = 64;
  const height = top + items.length * rowH + 30;
  const scaleMax = max || Math.max(...items.map((i) => (Number.isFinite(i.high) ? i.high : i.value)), 1e-9);
  const xs = (v) => left + (Math.max(0, v) / scaleMax) * (width - left - 70);
  let body = '';
  for (let t = 0; t <= 4; t += 1) {
    const v = (scaleMax * t) / 4;
    body += `<line class="g" x1="${xs(v)}" x2="${xs(v)}" y1="${top - 6}" y2="${top + items.length * rowH}"/><text class="lb" x="${xs(v)}" y="${top + items.length * rowH + 14}" text-anchor="middle">${+v.toPrecision(3)}</text>`;
  }
  items.forEach((item, i) => {
    const y = top + i * rowH;
    body += `<text class="lb" x="${left - 8}" y="${y + 13}" text-anchor="end">${esc(item.label)}</text>`;
    if (!Number.isFinite(item.value)) {
      body += `<text class="lb" x="${left + 4}" y="${y + 13}">n/a</text>`;
      return;
    }
    const w = Math.max(1, xs(item.value) - left);
    body += `<path class="s1" d="M${left},${y} h${w - 4} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z"><title>${esc(`${item.label}: ${item.value} ${unit}`)}</title></path>`;
    if (Number.isFinite(item.low) && Number.isFinite(item.high)) {
      body += `<line class="ax" x1="${xs(item.low)}" x2="${xs(item.high)}" y1="${y + barH / 2}" y2="${y + barH / 2}"/>`;
    }
    body += `<text class="lb" x="${xs(Number.isFinite(item.high) ? Math.max(item.high, item.value) : item.value) + 6}" y="${y + 13}">${+Number(item.value).toPrecision(3)}</text>`;
  });
  body += `<text class="lb" x="16" y="${height - 4}">${esc(unit)}</text>`;
  return svgDoc(width, height + 6, title, subtitle, body);
}

// Charts of one evaluation run, from its summary CSVs
function evalCharts(dir) {
  const label = fs.existsSync(path.join(dir, 'LABEL.txt')) ? fs.readFileSync(path.join(dir, 'LABEL.txt'), 'utf8').split('\n')[0] : '';
  const bySystem = parseCsv(fs.readFileSync(path.join(dir, 'summary_by_system.csv'), 'utf8'));
  const written = [];
  for (const [metric, low, high, title, unit, file] of [
    ['score_f1_mean', 'score_f1_ci_low', 'score_f1_ci_high', 'LoCoMo QA score (token F1) by system', 'mean token F1 (0-1), line = 95% bootstrap CI', 'chart_f1.svg'],
    ['judge_accuracy', 'judge_ci_low', 'judge_ci_high', 'LoCoMo QA accuracy (LLM judge) by system', 'share judged correct (0-1), line = 95% bootstrap CI', 'chart_judge.svg'],
    ['recall_at_k_mean', null, null, 'Evidence recall@k by system', 'mean recall@k of the evidence turns (0-1)', 'chart_recall.svg'],
  ]) {
    const items = bySystem.map((r) => ({ label: r.system, value: r[metric] === '' ? NaN : Number(r[metric]), low: low ? Number(r[low]) : NaN, high: high ? Number(r[high]) : NaN }));
    if (!items.some((i) => Number.isFinite(i.value))) continue;
    fs.writeFileSync(path.join(dir, file), barChart(items, { title, subtitle: `${label} Source: summary_by_system.csv`.trim(), unit, max: 1 }));
    written.push(file);
  }
  console.log(`Charts: ${written.join(', ')}`);
  return written;
}

if (require.main === module) {
  const [kind, target] = process.argv.slice(2);
  if (kind === 'index') indexCharts(target);
  else if (kind === 'eval') evalCharts(target);
  else {
    console.error('usage: node eval/charts.js index <results/prefix> | eval <results/run-dir>');
    process.exit(1);
  }
}

module.exports = { indexCharts, evalCharts, barChart, smallMultiples };
