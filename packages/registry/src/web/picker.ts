// The forms anyone can try in the map viewer. A fixed list: visitors choose one by id and never
// send a URL, so the viewer can't be pointed at anything else. All compiled cleanly in the
// accuracy run (reports/accuracy-review.csv); the demo site joins when this registry knows it.

export interface PickerForm {
  id: string;
  name: string;
  /** What the form is, in a few words. */
  about: string;
  url: string;
}

const PUBLIC_FORMS: PickerForm[] = [
  { id: 'govuk-contact', name: 'GOV.UK', about: 'Contact the GOV.UK team', url: 'https://www.gov.uk/contact/govuk' },
  { id: 'travelodge-booking', name: 'Travelodge', about: 'Search for a hotel room', url: 'https://www.travelodge.co.uk/' },
  { id: 'mozilla-newsletter', name: 'Mozilla', about: 'Sign up to the Firefox newsletter', url: 'https://www.mozilla.org/en-US/newsletter/' },
  { id: 'aviva-car', name: 'Aviva', about: 'Car insurance: the first step', url: 'https://www.aviva.co.uk/insurance/motor/car-insurance/' },
  { id: 'httpbin-order', name: 'httpbin', about: 'Order a pizza (a test form)', url: 'https://httpbin.org/forms/post' },
  { id: 'nationalrail-journey', name: 'National Rail', about: 'Plan a train journey', url: 'https://www.nationalrail.co.uk/' },
  { id: 'nhs-search', name: 'NHS', about: 'Search the NHS website', url: 'https://www.nhs.uk/' },
  { id: 'ons-search', name: 'ONS', about: 'Search national statistics', url: 'https://www.ons.gov.uk/' },
  { id: 'bbc-signup', name: 'BBC', about: 'Sign in to a BBC account', url: 'https://account.bbc.com/register' },
];

/** The ten forms: the demo site's quote form first, when this registry knows the demo site. */
export function pickerForms(demoOrigin?: string): PickerForm[] {
  const demo = demoOrigin ? [{ id: 'brightwater', name: 'Brightwater Motor', about: 'A three-step car insurance quote (our demo site)', url: `${demoOrigin.replace(/\/$/, '')}/quote/driver` }] : [];
  return [...demo, ...PUBLIC_FORMS];
}
