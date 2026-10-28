// The front page's only script of its own, served at /site.js (the page's policy allows scripts from
// this origin only). Sections settle into place as they come within a screen of view, and the six
// steps and the assistant illustration play in order; nothing is ever hidden, so the page reads the
// same without JavaScript, with reduced motion and in screenshots.

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
    }, { rootMargin: '0px 0px -40% 0px' });
    play.observe(chat);
  }
  // What happens in between: each step in turn (under two seconds each), the line filling to it,
  // then the last frame with all six shown. A step's number jumps to it; Replay plays it again.
  for (const seq of document.querySelectorAll('[data-steps]')) {
    const steps = [...seq.querySelectorAll('li[data-step]')];
    const replay = seq.querySelector('.seq-replay');
    let timer = 0;
    const show = (at, ended) => {
      steps.forEach((li, i) => {
        li.classList.toggle('done', i < at || ended);
        li.classList.toggle('on', i === at && !ended);
        if (i === at && !ended) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
      seq.classList.toggle('ended', ended);
      seq.classList.remove('typing-now');
    };
    const run = (from) => {
      clearTimeout(timer);
      if (replay) replay.hidden = true;
      const tick = (at) => {
        if (at >= steps.length) {
          // The last step done, the assistant types its reply, then the quote arrives.
          steps.forEach((li) => { li.classList.add('done'); li.classList.remove('on'); li.removeAttribute('aria-current'); });
          seq.classList.add('typing-now');
          timer = setTimeout(() => { show(steps.length - 1, true); if (replay) replay.hidden = false; }, 1300);
          return;
        }
        show(at, false);
        timer = setTimeout(() => tick(at + 1), 1800);
      };
      tick(from);
    };
    steps.forEach((li, i) => {
      const n = li.querySelector('.n');
      if (!n) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'n';
      button.textContent = n.textContent;
      button.setAttribute('aria-label', 'Show step ' + (i + 1) + ': ' + li.querySelector('h3').textContent.replace(/^\\s*\\d+\\s*/, ''));
      button.addEventListener('click', () => { clearTimeout(timer); show(i, i === steps.length - 1); if (replay) replay.hidden = false; });
      n.replaceWith(button);
    });
    if (replay) replay.addEventListener('click', () => run(0));
    seq.classList.add('seq-on');
    show(-1, false);
    const start = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      start.disconnect();
      run(0);
    }, { rootMargin: '0px 0px -30% 0px' });
    start.observe(seq);
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
