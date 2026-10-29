// A site that turns the browser away (bot protection's "Access Denied"), or a first page with no
// form: the run fails with a plain reason for the person, never "completed", and never a status code.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { runAgent, scriptedUser, type Profile } from '../src/index.ts';

let browser: Browser;
let server: Server;
let base: string;
const profile: Profile = { 'person.first_name': 'Sam' };

before(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    if (req.url === '/denied') return res.writeHead(403, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Access Denied</title><h1>Access Denied</h1><p>Reference #18.48b1</p>');
    if (req.url === '/empty') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Nothing here</title><p>No form.</p>');
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await browser.close();
  server.close();
});

const run = (path: string) => runAgent({ browser, url: `${base}${path}`, profile, intent: 'quote.life_insurance', registry: { close: async () => undefined } as never, noUsher: true, user: scriptedUser(profile) });

test('a site that refuses the browser fails the run in plain words, with nothing filled', async () => {
  const result = await run('/denied');
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason ?? '', /^The 127\.0\.0\.1:\d+ website wouldn't let Usher's browser in just now, so nothing was filled\./);
  assert.doesNotMatch(result.reason ?? '', /403|HTTP|status/i, 'no status codes for customers');
  assert.equal(result.pages.length, 0);
});

test('a first page with no form is not a finished journey', async () => {
  const result = await run('/empty');
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason ?? '', /found no form to fill/);
});
