// Hollyhock Vets: a Vue app. The server sends an empty page and this draws it. Written with render
// functions (no template compiler, so no eval and the strict CSP holds). Bundled by
// scripts/build.mjs to public/hollyhock.app.js.

import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue';
import { data, post, routeFor, shown, tel } from './shared.js';

const { site, journeys } = data;
const startOf = (key) => `/${key}/${Object.keys(journeys[key].steps)[0]}?restart`;

const state = reactive({
  route: data.route,
  result: data.route.result ?? null,
  // Answers already given, by step, so Back shows them again.
  saved: { [data.route.step]: { ...(data.route.values ?? {}) } },
});

function navigate(to, result) {
  if (result) state.result = result;
  history.pushState(null, '', to);
  state.route = routeFor(to);
  window.scrollTo(0, 0);
}
addEventListener('popstate', () => {
  const next = routeFor(location.pathname);
  if ((next.view === 'result' || next.view === 'next') && !state.result) location.reload();
  else state.route = next;
});

const paw = () =>
  h('svg', { class: 'hh-paw', viewBox: '0 0 32 32', 'aria-hidden': 'true' }, [
    h('ellipse', { cx: 16, cy: 21, rx: 7, ry: 6, fill: 'currentColor' }),
    ...[
      [7, 13],
      [12, 8],
      [20, 8],
      [25, 13],
    ].map(([cx, cy]) => h('ellipse', { cx, cy, rx: 3, ry: 3.6, fill: 'currentColor' })),
  ]);

const link = (to, text, cls) => h('a', { href: to, class: cls, onClick: (e) => (e.preventDefault(), navigate(to)) }, text);

const Header = () =>
  h('header', { class: 'hh-header' }, [
    h('a', { href: '/', class: 'hh-brand' }, [paw(), h('span', site.name)]),
    h('p', { class: 'hh-open' }, ['Open today · ', h('a', { href: tel(site.contact.phone) }, site.contact.phone)]),
  ]);

const Footer = () =>
  h('footer', { class: 'hh-footer' }, [
    h(
      'div',
      { class: 'hh-practices' },
      site.practices.map((p) => h('div', { class: 'hh-practice' }, [h('h2', `${p.name} practice`), h('p', p.address)])),
    ),
    h('p', site.contact.hours),
    h('p', { class: 'hh-fine' }, site.footer),
  ]);

const Home = () =>
  h('div', { class: 'hh-home' }, [
    h('section', { class: 'hh-hero' }, [
      h('h1', site.heading),
      h('p', { class: 'hh-lede' }, site.blurb),
      ...Object.keys(journeys).map((key) => h('a', { class: 'hh-btn', href: startOf(key) }, journeys[key].title)),
    ]),
    h(
      'ul',
      { class: 'hh-cards' },
      [
        ['Dogs, cats and rabbits', 'Check-ups, jabs and everything in between.'],
        ['Nervous pets welcome', 'Quiet waiting room and no-rush appointments.'],
        ['Same-day appointments', 'Held back every morning for poorly pets.'],
      ].map(([title, text]) => h('li', [h('h2', title), h('p', text)])),
    ),
  ]);

function fieldView(f, values, invalid) {
  const id = `f-${f.name}`;
  const set = (v) => (values[f.name] = v);
  const err = invalid ? h('p', { class: 'hh-error' }, f.type === 'checkbox' ? 'Please tick this box' : 'We need this one') : null;
  const cls = ['hh-field', `hh-field-${f.type}`, invalid && 'hh-invalid'];
  if (f.type === 'radio')
    return h('fieldset', { class: cls, id, key: f.name }, [
      h('legend', f.label),
      err,
      h(
        'div',
        { class: 'hh-pills' },
        f.options.map((o) =>
          h('label', { class: ['hh-pill', values[f.name] === o.value && 'on'], key: o.value }, [
            h('input', { type: 'radio', name: f.name, value: o.value, checked: values[f.name] === o.value, required: f.required, onChange: () => set(o.value) }),
            h('span', o.label),
          ]),
        ),
      ),
    ]);
  if (f.type === 'checkbox')
    return h('div', { class: cls, key: f.name }, [
      err,
      h('label', { class: 'hh-tick' }, [
        h('input', { type: 'checkbox', id, name: f.name, value: 'yes', checked: values[f.name] === 'yes', required: f.required, onChange: (e) => set(e.target.checked ? 'yes' : '') }),
        h('span', f.label),
      ]),
    ]);
  const control =
    f.type === 'select'
      ? h('select', { id, name: f.name, value: values[f.name] ?? '', required: f.required, onChange: (e) => set(e.target.value) }, [
          h('option', { value: '' }, 'Pick one'),
          ...f.options.map((o) => h('option', { value: o.value, key: o.value }, o.label)),
        ])
      : f.type === 'textarea'
        ? h('textarea', { id, name: f.name, rows: 4, value: values[f.name] ?? '', required: f.required, onInput: (e) => set(e.target.value) })
        : h('input', { id, name: f.name, type: f.type, value: values[f.name] ?? '', required: f.required, autocomplete: f.autocomplete, min: f.min, max: f.max, onInput: (e) => set(e.target.value) });
  return h('div', { class: cls, key: f.name }, [h('label', { for: id }, f.label), err, control]);
}

const Step = defineComponent({
  props: { route: Object },
  setup(props) {
    const journey = journeys[props.route.journey];
    const order = Object.keys(journey.steps);
    const index = order.indexOf(props.route.step);
    const step = journey.steps[props.route.step];
    const final = index === order.length - 1;
    const values = reactive({ ...(state.saved[props.route.step] ?? {}) });
    const errors = ref([]);
    const problem = ref('');
    const busy = ref(false);
    const heading = ref(null);
    document.title = `${step.title} | ${site.name}`;
    nextTick(() => heading.value?.focus());

    async function onSubmit(event) {
      event.preventDefault();
      busy.value = true;
      const answer = await post(event.currentTarget);
      busy.value = false;
      if (answer.leaving) return;
      errors.value = answer.errors ?? [];
      problem.value = answer.problem ?? '';
      if (answer.go) {
        state.saved[props.route.step] = { ...values };
        navigate(answer.go, answer.result);
      }
    }

    return () =>
      h('div', { class: 'hh-step' }, [
        h('div', { class: 'hh-dots', 'aria-label': `${journey.title}: step ${index + 1} of ${order.length}` }, order.map((k, i) => h('span', { class: { on: i <= index }, key: k }))),
        h('h1', { tabindex: -1, ref: heading }, step.title),
        problem.value && h('div', { class: 'hh-alert', role: 'alert' }, problem.value),
        errors.value.length > 0 && h('div', { class: 'hh-alert', role: 'alert' }, 'A couple of things need another look.'),
        h('form', { method: 'post', action: `/${props.route.journey}/${props.route.step}`, novalidate: true, onSubmit }, [
          ...step.fields.filter((f) => shown(f, values)).map((f) => fieldView(f, values, errors.value.includes(f.name))),
          final && journey.disclosure ? h('p', { class: 'hh-fine' }, journey.disclosure) : null,
          h('div', { class: 'hh-actions' }, [
            index > 0 ? link(`/${props.route.journey}/${order[index - 1]}`, 'Back', 'hh-back') : null,
            h('button', { type: 'submit', class: 'hh-btn', disabled: busy.value }, busy.value ? 'Just a sec…' : final ? journey.action : 'Next'),
          ]),
        ]),
      ]);
  },
});

const Result = (props) => {
  const r = state.result;
  return h('div', { class: 'hh-step hh-result' }, [
    h('p', { class: 'hh-eyebrow' }, journeys[props.route.journey].title),
    h('h1', [r.headline, r.headlineNote ? h('span', ` ${r.headlineNote}`) : null]),
    ...r.lines.map((l) => h('p', l)),
    h('p', { class: 'hh-ref' }, ['Reference ', h('strong', r.reference)]),
    h('p', { class: 'hh-fine' }, 'A demo: nothing here is real, and nothing has been booked.'),
    h('a', { href: '/', class: 'hh-back' }, `Back to ${site.short}`),
  ]);
};

const App = defineComponent({
  setup() {
    return () => {
      const route = state.route;
      const page =
        route.view === 'step' ? h(Step, { route, key: `${route.journey}/${route.step}` }) : route.view !== 'home' && state.result ? Result({ route }) : Home();
      return [Header(), h('main', { id: 'main' }, [page]), Footer()];
    };
  },
});

// Mounted before the page finishes loading, so scripts that read the form (Usher's) find it.
createApp(App).mount('#app');
