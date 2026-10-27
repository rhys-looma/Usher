// Recomputes accuracy from the marks in reports/accuracy-review.csv: fill key_correct and
// risk_correct with y or n (blank = not reviewed), then `npm run accuracy:score`. Public-form marks
// are human-checked; mock-site marks are automatic, against the mock site's answer key.
// Writes reports/accuracy-scored.md.

import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const text = await readFile(new URL('reports/accuracy-review.csv', root), 'utf8');

function parse(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted && c === '"' && line[i + 1] === '"') (cell += '"'), i++;
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) out.push(cell), (cell = '');
    else cell += c;
  }
  return [...out, cell];
}

const [header, ...lines] = text.trim().split('\n');
const cols = parse(header!);
const rows = lines.map((l) => Object.fromEntries(parse(l).map((v, i) => [cols[i]!, v.trim().toLowerCase()])) as Record<string, string>);

interface Tally {
  key: [number, number];
  risk: [number, number];
  locators: [number, number];
}
const tally = (subset: Record<string, string>[]): Tally => ({
  key: [subset.filter((r) => r.key_correct === 'y').length, subset.filter((r) => r.key_correct === 'y' || r.key_correct === 'n').length],
  risk: [subset.filter((r) => r.risk_correct === 'y').length, subset.filter((r) => r.risk_correct === 'y' || r.risk_correct === 'n').length],
  locators: [subset.filter((r) => r.locator_ok === 'y').length, subset.length],
});
const pct = ([a, b]: [number, number]) => (b ? `${Math.round((a / b) * 1000) / 10}% (${a}/${b})` : 'not reviewed');

// Two kinds of mark, never added together: the mock site's are automatic (whether a key matches the
// mock site's answer key), the public forms' are human-checked.
const SETS = [
  { title: 'Public forms, human-checked', rows: rows.filter((r) => r.category !== 'mock site') },
  { title: "Mock site, matches the mock site's answer key", rows: rows.filter((r) => r.category === 'mock site') },
];
const line = (name: string, subset: Record<string, string>[]) => {
  const t = tally(subset);
  return `| ${name} | ${pct(t.key)} | ${pct(t.risk)} | ${pct(t.locators)} |`;
};
const out = [
  '# Accuracy, from review marks',
  '',
  `Scored ${new Date().toISOString().slice(0, 10)} from \`reports/accuracy-review.csv\`. Only elements marked y or n count. Public forms are human-checked: a person marked each key and risk right or wrong. The mock site is marked automatically by whether each key matches the mock site's answer key (\`packages/core/test/fixtures/expected-keys.json\`), with risk following from that key; that shows the compiler agrees with our own answer key on a form we built, not accuracy in general.`,
  '',
  '| Set | Keys correct | Risk correct | Locators resolve |',
  '| --- | --- | --- | --- |',
  ...SETS.map((s) => line(s.title, s.rows)),
  '',
  ...SETS.flatMap((s) => [
    `## ${s.title}`,
    '',
    '| Form | Keys correct | Risk correct | Locators resolve |',
    '| --- | --- | --- | --- |',
    ...[...new Set(s.rows.map((r) => r.form))].map((f) => line(f!, s.rows.filter((r) => r.form === f))),
    '',
  ]),
];
await writeFile(new URL('reports/accuracy-scored.md', root), out.join('\n'));
console.log(out.join('\n'));
