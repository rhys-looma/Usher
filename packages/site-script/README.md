# @usher/site-script

The one tag a site adds. Built to `dist/usher.js` (`npm run build`) and served by the registry at `/usher.js`, and at `/usher/<version>.js` with a long cache.

```html
<script src="https://registry.example/usher.js" data-usher-registry="https://registry.example" data-usher-site-key="usp_…" defer></script>
```

What it does on each page:

- **Knock notice.** Marks every form with where to knock (`data-usher-knock`). Nothing a person sees, and nothing changes for them.
- **Drift.** Fingerprints the live form and compares it with the current map, cached for an hour. It reports drift only when they differ.
- **Binding.** When an agent binds the token it got by knocking (`window.usher.bind(token)`), it unlocks the form under the site's rules:
  - holds a consequential submit until the agent says its user confirmed (`window.usher.confirm()`);
  - leaves `needs_user` fields to the person (`window.usher.handoff(key)`);
  - adds the token to the submitted form for the server-side check.
- **The log.** Records the bound agent's actions by semantic key, and which keys a site rejected, never values or messages.

Page loads with no bound token send nothing: people are never logged. The page script is advisory. Enforcement is the server-side check in [`@usher/site-middleware`](../site-middleware/).

```bash
npm test --workspace packages/site-script
```
