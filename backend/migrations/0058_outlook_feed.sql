-- One Microsoft Graph (app-only) mail feed per deployment. The TD stores
-- tenant / client id / mailbox and a Fernet-encrypted client secret, plus a
-- receivedDateTime cursor so "Get latest" only pulls newer mail.

CREATE TABLE IF NOT EXISTS outlook_feed (
    id                      integer PRIMARY KEY CHECK (id = 1),
    enabled                 boolean NOT NULL DEFAULT false,
    tenant_id               text NOT NULL DEFAULT '4c0cbcf5-4d26-4983-afdb-cc67e4754e4a',
    client_id               text NOT NULL DEFAULT 'api://1fdab846-8104-468e-a650-149c2ddc40c6',
    secret_enc              text,
    mailbox                 text NOT NULL DEFAULT 'TD@myadllc.com',
    mail_query              text,
    poll_minutes            integer NOT NULL DEFAULT 15,
    lookback_days           integer NOT NULL DEFAULT 7,
    tournament_id           integer REFERENCES tournament(id) ON DELETE SET NULL,
    client_secret_expires   text NOT NULL DEFAULT '9/7/2028',
    last_received_at        timestamptz,
    last_fetched_at         timestamptz,
    last_status             text,
    last_error              text,
    last_imported           integer NOT NULL DEFAULT 0,
    last_duplicates         integer NOT NULL DEFAULT 0,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO outlook_feed (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE outlook_feed IS
  'Singleton Microsoft Graph app-only mail settings + latest-mail cursor (last_received_at).';
COMMENT ON COLUMN outlook_feed.secret_enc IS
  'Fernet-encrypted Entra client secret; never returned to the client.';
COMMENT ON COLUMN outlook_feed.last_received_at IS
  'Newest receivedDateTime already ingested; fetch only messages newer than this.';
