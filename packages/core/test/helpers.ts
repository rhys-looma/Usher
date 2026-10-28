import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { scanScript, type Scan } from '../src/index.ts';

/** a and b: the form before and after a redesign; c: the controls real quote forms use. */
export type Layout = 'a' | 'b' | 'c';
export type Step = 'driver' | 'vehicle' | 'cover';
/** Brightwater Health's steps, at /health/about, /health/cover and /health/declaration. */
export type HealthStep = 'health-about' | 'health-cover' | 'health-declaration';
export type AnyStep = Step | HealthStep;

export const LAYOUTS: Layout[] = ['a', 'b'];
export const STEPS: Step[] = ['driver', 'vehicle', 'cover'];
export const HEALTH_STEPS: HealthStep[] = ['health-about', 'health-cover', 'health-declaration'];

/** The path a step lives at. */
export const stepPath = (step: AnyStep) => (step.startsWith('health-') ? `/health/${step.slice('health-'.length)}` : `/quote/${step}`);
const journeyOf = (step: AnyStep): AnyStep[] => (step.startsWith('health-') ? HEALTH_STEPS : STEPS);

/** Base URL of the mock site in a layout. Set by scripts/test.mjs. */
export function mockUrl(layout: Layout): string {
  const url = process.env[`USHER_MOCK_${layout.toUpperCase()}`];
  if (!url) throw new Error('Mock site URLs are not set: run `npm test` from the repository root.');
  return url;
}

export function launch(): Promise<Browser> {
  return chromium.launch();
}

// Canonical field names; the mock site accepts these in both layouts.
const answers: Record<Exclude<AnyStep, 'cover' | 'health-declaration'>, Record<string, string>> = {
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
  'health-about': {
    title: 'mr',
    first_name: 'Sam',
    last_name: 'Taylor',
    dob: '1988-04-02',
    postcode: 'WR14 1AA',
    address_line1: '1 High Street',
    email: 'sam@example.com',
    covered: 'just-me',
    smoker: 'no',
  },
  'health-cover': {
    cover_level: 'comprehensive',
    excess: '250',
    hospital_list: 'standard',
    outpatient_limit: '1000',
    start_date: '2026-12-01',
    payment: 'monthly',
  },
};

/** Opens a step in a fresh session, submitting the steps before it first. */
export async function openStep(browser: Browser, layout: Layout, step: AnyStep): Promise<{ context: BrowserContext; page: Page }> {
  const base = mockUrl(layout);
  const context = await browser.newContext();
  const steps = journeyOf(step);
  for (const earlier of steps.slice(0, steps.indexOf(step))) {
    const res = await context.request.post(`${base}${stepPath(earlier)}`, { form: answers[earlier as keyof typeof answers] });
    if (!res.ok()) throw new Error(`submitting ${earlier} failed with ${res.status()}`);
  }
  const page = await context.newPage();
  await page.goto(`${base}${stepPath(step)}`);
  return { context, page };
}

export function scan(page: Page): Promise<Scan> {
  return page.evaluate(scanScript());
}
