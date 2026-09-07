-- One Gmail IMAP feed per deployment. The TD stores an address + app password
-- (encrypted) and a UID cursor so "Fetch latest" only pulls new mail.

CREATE TABLE IF NOT EXISTS gmail_feed (
    id                 integer PRIMARY KEY CHECK (id = 1),
    enabled            boolean NOT NULL DEFAULT false,
    gmail_address      text,
    secret_enc         text,
    imap_host          text NOT NULL DEFAULT 'imap.gmail.com',
    imap_port          integer NOT NULL DEFAULT 993,
    mailbox            text NOT NULL DEFAULT 'INBOX',
    gmail_query        text,
    poll_minutes       integer NOT NULL DEFAULT 15,
    lookback_days      integer NOT NULL DEFAULT 7,
    tournament_id      integer REFERENCES tournament(id) ON DELETE SET NULL,
    last_uid           bigint,
    uidvalidity        bigint,
    last_fetched_at    timestamptz,
    last_status        text,
    last_error         text,
    last_imported      integer NOT NULL DEFAULT 0,
    last_duplicates    integer NOT NULL DEFAULT 0,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO gmail_feed (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE gmail_feed IS
  'Singleton Gmail IMAP settings + latest-mail cursor (last_uid / uidvalidity).';
COMMENT ON COLUMN gmail_feed.secret_enc IS
  'Fernet-encrypted Gmail app password; never returned to the client.';
COMMENT ON COLUMN gmail_feed.last_uid IS
  'Highest IMAP UID already ingested; fetch only UIDs above this.';
