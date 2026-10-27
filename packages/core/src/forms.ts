// Which forms on a page a map could be for. Shared by the compiler, the agent, the keeper and the
// site script, so they all look at the same form without a model: a cookie or consent widget, a
// site search or a newsletter box is never the form, unless the intent asks for one. Between the
// forms that remain, the compiler asks the model (compile/choose.ts); everyone else finds the
// form the map was built for by its fingerprint.

import type { ExtractedForm } from './extract.ts';

type FormLike = Pick<ExtractedForm, 'pseudo' | 'banner' | 'search' | 'newsletter'> & { elements: { kind: string; visible: boolean }[] };

/** What an intent has to say for each kind of form that is otherwise left out. */
const ASKS = { banner: /cookie|consent/i, search: /search/i, newsletter: /newsletter|subscri|mailing/i };

const visibleFields = (f: FormLike) => f.elements.filter((e) => e.kind === 'field' && e.visible).length;

/**
 * The forms a map could be for, in page order: forms with visible fields that aren't cookie
 * widgets, site searches or newsletter boxes, unless the intent asks for one. With no intent to go
 * on (a site owner's viewer, the keeper, the page itself), a site search or newsletter box is
 * still better than nothing when it is all the page has; a cookie widget never is.
 */
export function candidateForms<T extends FormLike>(forms: T[], intent?: string | null): T[] {
  const asks = (kind: keyof typeof ASKS) => Boolean(intent && ASKS[kind].test(intent));
  const visible = forms.filter((f) => visibleFields(f) > 0);
  const strict = visible.filter((f) => (!f.banner || asks('banner')) && (!f.search || asks('search')) && (!f.newsletter || asks('newsletter')));
  if (strict.length || intent) return strict;
  return visible.filter((f) => !f.banner);
}

/** The likeliest form without a model: a real <form> before loose controls, then the most fields. */
export function mainForm<T extends FormLike>(forms: T[], intent?: string | null): T | undefined {
  return [...candidateForms(forms, intent)].sort((a, b) => Number(a.pseudo) - Number(b.pseudo) || visibleFields(b) - visibleFields(a))[0];
}
