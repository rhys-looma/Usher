-- How the agent proved its id when it knocked: Web Bot Auth (HTTP Message Signatures) or the
-- signed knock body, and where it publishes its keys. Structure only.
ALTER TABLE sessions ADD COLUMN identity jsonb;
