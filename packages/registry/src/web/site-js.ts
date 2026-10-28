// The front page's only script of its own, served at /site.js (the page's policy allows scripts from
// this origin only). Sections settle into place as they come within a screen of view, and the
// assistant illustration plays in order; nothing is ever hidden, so the page reads the same without
// JavaScript and in screenshots.

export const SITE_JS = `(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // The assistant illustration plays its steps in order once it is in view; until then the later
  // steps wait dimmed, never hidden.
  for (const chat of document.querySelectorAll('[data-sequence]')) {
    chat.classList.add('waiting');
    const play = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      chat.classList.add('play');
      chat.classList.remove('waiting');
      play.disconnect();
    }, { threshold: 0.35 });
    play.observe(chat);
  }
  const sections = [...document.querySelectorAll('[data-reveal]')];
  // Within one screen below the fold: already in place, never moved.
  const near = (el) => el.getBoundingClientRect().top < innerHeight * 2;
  const later = sections.filter((el) => !near(el));
  if (!later.length) return;
  for (const el of sections) if (near(el)) el.classList.add('shown');
  document.documentElement.classList.add('reveal');
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('shown'); seen.unobserve(e.target); }
  }, { rootMargin: '0px 0px 100% 0px' });
  for (const el of later) seen.observe(el);
})();
`;

// The demo dashboard's script, served at /demo.js: while the page is open and visible, it fetches
// the page again every few seconds and swaps in the parts marked data-live, leaving the rules
// sandbox (and anything being typed) alone.
export const DEMO_JS = `(() => {
  const url = location.pathname.replace(/\\/rules$/, '');
  let busy = false;
  const refresh = async () => {
    if (busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) return;
      const next = new DOMParser().parseFromString(await res.text(), 'text/html');
      for (const el of document.querySelectorAll('[data-live]')) {
        const fresh = next.querySelector('[data-live="' + el.getAttribute('data-live') + '"]');
        if (fresh && fresh.innerHTML !== el.innerHTML) el.innerHTML = fresh.innerHTML;
      }
    } catch {
      // Offline for a moment: try again on the next tick.
    } finally {
      busy = false;
    }
  };
  setInterval(refresh, 4000);
  document.addEventListener('visibilitychange', refresh);
})();
`;
