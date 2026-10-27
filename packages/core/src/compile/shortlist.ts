// The short-list step: for each element, the vocabulary keys whose meaning is closest to its
// label, best first, found by code before the model sees the form. The model then chooses among
// them, and uses a custom key only when it says none fits. Words in common between the element
// (label, options, control) and each key (its meaning, its own words and the usual ways sites say
// it), with a nudge from the control type.

import { vocabulary as defaultVocabulary, type Vocabulary, type VocabularyEntry } from '../vocabulary.ts';

/** How sites commonly say what a key means, beyond the vocabulary's own wording. */
const ALIASES: Record<string, string> = {
  'person.title': 'title mr mrs ms miss dr salutation',
  'person.first_name': 'first given forename name',
  'person.last_name': 'last surname family name',
  'person.full_name': 'full your name',
  'person.dob': 'birth born dob date',
  'person.gender': 'gender sex',
  'person.marital_status': 'marital married relationship',
  'person.occupation': 'occupation job role',
  'person.employment_status': 'employment employed work',
  'person.industry': 'industry business sector',
  'person.resident_since': 'resident lived living uk',
  'person.licence.type': 'licence license driving type',
  'person.licence.held_years': 'licence license held years',
  'person.licence.number': 'licence license number',
  'person.claims.has_any': 'claim claims accident',
  'person.claims.date': 'claim date',
  'person.claims.type': 'claim type',
  'person.convictions.has_any': 'conviction convictions offence points',
  'contact.email': 'email e-mail',
  'contact.phone': 'phone telephone tel number',
  'contact.mobile': 'mobile cell',
  'address.line1': 'address house street line first',
  'address.line2': 'address line second',
  'address.town': 'town city',
  'address.county': 'county state region province',
  'address.postcode': 'postcode post code zip',
  'address.country': 'country',
  'address.years_at': 'years address lived',
  'vehicle.registration': 'registration reg plate number car',
  'vehicle.make': 'make manufacturer brand',
  'vehicle.model': 'model',
  'vehicle.year': 'year manufacture built registered',
  'vehicle.value': 'value worth',
  'vehicle.purchase_date': 'bought purchase',
  'vehicle.annual_mileage': 'mileage miles annual',
  'vehicle.use': 'use usage commuting business social',
  'vehicle.overnight_location': 'overnight kept parked',
  'vehicle.owner': 'owner owns',
  'vehicle.keeper': 'keeper registered',
  'vehicle.modifications.has_any': 'modified modification modifications',
  'policy.start_date': 'start cover begin date',
  'policy.cover_level': 'cover level comprehensive type',
  'policy.voluntary_excess': 'excess voluntary',
  'policy.no_claims_years': 'claims bonus discount ncd years',
  'policy.payment_frequency': 'pay payment monthly annually',
  'policy.additional_drivers.has_any': 'additional drivers named',
  'search.query': 'search keyword query find looking',
  'search.location': 'where location destination place going departing station',
  'search.date_from': 'from check-in arrive arrival depart date',
  'search.date_to': 'to check-out return leave departure until date',
  'booking.date': 'date day',
  'booking.time': 'time',
  'booking.party_size': 'guests people party adults children rooms number',
  'message.subject': 'subject topic regarding',
  'message.body': 'message comments details enquiry question tell describe',
  'consent.terms': 'terms conditions agree accept',
  'consent.declaration': 'confirm declare true correct accurate complete',
  'consent.marketing': 'marketing offers news updates newsletter',
  'account.username': 'username user login',
  'account.password': 'password',
  'payment.card_number': 'card number',
  'payment.expiry': 'expiry expires card date',
  'payment.cvc': 'cvc cvv security code card',
  'payment.name': 'name card',
  'payment.account_number': 'account number bank',
  'payment.sort_code': 'sort code bank',
  'nav.next': 'continue next proceed forward',
  'nav.back': 'back previous',
  'nav.skip': 'skip later',
  'lookup.address': 'find address lookup look up',
  'lookup.vehicle': 'find car vehicle lookup look up registration',
  'form.save': 'save',
  'form.submit': 'submit send get quote apply book request subscribe register sign',
  'form.purchase': 'buy pay purchase checkout order',
  'account.create': 'create account register sign join',
  'ui.dismiss': 'accept reject close dismiss done hide ok cookies thanks essential necessary required only',
  'ui.expand': 'show more expand open menu details filter view see help know why',
  'search.submit': 'search go find',
};

/** Control types that point at particular keys. */
const CONTROLS: Record<string, string[]> = {
  email: ['contact.email'],
  tel: ['contact.phone', 'contact.mobile'],
  password: ['account.password'],
  search: ['search.query'],
  date: ['person.dob', 'policy.start_date', 'booking.date', 'search.date_from', 'search.date_to', 'person.claims.date', 'vehicle.purchase_date'],
};

/** The HTML autocomplete tokens that name a key outright. */
const AUTOCOMPLETE: Record<string, string> = {
  'honorific-prefix': 'person.title',
  'given-name': 'person.first_name',
  'family-name': 'person.last_name',
  name: 'person.full_name',
  bday: 'person.dob',
  sex: 'person.gender',
  email: 'contact.email',
  tel: 'contact.phone',
  'address-line1': 'address.line1',
  'address-line2': 'address.line2',
  'address-level2': 'address.town',
  'address-level1': 'address.county',
  'postal-code': 'address.postcode',
  country: 'address.country',
  'country-name': 'address.country',
  username: 'account.username',
  'current-password': 'account.password',
  'new-password': 'account.password',
  'cc-number': 'payment.card_number',
  'cc-exp': 'payment.expiry',
  'cc-csc': 'payment.cvc',
  'cc-name': 'payment.name',
};

const STOP = new Set(['a', 'an', 'the', 'your', 'you', 'my', 'of', 'for', 'to', 'in', 'on', 'at', 'and', 'or', 'is', 'are', 'do', 'does', 'did', 'what', 'which', 'how', 'please', 'with', 'by', 'any', 'this', 'it', 'be', 'have', 'has', 'been', 'will', 'all']);

const stem = (w: string) => w.replace(/(ing|ed|es)$/, '').replace(/(?<=...)s$/, '');
export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem));
}

/** What the short list needs to know about an element. */
export interface ShortlistElement {
  kind: string;
  control?: string | null;
  label: string;
  /** Option labels, for selects and radio groups. */
  options?: string[];
  placeholder?: string;
  autocomplete?: string;
}

const index = new WeakMap<Vocabulary, { entry: VocabularyEntry; words: Set<string> }[]>();
function indexed(vocab: Vocabulary) {
  let entries = index.get(vocab);
  if (!entries) {
    entries = vocab.entries.map((entry) => ({ entry, words: words(`${entry.meaning} ${entry.key.replace(/[._]/g, ' ')} ${ALIASES[entry.key] ?? ''}`) }));
    index.set(vocab, entries);
  }
  return entries;
}

/**
 * The best `size` vocabulary keys for an element, best first: field keys for fields and action keys
 * for actions, only those with something in common. A button with nothing in common still gets
 * ui.expand, because a button labelled by its content (an FAQ question, a cover feature) usually
 * reveals more; a link with nothing in common gets none, because it usually leads somewhere else.
 */
export function shortlist(element: ShortlistElement, size = 6, vocab: Vocabulary = defaultVocabulary): string[] {
  const label = words(element.label);
  const options = words((element.options ?? []).slice(0, 8).join(' '));
  const kind = element.kind === 'action' ? 'action' : 'field';
  const hint = words(element.placeholder ?? '');
  const nudged = CONTROLS[element.control ?? ''] ?? [];
  const named = (element.autocomplete ?? '').split(/\s+/).map((t) => AUTOCOMPLETE[t]).filter(Boolean);
  const keys = indexed(vocab)
    .filter(({ entry }) => entry.kind === kind)
    .map(({ entry, words: w }, order) => {
      let score = 0;
      for (const x of label) if (w.has(x)) score += 1;
      for (const x of options) if (w.has(x)) score += 0.5;
      for (const x of hint) if (w.has(x)) score += 0.5;
      if (nudged.includes(entry.key)) score += 1;
      if (named.includes(entry.key)) score += 2;
      return { key: entry.key, score, order };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, size)
    .map((s) => s.key);
  if (kind === 'action' && element.control !== 'link' && !keys.includes('ui.expand')) keys.push('ui.expand');
  return keys;
}
