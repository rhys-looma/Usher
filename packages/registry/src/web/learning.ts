// "Teaching the mapper": the learning loop, in public (/learning) and on an owner's dashboard
// (/dashboard/learning). Muse Spark labels pages; owners check and correct them in a walkthrough;
// their corrections lead the training set; a small tuned model learns from it and gives a second
// opinion on risk, where the stricter answer always wins. Four counters, two live from storage
// (maps in the registry, owner corrections) and two from reports/learning.json (the training set, and how
// far the student has got), which `npm run finetune:export -- --publish` and the training dry run
// write. Counts only: no labels, no pages, never a value.

import { readFile } from 'node:fs/promises';
import type { Storage } from '../storage.ts';
import { html, page, type Raw } from './html.ts';

const ROOT = new URL('../../../../', import.meta.url);

/** reports/learning.json: what the export and the training runs last said. */
export interface LearningReport {
  dataset?: { generated: string; unique: number; train: number; eval: number; forms: number; owner_verified: number };
  student?: { stage: 'none' | 'dry_run' | 'trained' | 'serving'; date: string; detail: string };
}

export interface LearningCounters {
  maps: number;
  sites: number;
  corrections: number;
  report: LearningReport;
}

export async function readLearningReport(): Promise<LearningReport> {
  try {
    return JSON.parse(await readFile(new URL('reports/learning.json', ROOT), 'utf8')) as LearningReport;
  } catch {
    return {};
  }
}

/** Counts across every site (or one), kept for five minutes so the page never scans storage per visit. */
export class Learning {
  private cached?: { at: number; value: Promise<LearningCounters> };
  constructor(private readonly storage: Storage) {}

  counters(): Promise<LearningCounters> {
    if (this.cached && Date.now() - this.cached.at < 300_000) return this.cached.value;
    const value = (async () => {
      const sites = await this.storage.listSites();
      const maps = (await Promise.all(sites.map((s) => this.storage.mapsForOrigin(s.origin)))).reduce((n, m) => n + m.length, 0);
      return { maps, sites: sites.length, corrections: (await this.storage.readLog('corrections')).length, report: await readLearningReport() };
    })();
    this.cached = { at: Date.now(), value };
    value.catch(() => (this.cached = undefined));
    return value;
  }

  async correctionsFor(origin: string): Promise<number> {
    return (await this.storage.readLog('corrections', origin)).length;
  }
}

export const LEARNING_STYLE = `
.counters { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin:18px 0 26px; }
.counter { border:1px solid var(--line); background:var(--card); border-radius:10px; padding:14px 16px; }
.counter b { display:block; font-family:var(--serif); font-size:34px; line-height:1.1; }
.counter span { display:block; font-size:14px; color:var(--muted); margin-top:4px; }
.loop-wrap { overflow-x:auto; margin:8px 0; }
.loop { width:100%; min-width:620px; max-width:860px; height:auto; display:block; }
.loop a rect { fill:var(--card); stroke:var(--line); stroke-width:1.5; }
.loop a:hover rect, .loop a:focus rect { stroke:#7434d3; stroke-width:2.5; }
.loop text { font:500 14px Inter,system-ui,sans-serif; fill:var(--ink); }
.loop text.small { font-size:12px; fill:var(--muted); }
.loop .arrow { stroke:var(--ink); stroke-width:1.6; fill:none; marker-end:url(#head); }
.loop .guard { stroke:#b3261e; }
blockquote.reuse { border-left:4px solid #7434d3; margin:10px 0 24px; padding:4px 18px; font-size:17px; }
ol.steps-text li { margin:6px 0; }
`;

/** The paragraph to reuse anywhere the loop needs explaining (pitch, README, the site). */
export const LOOP_PARAGRAPH =
  'Usher maps a form once, with Muse Spark, and every agent uses that map. Site owners check it in a walkthrough of their own form, and each correction they make is kept as an owner-verified label: structure only, never anything typed. Those labels lead the training set for a small open-weights model, Muse Glimmer tuned with LoRA, which gives a second opinion on how risky each field is. Where the two disagree, Usher keeps the stricter answer, so the student can make the maps more careful but never less.';

function studentLine(report: LearningReport): { value: string; detail: string } {
  const s = report.student;
  if (!s || s.stage === 'none') return { value: 'Not yet', detail: 'The training pipeline is built; no run yet.' };
  if (s.stage === 'dry_run') return { value: 'Dry run', detail: `${s.detail} (${s.date}). Not trained on a GPU yet.` };
  if (s.stage === 'trained') return { value: 'Trained', detail: `${s.detail} (${s.date}). Not serving yet.` };
  return { value: 'Serving', detail: `${s.detail} (${s.date}).` };
}

function counters(c: LearningCounters, own?: number): Raw {
  const d = c.report.dataset;
  const student = studentLine(c.report);
  return html`<div class="counters" role="list">
<div class="counter" role="listitem"><b>${String(c.maps)}</b><span>maps in the registry, across ${String(c.sites)} site${c.sites === 1 ? '' : 's'} (live)</span></div>
<div class="counter" role="listitem"><b>${String(own ?? c.corrections)}</b><span>${own === undefined ? 'corrections by site owners, kept as training labels (live)' : 'corrections you have made (live)'}</span></div>
<div class="counter" role="listitem"><b>${d ? String(d.unique) : '–'}</b><span>${d ? `training examples from ${d.forms} forms, ${d.owner_verified} owner-verified (exported ${d.generated.slice(0, 10)})` : 'training examples: not exported yet'}</span></div>
<div class="counter" role="listitem"><b>${student.value}</b><span>the tuned student. ${student.detail}</span></div>
</div>`;
}

/** The loop as a diagram; each step links to where it happens. The same steps follow as a list. */
function loopDiagram(walkthrough: string): Raw {
  const node = (x: number, y: number, w: number, href: string, title: string, sub: string) =>
    html`<a href="${href}"><rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="62" rx="10"></rect><text x="${String(x + 14)}" y="${String(y + 26)}">${title}</text><text class="small" x="${String(x + 14)}" y="${String(y + 46)}">${sub}</text></a>`;
  return html`<div class="loop-wrap"><svg class="loop" viewBox="0 0 860 300" role="img" aria-labelledby="loop-title loop-desc">
<title id="loop-title">The learning loop</title>
<desc id="loop-desc">Pages are labelled by Muse Spark into maps agents use. Owners check them in a walkthrough and correct them. Corrections lead the training set. A tuned student learns from it and gives a second opinion on risk, where the stricter answer is kept, back into the maps.</desc>
<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"></path></marker></defs>
${node(20, 20, 240, '/viewer', '1. Muse Spark labels a page', 'vote mode, masked screenshot')}
${node(310, 20, 240, '/viewer', '2. A map agents use', 'structure only, never values')}
${node(600, 20, 240, walkthrough, '3. The owner checks it', 'Map my site: walk, correct, publish')}
${node(600, 200, 240, '#steps', '4. Owner-verified labels', 'lead the training set')}
${node(310, 200, 240, '#steps', '5. A tuned student', 'Muse Glimmer + LoRA')}
${node(20, 200, 240, '#steps', '6. A second opinion on risk', 'the stricter answer is kept')}
<path class="arrow" d="M260 51 H306"></path>
<path class="arrow" d="M550 51 H596"></path>
<path class="arrow" d="M720 82 V196"></path>
<path class="arrow" d="M600 231 H554"></path>
<path class="arrow" d="M310 231 H264"></path>
<path class="arrow guard" d="M140 200 V150 H430 V86"></path>
<text class="small" x="160" y="142">only ever stricter</text>
</svg></div>`;
}

function body(c: LearningCounters, options: { own?: number; walkthrough: string; dashboard?: boolean }): Raw {
  return html`<h1>${options.dashboard ? 'Teaching the mapper' : 'How Usher learns'}</h1>
<p class="lede">${options.dashboard ? 'Every correction you make to a walkthrough teaches the mapper. Here is where it goes.' : 'Usher gets better at reading forms from the people who run them, without ever seeing what anyone types.'}</p>
${counters(c, options.own)}
${loopDiagram(options.walkthrough)}
<h2 id="steps">The loop, step by step</h2>
<ol class="steps-text">
<li><a href="/viewer">Muse Spark labels a page</a>: what each field means and how risky it is to act on, asked up to three times where it is unsure (vote mode).</li>
<li>The result is a <b>map</b>: the form's structure, which every agent then uses. Never a value.</li>
<li>The site's owner <a href="${options.walkthrough}">walks their own form</a> with Usher and corrects anything it got wrong.</li>
<li>Each correction is kept as an <b>owner-verified label</b>, with the element's structure. It takes precedence over any number of model runs in the training set.</li>
<li>A small open-weights model, <b>Muse Glimmer</b>, is tuned on that set with LoRA, to label one element at a time cheaply, beside a self-hosted registry.</li>
<li>The student gives a <b>second opinion on risk</b>. Where it and Muse Spark disagree, Usher keeps the stricter answer: the student can make maps more careful, never less.</li>
</ol>
<h2>In one paragraph</h2>
<blockquote class="reuse"><p>${LOOP_PARAGRAPH}</p></blockquote>
<p class="small muted">Counts only. The training set holds labels, options and neighbouring labels from the page's markup, never anything a person typed. ${options.dashboard ? html`<a href="/learning">The public version of this page</a>.` : html`<a href="/privacy">Privacy</a>.`}</p>`;
}

export function learningPage(c: LearningCounters): string {
  return page('How Usher learns', body(c, { walkthrough: '/demo/walkthrough' }), { style: LEARNING_STYLE });
}

export function teachingPage(c: LearningCounters, own: number): string {
  return page('Teaching the mapper', body(c, { own, walkthrough: '/dashboard/walkthrough', dashboard: true }), { style: LEARNING_STYLE });
}
