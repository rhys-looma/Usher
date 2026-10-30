// What the React and Vue sites share: the page data the server embeds, routes, and posting a step.
// Each step has its own address, so a reload or a link lands on the same step; moving between
// steps happens in the page, with history.pushState.

export const data = JSON.parse(document.getElementById('site-data').textContent);

/** The view for an address: home, a step, a result or the next thing after it. */
export function routeFor(path) {
  const [, journey, step, extra] = path.split('/');
  if (!journey || !Object.hasOwn(data.journeys, journey)) return { view: 'home' };
  if (step === 'result') return { view: extra === 'next' ? 'next' : 'result', journey };
  if (Object.hasOwn(data.journeys[journey].steps, step)) return { view: 'step', journey, step };
  return { view: 'home' };
}

/** A field asked only for another answer is not shown (or sent) until that answer is given. */
export const shown = (field, values) => !field.showIf || values[field.showIf[0]] === field.showIf[1];

/**
 * Posts a step's form as a form would, so a token the Usher script adds to it goes too. The server
 * answers { go }, { go, result }, { errors } or { wall }.
 */
export async function post(form) {
  let res;
  try {
    res = await fetch(form.getAttribute('action'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)),
      credentials: 'same-origin',
    });
  } catch {
    return { problem: 'We could not reach our server. Check your connection and try again.' };
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  if (res.ok && !isJson) {
    // Sent back to an earlier step (the session ran out): load it properly.
    location.assign(res.url);
    return { leaving: true };
  }
  const body = isJson ? await res.json() : {};
  if (res.status === 422) return { errors: body.errors ?? [] };
  if (body.error === 'knock_required') return { problem: 'An assistant needs to connect through Usher before it can do this for you.' };
  if (res.status === 429) return { problem: 'Too many tries. Please wait a minute and try again.' };
  if (!res.ok) return { problem: 'Something went wrong. Please try again.' };
  return body;
}

export const tel = (phone) => `tel:${phone.replaceAll(' ', '')}`;
