// What Usher keeps, in three lines: the front page, /privacy and docs/security.md say the same thing
// word for word (a test checks the doc). Change all three together, and only when the code changes.

export const KEEPS_HEADING = 'What Usher keeps';

export const KEEPS = [
  'Nothing you type is stored. Your own assistant fills the form; Usher puts your answers in the site\'s format inside one call and keeps none of them, or, for an assistant with no browser, fills it for you and forgets them.',
  'Maps describe forms, not answers. The site\'s log holds field names and your decisions, never the values.',
  'Medical questions are filled only if the site allows it, and only with your own answer, which you confirm.',
] as const;
