#!/usr/bin/env node
// Usage: node cli.mjs trades.csv [--trials 20] [--json]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gates = require('./gates.js');

const args = process.argv.slice(2);
const usage = 'Usage: node cli.mjs <trades.csv> [--trials N] [--json]\n' +
  '  --trials N  how many variants you tested before choosing this one (default 20)\n' +
  '  --json      print the raw result as JSON';

let file = null, trials = 20, json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--trials') trials = Number(args[++i]);
  else if (a.startsWith('--trials=')) trials = Number(a.slice(9));
  else if (a === '--json') json = true;
  else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
  else if (!file) file = a;
}
if (!file || !Number.isFinite(trials) || trials < 1) { console.error(usage); process.exit(2); }

let text;
try { text = readFileSync(file, 'utf8'); }
catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(2); }

try {
  const r = gates.check(text, trials);
  if (json) { const { curve, ...rest } = r; console.log(JSON.stringify(rest, null, 2)); }
  else console.log(gates.formatReport(r));
  process.exit(r.verdict === 'ready' ? 0 : 1);
} catch (e) {
  console.error('Error: ' + e.message);
  process.exit(2);
}
