-- "I run a site with forms": site address, email and an optional line from the front page's form.
CREATE TABLE interest (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), origin text, record jsonb NOT NULL);
