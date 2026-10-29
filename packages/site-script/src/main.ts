// The Usher site script (LU-25). One tag:
//
//   <script src="https://registry.example/usher.js" data-usher-registry="https://registry.example" defer></script>
//
// On load it adds the knock notice to every form (nothing a person sees), fingerprints the live
// form and looks up its map, and reports drift if the form no longer matches. An agent that has
// knocked binds its token with window.usher.bind(token) or a "usher:bind" postMessage; only then
// does the script unlock the form, apply the site's rules and log the agent's actions by
// semantic key. Page loads without a bound token are never logged, and no event carries a value.

import { extractForms } from '@usher/core/extract';
import { candidateForms, mainForm } from '@usher/core/forms';
import { fingerprint, similarity, type Fingerprint } from '@usher/core/fingerprint';
import { locatorKit } from '@usher/core/locators';
import { readValidationErrors, type PageError } from '@usher/core/page-errors';
import { verifyToken, type KeySet, type PublicJwk, type TokenClaims } from '@usher/core/token';

type Risk = 'safe' | 'consequential' | 'needs_user';
type Action = 'fill' | 'select' | 'choose' | 'check' | 'uncheck' | 'click' | 'submit' | 'held' | 'confirm' | 'handoff' | 'invalid';

interface MapElement {
  id: string;
  key: string;
  label: string;
  risk: Risk;
  control?: string;
  kind?: string;
  locators: { by: string; value: string; name?: string }[];
}

interface UsherMap {
  fingerprint: Fingerprint;
  form: { intent?: string };
  fields: MapElement[];
  actions: MapElement[];
}

interface Rules {
  agents: 'allowed' | 'denied';
  confirm: Risk[];
  human_only: Risk[];
  actions?: Record<string, 'allow' | 'confirm' | 'forbid'>;
}

const FLOOR: Record<Risk, 'allow' | 'confirm' | 'forbid'> = { safe: 'allow', consequential: 'confirm', needs_user: 'forbid' };

interface Lookup {
  match: { kind: 'exact' | 'near' | 'path' | 'none'; score: number; digest: string | null; drifted: boolean };
  map: UsherMap | null;
  rules: Rules;
}

type State = 'locked' | 'unlocked' | 'awaiting_confirmation';

const VERSION = '0.1.0';
const script = document.currentScript as HTMLScriptElement | null;
const registry = (script?.dataset.usherRegistry ?? (script?.src ? new URL(script.src).origin : '')).replace(/\/$/, '');
const knockUrl = `${registry}/knock`;
const keysUrl = `${registry}/.well-known/usher-keys.json`;
/** The site's public key, for drift reports. */
const siteKey = script?.dataset.usherSiteKey ?? '';
const MAP_CACHE_MS = 60 * 60 * 1000;
const TOKEN_FIELD = 'usher_token';
const kit = locatorKit();

let lookup: Lookup | null = null;
let live: Fingerprint | null = null;
// The other forms a map could be for, by fingerprint.
let others: Fingerprint[] = [];
let drifted = false;
let token: string | null = null;
let claims: TokenClaims | null = null;
let state: State = 'locked';
let confirmed = false;
let heldKey: string | undefined;
let elements = new Map<Element, MapElement>();

function setState(next: State): void {
  state = next;
  for (const f of Array.from(document.forms)) f.dataset.usherState = next;
}

// The notice: a data attribute and a visually hidden note pointing agents at the knock URL.
function addNotices(): void {
  for (const f of Array.from(document.forms)) {
    f.dataset.usherKnock = knockUrl;
    f.dataset.usherState = state;
    if (f.querySelector('[data-usher-note]')) continue;
    const note = document.createElement('p');
    note.setAttribute('role', 'note');
    note.dataset.usherNote = '';
    note.textContent = `This form has an agent lane (Usher). Agents: knock at ${knockUrl} before filling it.`;
    note.style.cssText = 'position:absolute!important;width:1px!important;height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;white-space:nowrap!important;border:0!important';
    f.append(note);
    // A browser that says it is driven by automation (navigator.webdriver: Playwright, Puppeteer,
    // Selenium) is an agent: the form says so, and the site's server asks it for a token. A
    // deterrent, not a lock; an agent with a token is unaffected.
    if (navigator.webdriver === true && !f.querySelector('input[name="usher_automation"]')) {
      const flag = document.createElement('input');
      flag.type = 'hidden';
      flag.name = 'usher_automation';
      flag.value = '1';
      f.append(flag);
    }
  }
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${registry}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), keepalive: true, credentials: 'omit' });
}

function stored<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // No storage: fine, we just fetch again next time.
  }
}

interface CurrentMap {
  digest: string | null;
  signature: string[] | null;
  at: number;
}

// The registry's current map for this page, fetched at most hourly per browser. Nothing about
// the visitor is sent: no cookies, no fingerprint of the page, just origin and path.
async function currentMap(): Promise<CurrentMap | null> {
  const cacheKey = `usher-map:${location.origin}${location.pathname}`;
  const cached = stored<CurrentMap>(cacheKey);
  if (cached && Date.now() - cached.at < MAP_CACHE_MS) return cached;
  const res = await fetch(`${registry}/maps/current?origin=${encodeURIComponent(location.origin)}&path=${encodeURIComponent(location.pathname)}`, { credentials: 'omit' });
  if (!res.ok) return cached;
  const current = { ...((await res.json()) as Omit<CurrentMap, 'at'>), at: Date.now() };
  store(cacheKey, current);
  return current;
}

// Fingerprints the live form and compares it with the registry's map locally. Only a mismatch
// is reported, once per map and live form.
async function load(): Promise<void> {
  // Every form a map could be for; the likeliest first. The map may be for another of them (a
  // model chose it by an agent's intent), so the one with the map's fingerprint wins.
  const forms = extractForms().forms;
  const likeliest = mainForm(forms);
  if (!likeliest) return;
  others = await Promise.all(candidateForms(forms).filter((f) => f !== likeliest).map((f) => fingerprint(f.elements)));
  live = await fingerprint(likeliest.elements);
  const current = await currentMap();
  // The map's form, or the one most like it, to compare with the map.
  const sig = current?.signature;
  if (sig) live = [live, ...others].sort((a, b) => Number(b.digest === current!.digest) - Number(a.digest === current!.digest) || similarity(b.signature, sig) - similarity(a.signature, sig))[0]!;
  if (!current?.digest || current.digest === live.digest) return;
  drifted = true;
  const seen = `usher-drift:${location.pathname}:${current.digest}:${live.digest}`;
  if (!siteKey || stored<boolean>(seen)) return;
  store(seen, true);
  const score = current.signature ? Math.round(similarity(live.signature, current.signature) * 1000) / 1000 : 0;
  await post('/drift', { origin: location.origin, path: location.pathname, map: current.digest, fingerprint: live, score }, { 'Usher-Site-Key': siteKey });
}

// The map and rules for this page, fetched only once an agent has bound a token.
async function lookupMap(agentToken: string | null = token): Promise<void> {
  if (!live) return;
  // The agent's token lets the registry show it its own map, before others have verified it (the
  // registry checks the token).
  const auth: Record<string, string> = agentToken ? { Authorization: `Usher ${agentToken}` } : {};
  const res = await post('/maps/lookup', { origin: location.origin, path: location.pathname, fingerprint: live }, auth);
  if (res.ok) lookup = (await res.json()) as Lookup;
  // An agent may have just shared a map for another form on the page.
  for (const other of lookup?.match.kind === 'exact' ? [] : others) {
    const again = await post('/maps/lookup', { origin: location.origin, path: location.pathname, fingerprint: other }, auth);
    const found = again.ok ? ((await again.json()) as Lookup) : null;
    if (found?.match.kind === 'exact') {
      lookup = found;
      live = other;
      return;
    }
  }
}

let keys: KeySet | null = null;
async function keyFor(kid: string): Promise<PublicJwk | undefined> {
  if (!keys?.keys.some((k) => k.kid === kid)) {
    const res = await fetch(keysUrl, { credentials: 'omit' });
    keys = res.ok ? ((await res.json()) as KeySet) : null;
  }
  return keys?.keys.find((k) => k.kid === kid);
}

// Which map element each page element is, found with the map's own locators.
function indexElements(map: UsherMap): Map<Element, MapElement> {
  const index = new Map<Element, MapElement>();
  for (const el of [...map.fields.map((f) => ({ ...f, kind: 'field' })), ...map.actions]) {
    for (const loc of el.locators) {
      const found = kit.resolve(loc as Parameters<typeof kit.resolve>[0]);
      if (found.length === 1) {
        index.set(found[0]!, el);
        break;
      }
    }
  }
  return index;
}

function elementFor(target: EventTarget | null): MapElement | undefined {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    const el = elements.get(node);
    if (el) return el;
  }
  return undefined;
}

function log(action: Action, el?: MapElement): void {
  if (!token || !claims) return;
  const event = { ts: new Date().toISOString(), source: 'site', action, path: location.pathname, ...(el && { key: el.key, element: el.id }) };
  void post(`/sessions/${claims.sid}/events`, { events: [event] }, { Authorization: `Usher ${token}` }).catch(() => undefined);
}

const CHOICES = new Set(['select', 'radio', 'checkbox']);
let lastFilled: string | undefined;

// Text is logged on its first input, so the log keeps the order the agent acted in (change
// only fires on blur); typing on in the same field adds nothing.
function onInput(event: Event): void {
  const el = elementFor(event.target);
  if (!token || !el || el.kind !== 'field' || CHOICES.has(el.control ?? '') || lastFilled === el.id) return;
  lastFilled = el.id;
  log('fill', el);
}

function onChange(event: Event): void {
  const el = elementFor(event.target);
  if (!token || !el || el.kind !== 'field' || !CHOICES.has(el.control ?? '')) return;
  lastFilled = undefined;
  const action: Action = el.control === 'select' ? 'select' : el.control === 'radio' ? 'choose' : (event.target as HTMLInputElement).checked ? 'check' : 'uncheck';
  log(action, el);
}

function onClick(event: Event): void {
  const el = elementFor(event.target);
  // Submits are logged by onSubmit, which can still hold them.
  if (!token || !el || (el.kind !== 'button' && el.kind !== 'link')) return;
  lastFilled = undefined;
  log('click', el);
}

function onSubmit(event: SubmitEvent): void {
  if (!token || !lookup) return;
  const el = elementFor(event.submitter) ?? lookup.map?.actions.find((a) => a.kind === 'submit');
  const rule = el ? (lookup.rules.actions?.[el.key] ?? FLOOR[el.risk]) : 'allow';
  // A token that already says the person confirmed this (they did, in the assistant's Usher card)
  // counts as confirmed: an assistant driving a browser can't call usher.confirm().
  const confirmedInToken = Boolean(el && claims?.confirmed?.includes(el.key));
  if (rule === 'forbid' || (rule === 'confirm' && !confirmed && !confirmedInToken)) {
    // The site's rules: the user must confirm this first, or only the user may do it.
    event.preventDefault();
    heldKey = el?.key;
    setState('awaiting_confirmation');
    log('held', el);
    return;
  }
  const f = event.target as HTMLFormElement;
  let field = f.querySelector<HTMLInputElement>(`input[name="${TOKEN_FIELD}"]`);
  if (!field) {
    field = document.createElement('input');
    field.type = 'hidden';
    field.name = TOKEN_FIELD;
    f.append(field);
  }
  field.value = token;
  log('submit', el);
}

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);
}

export interface BindResult {
  ok: boolean;
  error?: string;
  session?: string;
}

async function bind(candidate: string): Promise<BindResult> {
  await ready;
  if (typeof candidate !== 'string') return { ok: false, error: 'malformed' };
  // Look the map up now (an agent that found none may have just compiled and shared one).
  if (lookup?.match.kind !== 'exact') await lookupMap(candidate).catch(() => undefined);
  const result = await verifyToken(candidate, {
    keys: keyFor,
    origin: location.origin,
    issuers: [registry],
    ...(lookup?.map?.form.intent && { intent: lookup.map.form.intent }),
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (lookup?.rules.agents === 'denied') return { ok: false, error: 'agents_not_allowed' };
  token = candidate;
  claims = result.claims;
  confirmed = false;
  elements = lookup?.map ? indexElements(lookup.map) : new Map();
  setState('unlocked');
  listen();
  // The site sent the page back with errors: log which keys, never the messages (they can echo values).
  for (const e of errors()) log('invalid', [...elements.values()].find((m) => m.key === e.key));
  return { ok: true, session: result.claims.sid };
}

/** Called by the agent after its user has confirmed an action: the held one, or the one named. */
function confirm(key?: string): boolean {
  if (!token) return false;
  confirmed = true;
  const confirmedKey = heldKey ?? key;
  const el = confirmedKey ? [...elements.values()].find((e) => e.key === confirmedKey) : undefined;
  log('confirm', el);
  setState('unlocked');
  return true;
}

/** The page's validation errors, by semantic key, from the map's locators. */
function errors(): PageError[] {
  if (!lookup?.map) return [];
  return readValidationErrors(kit, [...lookup.map.fields, ...lookup.map.actions].map((e) => ({ key: e.key, locators: e.locators as Parameters<typeof readValidationErrors>[1][number]['locators'] })));
}

/** Called by the agent when it hands an element to its user (needs_user). */
function handoff(key: string): boolean {
  const el = [...elements.values()].find((e) => e.key === key);
  if (!token || !el) return false;
  log('handoff', el);
  return true;
}

const ready: Promise<void> = new Promise((resolve) => {
  const start = () => {
    addNotices();
    load().catch(() => undefined).finally(resolve);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as { type?: string; token?: string } | null;
  if (data?.type !== 'usher:bind' || typeof data.token !== 'string') return;
  void bind(data.token).then((result) => window.postMessage({ type: 'usher:bound', ...result }, location.origin));
});

const api = {
  version: VERSION,
  registry,
  ready,
  bind,
  confirm,
  handoff,
  errors,
  state: () => ({ state, bound: token !== null, session: claims?.sid ?? null, drifted, match: lookup?.match ?? null }),
};

declare global {
  interface Window {
    usher: typeof api;
  }
}
window.usher = api;

// An assistant driving its own browser opens the knock's entry_url: the token in the query
// (usher=…) is bound on load, kept for this tab's session so the journey's later pages bind it too,
// and taken out of the address bar so it is never shared, bookmarked or logged by the site.
const KEPT = 'usher:token';
void (async () => {
  const params = new URLSearchParams(location.search);
  const given = params.get('usher');
  if (given) {
    params.delete('usher');
    const rest = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  }
  let kept: string | null = null;
  try {
    kept = sessionStorage.getItem(KEPT);
  } catch {
    // Storage blocked: only the entry page is bound.
  }
  const candidate = given ?? kept;
  if (!candidate || !document.forms.length) return;
  const result = await bind(candidate);
  try {
    if (result.ok) sessionStorage.setItem(KEPT, candidate);
    else if (!given) sessionStorage.removeItem(KEPT);
  } catch {
    // As above.
  }
})();
