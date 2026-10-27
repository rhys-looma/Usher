// Fills a task definition template (deploy/ecs/<name>.json) from deploy/ecs/config.env, the image
// tag and the secrets' ARNs, and prints the JSON. Every ${PLACEHOLDER} must be filled.
//
//   node deploy/ecs/render.mjs registry|mock-site|migrate [image tag, default the git SHA]
//
// Secret ARNs come from SECRET_ARN_<NAME> if set, else are looked up by name (<SECRET_PREFIX>/<NAME>).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [name, tag] = process.argv.slice(2);
if (!['registry', 'mock-site', 'migrate'].includes(name ?? '')) {
  console.error('Usage: node deploy/ecs/render.mjs registry|mock-site|migrate [image tag]');
  process.exit(2);
}
const configFile = process.env.USHER_DEPLOY_CONFIG ?? new URL('config.env', import.meta.url).pathname;
const config = Object.fromEntries(
  readFileSync(configFile, 'utf8')
    .split('\n')
    .map((line) => /^\s*([A-Z0-9_]+)=(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^"(.*)"$/, '$1')]),
);
const values = { ...config, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k in config || k.startsWith('SECRET_ARN_'))) };
values.IMAGE_TAG = tag ?? values.IMAGE_TAG ?? execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();

const template = readFileSync(new URL(`${name}.json`, import.meta.url), 'utf8');
for (const [, secret] of template.matchAll(/\$\{SECRET_ARN_([A-Z0-9_]+)\}/g)) {
  values[`SECRET_ARN_${secret}`] ??= execFileSync('aws', ['secretsmanager', 'describe-secret', '--region', values.AWS_REGION, '--secret-id', `${values.SECRET_PREFIX}/${secret}`, '--query', 'ARN', '--output', 'text'], { encoding: 'utf8' }).trim();
}
const missing = new Set();
const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
  if (values[key] === undefined) missing.add(key);
  return JSON.stringify(String(values[key] ?? '')).slice(1, -1);
});
if (missing.size) {
  console.error(`Not set in ${configFile}: ${[...missing].join(', ')}`);
  process.exit(1);
}
JSON.parse(rendered);
process.stdout.write(rendered);
