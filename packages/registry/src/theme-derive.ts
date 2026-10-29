// A site's theme, derived from its own pages (LU-58), on join and on "Refresh from my site". Usher's
// browser opens the home page and the first journey's form page (the site's own origin only, as for
// the walkthrough) and collects candidates: the name as the site gives it, logos (each captured as a
// PNG of the element on the page, only from the site's own origin, and size-limited), the computed
// colours of its header, buttons and links, its font names and its buttons' corners. A masked
// screenshot of the home page (every field greyed out) goes with them.
//
// Muse Spark chooses from those candidates by index, under a strict schema: it never writes a
// colour, CSS or markup. Code builds the theme from its choice, checks it (core theme.ts), and moves
// colours to the nearest that pass contrast when a card uses them. Without a model, or past the
// day's budget, code chooses by simple rules. The result waits as a proposal until the owner
// accepts or adjusts it; nothing changes on the site's cards before that.

import type { Browser, Page } from 'playwright';
import { LOGO_MAX_BYTES, TYPEFACE_IDS, VIEWPORT, parseJsonContent, radiusFor, typefaceFor, validateTheme, type ChatFn, type ContentPart } from '@usher/core';
import type { Registry, SiteThemeRecord, ThemeCandidates } from './registry.ts';
import { MASK, ownPagesOnly } from './walkthrough.ts';

export interface ThemeDeriverOptions {
  registry: Registry;
  browser: () => Promise<Browser>;
  /** Muse Spark, within the registry's daily cap. */
  compiler?: { chat: ChatFn; model: string };
  spend?: { today: () => Promise<number>; cap: number };
  /** Derivations a site may run per UTC day (default 5). */
  dailyLimit?: number;
  /** Let it reach private addresses (local development and tests only). */
  allowPrivate?: boolean;
  now?: () => Date;
}

/** What the page script finds: structure and computed styles, never a value anyone typed. */
interface PageFindings {
  names: string[];
  colours: { role: string; hex: string }[];
  fonts: { role: string; family: string }[];
  logos: { i: number; kind: string; src: string | null; alt: string }[];
  radius: number | null;
}

// A plain script, not a compiled function: it runs in the site's page as written.
const COLLECT = `(() => {
  const hex = (c) => {
    const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/.exec(c || '');
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
    return '#' + [m[1], m[2], m[3]].map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('');
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const colours = [];
  const add = (role, c) => { const h = hex(c); if (h) colours.push({ role, hex: h }); };
  const bands = Array.from(document.querySelectorAll('header, [role=banner], nav, body > div, body > section')).filter(visible)
    .filter((el) => el.getBoundingClientRect().top < 200 && el.getBoundingClientRect().width > innerWidth * 0.6).slice(0, 6);
  for (const el of bands) add('header background', getComputedStyle(el).backgroundColor);
  const buttons = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[class*=btn], a[class*=button], [role=button]')).filter(visible).slice(0, 30);
  let radius = null;
  for (const b of buttons) {
    const s = getComputedStyle(b);
    add('button background', s.backgroundColor);
    if (s.borderTopWidth !== '0px') add('button border', s.borderTopColor);
    if (radius === null) radius = parseFloat(s.borderTopLeftRadius) || 0;
  }
  for (const a of Array.from(document.querySelectorAll('a')).filter(visible).slice(0, 30)) add('link text', getComputedStyle(a).color);
  for (const h of Array.from(document.querySelectorAll('h1, h2')).filter(visible).slice(0, 6)) add('heading text', getComputedStyle(h).color);
  add('page background', getComputedStyle(document.body).backgroundColor);
  add('body text', getComputedStyle(document.body).color);
  const fonts = [];
  const family = (role, el) => { if (el) fonts.push({ role, family: getComputedStyle(el).fontFamily.slice(0, 200) }); };
  family('body', document.body);
  family('heading', document.querySelector('h1, h2'));
  family('button', buttons[0]);
  const logos = [];
  const seen = new Set();
  const consider = (el, kind) => {
    if (!el || seen.has(el) || !visible(el) || logos.length >= 6) return;
    const r = el.getBoundingClientRect();
    if (r.top > 260 || r.width > 480 || r.height > 200 || r.width < 12 || r.height < 12) return;
    seen.add(el);
    const i = logos.length;
    el.setAttribute('data-usher-logo', String(i));
    logos.push({ i, kind, src: el.tagName === 'IMG' ? (el.currentSrc || el.src) : null, alt: (el.getAttribute('alt') || el.getAttribute('aria-label') || '').slice(0, 100) });
  };
  const logoish = /logo|brand|wordmark/i;
  for (const el of Array.from(document.querySelectorAll('img, svg'))) {
    const words = (el.getAttribute('class') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('alt') || '') + ' ' + ((el.closest('a') && el.closest('a').getAttribute('class')) || '');
    const home = el.closest('a[href="/"], a[href="./"], a[href="' + location.origin + '/"]');
    if (logoish.test(words) || home) consider(el, el.tagName.toLowerCase());
  }
  const home = document.querySelector('header a[href="/"], [role=banner] a[href="/"], a.brand, a[class*=logo]');
  if (home && !home.querySelector('[data-usher-logo]')) consider(home, 'wordmark');
  const names = [];
  const meta = (sel) => { const m = document.querySelector(sel); return m && m.getAttribute('content'); };
  names.push(meta('meta[property="og:site_name"]'), meta('meta[name="application-name"]'));
  names.push(...document.title.split(/\\s+[|\\u2013\\u2014:-]\\s+/));
  if (home) names.push(home.textContent);
  for (const l of logos) names.push(l.alt);
  return { names: names.filter(Boolean).map((n) => n.replace(/\\s+/g, ' ').trim()).filter((n) => n && n.length <= 60), colours, fonts, logos, radius };
})()`;

const SYSTEM = `You choose a website's theme for the small cards an AI assistant shows under the site's name. Usher collected the candidates from the site's own pages; you choose among them by index, and never invent a name, a colour or anything else.
- name: the site's or brand's name as people know it (not a page title with extras).
- logo: the candidate that is the site's own logo, or null if none clearly is. A wordmark that is just the name is acceptable when there is nothing better.
- accent: the colour of the site's main buttons or calls to action.
- second: the colour of the site's header or brand band; if the header is white or near-white, the site's strongest brand colour (it may be the same as accent).
- typeface: the closest on the list to the site's body or heading font.
- why: one short sentence on what you chose.
A screenshot of the home page comes with the candidates; every field in it is greyed out.`;

const schema = (typefaces: string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['name', 'logo', 'accent', 'second', 'typeface', 'why'],
  properties: {
    name: { type: 'integer' },
    logo: { type: ['integer', 'null'] },
    accent: { type: 'integer' },
    second: { type: 'integer' },
    typeface: { type: 'string', enum: typefaces },
    why: { type: 'string' },
  },
});

function saturation(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (l > 0.5 ? 2 - max - min : max + min);
}
const lightness = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (Math.max((n >> 16) & 255, (n >> 8) & 255, n & 255) + Math.min((n >> 16) & 255, (n >> 8) & 255, n & 255)) / 510;
};
/** A colour that can stand for a brand: not white, not black, not grey. */
const brandish = (hex: string) => saturation(hex) > 0.2 && lightness(hex) > 0.12 && lightness(hex) < 0.9;

/** Code's choice, used when no model can choose, and for anything the model's choice leaves out. */
export function chooseByCode(c: ThemeCandidates): { name: number; logo: number | null; accent: number; second: number; typeface: string } {
  const pick = (roles: string[], ok: (hex: string) => boolean) => {
    const found = c.colours.map((x, i) => ({ ...x, i })).filter((x) => roles.some((r) => x.role.endsWith(r)) && ok(x.hex));
    return found.sort((a, b) => b.count - a.count)[0]?.i ?? -1;
  };
  let accent = pick(['button background'], brandish);
  if (accent < 0) accent = pick(['link text', 'button border', 'heading text'], brandish);
  if (accent < 0) accent = pick(['button background', 'body text'], () => true);
  let second = pick(['header background'], (h) => lightness(h) < 0.9);
  if (second < 0) second = accent;
  const body = c.fonts.find((f) => f.role.endsWith('heading'))?.family ?? c.fonts[0]?.family ?? '';
  return { name: 0, logo: c.logos.length ? 0 : null, accent: Math.max(0, accent), second: Math.max(0, second), typeface: typefaceFor(body) };
}

export class ThemeDeriver {
  private readonly running = new Map<string, Promise<SiteThemeRecord | string>>();
  private readonly now: () => Date;

  constructor(private readonly o: ThemeDeriverOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Why a derivation can't run for this site now, or null. */
  async refusal(origin: string): Promise<string | null> {
    if (this.running.has(origin)) return null;
    const day = this.now().toISOString().slice(0, 10);
    const used = (await this.o.registry.storage.getCached<{ n: number }>('theme-runs', `${origin}|${day}`))?.n ?? 0;
    const limit = this.o.dailyLimit ?? 5;
    return used >= limit ? `Usher has read your site ${limit} times today; it can again after midnight UTC.` : null;
  }

  /** Whether a derivation for this site is running now. */
  busy(origin: string): boolean {
    return this.running.has(origin);
  }

  /** Reads the site and stores a proposed theme; the record, or why it couldn't. One at a time per site. */
  derive(origin: string): Promise<SiteThemeRecord | string> {
    const current = this.running.get(origin);
    if (current) return current;
    const run = this.run(origin).finally(() => this.running.delete(origin));
    this.running.set(origin, run);
    return run;
  }

  private async run(origin: string): Promise<SiteThemeRecord | string> {
    const refused = await this.refusal(origin);
    if (refused) return refused;
    const day = this.now().toISOString().slice(0, 10);
    const used = (await this.o.registry.storage.getCached<{ n: number }>('theme-runs', `${origin}|${day}`))?.n ?? 0;
    await this.o.registry.storage.putCached('theme-runs', `${origin}|${day}`, { n: used + 1 });
    const started = performance.now();
    const journeys = await this.o.registry.journeys(origin).catch(() => []);
    const paths = [...new Set(['/', ...journeys.slice(0, 1).map((j) => new URL(j.start, origin).pathname)])];
    const browser = await this.o.browser();
    const context = await browser.newContext({ viewport: VIEWPORT });
    if (!this.o.allowPrivate) await ownPagesOnly(context, origin);
    const candidates: ThemeCandidates = { pages: [], names: [], logos: [], colours: [], fonts: [], radius_px: null };
    let shot: string | undefined;
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      for (const path of paths) {
        try {
          await page.goto(`${origin}${path}`, { waitUntil: 'load', timeout: 20_000 });
        } catch {
          continue;
        }
        if (new URL(page.url()).origin !== origin) continue;
        candidates.pages.push(path);
        const found = (await page.evaluate(COLLECT)) as PageFindings;
        await this.take(page, origin, path, found, candidates);
        if (!shot) {
          const jpeg = await page.screenshot({ type: 'jpeg', quality: 50, mask: [page.locator(MASK)], maskColor: '#c9ccd4' }).catch(() => undefined);
          if (jpeg && jpeg.length < 300_000) shot = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
    if (!candidates.pages.length) return `Usher couldn't open ${origin}.`;
    const fallbackName = await this.o.registry.siteName(origin).catch(() => new URL(origin).host);
    if (!candidates.names.includes(fallbackName)) candidates.names.push(fallbackName);
    if (!candidates.colours.length) candidates.colours.push({ hex: '#191942', role: 'Usher default', count: 1 });

    const code = chooseByCode(candidates);
    let choice = code;
    let by = 'code';
    let why: string | undefined;
    const spent = this.o.spend ? await this.o.spend.today() : 0;
    if (this.o.compiler && (!this.o.spend || spent + 0.05 <= this.o.spend.cap)) {
      try {
        const chosen = await this.ask(candidates, shot);
        const index = (v: unknown, list: unknown[]) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < list.length ? (v as number) : undefined);
        choice = {
          name: index(chosen.name, candidates.names) ?? code.name,
          logo: chosen.logo === null ? null : (index(chosen.logo, candidates.logos) ?? code.logo),
          accent: index(chosen.accent, candidates.colours) ?? code.accent,
          second: index(chosen.second, candidates.colours) ?? code.second,
          typeface: (TYPEFACE_IDS as string[]).includes(String(chosen.typeface)) ? String(chosen.typeface) : code.typeface,
        };
        by = this.o.compiler.model;
        why = typeof chosen.why === 'string' ? chosen.why.slice(0, 300) : undefined;
      } catch {
        // Code's choice stands: a theme is never worth failing a join over.
      }
    }
    const input: Record<string, unknown> = {
      name: candidates.names[choice.name] ?? fallbackName,
      ...(choice.logo !== null && candidates.logos[choice.logo] && { logo: candidates.logos[choice.logo] }),
      accent: candidates.colours[choice.accent]!.hex,
      second: candidates.colours[choice.second]!.hex,
      typeface: choice.typeface,
      radius: radiusFor(candidates.radius_px ?? 0),
      result_fields: ['more_facts', 'thumbnail'],
    };
    let checked = validateTheme(input);
    if ('problems' in checked) checked = validateTheme({ ...input, name: fallbackName });
    if ('problems' in checked) return `Usher couldn't make a theme from ${origin}: ${checked.problems.map((p) => p.message).join(' ')}`;
    const record = await this.o.registry.siteTheme(origin);
    const next: SiteThemeRecord = {
      ...record,
      proposed: checked.theme,
      derived: { at: this.now().toISOString(), ms: Math.round(performance.now() - started), by, ...(why && { why }), candidates, ...(shot && { shot }) },
    };
    await this.o.registry.putSiteTheme(origin, next);
    return next;
  }

  /** Adds a page's findings: colours counted, names and fonts kept once, logos captured if they're the site's own. */
  private async take(page: Page, origin: string, path: string, found: PageFindings, c: ThemeCandidates): Promise<void> {
    const where = path === '/' ? 'home' : 'form';
    for (const name of found.names) if (!c.names.includes(name) && c.names.length < 12) c.names.push(name);
    for (const col of found.colours) {
      const role = `${where} ${col.role}`;
      const same = c.colours.find((x) => x.hex === col.hex && x.role === role);
      if (same) same.count++;
      else if (c.colours.length < 40) c.colours.push({ hex: col.hex, role, count: 1 });
    }
    for (const f of found.fonts) if (!c.fonts.some((x) => x.family === f.family && x.role.endsWith(f.role))) c.fonts.push({ family: f.family, role: `${where} ${f.role}` });
    if (c.radius_px === null && found.radius !== null) c.radius_px = found.radius;
    for (const logo of found.logos) {
      if (c.logos.length >= 6) break;
      // Only the site's own: an image served from its origin (or inline in its page), or its own markup.
      if (logo.src && !logo.src.startsWith('data:image/') && new URL(logo.src, origin).origin !== origin) continue;
      const png = await page.locator(`[data-usher-logo="${logo.i}"]`).screenshot({ type: 'png', timeout: 4_000, animations: 'disabled' }).catch(() => undefined);
      if (!png || png.length > LOGO_MAX_BYTES) continue;
      const url = `data:image/png;base64,${png.toString('base64')}`;
      if (!c.logos.includes(url)) c.logos.push(url);
    }
  }

  private async ask(c: ThemeCandidates, shot: string | undefined): Promise<Record<string, unknown>> {
    const compiler = this.o.compiler!;
    const listed = {
      names: c.names.map((n, i) => ({ i, name: n })),
      logos: c.logos.map((_, i) => ({ i, note: `logo candidate ${i}, shown below` })),
      colours: c.colours.map((x, i) => ({ i, hex: x.hex, where: x.role, seen: x.count })),
      fonts: c.fonts,
      typefaces: TYPEFACE_IDS,
    };
    const content: ContentPart[] = [{ type: 'text', text: `Candidates from ${c.pages.join(' and ')}:\n${JSON.stringify(listed)}` }];
    c.logos.forEach((url, i) => content.push({ type: 'text', text: `Logo candidate ${i}:` }, { type: 'image_url', image_url: { url } }));
    if (shot) content.push({ type: 'text', text: 'The home page, fields greyed out:' }, { type: 'image_url', image_url: { url: shot } });
    const result = await compiler.chat({
      model: compiler.model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'usher_theme', strict: true, schema: schema(TYPEFACE_IDS) } },
    });
    return parseJsonContent(result.content) as Record<string, unknown>;
  }
}
