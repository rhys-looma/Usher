# Demo sites

Six fictional businesses, none of them real, that would each want their own app in ChatGPT or Claude. Each one has forms that people put off, and some of its questions have to be answered by the person themselves. Every price is made up, and nothing is bought or booked.

| Site | Port | Built as | Journeys | Why an assistant app helps |
| --- | --- | --- | --- | --- |
| **Larchmont Mortgages** | 4301 | Server pages: a building society, with a stepper and side panel | Agreement in principle (three steps); book a call with an adviser | A long form whose answers the person already has. A joint application shows a second applicant, and self-employed asks for profit instead of salary. Credit history and consent to a credit search are the person's own. |
| **Kestrel Energy** | 4302 | A React app: pages drawn in the browser, steps without page loads | A price and a switch (three steps) | "Am I paying too much?" turned into a price. The switch itself waits behind a second button. |
| **Fernbrook Borough Council** | 4303 | Server pages: a plain council service, a question per section | Resident parking permit (three steps); report a pothole or street problem (two steps) | Council forms are the ones people least want to fill in. A permit carries a declaration under offence. |
| **Hollyhock Vets** | 4304 | A Vue app: pages drawn in the browser, pill buttons | Book an appointment (three steps) | "Book Biscuit in for his jabs next week." Symptoms appear only when the pet is unwell. There's a missed-appointment charge to agree to. |
| **Packhorse Removals** | 4305 | Server pages: bold, with the steps down the side | A moving quote (three steps) | Two addresses, floors and a date in one go. "Book this move" leads to a deposit, which is a demo wall. |
| **Little Fig** | 4306 | Server pages: a quiet restaurant site, underlined fields | Book a table (two steps) | The classic assistant booking, with a no-show charge that is the person's to accept. |

Each site looks and is built differently, so mapping meets more than one kind of page: server-rendered forms, and apps whose steps change in the browser with no page load (they post each step with `fetch`, and the token the Usher script adds goes with it). The apps use real React and Vue, bundled by `npm run build` into `public/` and served by the sites themselves, so the strict content security policy holds. Without that build their pages say so.

Every journey's last button is consequential. Each journey has its own intent (`quote.mortgage`, `booking.table`, …), so the token check knows which journey it is guarding.

## Run them

```bash
npm run build
```

```bash
npm run sites
```

That starts all six sites, each on its own port. Each port is its own origin, so each site can join Usher like a real site.

- `SITES=larchmont npm run sites` starts only the sites you name.
- `PORT_BASE=5300` moves the ports.

## Map one as its owner

This uses Larchmont as the example; the steps are the same for every site.

1. Build the middleware once, then start a local registry that may open local addresses:

   ```bash
   npm run build
   ```

   ```bash
   npm run registry -- --allow-private
   ```

   The walkthrough calls Muse Spark, so the registry needs `MODEL_API_KEY` in `.env`.

2. On the registry, open `/sites/new` and enter Larchmont's address: `http` on `localhost`, port 4301. Keep the keys it gives you.
3. On Larchmont, open `/__settings`. Enter the registry's address and the site key, and save. That is where a real owner would paste the tag into their site's admin. The site now serves the script tag and the claim file at `/.well-known/usher-site.json`, and checks tokens on each journey's last step.
4. Back on the registry, press **Check now**. The dashboard opens, signed in.
5. On the dashboard's app page, follow the strip:
   - **Map my site:** start at `/aip/you`, with a generated test person. Tick "press the last button" if you want the run to go all the way through.
   - Correct anything the map got wrong, then publish.
   - Write the rules.
   - Accept the look.
   - Switch the app on.

`/__settings` only opens from the same machine, as if it were behind the site's own admin login. Settings are kept in `.settings.json` here (gitignored). Or set them up front with `USHER_REGISTRY_URL` and `USHER_SITE_KEY_<SITE>` (for example `USHER_SITE_KEY_LARCHMONT`).

## In public

Production serves all six sites from one container, each at its own name under the registry's host: `larchmont.`, `kestrel.`, `fernbrook.`, `hollyhock.`, `packhorse.` and `littlefig.` (`SITE_DOMAIN` is the registry's host). Joining works as above, with the production registry:

- `/__settings` asks for the admin key, the one in Secrets Manager that also guards Brightwater's `/__admin`. Only the site key can be set; the registry is always the production one. Settings last until the next deploy. A claim the registry has already checked stays checked.
- Anyone can reach the sites, so:
  - nothing to upload and no passwords;
  - only the sites' own host names (anything else gets 421);
  - request bodies up to 16 KB;
  - rate limits per client: 240 requests and 40 submits a minute, and 10 tries at the settings an hour;
  - sessions in memory for an hour, and a journey's answers dropped once its result is shown;
  - strict security headers: CSP (only the page's own files and the registry), no framing, HSTS;
  - no stack traces in responses.

## Adding a site

A site is data in `sites.mjs`: a name, a colour and its journeys. Each journey has steps of fields, plus a `result()` that turns the answers into the result page. The server, the validation and the conditional fields come for free.
