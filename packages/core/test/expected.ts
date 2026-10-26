import type { Layout, Step } from './helpers.ts';

// What each step of the mock site should extract to: [control, label] in document order.
// Layout B reorders the driver step, rewords some labels and says "Next" for "Continue".
type Row = [control: string, label: string];

const claimsQuestion = 'Have you made any claims in the last 5 years?';

export const expected: Record<Layout, Record<Step, Row[]>> = {
  a: {
    driver: [
      ['select', 'Title'],
      ['text', 'First name'],
      ['text', 'Last name'],
      ['date', 'Date of birth'],
      ['email', 'Email address'],
      ['tel', 'Phone number (optional)'],
      ['text', 'Postcode'],
      ['text', 'First line of address'],
      ['select', 'Occupation'],
      ['radio', 'Employment status'],
      ['radio', claimsQuestion],
      ['date', 'Date of the claim'],
      ['select', 'Type of claim'],
      ['submit', 'Continue'],
    ],
    vehicle: [
      ['text', 'Registration number'],
      ['button', 'Find car'],
      ['text', 'Make'],
      ['text', 'Model'],
      ['number', 'Year of manufacture'],
      ['number', 'Estimated annual mileage'],
      ['radio', 'What do you use the car for?'],
      ['select', 'Where is the car kept overnight?'],
      ['radio', 'Has the car been modified?'],
      ['link', 'Back'],
      ['submit', 'Continue'],
    ],
    cover: [
      ['date', 'Cover start date'],
      ['radio', 'Level of cover'],
      ['select', 'Voluntary excess'],
      ['select', 'Years of no-claims discount'],
      ['radio', 'How would you like to pay?'],
      ['checkbox', 'I confirm the information I have given is true and complete'],
      ['checkbox', 'Send me offers by email (optional)'],
      ['link', 'Back'],
      ['submit', 'Get my quote'],
    ],
  },
  b: {
    driver: [
      ['email', 'Email'],
      ['tel', 'Phone number (optional)'],
      ['select', 'Title'],
      ['text', 'First name'],
      ['text', 'Surname'],
      ['date', 'Your date of birth'],
      ['text', 'Postcode'],
      ['text', 'House number and street'],
      ['select', 'Main occupation'],
      ['radio', 'Employment status'],
      ['radio', claimsQuestion],
      ['date', 'Date of the claim'],
      ['select', 'Type of claim'],
      ['submit', 'Next'],
    ],
    vehicle: [
      ['text', 'Car registration'],
      ['button', 'Find car'],
      ['text', 'Make'],
      ['text', 'Model'],
      ['number', 'Year of manufacture'],
      ['number', 'Miles per year'],
      ['radio', 'What do you use the car for?'],
      ['select', 'Where is the car kept overnight?'],
      ['radio', 'Has the car been modified?'],
      ['link', 'Back'],
      ['submit', 'Next'],
    ],
    cover: [
      ['date', 'When should cover start?'],
      ['radio', 'Level of cover'],
      ['select', 'Voluntary excess'],
      ['select', 'Years of no-claims discount'],
      ['radio', 'How would you like to pay?'],
      ['checkbox', 'I confirm the information I have given is true and complete'],
      ['checkbox', 'Send me offers by email (optional)'],
      ['link', 'Back'],
      ['submit', 'Get my quote'],
    ],
  },
};

/** Labels of fields that start hidden: the claim details, shown only after answering "yes". */
export const hiddenLabels = new Set(['Date of the claim', 'Type of claim']);
