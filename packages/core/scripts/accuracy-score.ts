// Recomputes accuracy from the marks in reports/accuracy-review.csv: fill key_correct and
// risk_correct with y or n (blank = not reviewed), then `npm run accuracy:score`.
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

const forms = [...new Set(rows.map((r) => r.form))];
const groups = [
  ['All', rows],
  ['Mock site', rows.filter((r) => r.category === 'mock site')],
  ['Public forms', rows.filter((r) => r.category !== 'mock site')],
] as const;
const out = [
  '# Accuracy, from review marks',
  '',
  `Scored ${new Date().toISOString().slice(0, 10)} from \`reports/accuracy-review.csv\`. Only elements marked y or n count.`,
  '',
  '| Set | Keys correct | Risk correct | Locators resolve |',
  '| --- | --- | --- | --- |',
  ...groups.map(([name, subset]) => {
    const t = tally([...subset]);
    return `| ${name} | ${pct(t.key)} | ${pct(t.risk)} | ${pct(t.locators)} |`;
  }),
  '',
  '| Form | Keys correct | Risk correct | Locators resolve |',
  '| --- | --- | --- | --- |',
  ...forms.map((f) => {
    const t = tally(rows.filter((r) => r.form === f));
    return `| ${f} | ${pct(t.key)} | ${pct(t.risk)} | ${pct(t.locators)} |`;
  }),
  '',
];
await writeFile(new URL('reports/accuracy-scored.md', root), out.join('\n'));
console.log(out.join('\n'));
