-- H4.2: gate bulk CSV export of minors' PII (permissioned action).
-- Admins with can_export_pii=false can still use the app; full PII CSV
-- downloads are refused. Default true so existing single-TD POC behavior is
-- unchanged until a second admin is created without the flag.

ALTER TABLE user_account
    ADD COLUMN IF NOT EXISTS can_export_pii boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN user_account.can_export_pii IS
    'H4.2: when false, refuse full minors-PII CSV export (redacted may still be allowed client-side).';
