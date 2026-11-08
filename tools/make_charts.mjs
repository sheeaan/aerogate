// Builds the README comparison charts (docs/media/chart_*_{light,dark}.svg).
// Input: a JSON series of aircraft waiting for a gate per minute, written by a headless run of
// dashboard/static/traffic.js over the AeroGate and greedy-rules payloads ({t0, t1, rows: [[min, aerogate, greedy]]}).
// Usage: node tools/make_charts.mjs <series.json> <out dir>
import fs from "node:fs";
import path from "node:path";

const [seriesPath, outDir] = process.argv.slice(2);
const S = JSON.parse(fs.readFileSync(seriesPath, "utf8"));

// palette: categorical slots 1-2 (validated light and dark), chrome from the same reference instance
const MODES = {
  light: { surface: "#fcfcfb", ring: "rgba(11,11,11,0.10)", primary: "#0b0b0b", secondary: "#52514e", muted: "#898781",
    grid: "#e1e0d9", axis: "#c3c2b7", aero: "#2a78d6", greedy: "#eb6834" },
  dark: { surface: "#1a1a19", ring: "rgba(255,255,255,0.10)", primary: "#f0efec", secondary: "#c3c2b7", muted: "#898781",
    grid: "#2c2c2a", axis: "#383835", aero: "#3987e5", greedy: "#d95926" },
};
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
const hm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function frame(c, W, H, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="${c.surface}" stroke="${c.ring}"/>
<g font-family="${FONT}">${body}</g>
</svg>
`;
}
function legend(c, x, y) {
  const item = (dx, col, label) => `<rect x="${x + dx}" y="${y - 5}" width="14" height="3" rx="1.5" fill="${col}"/><text x="${x + dx + 20}" y="${y}" font-size="12.5" fill="${c.secondary}">${label}</text>`;
  return item(0, c.aero, "AeroGate") + item(92, c.greedy, "Greedy rules");
}

/* 1. aircraft waiting for a gate, minute by minute (step lines over a 10% wash) */
function waitingChart(c) {
  const W = 880, H = 330, L = 52, R = 28, T = 86, B = 40;
  const x0 = 16 * 60, x1 = 21 * 60 + 30, yMax = 4;
  const X = m => L + (m - x0) / (x1 - x0) * (W - L - R), Y = v => T + (1 - v / yMax) * (H - T - B);
  const rows = S.rows.filter(r => r[0] >= x0 && r[0] <= x1);
  const step = k => {
    let d = `M${X(rows[0][0]).toFixed(1)},${Y(rows[0][k]).toFixed(1)}`;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][k] !== rows[i - 1][k]) d += `H${X(rows[i][0]).toFixed(1)}V${Y(rows[i][k]).toFixed(1)}`;
    }
    return d + `H${X(rows[rows.length - 1][0]).toFixed(1)}`;
  };
  const area = k => step(k) + `V${Y(0)}H${X(rows[0][0])}Z`;
  const total = k => S.rows.reduce((a, r) => a + r[k], 0);
  let g = "";
  g += `<text x="${L - 4}" y="30" font-size="15" font-weight="600" fill="${c.primary}">Aircraft waiting for a gate, Pearson evening</text>`;
  g += `<text x="${L - 4}" y="50" font-size="12.5" fill="${c.secondary}">Same storm and rules, minute by minute, including short waits for a stand to clear. Total: AeroGate ${total(1)} aircraft-minutes, greedy rules ${total(2)}.</text>`;
  g += legend(c, L - 4, 72);
  for (let v = 0; v <= yMax; v++) {
    g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v ? c.grid : c.axis}" stroke-width="1"/>`;
    g += `<text x="${L - 10}" y="${Y(v) + 4}" font-size="11" fill="${c.muted}" text-anchor="end" style="font-variant-numeric: tabular-nums">${v}</text>`;
  }
  for (let m = 16 * 60; m <= 21 * 60; m += 60) g += `<text x="${X(m)}" y="${H - B + 18}" font-size="11" fill="${c.muted}" text-anchor="middle">${hm(m)}</text>`;
  // the storm update: a hairline and a quiet label
  const s = 16 * 60 + 15;
  g += `<line x1="${X(s)}" x2="${X(s)}" y1="${T - 6}" y2="${Y(0)}" stroke="${c.axis}" stroke-width="1"/>`;
  g += `<text x="${X(s) + 6}" y="${T + 4}" font-size="11.5" fill="${c.secondary}">16:15 storm update</text>`;
  g += `<path d="${area(2)}" fill="${c.greedy}" fill-opacity="0.10"/><path d="${area(1)}" fill="${c.aero}" fill-opacity="0.10"/>`;
  g += `<path d="${step(2)}" fill="none" stroke="${c.greedy}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  g += `<path d="${step(1)}" fill="none" stroke="${c.aero}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  // label the two peaks only
  const peak = k => rows.reduce((b, r) => (r[k] > b[k] ? r : b), rows[0]);
  const pg = peak(2), pa = peak(1);
  g += `<text x="${X(pg[0]) - 8}" y="${Y(pg[2]) - 8}" font-size="12" fill="${c.primary}" text-anchor="end">greedy peak: ${pg[2]} waiting at ${hm(pg[0])}</text>`;
  g += `<text x="${X(pa[0]) + 8}" y="${Y(pa[1]) - 8}" font-size="12" fill="${c.primary}">AeroGate peak: ${pa[1]} at ${hm(pa[0])}</text>`;
  return frame(c, W, H, g, "Aircraft waiting for a gate on the Pearson evening, AeroGate versus greedy rules");
}

/* 2. paired bars, one small multiple per measure (each its own scale) */
function compareChart(c) {
  const W = 880, H = 214, L = 24, top = 92, panelW = 208;
  const metrics = [
    ["Flights held on the tarmac", 3, 11, v => String(v)],
    ["Minutes held on the tarmac", 70, 320, v => String(v)],
    ["Passenger-hours held", 234, 1320, v => v.toLocaleString("en-US")],
    ["Score (lower is better)", 301.2, 377.9, v => v.toFixed(1)],
  ];
  let g = "";
  g += `<text x="${L}" y="30" font-size="15" font-weight="600" fill="${c.primary}">Same evening, same disruptions</text>`;
  g += `<text x="${L}" y="50" font-size="12.5" fill="${c.secondary}">Both plans gate all 83 flights with no rule violations. The difference is the tarmac.</text>`;
  g += legend(c, L, 72);
  const bar = (x, y, w, h, col) => {           // square at the baseline, 4px rounded data-end
    const r = Math.min(4, w / 2, h / 2);
    return `<path d="M${x},${y}h${(w - r).toFixed(1)}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${(w - r).toFixed(1)}Z" fill="${col}"/>`;
  };
  metrics.forEach(([label, a, gr, f], i) => {
    const px = L + i * (panelW + 8), bx = px, maxW = panelW - 56, sc = maxW / Math.max(a, gr), h = 16;
    g += `<text x="${px}" y="${top}" font-size="12" fill="${c.secondary}">${label}</text>`;
    g += `<line x1="${bx}" x2="${bx}" y1="${top + 10}" y2="${top + 66}" stroke="${c.axis}" stroke-width="1"/>`;
    [[a, c.aero, top + 16], [gr, c.greedy, top + 44]].forEach(([v, col, y]) => {
      const w = Math.max(2, v * sc);
      g += bar(bx + 1, y, w, h, col);
      g += `<text x="${bx + 1 + w + 6}" y="${y + 12.5}" font-size="12.5" font-weight="600" fill="${c.primary}">${f(v)}</text>`;
    });
  });
  g += `<text x="${L}" y="${H - 18}" font-size="11.5" fill="${c.muted}">Pearson evening bank: 83 flights, thunderstorm, jetbridge failure, medical diversion, 787 swap, cancellation. Passenger-hours at an 85% load factor.</text>`;
  return frame(c, W, H, g, "AeroGate versus greedy rules on the Pearson evening: tarmac holds and score");
}

fs.mkdirSync(outDir, { recursive: true });
for (const [mode, c] of Object.entries(MODES)) {
  fs.writeFileSync(path.join(outDir, `chart_waiting_${mode}.svg`), waitingChart(c));
  fs.writeFileSync(path.join(outDir, `chart_compare_${mode}.svg`), compareChart(c));
}
console.log("charts written to", outDir);
