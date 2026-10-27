// The front page's only script of its own, served at /site.js (the page's policy allows scripts from
// this origin only). Sections settle into place as they come within a screen of view; nothing is
// ever hidden, so the page reads the same without JavaScript and in screenshots.

export const SITE_JS = `(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
