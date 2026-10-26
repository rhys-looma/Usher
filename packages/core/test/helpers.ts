import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { scanScript, type Scan } from '../src/index.ts';

export type Layout = 'a' | 'b';
export type Step = 'driver' | 'vehicle' | 'cover';

export const LAYOUTS: Layout[] = ['a', 'b'];
export const STEPS: Step[] = ['driver', 'vehicle', 'cover'];

/** Base URL of the mock site in a layout. Set by scripts/test.mjs. */
export function mockUrl(layout: Layout): string {
  const url = process.env[layout === 'a' ? 'USHER_MOCK_A' : 'USHER_MOCK_B'];
  if (!url) throw new Error('Mock site URLs are not set: run `npm test` from the repository root.');
  return url;
}

export function launch(): Promise<Browser> {
  return chromium.launch();
}

// Canonical field names; the mock site accepts these in both layouts.
const answers: Record<Exclude<Step, 'cover'>, Record<string, string>> = {
  driver: {
    title: 'mr',
    first_name: 'Sam',
    last_name: 'Taylor',
    dob: '1988-04-02',
    email: 'sam@example.com',
    postcode: 'WR14 1AA',
    address_line1: '1 High Street',
    occupation: 'teacher',
    employment_status: 'employed',
    has_claims: 'no',
  },
  vehicle: {
    registration: 'AB12CDE',
    make: 'Ford',
    model: 'Fiesta',
    year: '2018',
    annual_mileage: '8000',
    use: 'social-and-commuting',
    overnight: 'driveway',
    modified: 'no',
  },
};

/** Opens a step in a fresh session, submitting the steps before it first. */
export async function openStep(browser: Browser, layout: Layout, step: Step): Promise<{ context: BrowserContext; page: Page }> {
  const base = mockUrl(layout);
  const context = await browser.newContext();
  for (const earlier of STEPS.slice(0, STEPS.indexOf(step))) {
    const res = await context.request.post(`${base}/quote/${earlier}`, { form: answers[earlier as keyof typeof answers] });
    if (!res.ok()) throw new Error(`submitting ${earlier} failed with ${res.status()}`);
  }
  const page = await context.newPage();
  await page.goto(`${base}/quote/${step}`);
  return { context, page };
}

export function scan(page: Page): Promise<Scan> {
  return page.evaluate(scanScript());
}
