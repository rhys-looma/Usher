// npm run finetune:train | finetune:status | finetune:serve | finetune:stop
//
//   train --dry-run          one step on 10 examples, on CPU, with a tiny stand-in model (free)
//   train --confirm-spend    the real LoRA run on one Modal H100 (paid: see docs/finetune.md)
//   status                   Modal apps and the latest run in the volume
//   serve                    deploy vLLM with the latest adapter; prints the endpoint
//   stop                     stop both Modal apps
//
// Python for the dry run: FINETUNE_PYTHON, else python3, with torch, transformers, peft, trl,
// datasets and accelerate installed (deploy/finetune/requirements.txt). Modal runs need the modal
// CLI, signed in (modal token new).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [command, ...args] = process.argv.slice(2);
const run = (bin, argv) => {
  const result = spawnSync(bin, argv, { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') {
    console.error(bin === 'modal' ? 'The modal CLI is not installed: pip install modal, then modal token new.' : `${bin} was not found.`);
    process.exit(2);
  }
  process.exit(result.status ?? 1);
};
const needData = () => {
  if (!existsSync('data/finetune/train.chat.jsonl')) {
    console.error('No dataset: run npm run finetune:export first.');
    process.exit(2);
  }
};

switch (command) {
  case 'train':
    needData();
    if (args.includes('--dry-run')) {
      const result = spawnSync(process.env.FINETUNE_PYTHON ?? 'python3', ['deploy/finetune/train.py', '--dry-run'], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status ?? 1);
      // The /learning page says how far the student has got (reports/learning.json), unless it is further.
      const summary = JSON.parse(readFileSync('data/finetune/dry-run/summary.json', 'utf8'));
      const report = existsSync('reports/learning.json') ? JSON.parse(readFileSync('reports/learning.json', 'utf8')) : {};
      if (!report.student || report.student.stage === 'none' || report.student.stage === 'dry_run') {
        report.student = { stage: 'dry_run', date: new Date().toISOString().slice(0, 10), detail: `The pipeline ran ${summary.steps} training step on ${summary.examples} examples on CPU, with a tiny stand-in for the base model, and saved the adapter` };
        writeFileSync('reports/learning.json', `${JSON.stringify(report, null, 2)}\n`);
      }
      process.exit(0);
    }
    if (!args.includes('--confirm-spend')) {
      console.error('The real run rents an H100 on Modal and costs money. Add --confirm-spend to start it, or --dry-run for the free CPU check.');
      process.exit(2);
    }
    run('modal', ['run', 'deploy/finetune/train.py']);
    break;
  case 'status':
    spawnSync('modal', ['app', 'list'], { stdio: 'inherit' });
    run('modal', ['volume', 'get', 'usher-finetune', 'runs/latest', '-']);
    break;
  case 'serve':
    run('modal', ['deploy', 'deploy/finetune/serve.py']);
    break;
  case 'stop':
    spawnSync('modal', ['app', 'stop', 'usher-labeller'], { stdio: 'inherit' });
    run('modal', ['app', 'stop', 'usher-finetune']);
    break;
  default:
    console.error('Usage: node scripts/finetune.mjs train --dry-run | train --confirm-spend | status | serve | stop');
    process.exit(2);
}
