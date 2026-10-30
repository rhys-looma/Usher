// The front page (LU-53): the sentence and Brightwater's app in an assistant, the twenty
// minutes, what happens in between on the hosted path (six steps, in reading order with no
// JavaScript) and what Usher keeps (as docs/security.md says it), for sites then for agents with this
// registry's address, the viewer box, the numbers, and the interest form, which carries Usher's own
// tag, asks whether Looma should set up the app, is locked to agents that didn't knock, and is listed
// for the admin only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startRegistry, type RunningRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';
import { pickerForms } from '../src/web/picker.ts';
import { KEEPS } from '../src/web/keeps.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
let dir: string;
let registry: RunningRegistry;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-landing-'));
  registry = await startRegistry({ storage: await testStorage(dir), siteScript, web: { adminKey: 'admin-test-key', viewer: 'open', forms: pickerForms() } });
});
after(async () => {
  await registry.close();
  await rm(dir, { recursive: true });
});

const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${registry.url}${path}`, { method: 'POST', body: new URLSearchParams(form), headers, redirect: 'manual' });

test('front page: the sentence (no prompt box in the hero), the example, the twenty minutes, the six steps, both quickstarts, the viewer box, numbers, sharing tags', async () => {
  const res = await fetch(`${registry.url}/`);
  const text = await res.text();
  assert.equal(res.status, 200);
  // The sentence, its second half set in italic.
  const order = ['Your site inside every assistant in twenty minutes. <em>Under your rules.</em>', 'Usher fills the form and forgets it.</p>', '<p class="ticket-title">Health insurance quote</p>', '<section class="example"', '<h2>The twenty minutes</h2>', '<h3>Tag</h3>', '<h3>Map</h3>', '<h3>Rules</h3>', '<h3>Publish</h3>', '<h3>Quote</h3>', '<h2>What happens in between</h2>', '<h3>What Usher keeps</h3>', '<p class="label">For sites</p><h2>Your site is the gateway. No rebuild, just your rules.</h2>', '<p class="lede">Keep the site and forms you have. One tag, then twenty minutes: Usher turns them into your own app in every assistant, hosts it and runs it.</p>', '<b>No changes to your systems.</b>', '<b>You set the terms.</b>', '<b>Every agent action on the record.</b>', 'Looma, the team behind Usher, sets it up and publishes it with you', '<p class="label">For agents</p><h2>Usher gives you the plan and holds the door; you drive.</h2>', '<h2>Try it</h2>', '<h2>Numbers</h2>', '<h2>I run a site with forms</h2>', 'Would you want Looma to set up and publish your assistant app?', 'Built by</small><a class="wordmark" href="https://looma.insure"'];
  const at = order.map((s) => text.indexOf(s));
  assert.ok(at.every((i) => i >= 0), `all present: ${order.filter((_, i) => at[i]! < 0).join(', ')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order');
  assert.doesNotMatch(text.split('</section>')[0]!, /Ask your assistant|class="bubble"/, 'the hero shows no prompt box');
  assert.ok(text.includes('No signup. Your agent&#39;s key is its identity.') || text.includes("No signup. Your agent's key is its identity."));
  assert.ok(text.includes(`&quot;USHER_REGISTRY_URL&quot;: &quot;${registry.url}&quot;`), 'the MCP entry names this registry');
  assert.ok(text.includes(`data-usher-registry=&quot;${registry.url}&quot;`), 'the tag names this registry');
  assert.ok(text.includes('href="/sites/new"'), 'Get your keys');
  assert.match(text, /× faster/, 'the benchmark');
  assert.match(text, /of fields and buttons on public forms given the right meaning \(\d+ of \d+\), human-checked/, 'human-checked public forms only, never the mock site\'s answer key');
  assert.match(text, /given the right risk \(\d+ of \d+\)/, 'with the sample size');
  assert.ok(text.includes('Maps are cached and refreshed by Usher&#39;s keeper; nothing is submitted to any of these sites.') || text.includes("Maps are cached and refreshed by Usher's keeper; nothing is submitted to any of these sites."));
  assert.match(text, /<code>get_plan<\/code> gives you the journey and the rules; <code>prepare_run<\/code> puts your user&#39;s answers in the site&#39;s own form|<code>get_plan<\/code> gives you the journey and the rules; <code>prepare_run<\/code> puts your user's answers in the site's own form/);
  const description = 'Usher puts your site inside every assistant in twenty minutes: the forms you already have become your own app, in your name and look, run under your rules. Nothing to rebuild. Usher fills the form and forgets it.';
  assert.ok(text.includes(`<meta name="description" content="${description}">`) && text.includes(`<meta property="og:description" content="${description}">`));
  assert.match(text, /<meta property="og:image" content="[^"]+\/og\.png">/);
  assert.match(text, /<title>Usher: your site inside every assistant<\/title>/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'; connect-src 'self'/, 'its own site script, nothing else');
  const og = await fetch(`${registry.url}/og.png`);
  assert.deepEqual([og.status, og.headers.get('content-type')], [200, 'image/png']);
});

test('front page: the interest form carries Usher\'s own tag, and the site claims its origin like any other', async () => {
  const own = await registry.registry.ownSite();
  const text = await (await fetch(`${registry.url}/`)).text();
  assert.ok(text.includes(`data-usher-site-key="${own.site_key}"`));
  assert.deepEqual(await (await fetch(`${registry.url}/.well-known/usher-site.json`)).json(), { usher_site: '0.1', site_key: own.site_key });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${registry.url}/`);
  await page.waitForFunction(() => document.querySelector('form[action="/interest"]')?.getAttribute('data-usher-knock'));
  assert.equal(await page.locator('form[action="/interest"]').getAttribute('data-usher-knock'), `${registry.url}/knock`);
  await browser.close();
});

test('front page: a failed "try it" is explained on the page', async () => {
  const res = await post('/viewer', { from: 'home', url: 'http://10.0.0.1/form' });
  assert.equal(res.status, 422);
  const text = await res.text();
  assert.match(text, /class="card error">The viewer only opens public websites\./);
  assert.match(text, /<h2>What happens in between<\/h2>/, 'still the front page');
});

test('interest: people are stored, agents must knock, mistakes are explained, the list is for the admin only', async () => {
  const ok = await post('/interest', { site: 'https://shop.example', email: 'owner@shop.example', note: 'A checkout form', setup: 'yes' });
  assert.deepEqual([ok.status, ok.headers.get('location')], [303, '/interest/thanks']);
  assert.match(await (await fetch(`${registry.url}/interest/thanks`)).text(), /Thank you/);
  const agent = await post('/interest', { site: 'https://shop.example', email: 'a@shop.example' }, { 'Usher-Agent': 'test-agent' });
  assert.equal(agent.status, 403);
  assert.deepEqual(((await agent.json()) as { error: string; intent: string }).intent, 'contact.interest');
  const bad = await post('/interest', { site: 'shop', email: 'a@shop.example' });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Give your site&#39;s address|Give your site's address/);

  assert.equal((await fetch(`${registry.url}/admin`)).status, 200, 'a sign-in form');
  assert.doesNotMatch(await (await fetch(`${registry.url}/admin`)).text(), /owner@shop\.example/);
  assert.equal((await post('/admin/login', { key: 'wrong' })).status, 401);
  const login = await post('/admin/login', { key: 'admin-test-key' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const list = await (await fetch(`${registry.url}/admin`, { headers: { cookie } })).text();
  assert.match(list, /owner@shop\.example/);
  assert.match(list, /A checkout form<\/td><td>yes<\/td>/, 'with the answer to "Looma to set up"');
  assert.doesNotMatch(list, /a@shop\.example/, 'the refused agent stored nothing');
});

test('specifications are served with this registry in place of the example registry', async () => {
  const index = await (await fetch(`${registry.url}/spec/`)).text();
  assert.match(index, /knock\.md/);
  const discovery = (await (await fetch(`${registry.url}/spec/examples/knock/site-discovery.json`)).json()) as { registry: string; knock_url: string };
  assert.deepEqual([discovery.registry, discovery.knock_url], [registry.url, `${registry.url}/knock`]);
  assert.equal((await fetch(`${registry.url}/spec/../package.json`)).status, 404);
});

test('the dashboard sign-in and signup step 1 carry the same three claims', async () => {
  for (const path of ['/dashboard', '/sites/new']) {
    const text = await (await fetch(`${registry.url}${path}`)).text();
    for (const claim of ['No changes to your systems.', 'You set the terms.', 'Every agent action on the record.']) assert.ok(text.includes(`<b>${claim}</b>`), `${path}: ${claim}`);
  }
});

test('numbers: a half-marked accuracy run is never shown; the latest complete one is, with its sample sizes', async () => {
  const { loadNumbers } = await import('../src/web/landing.ts');
  const { accuracy } = await loadNumbers();
  assert.equal(accuracy?.kind, 'reviewed');
  if (accuracy?.kind !== 'reviewed') return;
  // The current review still has unmarked public rows, so the complete run of 27 October shows.
  assert.equal(accuracy.run, '2026-10-27');
  assert.deepEqual([accuracy.keys, accuracy.keysOf, accuracy.risk, accuracy.riskOf], ['73.9%', '51 of 69', '98.6%', '68 of 69']);
});

test('what happens in between: Brightwater\'s own app on one side, six hosted steps with what Usher sees on the other, readable with no JavaScript', async () => {
  const text = await (await fetch(`${registry.url}/`)).text();
  const section = /<section class="between" id="how"[\s\S]*?<\/section>/.exec(text)?.[0] ?? '';
  // The customer's side first (message, decision card, quote), then the steps, then what Usher keeps.
  const at = (s: string) => section.indexOf(s);
  assert.ok(at('class="step person"') < at('class="step said s-decision"') && at('s-decision') < at('class="step said s-result"') && at('s-result') < at('<ol class="seq-steps">') && at('</ol>') < at('id="keeps"'));
  // The customer's side is Brightwater's app, drawn as the card draws it: the band with its name and
  // Usher's mark, the card's own words, the reference and the way back to the site.
  const customer = /<figure class="assistant uc"[\s\S]*?<\/figure>/.exec(section)?.[0] ?? '';
  assert.match(customer, /<p class="callout"><b>Only with Usher<\/b> Your customer decides, in your words\./);
  assert.match(customer, /<div class="card decision branded"><div class="band">[^]*?<span class="name">Brightwater Insurance<\/span><span class="via">via Usher<\/span><\/div><p class="label">Your decision<\/p><p class="title">Before Usher goes on<\/p>/);
  assert.match(customer, /<p class="asking">Usher is asking you, not the agent<\/p>/);
  assert.match(customer, /<p class="ref">Reference <b>BWH-3F9A2C71<\/b><\/p>[^]*Continue on Brightwater Insurance/);
  const steps = [...section.matchAll(/<li data-step="(\d)"><h3><span class="n">\d<\/span> ([^<]+)<\/h3><p>([^<]+)<\/p>(?:<p class="note">([^<]+)<\/p>)?<p class="sees"><b>Usher sees:<\/b> ([^<]+)<\/p><\/li>/g)].map((m) => [m[1], m[2], m[3], m[4], m[5]]);
  const plain = (s?: string) => s?.replace(/&#39;/g, "'");
  assert.deepEqual(steps.map((s) => s.map(plain)), [
    ['1', 'Your app is asked', 'Your customer asks their assistant for a quote, and it calls your app. Your app runs only on sites that joined, and acts only on yours.', undefined, 'your site, what the app came to do, when its pass expires.'],
    ['2', 'Your map and your rules', "Usher takes your published map, every field by meaning, in order, and your rules: what an assistant may fill and what is your customer's alone.", undefined, 'field names and types. Never what anyone types.'],
    ['3', 'Usher fills the safe fields', 'Name, date of birth, postcode, cover level: the fields you let it fill, from what your customer said, in a fresh browser on your site. Usher fills the form and forgets it.', undefined, 'which fields were filled. Not the values.'],
    ['4', 'The questions that are yours', 'Smoking, the declaration, any you choose: shown to your customer in your own wording, word for word, unticked, never answered by their assistant.', 'Or let the assistant answer one from what your customer said: Usher still shows it back to them to confirm.', "that each was shown, and your customer's yes or no."],
    ['5', 'Submit with the token', "Usher presses your button as your rules say (Brightwater's: only once the customer confirms), with a token your server checks before it quotes. No token, no quote.", undefined, 'that a quote was asked for, with a valid token.'],
    ['6', 'On your record', 'Your customer gets your quote, its reference and a way to continue on your site. Your dashboard shows the session: which fields, what your customer was shown and what they confirmed.', undefined, 'the session. Never the answers.'],
  ]);
  // Nothing in it is hidden or waiting until a script runs; the replay control is the script's.
  assert.doesNotMatch(section.replace('class="seq-replay" hidden', ''), /\shidden|display:none|opacity:0/);
  assert.match(section, /<div class="views seq" data-steps>/);
  assert.match(section, /What your customer sees <span>Brightwater Insurance(&#39;|')s own app<\/span>[\s\S]*Under the hood <span>Usher, for you<\/span>/);
  // Brightwater's app runs on Usher; the form is on Brightwater's own site.
  assert.match(section, /<ol class="route"[^>]*><li>Your customer(&#39;|')s assistant<\/li><li>Brightwater(&#39;|')s app<\/li><li class="usher"><span>Usher<\/span><\/li><li>Brightwater(&#39;|')s site<\/li><\/ol>/);
  const js = await (await fetch(`${registry.url}/site.js`)).text();
  assert.match(js, /prefers-reduced-motion: reduce\)'\)\.matches\) return;/, 'reduced motion: no autoplay, everything shown');
  assert.match(js, /data-steps/);
  assert.match(text, /\.seq\.seq-on \.seq-steps li \{ opacity:\.22;/, 'faded only once site.js plays the sequence');
  // A generic assistant, no product's interface, here and in the example under the hero.
  const example = /<section class="example"[\s\S]*?<\/section>/.exec(text)?.[0] ?? '';
  assert.match(example, /<div class="card branded"><div class="band">/);
  for (const shown of [customer, example, /<div class="hood">[\s\S]*?<\/ol>/.exec(section)?.[0] ?? '']) assert.doesNotMatch(shown, /Claude|ChatGPT|OpenAI|Anthropic|Gemini|Copilot|Cursor|<img/);
});

test('what Usher keeps: the same three lines on the page, in /privacy and in docs/security.md', async () => {
  const text = (await (await fetch(`${registry.url}/`)).text()).replace(/&#39;/g, "'");
  const privacy = (await (await fetch(`${registry.url}/privacy`)).text()).replace(/&#39;/g, "'");
  const doc = await readFile(new URL('../../../docs/security.md', import.meta.url), 'utf8');
  const block = /## What Usher keeps\n\n((?:- .+\n)+)/.exec(doc)?.[1] ?? '';
  assert.deepEqual(block.trim().split('\n').map((l) => l.slice(2)), [...KEEPS], 'docs/security.md says it word for word');
  const keeps = /<div class="keeps" id="keeps"><h3>What Usher keeps<\/h3><ul>([\s\S]*?)<\/ul>/.exec(text)?.[1] ?? '';
  assert.deepEqual([...keeps.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]), [...KEEPS]);
  for (const line of KEEPS) assert.ok(privacy.includes(`<li>${line}</li>`), line);
  for (const page of [text, privacy, doc]) assert.doesNotMatch(page, /no sensitive data goes to Usher/i);
  assert.ok(text.indexOf('id="keeps"') > text.indexOf('<ol class="seq-steps">'), 'directly under the sequence');
});
