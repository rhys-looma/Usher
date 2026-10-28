# Field and action vocabulary, draft 0.1

Semantic keys say what a field or action *means*, independent of how a site labels it. An agent fills `person.dob` the same way on every site. Keys are lowercase, dotted, and never carry values.

When nothing here fits, use `custom.<slug>` (for example `custom.how_did_you_hear`). Custom keys that recur across sites get promoted into this list.

## Values

Values by key are written one way everywhere, whatever the site shows; the agent translates when it fills.

- **Dates** are YYYY-MM-DD: `person.dob`, `person.claims.date`, `vehicle.purchase_date`, `policy.start_date`, `search.date_from`, `search.date_to`, `booking.date`. A site may ask for one as a date picker, as text in its own format (DD/MM/YYYY and the like), or split into day, month and year boxes (fields with a `part`, see [map.md](map.md)): the value is the same.
- **Yes or no** answers may be given as `yes`/`no`, `true`/`false` or `y`/`n`; **numbers** as digits, without currency, separators or units.

## Defaults

Each key has a default risk and sensitivity. A map may make a field **stricter** than its default (for example, a `safe` key marked `consequential` on one site) but never looser. Keys marked sensitive are always `needs_user` and never appear in a plan's filled values.

## Person

| Key | Meaning | Default risk |
| --- | --- | --- |
| `person.title` | Title (Mr, Ms, Dr…) | safe |
| `person.first_name` | First or given name | safe |
| `person.last_name` | Surname or family name | safe |
| `person.full_name` | Full name in one field | safe |
| `person.dob` | Date of birth | safe |
| `person.gender` | Gender | safe |
| `person.marital_status` | Marital status | safe |
| `person.occupation` | Occupation or job title | safe |
| `person.employment_status` | Employed, self-employed, retired… | safe |
| `person.industry` | Industry of employment | safe |
| `person.resident_since` | Date or years resident in the country | safe |
| `person.licence.type` | Driving licence type | safe |
| `person.licence.held_years` | Years the licence has been held | safe |
| `person.licence.number` | Driving licence number | needs_user, sensitive |
| `person.claims.has_any` | Any claims in a period | safe |
| `person.claims.date` | Date of a claim | safe |
| `person.claims.type` | Type of a claim | safe |
| `person.convictions.has_any` | Any motoring convictions in a period | safe |

## Contact and address

| Key | Meaning | Default risk |
| --- | --- | --- |
| `contact.email` | Email address | safe |
| `contact.phone` | Phone number | safe |
| `contact.mobile` | Mobile number | safe |
| `address.line1`, `address.line2` | Address lines | safe |
| `address.town` | Town or city | safe |
| `address.county` | County, state or region | safe |
| `address.postcode` | Postcode or ZIP | safe |
| `address.country` | Country | safe |
| `address.years_at` | Years at this address | safe |

## Vehicle

| Key | Meaning | Default risk |
| --- | --- | --- |
| `vehicle.registration` | Registration plate | safe |
| `vehicle.make`, `vehicle.model` | Make and model | safe |
| `vehicle.year` | Year of manufacture | safe |
| `vehicle.value` | Estimated value | safe |
| `vehicle.purchase_date` | Date bought | safe |
| `vehicle.annual_mileage` | Expected annual mileage | safe |
| `vehicle.use` | Social, commuting, business | safe |
| `vehicle.overnight_location` | Where it is kept overnight | safe |
| `vehicle.owner` | Who owns it | safe |
| `vehicle.keeper` | Who is the registered keeper | safe |
| `vehicle.modifications.has_any` | Any modifications | safe |

## Policy and cover

| Key | Meaning | Default risk |
| --- | --- | --- |
| `policy.start_date` | Cover start date | safe |
| `policy.cover_level` | Comprehensive, third party… | safe |
| `policy.voluntary_excess` | Voluntary excess | safe |
| `policy.no_claims_years` | Years of no-claims discount | safe |
| `policy.payment_frequency` | Monthly or annual | safe |
| `policy.additional_drivers.has_any` | Any additional drivers | safe |

## Search and booking

| Key | Meaning | Default risk |
| --- | --- | --- |
| `search.query` | Free-text search | safe |
| `search.location` | Where | safe |
| `search.date_from`, `search.date_to` | Date range | safe |
| `booking.date`, `booking.time` | Booking date and time | safe |
| `booking.party_size` | Number of people | safe |

## Messages

| Key | Meaning | Default risk |
| --- | --- | --- |
| `message.subject` | Subject line | safe |
| `message.body` | Message text | safe |

## Consent, account and payment

| Key | Meaning | Default risk |
| --- | --- | --- |
| `consent.terms` | Accept terms and conditions | needs_user |
| `consent.declaration` | Confirm the information given is true | needs_user |
| `consent.marketing` | Marketing opt-in | needs_user |
| `account.username` | Account username | safe |
| `account.password` | Password | needs_user, sensitive |
| `payment.card_number`, `payment.expiry`, `payment.cvc`, `payment.name` | Card details | needs_user, sensitive |
| `payment.account_number`, `payment.sort_code` | Bank details | needs_user, sensitive |

## Actions

| Key | Meaning | Default risk |
| --- | --- | --- |
| `nav.next` | Go to the next step without committing anything | safe |
| `nav.back` | Go to the previous step | safe |
| `nav.skip` | Skip an optional step | safe |
| `lookup.address` | Look up an address from a postcode | safe |
| `lookup.vehicle` | Look up a vehicle from its registration | safe |
| `form.save` | Save progress | safe |
| `search.submit` | Run a search or filter results; commits nothing | safe |
| `form.submit` | Submit the form (request a quote, send a message, make a booking) | consequential |
| `form.purchase` | Buy, pay or commit to a contract | needs_user |
| `account.create` | Create an account | needs_user |
| `ui.dismiss` | Dismiss a banner or dialog (cookie notices: always the least-consent option) | safe |
| `ui.expand` | Reveal more fields or options | safe |
