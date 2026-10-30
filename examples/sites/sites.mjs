// The fictional businesses served by server.mjs. Each one is data: a brand and its journeys, each
// journey a few steps of fields. None of them is a real business; every price is made up.
//
// Field types: text, email, tel, date, number, textarea, select, radio (card: true for card
// radios), checkbox. showIf: [field, value] shows a field only for that answer. A journey's result(v, t)
// gets the answers by step (v) and the same answers as the person saw them, option labels (t).

const list = (...labels) => labels.map((label) => ({ value: slug(label), label }));
const yesNo = list('Yes', 'No');

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const name = [
  { name: 'first_name', label: 'First name', type: 'text', required: true, autocomplete: 'given-name' },
  { name: 'last_name', label: 'Last name', type: 'text', required: true, autocomplete: 'family-name' },
];
const contact = [
  { name: 'email', label: 'Email address', type: 'email', required: true, autocomplete: 'email' },
  { name: 'phone', label: 'Phone number', type: 'tel', required: true, autocomplete: 'tel' },
];
const postcode = (label = 'Postcode', field = 'postcode') => ({ name: field, label, type: 'text', required: true, autocomplete: field === 'postcode' ? 'postal-code' : 'off', pattern: '[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}' });
const ref = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const money = (n) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const whole = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;

export const sites = {
  larchmont: {
    name: 'Larchmont Mortgages',
    short: 'Larchmont',
    tagline: 'Mortgages',
    colour: '#1f3b63',
    blurb: 'Find out how much you could borrow in ten minutes, with no effect on your credit score.',
    journeys: {
      aip: {
        title: 'Get an agreement in principle',
        intent: 'quote.mortgage',
        summary: 'How much you could borrow, for buying a home or remortgaging.',
        action: 'Get my agreement in principle',
        disclosure: 'We will run a soft credit search. It is not seen by other lenders and does not affect your credit score. An agreement in principle is not a mortgage offer.',
        steps: {
          you: {
            title: 'About you',
            fields: [
              { name: 'applicants', label: 'Who is applying?', type: 'radio', card: true, required: true, options: list('Just me', 'Me and someone else') },
              ...name,
              { name: 'dob', label: 'Date of birth', type: 'date', required: true, autocomplete: 'bday' },
              ...contact,
              postcode('Current postcode'),
              { name: 'residential_status', label: 'Where do you live now?', type: 'select', required: true, options: list('Renting', 'Living with family', 'I own my home') },
              { name: 'partner_first_name', label: 'Second applicant: first name', type: 'text', required: true, showIf: ['applicants', 'me-and-someone-else'] },
              { name: 'partner_last_name', label: 'Second applicant: last name', type: 'text', required: true, showIf: ['applicants', 'me-and-someone-else'] },
              { name: 'partner_dob', label: 'Second applicant: date of birth', type: 'date', required: true, showIf: ['applicants', 'me-and-someone-else'] },
            ],
          },
          mortgage: {
            title: 'The mortgage',
            fields: [
              { name: 'reason', label: 'What is the mortgage for?', type: 'radio', card: true, required: true, options: list('Buying my first home', 'Moving home', 'Remortgaging', 'Buying to let') },
              { name: 'property_value', label: 'Property price or value (£)', type: 'number', required: true, min: 25000, max: 10000000 },
              { name: 'deposit', label: 'Deposit (£)', type: 'number', required: true, min: 0, max: 10000000 },
              { name: 'term_years', label: 'Mortgage term', type: 'select', required: true, options: [10, 15, 20, 25, 30, 35].map((n) => ({ value: String(n), label: `${n} years` })) },
              { name: 'rate_type', label: 'Type of rate', type: 'radio', required: true, options: list('2-year fixed', '5-year fixed', 'Tracker') },
              { name: 'found_property', label: 'Have you found a property?', type: 'radio', required: true, options: yesNo },
              postcode('Property postcode', 'property_postcode'),
            ],
          },
          income: {
            title: 'Income and credit',
            fields: [
              { name: 'employment', label: 'Employment', type: 'radio', required: true, options: list('Employed', 'Self-employed', 'Retired', 'Not working') },
              { name: 'salary', label: 'Annual salary before tax (£)', type: 'number', required: true, min: 0, max: 5000000, showIf: ['employment', 'employed'] },
              { name: 'net_profit', label: 'Average net profit over the last two years (£)', type: 'number', required: true, min: 0, max: 5000000, showIf: ['employment', 'self-employed'] },
              { name: 'other_income', label: 'Other income a year, such as a pension or rent (£)', type: 'number', required: false, min: 0, max: 5000000 },
              { name: 'monthly_commitments', label: 'Monthly loan and credit card payments (£)', type: 'number', required: true, min: 0, max: 100000 },
              { name: 'dependants', label: 'Number of children or other dependants', type: 'select', required: true, options: ['0', '1', '2', '3', '4+'].map((n) => ({ value: n, label: n })) },
              { name: 'credit_problems', label: 'In the last six years, have you had a CCJ, a default, an IVA or been declared bankrupt?', type: 'radio', required: true, options: yesNo },
              { name: 'credit_search', label: 'I agree to Larchmont running a soft credit search on me (and anyone applying with me)', type: 'checkbox', required: true },
              { name: 'marketing', label: 'Email me about rates and offers (optional)', type: 'checkbox', required: false },
            ],
          },
        },
        result(v, t) {
          const income = Number(v.income.salary || v.income.net_profit || 0) + Number(v.income.other_income || 0) * 0.5;
          const multiple = v.income.credit_problems === 'yes' ? 3 : 4.5;
          const loan = Math.max(0, Math.min(income * multiple - Number(v.income.monthly_commitments) * 12 * 2, Number(v.mortgage.property_value) * 0.95));
          const rate = { '2-year-fixed': 4.29, '5-year-fixed': 4.09, tracker: 4.49 }[v.mortgage.rate_type] ?? 4.5;
          const months = Number(v.mortgage.term_years) * 12;
          const r = rate / 100 / 12;
          const monthly = loan > 0 ? (loan * r) / (1 - (1 + r) ** -months) : 0;
          return {
            reference: ref('AIP'),
            headline: whole(loan),
            headlineNote: 'you could borrow',
            lines: [`About ${money(monthly)} a month over ${v.mortgage.term_years} years at ${rate}% (${t.mortgage.rate_type})`, 'Valid for 90 days. An adviser can turn it into a full application.'],
          };
        },
      },
      callback: {
        title: 'Book a call with an adviser',
        intent: 'booking.callback',
        summary: 'A free call with a mortgage adviser, at a time that suits you.',
        action: 'Book my call',
        steps: {
          call: {
            title: 'Book a call',
            fields: [
              ...name,
              ...contact,
              { name: 'date', label: 'Day', type: 'date', required: true },
              { name: 'time', label: 'Time', type: 'select', required: true, options: list('9am to 11am', '11am to 1pm', '1pm to 3pm', '3pm to 5pm', '5pm to 7pm') },
              { name: 'topic', label: 'What would you like to talk about?', type: 'textarea', required: false },
            ],
          },
        },
        result: (v, t) => ({ reference: ref('CALL'), headline: 'Call booked', lines: [`An adviser will call you on ${day(v.call.date)}, ${t.call.time}.`] }),
      },
    },
  },

  kestrel: {
    name: 'Kestrel Energy',
    short: 'Kestrel',
    tagline: 'Gas and electricity',
    colour: '#0f6b4f',
    blurb: 'Simple tariffs, no exit fees on variable. See your price and switch in a few minutes.',
    journeys: {
      switch: {
        title: 'Get a price and switch',
        intent: 'quote.energy',
        summary: 'Your price for gas and electricity, and a switch to Kestrel.',
        action: 'See my prices',
        steps: {
          home: {
            title: 'Your home',
            fields: [
              postcode(),
              { name: 'address_line1', label: 'First line of address', type: 'text', required: true, autocomplete: 'address-line1' },
              { name: 'property_type', label: 'Type of home', type: 'select', required: true, options: list('Flat', 'Terraced house', 'Semi-detached house', 'Detached house', 'Bungalow') },
              { name: 'bedrooms', label: 'Bedrooms', type: 'select', required: true, options: ['1', '2', '3', '4', '5+'].map((n) => ({ value: n, label: n })) },
              { name: 'supplier', label: 'Who supplies your energy now?', type: 'select', required: true, options: list('Northwind Power', 'Hearth Energy', 'Bluebell Gas & Electric', 'Another supplier', 'Not sure') },
            ],
          },
          usage: {
            title: 'Your energy use',
            fields: [
              { name: 'fuel', label: 'What do you need?', type: 'radio', card: true, required: true, options: list('Gas and electricity', 'Electricity only') },
              { name: 'smart_meter', label: 'Do you have a smart meter?', type: 'radio', required: true, options: list('Yes', 'No', 'Not sure') },
              { name: 'know_usage', label: 'Do you know how much energy you use?', type: 'radio', required: true, options: yesNo },
              { name: 'electricity_kwh', label: 'Electricity a year (kWh)', type: 'number', required: true, min: 100, max: 100000, showIf: ['know_usage', 'yes'] },
              { name: 'heating', label: 'How do you heat your home?', type: 'select', required: true, options: list('Gas boiler', 'Electric heaters', 'Heat pump', 'Oil or other') },
            ],
          },
          tariff: {
            title: 'Your tariff',
            fields: [
              { name: 'tariff', label: 'Choose a tariff', type: 'radio', card: true, required: true, options: list('Kestrel Fixed 12', 'Kestrel Fixed 24', 'Kestrel Flex (variable)') },
              { name: 'payment', label: 'How would you like to pay?', type: 'radio', required: true, options: list('Monthly direct debit', 'When I get a bill') },
              ...name,
              { name: 'email', label: 'Email address', type: 'email', required: true, autocomplete: 'email' },
              { name: 'terms', label: 'I have read the tariff terms, including the £50 exit fee on fixed tariffs', type: 'checkbox', required: true },
            ],
          },
        },
        result(v, t) {
          const base = { '1': 2100, '2': 2500, '3': 2900, '4': 3400, '5': 4000 }[v.home.bedrooms.replace('+', '')] ?? 2900;
          const kwh = Number(v.usage.electricity_kwh) || base;
          const gas = v.usage.fuel === 'gas-and-electricity' ? kwh * 3.6 * 0.062 + 109 : 0;
          const factor = { 'kestrel-fixed-12': 1, 'kestrel-fixed-24': 1.03, 'kestrel-flex-variable': 0.97 }[v.tariff.tariff] ?? 1;
          const year = (kwh * 0.245 + 220 + gas) * factor * (v.tariff.payment === 'monthly-direct-debit' ? 1 : 1.05);
          return {
            reference: ref('KE'),
            headline: money(year / 12),
            headlineNote: 'a month, estimated',
            lines: [`${whole(year)} a year on ${t.tariff.tariff}`, 'Your switch takes about five working days. Nothing happens until you confirm it.'],
            next: { label: 'Switch to Kestrel', action: 'Confirm my switch', wall: 'This is where Kestrel would ask for your bank details and start the switch. It is a demo, so nothing is switched.' },
          };
        },
      },
    },
  },

  fernbrook: {
    name: 'Fernbrook Borough Council',
    short: 'Fernbrook',
    tagline: 'Council services',
    colour: '#24513a',
    blurb: 'Apply, pay and report it online.',
    journeys: {
      permit: {
        title: 'Apply for a resident parking permit',
        intent: 'apply.parking_permit',
        summary: 'A permit to park in your zone, for 3, 6 or 12 months.',
        action: 'Submit application',
        disclosure: 'Giving false information to get a permit is an offence. We check every application against the electoral roll and the DVLA.',
        steps: {
          resident: {
            title: 'About you',
            fields: [
              ...name,
              ...contact,
              { name: 'address_line1', label: 'Address in Fernbrook', type: 'text', required: true, autocomplete: 'address-line1' },
              postcode(),
              { name: 'lived_months', label: 'How long have you lived there?', type: 'select', required: true, options: list('Less than 3 months', '3 to 12 months', 'Over a year') },
            ],
          },
          vehicle: {
            title: 'Your vehicle',
            fields: [
              { name: 'registration', label: 'Vehicle registration', type: 'text', required: true, pattern: '[A-Za-z0-9 ]{2,8}' },
              { name: 'make', label: 'Make', type: 'text', required: true },
              { name: 'colour', label: 'Colour', type: 'text', required: true },
              { name: 'keeper', label: 'Is the vehicle registered to you at this address?', type: 'radio', required: true, options: yesNo },
              { name: 'keeper_reason', label: 'Why is it registered to someone else?', type: 'select', required: true, showIf: ['keeper', 'no'], options: list('Company car', 'Lease or hire', 'Family member', 'I have just moved') },
            ],
          },
          permit: {
            title: 'Your permit',
            fields: [
              { name: 'zone', label: 'Permit zone', type: 'select', required: true, options: list('Zone A: Old Town', 'Zone B: Riverside', 'Zone C: Station Quarter', 'Zone D: Fernbrook Park') },
              { name: 'length', label: 'How long for?', type: 'radio', card: true, required: true, options: list('3 months', '6 months', '12 months') },
              { name: 'start_date', label: 'Start date', type: 'date', required: true },
              { name: 'blue_badge', label: 'Do you hold a Blue Badge?', type: 'radio', required: true, options: yesNo },
              { name: 'declaration', label: 'I confirm the information I have given is true', type: 'checkbox', required: true },
            ],
          },
        },
        result(v, t) {
          const cost = v.permit.blue_badge === 'yes' ? 0 : { '3-months': 32, '6-months': 58, '12-months': 104 }[v.permit.length] ?? 104;
          return {
            reference: ref('FBC'),
            headline: cost ? whole(cost) : 'Free',
            headlineNote: cost ? 'to pay once approved' : 'with a Blue Badge',
            lines: [`${t.permit.zone}, from ${day(v.permit.start_date)}`, 'We aim to decide within five working days and will email you a link to pay.'],
          };
        },
      },
      pothole: {
        title: 'Report a pothole or street problem',
        intent: 'report.street_problem',
        summary: 'Potholes, broken street lights, fly-tipping and blocked drains.',
        action: 'Send report',
        steps: {
          problem: {
            title: 'The problem',
            fields: [
              { name: 'problem', label: 'What is the problem?', type: 'radio', required: true, options: list('Pothole', 'Broken street light', 'Fly-tipping', 'Blocked drain', 'Something else') },
              { name: 'location', label: 'Where is it? A street name and a nearby landmark help', type: 'text', required: true },
              { ...postcode('Nearest postcode (optional)'), required: false },
              { name: 'details', label: 'Tell us more', type: 'textarea', required: false },
              { name: 'danger', label: 'Is it causing an immediate danger?', type: 'radio', required: true, options: yesNo },
            ],
          },
          contact: {
            title: 'Your details',
            fields: [
              ...name,
              { name: 'email', label: 'Email address, for updates', type: 'email', required: true, autocomplete: 'email' },
            ],
          },
        },
        result: (v) => ({ reference: ref('FIX'), headline: 'Report sent', lines: [v.problem.danger === 'yes' ? 'Marked as dangerous: we aim to make it safe within 24 hours.' : 'We aim to inspect it within ten working days.'] }),
      },
    },
  },

  hollyhock: {
    name: 'Hollyhock Vets',
    short: 'Hollyhock',
    tagline: 'Veterinary practice',
    colour: '#7a3e6c',
    blurb: 'Friendly vets in Fernbrook and Larkhill. Book online, any time.',
    journeys: {
      book: {
        title: 'Book an appointment',
        intent: 'booking.vet_appointment',
        summary: 'Check-ups, vaccinations and poorly pets.',
        action: 'Book appointment',
        disclosure: 'If your pet is having trouble breathing, is bleeding heavily or has collapsed, call us now on 0100 000 0000. Do not book online.',
        steps: {
          pet: {
            title: 'Your pet',
            fields: [
              { name: 'pet_name', label: "Pet's name", type: 'text', required: true },
              { name: 'species', label: 'What kind of animal?', type: 'radio', card: true, required: true, options: list('Dog', 'Cat', 'Rabbit', 'Other') },
              { name: 'species_other', label: 'What kind of animal is it?', type: 'text', required: true, showIf: ['species', 'other'] },
              { name: 'age_years', label: 'Age in years', type: 'number', required: true, min: 0, max: 40 },
              { name: 'registered', label: 'Is your pet registered with us?', type: 'radio', required: true, options: yesNo },
            ],
          },
          visit: {
            title: 'The visit',
            fields: [
              { name: 'reason', label: 'Reason for the visit', type: 'select', required: true, options: list('Vaccination', 'Check-up', 'Unwell', 'Injury', 'Nail clip', 'Something else') },
              { name: 'symptoms', label: "Describe what's wrong and how long it has been going on", type: 'textarea', required: true, showIf: ['reason', 'unwell'] },
              { name: 'date', label: 'Preferred day', type: 'date', required: true },
              { name: 'time', label: 'Time', type: 'select', required: true, options: list('8:30am', '9:15am', '10:00am', '11:30am', '2:00pm', '3:15pm', '4:30pm', '6:00pm') },
              { name: 'branch', label: 'Branch', type: 'radio', required: true, options: list('Fernbrook', 'Larkhill') },
            ],
          },
          owner: {
            title: 'Your details',
            fields: [
              ...name,
              ...contact,
              { name: 'cancellation', label: 'I understand there is a £25 charge if I miss the appointment without 24 hours notice', type: 'checkbox', required: true },
            ],
          },
        },
        result: (v, t) => ({ reference: ref('HV'), headline: 'Booked', lines: [`${v.pet.pet_name} at ${t.visit.branch}, ${day(v.visit.date)} at ${t.visit.time}`, 'We have sent a confirmation by email.'] }),
      },
    },
  },

  packhorse: {
    name: 'Packhorse Removals',
    short: 'Packhorse',
    tagline: 'Home removals',
    colour: '#8a4b1f',
    blurb: 'Family-run removals since 1987. A fixed price, no surprises.',
    journeys: {
      quote: {
        title: 'Get a moving quote',
        intent: 'quote.removals',
        summary: 'A fixed price for your move, in two minutes.',
        action: 'Get my quote',
        steps: {
          from: {
            title: 'Moving from',
            fields: [
              postcode('Postcode you are moving from'),
              { name: 'from_type', label: 'Type of home', type: 'select', required: true, options: list('Flat', 'House', 'Bungalow', 'Office') },
              { name: 'bedrooms', label: 'Bedrooms', type: 'select', required: true, options: ['Studio', '1', '2', '3', '4', '5+'].map((n) => ({ value: slug(n), label: n })) },
              { name: 'from_floor', label: 'Which floor?', type: 'select', required: true, options: list('Ground', '1st', '2nd', '3rd or higher') },
              { name: 'lift', label: 'Is there a lift?', type: 'radio', required: true, options: yesNo },
            ],
          },
          to: {
            title: 'Moving to',
            fields: [
              postcode('Postcode you are moving to', 'to_postcode'),
              { name: 'to_type', label: 'Type of home', type: 'select', required: true, options: list('Flat', 'House', 'Bungalow', 'Office') },
              { name: 'to_floor', label: 'Which floor?', type: 'select', required: true, options: list('Ground', '1st', '2nd', '3rd or higher') },
              { name: 'parking', label: 'Can a large van park outside?', type: 'radio', required: true, options: list('Yes', 'No', 'Not sure') },
            ],
          },
          when: {
            title: 'When and what',
            fields: [
              { name: 'move_date', label: 'Moving date', type: 'date', required: true },
              { name: 'flexible', label: 'Are your dates flexible?', type: 'radio', required: true, options: yesNo },
              { name: 'packing', label: 'Packing', type: 'radio', card: true, required: true, options: list('I will pack', 'Pack the kitchen only', 'Pack everything') },
              { name: 'piano', label: 'I have a piano or other very heavy item', type: 'checkbox', required: false },
              ...name,
              ...contact,
            ],
          },
        },
        result(v) {
          const rooms = { studio: 0.6, '1': 1, '2': 1.5, '3': 2, '4': 2.6, '5': 3.2 }[v.from.bedrooms] ?? 2;
          const packing = { 'i-will-pack': 0, 'pack-the-kitchen-only': 120, 'pack-everything': 380 * rooms }[v.when.packing] ?? 0;
          const total = 340 * rooms + packing + (v.when.piano === 'yes' ? 150 : 0) + (v.from.lift === 'no' && v.from.from_floor !== 'ground' ? 90 : 0);
          return {
            reference: ref('PH'),
            headline: whole(total),
            headlineNote: 'fixed price, including VAT',
            lines: [`Moving on ${day(v.when.move_date)}${v.when.flexible === 'yes' ? ' (flexible)' : ''}`, 'We hold this price for 14 days.'],
            next: { label: 'Book this move', action: 'Pay the £75 deposit', wall: 'This is where Packhorse would take a deposit. It is a demo, so nothing is booked or paid.' },
          };
        },
      },
    },
  },

  littlefig: {
    name: 'Little Fig',
    short: 'Little Fig',
    tagline: 'Kitchen and wine bar',
    colour: '#a3462b',
    blurb: 'Small plates, natural wine and a terrace in the Old Town. Open Tuesday to Sunday.',
    journeys: {
      table: {
        title: 'Book a table',
        intent: 'booking.table',
        summary: 'Lunch and dinner, for up to eight.',
        action: 'Book table',
        steps: {
          table: {
            title: 'Your table',
            fields: [
              { name: 'date', label: 'Date', type: 'date', required: true },
              { name: 'time', label: 'Time', type: 'select', required: true, options: list('12:00', '12:30', '13:00', '13:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00') },
              { name: 'party_size', label: 'Number of people', type: 'select', required: true, options: ['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => ({ value: n, label: n })) },
              { name: 'seating', label: 'Where would you like to sit?', type: 'radio', card: true, required: true, options: list('Inside', 'Terrace', 'Counter') },
            ],
          },
          details: {
            title: 'Your details',
            fields: [
              ...name,
              ...contact,
              { name: 'occasion', label: 'Is it a special occasion? (optional)', type: 'select', required: false, options: list('Birthday', 'Anniversary', 'Business', 'Other') },
              { name: 'dietary', label: 'Allergies or dietary needs (optional)', type: 'textarea', required: false },
              { name: 'highchair', label: 'We need a high chair', type: 'checkbox', required: false },
              { name: 'no_show', label: 'I agree to a £10 a head charge if we do not turn up or cancel with less than 24 hours notice', type: 'checkbox', required: true },
            ],
          },
        },
        result: (v, t) => ({ reference: ref('FIG'), headline: 'See you soon', lines: [`A table for ${v.table.party_size}, ${t.table.seating.toLowerCase()}, on ${day(v.table.date)} at ${t.table.time}.`, 'We have sent a confirmation by email.'] }),
      },
    },
  },
};
