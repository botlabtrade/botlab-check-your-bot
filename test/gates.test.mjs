import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const G = require('../gates.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ex = f => readFileSync(join(root, 'examples', f), 'utf8');

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const csv = (rows, head = 'symbol,date,r') => head + '\n' + rows.join('\n');

/* deterministic PRNG for synthetic inputs */
const prng = s => () => (s = (s * 16807) % 2147483647) / 2147483647;

test('normal helpers', () => {
  close(G.ncdf(0), 0.5);
  close(G.ncdf(1.96), 0.975);
  close(G.ninv(0.95), 1.6449);
  close(G.ninv(0.01), -2.3263);
  close(G.ncdf(G.ninv(0.3)), 0.3);
});

test('parseCSV: separators, units, columns', () => {
  const a = G.parseCSV('Symbol;Date;PnL_R\nBTC;2026-01-01;1,5\nETH;2026-01-02;-1');
  assert.equal(a.unit, 'R');
  assert.deepEqual(a.rows.map(r => r.v), [1.5, -1]);
  assert.ok(a.hasSym && a.hasDay && !a.hasSide);

  const b = G.parseCSV('pnl_usd\tside\n12.5\tLONG\n-3\tsell\nx\tshort');
  assert.equal(b.unit, '$');
  assert.equal(b.rows.length, 2, 'non-numeric rows are skipped');
  assert.deepEqual(b.rows.map(r => r.side), ['L', 'S']);

  const c = G.parseCSV('r,ts\n1,1767225600\n2,1767225600000');
  assert.deepEqual(c.rows.map(r => r.day), ['2026-01-01', '2026-01-01'], 'unix seconds and ms');

  assert.throws(() => G.parseCSV('r'), /header row/);
  assert.throws(() => G.parseCSV('a,b\n1,2'), /No result column/);
  assert.throws(() => G.parseCSV('r\nfoo'), /numeric rows/);
});

test('G1: needs max(300, MinTRL)', () => {
  const rnd = prng(3);
  const rows = Array.from({ length: 400 }, (_, i) => `S${i % 9},2026-01-${String(1 + (i % 28)).padStart(2, '0')},${rnd() < 0.5 ? 1.2 : -1}`);
  const r = G.check(csv(rows), 1);
  const m = G.moments(r.curve.map((v, i) => v - (r.curve[i - 1] || 0)));
  assert.equal(r.minTRL, G.minTRL(m, 0.95));
  assert.equal(r.need, Math.max(300, r.minTRL));
  assert.equal(r.G.G1[0], r.n >= r.need);
  // losing series => MinTRL is infinite => G1 fails no matter how many trades
  const lose = G.check(csv(Array.from({ length: 500 }, (_, i) => `A,2026-01-01,${i % 2 ? -1 : 0.9}`)), 1);
  assert.equal(lose.minTRL, Infinity);
  assert.equal(lose.G.G1[0], false);
});

test('G2: more trials lowers DSR, PSR unchanged', () => {
  const t = ex('synthetic_42_trades_small_lucky.csv');
  const r1 = G.check(t, 1), r100 = G.check(t, 100);
  close(r1.psr0, r100.psr0, 1e-12);
  close(r1.dsr, r1.psr0, 1e-12); // 1 trial => SR0 = 0 => DSR = PSR(0)
  assert.ok(r100.dsr < r1.dsr);
});

test('G3: recent windows', () => {
  const base = Array.from({ length: 200 }, () => 'A,2026-01-01,0.5');
  const bad = Array.from({ length: 30 }, () => 'A,2026-01-01,-0.2');
  const r = G.check(csv([...base, ...bad]), 1);
  assert.equal(r.G.G3[0], false, 'last 30 avg -0.2 <= -0.1');
  const ok = G.check(csv([...base, ...Array.from({ length: 30 }, () => 'A,2026-01-01,-0.05')]), 1);
  assert.equal(ok.G.G3[0], true);
});

test('G4: coin and day concentration', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push(`C${Math.floor(i / 2) % 10},2026-02-${String(1 + Math.floor(i / 4)).padStart(2, '0')},${i % 2 ? 1.5 : -0.8}`);
  assert.equal(G.check(csv(rows), 1).G.G4[0], true);
  rows.push('MOON,2026-03-01,40');
  const r = G.check(csv(rows), 1);
  assert.equal(r.G.G4[0], false);
  assert.equal(r.topSyms[0][0], 'MOON');
  assert.equal(G.check('r\n1\n-1\n2', 1).G.G4[0], true, 'no symbol/date columns => not penalised');
});

test('G5: losing side with >= 50 trades fails; no side column => not scored', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(`A,2026-01-01,long,1`);
  for (let i = 0; i < 49; i++) rows.push(`A,2026-01-01,short,-0.5`);
  assert.equal(G.check(csv(rows, 'symbol,date,side,r'), 1).G.G5[0], true, '49 short trades is below the minimum');
  rows.push('A,2026-01-01,short,-0.5');
  assert.equal(G.check(csv(rows, 'symbol,date,side,r'), 1).G.G5[0], false);
  assert.equal(G.check('r\n1\n-1', 1).G.G5[0], null);
});

test('G6: drawdown in R only', () => {
  const r = G.check(csv(['A,2026-01-01,5', ...Array.from({ length: 16 }, () => 'A,2026-01-02,-1')]), 1);
  close(r.dd, 16);
  assert.equal(r.G.G6[0], false);
  assert.equal(G.check('pnl\n5\n-100', 1).G.G6[0], null, 'USD input is not scored on G6');
});

test('examples: passing and failing synthetic files', () => {
  const p = G.check(ex('synthetic_640_trades_passes.csv'), 20);
  assert.equal(p.verdict, 'ready');
  assert.equal(p.passed, 6);
  const f = G.check(ex('synthetic_42_trades_small_lucky.csv'), 20);
  assert.equal(f.verdict, 'no');
  assert.equal(f.G.G1[0], false);
  assert.equal(f.G.G2[0], false);
  assert.equal(f.G.G4[0], false);
});

/* Reference: the online tool's grade() (G1-G4, G6), transcribed without the UI/i18n parts. */
function siteGrade(rows, trials) {
  const x = rows.map(r => r.v), n = x.length, mean = x.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)) || 1e-9;
  const sk = x.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n, ku = x.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n;
  const sr = mean / sd, den = Math.sqrt(Math.max(1e-9, 1 - sk * sr + (ku - 1) / 4 * sr * sr));
  const psrAt = sr0 => G.ncdf((sr - sr0) * Math.sqrt(n - 1) / den);
  const psr0 = psrAt(0); const N = Math.max(1, trials | 0), g = 0.5772156649;
  const sr0 = N > 1 ? Math.sqrt(1 / (n - 1)) * ((1 - g) * G.ninv(1 - 1 / N) + g * G.ninv(1 - 1 / (N * Math.E))) : 0;
  const dsr = psrAt(sr0); const z = G.ninv(0.95);
  const minTRL = sr > 0 ? Math.ceil(1 + (1 - sk * sr + (ku - 1) / 4 * sr * sr) * (z / sr) ** 2) : Infinity;
  let eq = 0, pk = 0, dd = 0; x.forEach(v => { eq += v; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); });
  const avgLast = k => { const s = x.slice(-k); return s.reduce((a, b) => a + b, 0) / s.length; };
  const posSum = x.filter(v => v > 0).reduce((a, b) => a + b, 0) || 1e-9, tot = x.reduce((a, b) => a + b, 0);
  const groupShare = (key, k, base) => { const m = {}; rows.forEach(r => m[r[key]] = (m[r[key]] || 0) + r.v);
    const top = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, k); return top.reduce((a, b) => a + Math.max(0, b[1]), 0) / base; };
  const symShare = groupShare('sym', 3, posSum), dayShare = groupShare('day', 2, Math.abs(tot) || 1e-9);
  const need = Math.max(300, minTRL);
  return { psr0, dsr, dd, G1: n >= need, G2: psr0 >= 0.95 && dsr >= 0.5, G3: avgLast(100) > 0 && avgLast(30) > -0.1,
    G4: symShare < 0.5 && dayShare < 0.5, G6: dd < 15 };
}

test('matches the online tool on 200 random trade logs', () => {
  const rnd = prng(12345);
  for (let k = 0; k < 200; k++) {
    const n = 20 + Math.floor(rnd() * 900), wp = 0.3 + rnd() * 0.3, trials = 1 + Math.floor(rnd() * 200);
    const rows = Array.from({ length: n }, (_, i) => `C${Math.floor(rnd() * (2 + k % 15))},2026-0${1 + (i % 9)}-1${i % 9},${rnd() < wp ? (0.5 + rnd() * 2.5).toFixed(2) : (-0.7 - rnd() * 0.4).toFixed(2)}`);
    const P = G.parseCSV(csv(rows)), mine = G.grade(P, trials), ref = siteGrade(P.rows, trials);
    close(mine.psr0, ref.psr0, 1e-12); close(mine.dsr, ref.dsr, 1e-12); close(mine.dd, ref.dd, 1e-9);
    for (const g of ['G1', 'G2', 'G3', 'G4', 'G6']) assert.equal(mine.G[g][0], ref[g], `${g} mismatch on case ${k}`);
  }
});

test('CLI prints a report', () => {
  let out;
  try { out = execFileSync(process.execPath, [join(root, 'cli.mjs'), join(root, 'examples', 'synthetic_640_trades_passes.csv')], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout; }
  assert.match(out, /\[PASS\] G1 Sufficient sample/);
  assert.match(out, /Not financial advice/);
  let code = 0;
  try { execFileSync(process.execPath, [join(root, 'cli.mjs'), join(root, 'examples', 'synthetic_42_trades_small_lucky.csv')], { stdio: 'pipe' }); }
  catch (e) { code = e.status; }
  assert.equal(code, 1, 'non-ready verdict exits with code 1');
});
