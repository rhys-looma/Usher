// Which candidate public forms can join the eval (evals/forms.json): robots.txt allows the page (for
// any crawler, and for ours), it loads in a headless browser without an unavoidable cookie wall or a
// login, and it has a form a map could be for. For each one that can, writes an extraction fixture
// (structure only: labels, controls, options, flags; extraction never reads what is typed) to
// test/fixtures/eval-forms/<id>.json. Nothing is clicked, typed or submitted.
//
//   node --import tsx packages/core/scripts/eval-probe.ts [--add]   # --add appends the passing forms to evals/forms.json

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { VIEWPORT, candidateForms, compactExtraction, scanScript, type Scan } from '../src/index.ts';
import { robotsAllows } from '../../registry/src/keeper.ts';

const { values } = parseArgs({ options: { add: { type: 'boolean', default: false } } });
const root = new URL('../../../', import.meta.url);

// UK public pages with a form on them, read-only. Categories as in evals/forms.json.
const CANDIDATES: { id: string; category: string; url: string }[] = [
  { id: 'govuk-find-council', category: 'lookup', url: 'https://www.gov.uk/find-local-council' },
  { id: 'govuk-travel-advice', category: 'search', url: 'https://www.gov.uk/foreign-travel-advice' },
  { id: 'govuk-electoral-office', category: 'lookup', url: 'https://www.gov.uk/contact-electoral-registration-office' },
  { id: 'vehicle-enquiry', category: 'lookup', url: 'https://vehicleenquiry.service.gov.uk/' },
  { id: 'check-mot', category: 'lookup', url: 'https://www.check-mot.service.gov.uk/' },
  { id: 'epc-postcode', category: 'lookup', url: 'https://find-energy-certificate.service.gov.uk/find-a-certificate/search-by-postcode' },
  { id: 'companies-house-search', category: 'search', url: 'https://find-and-update.company-information.service.gov.uk/' },
  { id: 'charity-register-search', category: 'search', url: 'https://register-of-charities.charitycommission.gov.uk/en/charity-search' },
  { id: 'food-ratings', category: 'search', url: 'https://ratings.food.gov.uk/' },
  { id: 'flood-check', category: 'lookup', url: 'https://check-for-flooding.service.gov.uk/' },
  { id: 'ofsted-reports', category: 'search', url: 'https://reports.ofsted.gov.uk/' },
  { id: 'legislation-search', category: 'search', url: 'https://www.legislation.gov.uk/' },
  { id: 'national-archives-search', category: 'search', url: 'https://discovery.nationalarchives.gov.uk/' },
  { id: 'police-uk', category: 'lookup', url: 'https://www.police.uk/' },
  { id: 'nhs-find-gp', category: 'lookup', url: 'https://www.nhs.uk/service-search/find-a-gp' },
  { id: 'nhs-find-pharmacy', category: 'lookup', url: 'https://www.nhs.uk/service-search/pharmacy/find-a-pharmacy' },
  { id: 'nhs-find-dentist', category: 'lookup', url: 'https://www.nhs.uk/service-search/find-a-dentist' },
  { id: 'tfl-journey', category: 'booking', url: 'https://tfl.gov.uk/plan-a-journey/' },
  { id: 'metoffice-search', category: 'search', url: 'https://www.metoffice.gov.uk/' },
  { id: 'ofcom-broadband-checker', category: 'lookup', url: 'https://checker.ofcom.org.uk/en-gb/broadband-coverage' },
  { id: 'royalmail-track', category: 'lookup', url: 'https://www.royalmail.com/track-your-item' },
  { id: 'royalmail-postcode', category: 'lookup', url: 'https://www.royalmail.com/find-a-postcode' },
  { id: 'postoffice-branch', category: 'lookup', url: 'https://www.postoffice.co.uk/branch-finder' },
  { id: 'moneyhelper-mortgage', category: 'calculator', url: 'https://www.moneyhelper.org.uk/en/homes/buying-a-home/mortgage-calculator' },
  { id: 'moneyhelper-budget', category: 'calculator', url: 'https://www.moneyhelper.org.uk/en/everyday-money/budgeting/budget-planner' },
  { id: 'moneyhelper-contact', category: 'contact', url: 'https://www.moneyhelper.org.uk/en/contact-us' },
  { id: 'halifax-mortgage-calc', category: 'calculator', url: 'https://www.halifax.co.uk/mortgages/mortgage-calculator.html' },
  { id: 'citizensadvice-search', category: 'search', url: 'https://www.citizensadvice.org.uk/' },
  { id: 'fca-register', category: 'search', url: 'https://register.fca.org.uk/s/' },
  { id: 'uswitch-broadband', category: 'lookup', url: 'https://www.uswitch.com/broadband/postcode_checker/' },
  { id: 'octopus-quote', category: 'quote', url: 'https://octopus.energy/' },
  { id: 'nationalexpress-search', category: 'booking', url: 'https://www.nationalexpress.com/en' },
  { id: 'premierinn-search', category: 'booking', url: 'https://www.premierinn.com/gb/en/home.html' },
  { id: 'yha-search', category: 'booking', url: 'https://www.yha.org.uk/' },
  { id: 'nationaltrust-search', category: 'search', url: 'https://www.nationaltrust.org.uk/' },
  { id: 'english-heritage-search', category: 'search', url: 'https://www.english-heritage.org.uk/' },
  { id: 'cruk-donate', category: 'donation', url: 'https://www.cancerresearchuk.org/get-involved/donate' },
  { id: 'redcross-donate', category: 'donation', url: 'https://donate.redcross.org.uk/appeal/disaster-fund' },
  { id: 'oxfam-donate', category: 'donation', url: 'https://www.oxfam.org.uk/donate/' },
  { id: 'shelter-donate', category: 'donation', url: 'https://england.shelter.org.uk/donate' },
  { id: 'parliament-petitions', category: 'search', url: 'https://petition.parliament.uk/petitions' },
  { id: 'writetothem', category: 'lookup', url: 'https://www.writetothem.com/' },
  { id: 'theyworkforyou', category: 'lookup', url: 'https://www.theyworkforyou.com/' },
  { id: 'fixmystreet', category: 'lookup', url: 'https://www.fixmystreet.com/' },
  { id: 'ucas-search', category: 'search', url: 'https://digital.ucas.com/coursedisplay/search' },
  { id: 'gov-paye-calculator', category: 'calculator', url: 'https://www.tax.service.gov.uk/estimate-paye-take-home-pay/your-pay' },
  { id: 'bl-search', category: 'search', url: 'https://www.bl.uk/' },
  { id: 'nhs-111-start', category: 'search', url: 'https://www.nhs.uk/nhs-services/urgent-and-emergency-care-services/' },
  { id: 'gov-bank-holidays-sub', category: 'newsletter', url: 'https://www.gov.uk/email-signup?link=/bank-holidays' },
  { id: 'citizensadvice-contact', category: 'contact', url: 'https://www.citizensadvice.org.uk/about-us/contact-us/contact-us/contact-us/' },
  { id: 'ons-census-search', category: 'search', url: 'https://www.ons.gov.uk/census' },
  { id: 'gov-uk-contact-dvla', category: 'contact', url: 'https://www.gov.uk/contact-the-dvla' },
  { id: 'bfi-newsletter', category: 'newsletter', url: 'https://www.bfi.org.uk/' },
  { id: 'kew-search', category: 'search', url: 'https://www.kew.org/' },
  { id: 'nhm-search', category: 'search', url: 'https://www.nhm.ac.uk/' },
  { id: 'trainline-search', category: 'booking', url: 'https://www.thetrainline.com/' },
  { id: 'zoopla-search', category: 'search', url: 'https://www.zoopla.co.uk/' },
  { id: 'autotrader-search', category: 'search', url: 'https://www.autotrader.co.uk/' },
  { id: 'findajob-search', category: 'search', url: 'https://findajob.dwp.gov.uk/' },
  { id: 'nhs-jobs-search', category: 'search', url: 'https://www.jobs.nhs.uk/candidate/search' },
  { id: 'datagovuk-search', category: 'search', url: 'https://www.data.gov.uk/' },
  { id: 'hse-search', category: 'search', url: 'https://www.hse.gov.uk/' },
  { id: 'bbc-search', category: 'search', url: 'https://www.bbc.co.uk/search' },
  { id: 'macmillan-donate', category: 'donation', url: 'https://www.macmillan.org.uk/donate' },
  { id: 'mind-donate', category: 'donation', url: 'https://www.mind.org.uk/donate/' },
  { id: 'ageuk-search', category: 'search', url: 'https://www.ageuk.org.uk/' },
  { id: 'openreach-fibre-checker', category: 'lookup', url: 'https://www.openreach.com/fibre-checker' },
  { id: 'gumtree-search', category: 'search', url: 'https://www.gumtree.com/' },
  { id: 'nhs-conditions-search', category: 'search', url: 'https://www.nhs.uk/conditions/' },
  { id: 'gov-find-apprenticeship', category: 'search', url: 'https://www.findapprenticeship.service.gov.uk/apprenticeships' },
];

const existing = JSON.parse(await readFile(new URL('evals/forms.json', root), 'utf8')) as { forms: { id: string; url: string }[] };
const known = new Set(existing.forms.map((f) => f.id));
const dir = new URL('packages/core/test/fixtures/eval-forms/', root);
await mkdir(dir, { recursive: true });

const robotsCache = new Map<string, string>();
async function robots(url: URL): Promise<string> {
  if (!robotsCache.has(url.origin)) {
    const res = await fetch(new URL('/robots.txt', url), { signal: AbortSignal.timeout(10_000), redirect: 'follow' }).catch(() => null);
    robotsCache.set(url.origin, res?.ok ? (await res.text()).slice(0, 200_000) : '');
  }
  return robotsCache.get(url.origin)!;
}

const browser = await chromium.launch();
const passed: typeof CANDIDATES = [];
for (const c of CANDIDATES.filter((x) => !known.has(x.id))) {
  const url = new URL(c.url);
  const txt = await robots(url);
  if (!robotsAllows(txt, url.pathname, '*') || !robotsAllows(txt, url.pathname, 'usherkeeper')) {
    console.log(`skip ${c.id}: robots.txt disallows ${url.pathname}`);
    continue;
  }
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    const res = await page.goto(c.url, { waitUntil: 'load', timeout: 30_000 });
    if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
    await page.waitForTimeout(1500);
    if (/\/(login|signin|sign-in)\b/i.test(new URL(page.url()).pathname)) throw new Error('sends to a login');
    const scan: Scan = await page.evaluate(scanScript());
    const forms = candidateForms(scan.forms).filter((f) => f.elements.some((e) => e.kind === 'field' && e.visible));
    if (!forms.length) throw new Error(scan.forms.length ? 'only a consent widget, site search or newsletter box, or no visible field' : 'no form');
    const title = await page.title();
    const fixture = { url: c.url, final_url: page.url(), recorded_at: new Date().toISOString(), forms: forms.map((f) => compactExtraction(f, { path: new URL(page.url()).pathname, title })) };
    await writeFile(new URL(`${c.id}.json`, dir), `${JSON.stringify(fixture, null, 1)}\n`);
    passed.push(c);
    console.log(`ok   ${c.id}: ${forms.length} form${forms.length === 1 ? '' : 's'}, ${forms[0]!.elements.filter((e) => e.visible).length} visible elements in the first`);
  } catch (err) {
    console.log(`skip ${c.id}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  } finally {
    await context.close();
  }
}
await browser.close();
console.log(`\n${passed.length} of ${CANDIDATES.filter((x) => !known.has(x.id)).length} candidates can join (${existing.forms.length} already in the eval).`);
if (values.add) {
  existing.forms.push(...passed.map((p) => ({ ...p, recorded: true })));
  await writeFile(new URL('evals/forms.json', root), `${JSON.stringify(existing, null, 2)}\n`);
  console.log(`evals/forms.json now lists ${existing.forms.length} forms.`);
}
