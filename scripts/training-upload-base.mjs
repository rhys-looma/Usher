// Sends the base set to the registry for automatic retraining: the export's examples from the
// compiler log (data/finetune/train.jsonl and eval.jsonl, from npm run finetune:export), structure
// only. The registry adds owners' corrections to it at each run. Replaces the base set whole.
//
//   USHER_ADMIN_KEY=… npm run training:upload-base -- <registry URL> [--data data/finetune]
//
// The admin key comes from the environment only (in production, Secrets Manager); it is never printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { data: { type: 'string', default: 'data/finetune' } } });
const registry = positionals[0]?.replace(/\/$/, '');
const key = process.env.USHER_ADMIN_KEY;
if (!registry || !key) {
  console.error('Usage: USHER_ADMIN_KEY=… npm run training:upload-base -- <registry URL> [--data data/finetune]');
  process.exit(2);
}
const read = (name) => readFileSync(join(values.data, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
// Owners' corrections come from the registry's own log at each run, so only the model's labels go.
const examples = [...read('train.jsonl'), ...read('eval.jsonl')].filter((ex) => ex.meta?.model !== 'owner');
const res = await fetch(`${registry}/admin/training/base`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ examples }) });
const body = await res.text();
console.log(`HTTP ${res.status} ${body.slice(0, 300)}`);
process.exit(res.ok ? 0 : 1);
