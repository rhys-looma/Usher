// The generated test person for a walkthrough: one fixed, fictional set of answers by vocabulary key,
// for owners who tick "use a generated test person" rather than typing their own. Nobody real: the
// phone number is in Ofcom's range for drama, the email domain is reserved for examples, the
// registration and postcode are the demo site's. Answers are written the way people say them; the
// fill matches each to the site's own options.

export const TEST_PERSON: Readonly<Record<string, string | boolean>> = Object.freeze({
  'person.title': 'Mx',
  'person.first_name': 'Robin',
  'person.last_name': 'Example',
  'person.full_name': 'Robin Example',
  'person.dob': '1990-05-17',
  'person.occupation': 'Teacher',
  'person.employment_status': 'employed',
  'person.claims.has_any': 'no',
  'person.smoker': 'no',
  'contact.email': 'robin@example.com',
  'contact.phone': '07700 900000',
  'address.postcode': 'WR14 1AA',
  'address.line1': '1 High Street',
  'vehicle.registration': 'AB12CDE',
  'vehicle.annual_mileage': '8000',
  'vehicle.use': 'social',
  'vehicle.overnight_location': 'driveway',
  'vehicle.modifications.has_any': 'no',
  'cover.who': 'just me',
  'cover.level': 'standard',
  'cover.excess': '250',
  'cover.hospital_list': 'standard',
  'cover.outpatient_limit': '1000',
  'policy.cover_level': 'comprehensive',
  'policy.voluntary_excess': '250',
  'policy.no_claims_years': '5',
  'policy.payment_frequency': 'monthly',
  'consent.declaration': true,
  'consent.marketing': false,
});

/** A start date a fortnight away, in YYYY-MM-DD, so a test run is never refused for a past date. */
export function testStartDate(now = new Date()): string {
  return new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
}

/** Stand-ins tried, in order, for a required text field with a pattern: the first the pattern accepts. */
const PATTERNED = ['Test', 'WR14 1AA', 'AB12CDE', '1', '123456'];

/**
 * A harmless test answer for a required field that no test value covers (a mortgage's property
 * price, a booking's party size, a pet's name), so the walk isn't refused on a page it could map.
 * The first real option of a list, the lowest number allowed, a date a fortnight away, a ticked box.
 * Optional fields, files and passwords are left alone. Like every test value, it stays in the run.
 */
export function standIn(field: { control: string; required: boolean; constraints?: { pattern?: string; min?: number | string; max?: number | string }; options?: { items: { value: string; label: string }[] } }, now = new Date()): string | boolean | undefined {
  if (!field.required) return undefined;
  const c = field.constraints ?? {};
  switch (field.control) {
    case 'select':
    case 'radio':
    case 'buttons':
      return field.options?.items.find((o) => o.value !== '' && !/^(please )?(select|choose)/i.test(o.label))?.value;
    case 'checkbox':
      return true;
    case 'number': {
      const min = Number(c.min);
      const max = Number(c.max);
      const n = Number.isFinite(min) ? Math.max(min, 1) : 1;
      return String(Number.isFinite(max) ? Math.min(n, max) : n);
    }
    case 'date': {
      const date = testStartDate(now);
      return typeof c.max === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.max) && c.max < date ? c.max : date;
    }
    case 'email':
      return 'test@example.com';
    case 'tel':
      return '07700 900000';
    case 'text':
    case 'textarea': {
      if (!c.pattern) return 'Test';
      try {
        const re = new RegExp(`^(?:${c.pattern})$`);
        return PATTERNED.find((s) => re.test(s));
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}
