-- An owner's corrections to a walkthrough's proposal: the model's label and the owner's, per element,
-- structure only. Training data for the open model (owner-verified).
CREATE TABLE corrections (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), origin text, record jsonb NOT NULL);
CREATE INDEX corrections_origin ON corrections (origin, ts);
