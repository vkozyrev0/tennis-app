"""PII H2.3: MultiFernet key lists + rotate_token (docs/pii-h2-key-management.md).

Pure unit tests — no DB required for crypto; one integration check when DB is up.
"""

import pytest
from cryptography.fernet import Fernet

from app import crypto


@pytest.fixture
def two_keys(monkeypatch):
    old = Fernet.generate_key().decode()
    new = Fernet.generate_key().decode()
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{new},{old}")
    monkeypatch.delenv("PII_ENCRYPTION_KEY", raising=False)
    return new, old


def test_encrypt_uses_primary_decrypt_accepts_old(two_keys, monkeypatch):
    new, old = two_keys
    plain = "minor PII under rotation"
    # Ciphertext under OLD only
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", old)
    token_old = crypto.encrypt(plain)
    # Dual-key window: NEW first
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{new},{old}")
    assert crypto.decrypt(token_old) == plain
    token_new = crypto.encrypt(plain)
    assert crypto.decrypt(token_new) == plain
    # After retiring OLD, old ciphertext fails → passthrough (not valid under NEW)
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", new)
    assert crypto.decrypt(token_old) == token_old  # passthrough legacy/invalid
    assert crypto.decrypt(token_new) == plain


def test_rotate_token_rewrites_under_primary(two_keys, monkeypatch):
    new, old = two_keys
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", old)
    token_old = crypto.encrypt("rotate-me")
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{new},{old}")
    rotated = crypto.rotate_token(token_old)
    assert rotated != token_old
    assert crypto.decrypt(rotated) == "rotate-me"
    # Primary-only can still read the rotated token
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", new)
    assert crypto.decrypt(rotated) == "rotate-me"


def test_rotate_passthrough_plaintext_and_empty(two_keys):
    assert crypto.rotate_token("not a fernet token") == "not a fernet token"
    assert crypto.rotate_token(None) is None
    assert crypto.rotate_token("") == ""


def test_using_dev_key_detects_dev_in_list(monkeypatch):
    monkeypatch.delenv("PII_ENCRYPTION_KEYS", raising=False)
    monkeypatch.delenv("PII_ENCRYPTION_KEY", raising=False)
    assert crypto.using_dev_key() is True
    real = Fernet.generate_key().decode()
    monkeypatch.setenv("PII_ENCRYPTION_KEY", real)
    assert crypto.using_dev_key() is False
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{real},{crypto._DEV_KEY}")
    assert crypto.using_dev_key() is True


def test_single_key_alias_still_works(monkeypatch):
    k = Fernet.generate_key().decode()
    monkeypatch.delenv("PII_ENCRYPTION_KEYS", raising=False)
    monkeypatch.setenv("PII_ENCRYPTION_KEY", k)
    assert crypto.decrypt(crypto.encrypt("alias-ok")) == "alias-ok"


def test_backfill_rotates_mailbox_secrets(two_keys, monkeypatch):
    import reencrypt_pii
    from app.db import get_conn

    new, old = two_keys
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", old)
    token = crypto.encrypt("app-password")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE gmail_feed SET secret_enc = %s WHERE id = 1", (token,))
        cur.execute("UPDATE outlook_feed SET secret_enc = %s WHERE id = 1", (token,))
        conn.commit()
    try:
        monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{new},{old}")
        assert reencrypt_pii.run(apply=True, batch=100) == 0
        monkeypatch.setenv("PII_ENCRYPTION_KEYS", new)
        with get_conn() as conn, conn.cursor() as cur:
            for table in ("gmail_feed", "outlook_feed"):
                cur.execute(f"SELECT secret_enc FROM {table} WHERE id = 1")
                assert crypto.decrypt(cur.fetchone()["secret_enc"]) == "app-password"
    finally:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("UPDATE gmail_feed SET secret_enc = NULL WHERE id = 1")
            cur.execute("UPDATE outlook_feed SET secret_enc = NULL WHERE id = 1")
            conn.commit()


def test_backfill_rotates_player_history_birthdate(two_keys, monkeypatch):
    """A retired old key must not leave history birthdates unreadable."""
    import reencrypt_pii
    from app.db import get_conn

    new, old = two_keys
    monkeypatch.setenv("PII_ENCRYPTION_KEYS", old)
    token = crypto.encrypt("2012-05-01")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO player (usta_number, first_name, last_name, gender, birthdate) "
            "VALUES ('ROT-HIST-1', 'Rot', 'Ation', 'male', %s) RETURNING id",
            (token,),
        )
        pid = cur.fetchone()["id"]
        cur.execute(
            "INSERT INTO player_history "
            "(player_id, usta_number, first_name, last_name, birthdate, valid_from, change_type) "
            "VALUES (%s, 'ROT-HIST-1', 'Rot', 'Ation', %s, now(), 'update')",
            (pid, token),
        )
        conn.commit()
    try:
        monkeypatch.setenv("PII_ENCRYPTION_KEYS", f"{new},{old}")
        assert reencrypt_pii.run(apply=True, batch=100) == 0
        # Primary-only: both copies must decrypt after the old key is retired.
        monkeypatch.setenv("PII_ENCRYPTION_KEYS", new)
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT birthdate FROM player WHERE id = %s", (pid,))
            assert crypto.decrypt(cur.fetchone()["birthdate"]) == "2012-05-01"
            cur.execute(
                "SELECT birthdate FROM player_history WHERE player_id = %s", (pid,),
            )
            assert crypto.decrypt(cur.fetchone()["birthdate"]) == "2012-05-01"
    finally:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM player_history WHERE player_id = %s", (pid,))
            cur.execute("DELETE FROM player WHERE id = %s", (pid,))
            conn.commit()
