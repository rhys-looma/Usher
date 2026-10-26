// Page behaviour for the demo quote site: conditional fields and the vehicle lookup.

document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form[method="post"]');
  if (!form) return;

  // Fields marked data-show-if="name=value" appear only when that answer is chosen.
  const conditional = [...form.querySelectorAll('[data-show-if]')];
  const refresh = () => {
    for (const row of conditional) {
      const [name, value] = row.dataset.showIf.split('=');
      const chosen = form.querySelector(`[name="${CSS.escape(name)}"]:checked`) ?? form.querySelector(`select[name="${CSS.escape(name)}"]`);
      const show = chosen?.value === value;
      row.hidden = !show;
      for (const input of row.querySelectorAll('input, select, textarea')) input.disabled = !show;
    }
  };
  form.addEventListener('change', refresh);
  refresh();

  // "Find car" fills make, model and year from the registration.
  const button = form.querySelector('[data-lookup="vehicle"]');
  if (button) {
    const [reg, make, model, year] = button.dataset.fields.split(' ').map((n) => form.querySelector(`[name="${CSS.escape(n)}"]`));
    const status = form.querySelector('.lookup-status');
    button.addEventListener('click', async () => {
      status.textContent = 'Looking up…';
      try {
        const res = await fetch(`/api/vehicle?registration=${encodeURIComponent(reg.value)}`);
        if (!res.ok) throw new Error('not found');
        const car = await res.json();
        make.value = car.make;
        model.value = car.model;
        year.value = car.year;
        status.textContent = `Found: ${car.year} ${car.make} ${car.model}`;
      } catch {
        status.textContent = 'We couldn’t find that registration. Enter the details below.';
      }
    });
  }
});
