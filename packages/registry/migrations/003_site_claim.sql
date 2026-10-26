-- Proof that a site's registrant controls its origin (well-known file, DNS TXT, or development
-- keys), when it was proved and last re-checked.
ALTER TABLE sites ADD COLUMN claim jsonb;
