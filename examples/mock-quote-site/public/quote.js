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

  // "Find address" (health, and car layout C) adds a list of the addresses on the postcode, for the person to pick.
  const findAddress = form.querySelector('[data-lookup="address"]');
  if (findAddress) {
    const postcode = form.querySelector(`[name="${CSS.escape(findAddress.dataset.postcode)}"]`);
    const results = findAddress.closest('.row').querySelector('.lookup-results');
    const status = findAddress.parentElement.querySelector('.lookup-status');
    findAddress.addEventListener('click', async () => {
      status.textContent = 'Looking up…';
      results.textContent = '';
      try {
        const res = await fetch(`/api/address?postcode=${encodeURIComponent(postcode.value)}`);
        if (!res.ok) throw new Error('not found');
        const { addresses } = await res.json();
        const label = document.createElement('label');
        // The list's name and label are the layout's own (layout B renames them).
        const name = findAddress.dataset.select ?? 'address';
        label.htmlFor = name;
        label.textContent = findAddress.dataset.label ?? 'Please select an address';
        const select = document.createElement('select');
        select.id = name;
        select.name = name;
        select.required = true;
        select.append(new Option('Please select', ''), ...addresses.map((a) => new Option(a.label, a.id)));
        results.append(label, select);
        status.textContent = `${addresses.length} addresses found`;
      } catch {
        status.textContent = 'We couldn’t find that postcode.';
      }
    });
  }

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
