-- Usher registry schema, version 1. Structure only: maps, rules, keys, sessions of semantic events.

CREATE TABLE signing_keys (
  kid text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  private_jwk jsonb NOT NULL
);

CREATE TABLE agent_keys (
  agent_id text PRIMARY KEY,
  jwk jsonb NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now()
);

-- Every version of every map is kept; the newest for a path is current.
CREATE TABLE maps (
  origin text NOT NULL,
  digest text NOT NULL,
  path text NOT NULL,
  signature text[] NOT NULL,
  added_at timestamptz NOT NULL,
  submitted_by text,
  drifted_at timestamptz,
  record jsonb NOT NULL,
  PRIMARY KEY (origin, digest)
);
CREATE INDEX maps_origin_path ON maps (origin, path, added_at DESC);
CREATE INDEX maps_signature ON maps USING gin (signature);

-- Where each map's actions lead (from leads_to), for plans across steps.
CREATE TABLE edges (
  origin text NOT NULL,
  digest text NOT NULL,
  action_id text NOT NULL,
  action_key text NOT NULL,
  from_path text NOT NULL,
  leads_to text NOT NULL,
  PRIMARY KEY (origin, digest, action_id),
  FOREIGN KEY (origin, digest) REFERENCES maps (origin, digest) ON DELETE CASCADE
);
CREATE INDEX edges_from ON edges (origin, from_path);

CREATE TABLE sites (
  origin text PRIMARY KEY,
  site_key text NOT NULL UNIQUE,
  secret_sha256 text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE policies (
  origin text PRIMARY KEY,
  policy jsonb NOT NULL,
  english text,
  draft_id text,
  confirmed_at timestamptz NOT NULL
);

CREATE TABLE rule_drafts (
  id text PRIMARY KEY,
  origin text NOT NULL,
  english text NOT NULL,
  policy jsonb NOT NULL,
  summary text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'superseded'))
);
CREATE INDEX rule_drafts_origin ON rule_drafts (origin, created_at DESC);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  origin text NOT NULL,
  agent text NOT NULL,
  intent text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX sessions_origin ON sessions (origin, created_at DESC);

-- Events name what was done by semantic key; there is no column for a value.
CREATE TABLE session_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  source text NOT NULL,
  action text NOT NULL,
  key text,
  element text,
  path text,
  detail jsonb
);
CREATE INDEX session_events_session ON session_events (session_id, id);

CREATE TABLE match_log (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), origin text, record jsonb NOT NULL);
CREATE TABLE run_reports (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), origin text, record jsonb NOT NULL);
CREATE TABLE drift_reports (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), origin text, record jsonb NOT NULL);
CREATE TABLE blocked_attempts (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), origin text, record jsonb NOT NULL);
CREATE INDEX match_log_origin ON match_log (origin, id);
CREATE INDEX run_reports_origin ON run_reports (origin, id);
CREATE INDEX drift_reports_origin ON drift_reports (origin, id);
CREATE INDEX blocked_attempts_origin ON blocked_attempts (origin, id);

CREATE TABLE cache (
  kind text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
