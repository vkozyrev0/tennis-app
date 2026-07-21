-- D3: flag accounts that must change password before using the app (prod gate).
-- Seeded admin/admin sets this true; change-password clears it. Login also
-- re-detects the still-default admin password so existing DBs are covered.

ALTER TABLE user_account
    ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN user_account.must_change_password IS
    'D3: when true, API (ENV=prod) refuses non-auth routes until password is changed.';
