// What the /demo page shows, and how it gets there. The runner changes the stage; the page
// follows it over server-sent events. Browser panes are live frames from the agents' headless
// browsers (Chromium's screencast), so the page shows exactly what each agent is doing.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Page } from 'playwright';
import { DEMO_CSS, DEMO_HTML, DEMO_JS } from './page.ts';

export interface PaneState {
  id: string;
  title: string;
  subtitle?: string;
  status: string;
  tone?: 'ok' | 'bad' | 'wait';
  /** Server times (ms): the pane's timer runs from started_at to ended_at. */
  started_at?: number;
  ended_at?: number;
  /** Model tokens and cost, when the pane counts them. */
  counters: boolean;
  tokens: number;
  cost_usd: number;
}

export interface CardState {
  id: string;
  title: string;
  lines?: string[];
  code?: string;
  tone?: 'ok' | 'bad' | 'info';
  timer?: { started_at: number; ended_at?: number };
}

export interface StageState {
  scene: string | null;
  title: string;
  caption: string;
  /** Small print under the caption, e.g. that model latency is replayed. */
  note?: string;
  panes: PaneState[];
  cards: CardState[];
  ask?: { id: string; question: string };
  numbers: [string, string][];
  running: boolean;
}

export interface SceneInfo {
  id: string;
  title: string;
}

const EMPTY: StageState = { scene: null, title: 'Usher', caption: 'Press a number to run a scene.', panes: [], cards: [], numbers: [], running: false };

export class Stage {
  state: StageState = structuredClone(EMPTY);
  private readonly clients = new Set<ServerResponse>();
  private readonly frames = new Map<string, string>();
  private answer?: (yes: boolean) => void;

  constructor(
    private readonly scenes: SceneInfo[],
    private readonly run: (scene: string) => void,
  ) {}

  get watching(): number {
    return this.clients.size;
  }

  clear(scene: string | null, title: string, caption: string, note?: string): void {
    this.frames.clear();
    this.state = { ...structuredClone(EMPTY), scene, title, caption, ...(note && { note }), running: scene !== null };
    this.publish();
  }

  set(patch: Partial<StageState>): void {
    Object.assign(this.state, patch);
    this.publish();
  }

  pane(id: string, patch: Partial<PaneState>): PaneState {
    let pane = this.state.panes.find((p) => p.id === id);
    if (!pane) this.state.panes.push((pane = { id, title: id, status: '', counters: false, tokens: 0, cost_usd: 0 }));
    Object.assign(pane, patch);
    this.publish();
    return pane;
  }

  card(id: string, patch: Partial<CardState>): CardState {
    let card = this.state.cards.find((c) => c.id === id);
    if (!card) this.state.cards.push((card = { id, title: id }));
    Object.assign(card, patch);
    this.publish();
    return card;
  }

  number(label: string, value: string): void {
    this.state.numbers.push([label, value]);
    this.publish();
  }

  /** Asks the person at the demo; yes after `autoMs` if nobody answers (so scripted runs finish). */
  ask(question: string, autoMs: number): Promise<boolean> {
    const id = Math.random().toString(36).slice(2);
    this.set({ ask: { id, question } });
    return new Promise((resolve) => {
      const done = (yes: boolean) => {
        clearTimeout(timer);
        this.answer = undefined;
        this.set({ ask: undefined });
        resolve(yes);
      };
      const timer = setTimeout(() => done(true), autoMs);
      this.answer = done;
    });
  }

  /** Streams a page into a pane: every frame Chromium paints, until the page closes. */
  async stream(paneId: string, page: Page): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Page.screencastFrame', (frame) => {
      this.frames.set(paneId, frame.data);
      this.send('frame', { pane: paneId, data: frame.data });
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, everyNthFrame: 1 });
  }

  private send(event: string, data: unknown): void {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.write(chunk);
  }

  publish(): void {
    this.send('state', { ...this.state, now: Date.now() });
  }

  /** The /demo routes. */
  handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const route = `${req.method} ${url.pathname}`;
    const asset = (type: string, body: string) => {
      res.writeHead(200, {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(body);
    };
    if (route === 'GET /demo') return asset('text/html', DEMO_HTML);
    if (route === 'GET /demo/demo.css') return asset('text/css', DEMO_CSS);
    if (route === 'GET /demo/demo.js') return asset('text/javascript', DEMO_JS);
    if (route === 'GET /demo/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: scenes\ndata: ${JSON.stringify(this.scenes)}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify({ ...this.state, now: Date.now() })}\n\n`);
      for (const [pane, data] of this.frames) res.write(`event: frame\ndata: ${JSON.stringify({ pane, data })}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    const scene = /^\/demo\/run\/([a-z-]+)$/.exec(url.pathname);
    if (scene && req.method === 'POST') {
      const known = scene[1] === 'all' || this.scenes.some((s) => s.id === scene[1]);
      const busy = this.state.running;
      if (known && !busy) this.run(scene[1]!);
      res.writeHead(!known ? 404 : busy ? 409 : 202, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ ok: known && !busy }));
    }
    if (route === 'POST /demo/answer') {
      const yes = url.searchParams.get('yes') !== '0';
      this.answer?.(yes);
      res.writeHead(204);
      return void res.end();
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not a demo route.');
  };
}
