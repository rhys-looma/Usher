# Demo sites

Six fictional businesses, none of them real, that would each want their own app in ChatGPT or Claude. Each one has forms that people put off, and some of its questions have to be answered by the person themselves. Every price is made up, and nothing is bought or booked. No dependencies.

| Site | Port | Journeys | Why an assistant app helps |
| --- | --- | --- | --- |
| **Larchmont Mortgages** | 4301 | Agreement in principle (three steps); book a call with an adviser | A long form whose answers the person already has. A joint application shows a second applicant, and self-employed asks for profit instead of salary. Credit history and consent to a credit search are the person's own. |
| **Kestrel Energy** | 4302 | A price and a switch (three steps) | "Am I paying too much?" turned into a price. The switch itself waits behind a second button. |
| **Fernbrook Borough Council** | 4303 | Resident parking permit (three steps); report a pothole or street problem (two steps) | Council forms are the ones people least want to fill in. A permit carries a declaration under offence. |
| **Hollyhock Vets** | 4304 | Book an appointment (three steps) | "Book Biscuit in for his jabs next week." Symptoms appear only when the pet is unwell. There's a missed-appointment charge to agree to. |
| **Packhorse Removals** | 4305 | A moving quote (three steps) | Two addresses, floors and a date in one go. "Book this move" leads to a deposit, which is a demo wall. |
| **Little Fig** | 4306 | Book a table (two steps) | The classic assistant booking, with a no-show charge that is the person's to accept. |

Every journey's last button is consequential. Each journey has its own intent (`quote.mortgage`, `booking.table`, …), so the token check knows which journey it is guarding.

## Run them

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

## Adding a site

A site is data in `sites.mjs`: a name, a colour and its journeys. Each journey has steps of fields, plus a `result()` that turns the answers into the result page. The server, the validation and the conditional fields come for free.
