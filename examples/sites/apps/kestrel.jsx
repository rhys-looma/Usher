// Kestrel Energy: a React app. The server sends an empty page and this draws it, the way many
// real sites are built. Bundled by scripts/build.mjs to public/kestrel.app.js.

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { data, post, routeFor, shown, tel } from './shared.js';

const { site, journeys } = data;
const startOf = (key) => `/${key}/${Object.keys(journeys[key].steps)[0]}?restart`;

function Logo() {
  return (
    <svg className="kst-logo" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="17" fill="currentColor" />
      <path d="M20 6 10 20h7l-2 10 11-15h-7z" fill="#fff" />
    </svg>
  );
}

function Header() {
  return (
    <header className="kst-header">
      <div className="kst-wrap kst-header__inner">
        <a href="/" className="kst-brand">
          <Logo />
          <span>{site.short}</span>
        </a>
        <nav aria-label="Main" className="kst-nav">
          {Object.keys(journeys).map((key) => (
            <a key={key} href={startOf(key)}>
              {journeys[key].title}
            </a>
          ))}
          <a href="#help">Help</a>
        </nav>
        <a className="kst-btn kst-btn--small" href={startOf(Object.keys(journeys)[0])}>
          Get a quote
        </a>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="kst-footer" id="help">
      <div className="kst-wrap kst-footer__cols">
        <div>
          <h2>Need a hand?</h2>
          <p>
            Call <a href={tel(site.contact.phone)}>{site.contact.phone}</a>
            <br />
            {site.contact.hours}
          </p>
        </div>
        <div>
          <h2>{site.name}</h2>
          <p>{site.footer}</p>
        </div>
      </div>
    </footer>
  );
}

function Home() {
  const [key] = Object.keys(journeys);
  return (
    <>
      <section className="kst-hero">
        <div className="kst-wrap">
          <p className="kst-rating" aria-label={`Rated ${site.rating.score} out of 5`}>
            <span aria-hidden="true">★★★★★</span> {site.rating.score} out of 5 from {site.rating.reviews} reviews
          </p>
          <h1>{site.heading}</h1>
          <p className="kst-lede">{site.blurb}</p>
          <a className="kst-btn" href={startOf(key)}>
            {journeys[key].title}
          </a>
        </div>
      </section>
      <section className="kst-wrap kst-perks">
        {[
          ['No exit fees', 'Leave our variable tariff any time, for free.'],
          ['Renewable electricity', 'Every kilowatt hour matched with UK wind and solar.'],
          ['People, not bots', 'A UK team answers the phone, seven days a week.'],
        ].map(([title, text]) => (
          <div className="kst-perk" key={title}>
            <h2>{title}</h2>
            <p>{text}</p>
          </div>
        ))}
      </section>
    </>
  );
}

function Field({ field, value, onChange, error }) {
  const id = `f-${field.name}`;
  const message = error ? <p className="kst-field__error">{field.type === 'checkbox' ? 'Please tick to continue' : 'Please fill this in'}</p> : null;
  const cls = `kst-field kst-field--${field.type}${error ? ' kst-field--invalid' : ''}`;
  if (field.type === 'radio') {
    return (
      <fieldset className={cls} id={id}>
        <legend>{field.label}</legend>
        {message}
        <div className={`kst-tiles${field.options.length > 3 ? ' kst-tiles--grid' : ''}`} role="radiogroup">
          {field.options.map((o) => (
            <label key={o.value} className={`kst-tile${value === o.value ? ' is-selected' : ''}`}>
              <input type="radio" name={field.name} value={o.value} checked={value === o.value} required={field.required} onChange={() => onChange(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field.type === 'checkbox') {
    return (
      <div className={cls}>
        {message}
        <label className="kst-check">
          <input type="checkbox" id={id} name={field.name} value="yes" checked={value === 'yes'} required={field.required} onChange={(e) => onChange(e.target.checked ? 'yes' : '')} />
          <span>{field.label}</span>
        </label>
      </div>
    );
  }
  return (
    <div className={cls}>
      <label htmlFor={id}>{field.label}</label>
      {message}
      {field.type === 'select' ? (
        <select id={id} name={field.name} value={value} required={field.required} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea id={id} name={field.name} rows={4} value={value} required={field.required} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          id={id}
          name={field.name}
          type={field.type}
          value={value}
          required={field.required}
          autoComplete={field.autocomplete}
          min={field.min}
          max={field.max}
          inputMode={field.type === 'number' ? 'numeric' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function Step({ route, saved, navigate }) {
  const journey = journeys[route.journey];
  const order = Object.keys(journey.steps);
  const index = order.indexOf(route.step);
  const step = journey.steps[route.step];
  const final = index === order.length - 1;
  const [values, setValues] = useState(saved[route.step] ?? {});
  const [errors, setErrors] = useState([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const heading = useRef(null);
  useEffect(() => {
    document.title = `${step.title} | ${site.name}`;
    heading.current?.focus();
  }, [route.step]);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    const answer = await post(event.currentTarget);
    setBusy(false);
    if (answer.leaving) return;
    setErrors(answer.errors ?? []);
    setProblem(answer.problem ?? '');
    if (answer.go) {
      saved[route.step] = values;
      navigate(answer.go, answer.result);
    }
  }

  return (
    <div className="kst-wrap kst-step">
      <div className="kst-progress">
        <span>
          {journey.title} · step {index + 1} of {order.length}
        </span>
        <div className="kst-progress__bar">
          <div style={{ width: `${((index + 1) / order.length) * 100}%` }} />
        </div>
      </div>
      <div className="kst-card">
        <h1 tabIndex={-1} ref={heading}>
          {step.title}
        </h1>
        {problem && (
          <div className="kst-alert" role="alert">
            {problem}
          </div>
        )}
        {errors.length > 0 && (
          <div className="kst-alert" role="alert">
            Please check the {errors.length === 1 ? 'highlighted answer' : `${errors.length} highlighted answers`}.
          </div>
        )}
        <form method="post" action={`/${route.journey}/${route.step}`} noValidate onSubmit={onSubmit}>
          <div className="kst-grid">
            {step.fields
              .filter((f) => shown(f, values))
              .map((f) => (
                <Field key={f.name} field={f} value={values[f.name] ?? ''} error={errors.includes(f.name)} onChange={(v) => setValues({ ...values, [f.name]: v })} />
              ))}
          </div>
          {final && journey.disclosure && <p className="kst-small">{journey.disclosure}</p>}
          <div className="kst-actions">
            {index > 0 && (
              <a className="kst-link" href={`/${route.journey}/${order[index - 1]}`} onClick={(e) => (e.preventDefault(), navigate(`/${route.journey}/${order[index - 1]}`))}>
                ← Back
              </a>
            )}
            <button type="submit" className="kst-btn" disabled={busy}>
              {busy ? 'One moment…' : final ? journey.action : 'Continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Result({ route, result, navigate }) {
  const journey = journeys[route.journey];
  return (
    <div className="kst-wrap kst-step">
      <div className="kst-card kst-result">
        <p className="kst-eyebrow">{journey.title}</p>
        <h1>
          {result.headline} {result.headlineNote && <span>{result.headlineNote}</span>}
        </h1>
        {result.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        <p className="kst-small">
          Your reference: <strong>{result.reference}</strong>
        </p>
        {result.next && (
          <a className="kst-btn" href={`/${route.journey}/result/next`} onClick={(e) => (e.preventDefault(), navigate(`/${route.journey}/result/next`))}>
            {result.next.label}
          </a>
        )}
        <p className="kst-small">A demo: nothing here is real, and nothing has been bought.</p>
      </div>
    </div>
  );
}

function Next({ route, result }) {
  const [wall, setWall] = useState('');
  const [problem, setProblem] = useState('');
  async function onSubmit(event) {
    event.preventDefault();
    const answer = await post(event.currentTarget);
    setProblem(answer.problem ?? '');
    if (answer.wall) setWall(answer.wall);
  }
  return (
    <div className="kst-wrap kst-step">
      <div className="kst-card">
        <h1>{result.next.label}</h1>
        {wall ? (
          <p>{wall}</p>
        ) : (
          <form method="post" action={`/${route.journey}/result/next`} onSubmit={onSubmit}>
            <p>
              Reference <strong>{result.reference}</strong>: {result.headline} {result.headlineNote}
            </p>
            {problem && (
              <div className="kst-alert" role="alert">
                {problem}
              </div>
            )}
            <div className="kst-actions">
              <button type="submit" className="kst-btn">
                {result.next.action}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function App() {
  const [route, setRoute] = useState(data.route);
  const [result, setResult] = useState(data.route.result);
  // Answers already given, by step, so Back shows them again.
  const saved = useRef({ [data.route.step]: data.route.values ?? {} }).current;

  function navigate(to, newResult) {
    if (newResult) setResult(newResult);
    history.pushState(null, '', to);
    setRoute(routeFor(to));
    window.scrollTo(0, 0);
  }
  useEffect(() => {
    const onPop = () => {
      const next = routeFor(location.pathname);
      if ((next.view === 'result' || next.view === 'next') && !result) location.reload();
      else setRoute(next);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [result]);

  let page;
  if (route.view === 'step') page = <Step key={`${route.journey}/${route.step}`} route={route} saved={saved} navigate={navigate} />;
  else if (route.view === 'result' && result) page = <Result route={route} result={result} navigate={navigate} />;
  else if (route.view === 'next' && result?.next) page = <Next route={route} result={result} />;
  else page = <Home />;
  return (
    <>
      <Header />
      <main id="main">{page}</main>
      <Footer />
    </>
  );
}

// Drawn before the page finishes loading, so scripts that read the form (Usher's) find it.
const root = createRoot(document.getElementById('app'));
flushSync(() => root.render(<App />));
