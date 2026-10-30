// Page behaviour for the demo sites: fields marked data-show-if="name=value" appear only for that answer.

document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form[method="post"]');
  if (!form) return;
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
});
