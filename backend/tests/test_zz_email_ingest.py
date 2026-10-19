"""Email auto-ingest webhook (D4) — token auth, dedup, routing, encryption.

Named test_zz_* so logins sort after other modules (suite convention).
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.crypto import decrypt
from app.db import get_conn
from app.main import app
from app.triage import classify_timed

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)

TOKEN = "test-ingest-token-not-for-prod"


@pytest.fixture(autouse=True)
def _token_and_admin(monkeypatch):
    monkeypatch.setenv("INGEST_TOKEN", TOKEN)
    monkeypatch.delenv("INGEST_DEFAULT_TOURNAMENT_ID", raising=False)
    client.post("/api/auth/login", json={"username": "admin", "password": "admin"})


def _ok(r, code=201):
    assert r.status_code == code, r.text
    return r.json()


def _tournament(**kw):
    body = {
        "name": "Ingest T " + uuid.uuid4().hex[:8],
        "type": "junior",
        "play_start_date": "2026-07-01",
        "play_end_date": "2026-07-04",
        **kw,
    }
    return _ok(client.post("/api/tournaments", json=body))


def _headers(**extra):
    h = {"X-Ingest-Token": TOKEN}
    h.update(extra)
    return h


# --------------------------------------------------------------------------
# Auth / enablement
# --------------------------------------------------------------------------

def test_status_reports_enabled():
    r = client.get("/api/ingest/status")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert "json" in body["endpoints"]


def test_disabled_without_token(monkeypatch):
    monkeypatch.delenv("INGEST_TOKEN", raising=False)
    r = client.post("/api/ingest/email", json={
        "subject": "hi", "body": "there",
    })
    assert r.status_code == 503
    assert "INGEST_TOKEN" in r.json()["detail"]


def test_wrong_token_401():
    r = client.post(
        "/api/ingest/email",
        headers={"X-Ingest-Token": "wrong"},
        json={"subject": "x", "body": "y"},
    )
    assert r.status_code == 401


def test_bearer_token_works():
    mid = f"<{uuid.uuid4().hex}@test>"
    r = client.post(
        "/api/ingest/email",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={
            "message_id": mid,
            "from_address": "parent@example.com",
            "subject": "please withdraw Jane Doe",
            "body": "She is injured and cannot play.",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["duplicate"] is False


# --------------------------------------------------------------------------
# Happy path + classification + encryption
# --------------------------------------------------------------------------

def test_ingest_json_classifies_and_encrypts_body():
    t = _tournament(ingest_address="macon-demo")
    mid = f"withdraw-{uuid.uuid4().hex}@example.com"
    body_text = "Please withdraw Sam Player from the tournament. USTA # 1234567890"
    r = client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": mid,
            "from_address": "mom@example.com",
            "to_address": "macon-demo@inbox.example.com",
            "subject": "Withdrawal request",
            "body": body_text,
        },
    )
    data = _ok(r, 201)
    assert data["tournament_id"] == t["id"]
    assert data["classification"] == "withdrawal"
    assert data["status"] == "new"
    assert data["duplicate"] is False

    # Encrypted at rest: ciphertext in DB ≠ plaintext; admin read decrypts.
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT body, to_address, ingest_source FROM email_message WHERE id = %s",
                (data["id"],),
            )
            row = cur.fetchone()
    assert row["body"] != body_text
    assert decrypt(row["body"]) == body_text
    assert row["to_address"] == "macon-demo@inbox.example.com"
    assert row["ingest_source"] == "webhook"

    em = _ok(client.get(f"/api/emails?tournament_id={t['id']}"), 200)
    hit = next((e for e in em if e["id"] == data["id"]), None)
    assert hit is not None
    assert hit["body"] == body_text
    assert hit["ingest_source"] == "webhook"
    assert hit["to_address"] == "macon-demo@inbox.example.com"


def test_pdf_style_row_is_not_replaced_on_feed_ingest():
    """Same tournament + sender + subject with no stored message_id (PDF) skips."""
    from app.db import get_conn
    from app.email_ingest import IngestPayload, ingest_email, sender_key

    assert sender_key("Jane Roe <jane@x.com>") == "jane@x.com"
    t = _tournament()
    pasted = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "from_address": "Jane Roe <parent@example.com>",
        "subject": "Boys 14 Withdrawal",
        "body": "please withdraw",
    }))
    put = client.put(f"/api/emails/{pasted['id']}", json={
        "tournament_id": t["id"],
        "classification": "hotel",
        "status": "needs_followup",
    })
    assert put.status_code == 200, put.text
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE email_message SET message_id = NULL WHERE id = %s",
                (pasted["id"],),
            )
            result = ingest_email(cur, IngestPayload(
                message_id="<feed-1@gmail.com>",
                from_address="parent@example.com",
                to_address="td@example.com",
                subject="Boys 14 Withdrawal",
                body="Please withdraw Jane Roe from singles.",
                tournament_id=t["id"],
                ingest_source="gmail",
            ))
        conn.commit()
    assert result["duplicate"] is True
    assert result["id"] == pasted["id"]
    row = next(e for e in client.get(f"/api/emails?tournament_id={t['id']}").json()
               if e["id"] == pasted["id"])
    assert row["classification"] == "hotel"
    assert row["status"] == "needs_followup"
    assert row["body"] == "please withdraw"
    assert len([e for e in client.get(f"/api/emails?tournament_id={t['id']}").json()
                if (e.get("subject") or "") == "Boys 14 Withdrawal"]) == 1


def test_ingest_unique_violation_race_still_returns_duplicate(monkeypatch):
    from app import email_ingest as ei
    from app.email_ingest import IngestPayload
    t = _tournament()
    mid = f"race-{uuid.uuid4().hex}@example.com"
    monkeypatch.setattr(ei, "find_existing_email", lambda *_a, **_k: None)
    with get_conn() as conn:
        with conn.cursor() as cur:
            first = ei.ingest_email(cur, IngestPayload(
                message_id=mid, from_address="a@b.com", to_address=None,
                subject="race subject", body="body", tournament_id=t["id"],
            ))
            assert first["duplicate"] is False
            second = ei.ingest_email(cur, IngestPayload(
                message_id=mid, from_address="a@b.com", to_address=None,
                subject="race subject", body="body", tournament_id=t["id"],
            ))
            assert second["duplicate"] is True
            assert second["id"] == first["id"]
        conn.commit()


def test_ingest_adopts_unscoped_message_id():
    """Get mails after Clear: unscoped message_id rows attach to the active event."""
    from app.email_ingest import IngestPayload, ingest_email
    t = _tournament()
    mid = f"<orphan-{uuid.uuid4().hex}@mail.test>"
    row = _ok(client.post("/api/emails", json={
        "tournament_id": t["id"],
        "message_id": mid,
        "from_address": "parent@example.com",
        "subject": "Boys 14 Withdrawal",
        "body": "please withdraw",
    }))
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE email_message SET tournament_id = NULL WHERE id = %s",
                (row["id"],),
            )
            result = ingest_email(cur, IngestPayload(
                message_id=mid,
                from_address="parent@example.com",
                to_address="td@example.com",
                subject="Boys 14 Withdrawal",
                body="please withdraw",
                tournament_id=t["id"],
                ingest_source="outlook",
            ))
        conn.commit()
    assert result["duplicate"] is False
    assert result["id"] == row["id"]
    assert result["tournament_id"] == t["id"]
    listed = client.get(f"/api/emails?tournament_id={t['id']}").json()
    assert any(e["id"] == row["id"] for e in listed)


def test_find_existing_needs_sender_subject_and_tournament():
    from app.db import get_conn
    from app.email_ingest import IngestPayload, find_existing_email
    t = _tournament()
    with get_conn() as conn:
        with conn.cursor() as cur:
            assert find_existing_email(cur, IngestPayload(
                message_id=None, from_address="a@b.com", to_address=None,
                subject="", body="x"), t["id"]) is None
            assert find_existing_email(cur, IngestPayload(
                message_id=None, from_address="", to_address=None,
                subject="Hi", body="x"), t["id"]) is None
            assert find_existing_email(cur, IngestPayload(
                message_id=None, from_address="a@b.com", to_address=None,
                subject="Hi", body="x"), None) is None


def test_dedup_by_message_id_returns_200():
    mid = f"dup-{uuid.uuid4().hex}@example.com"
    payload = {
        "message_id": mid,
        "from_address": "a@b.com",
        "subject": "late entry for kid",
        "body": "Can we still register late?",
    }
    first = _ok(client.post("/api/ingest/email", headers=_headers(), json=payload), 201)
    second = client.post("/api/ingest/email", headers=_headers(), json=payload)
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["duplicate"] is True
    assert body["id"] == first["id"]


def test_explicit_tournament_id():
    t = _tournament()
    mid = f"exp-{uuid.uuid4().hex}@example.com"
    data = _ok(client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": mid,
            "tournament_id": t["id"],
            "subject": "hotel stay",
            "body": "We are staying at the Marriott downtown.",
            "from_address": "dad@example.com",
        },
    ), 201)
    assert data["tournament_id"] == t["id"]
    assert data["classification"] == "hotel"


def test_bad_tournament_id_400():
    r = client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": f"bad-{uuid.uuid4().hex}@x",
            "tournament_id": 99999999,
            "subject": "x",
            "body": "y",
        },
    )
    assert r.status_code == 400


def test_default_tournament_env(monkeypatch):
    t = _tournament()
    monkeypatch.setenv("INGEST_DEFAULT_TOURNAMENT_ID", str(t["id"]))
    mid = f"def-{uuid.uuid4().hex}@example.com"
    data = _ok(client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": mid,
            "subject": "doubles pair request",
            "body": "Mia Langone and Chelsea Ie would like to pair for doubles.",
            "from_address": "p@example.com",
        },
    ), 201)
    assert data["tournament_id"] == t["id"]


def test_stale_default_tournament_falls_back_to_unscoped(monkeypatch):
    monkeypatch.setenv("INGEST_DEFAULT_TOURNAMENT_ID", "99999999")
    mid = f"stale-{uuid.uuid4().hex}@example.com"
    data = _ok(client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={
            "message_id": mid,
            "subject": "no tournament",
            "body": "unscoped mail",
            "from_address": "p@example.com",
        },
    ), 201)
    assert data["tournament_id"] is None


def test_form_mailgun_style():
    t = _tournament(ingest_address="mg-route")
    mid = f"mg-{uuid.uuid4().hex}@mailgun"
    r = client.post(
        "/api/ingest/email/form",
        headers=_headers(),
        data={
            "sender": "parent@example.com",
            "recipient": "mg-route@mg.example.com",
            "subject": "cannot play Saturday morning",
            "body-plain": "My child has a time conflict and can't play after 9.",
            "Message-Id": f"<{mid}>",
        },
    )
    data = _ok(r, 201)
    assert data["tournament_id"] == t["id"]
    assert data["classification"] == "scheduling_avoidance"
    assert data["message_id"] == mid  # angle brackets stripped


def test_empty_message_400():
    r = client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={},
    )
    assert r.status_code == 400


def test_ingest_address_unique_per_active_tournament():
    addr = f"shared-{uuid.uuid4().hex[:6]}"
    _tournament(ingest_address=addr)
    r = client.post("/api/tournaments", json={
        "name": "Clash " + uuid.uuid4().hex[:6],
        "type": "junior",
        "play_start_date": "2026-08-01",
        "play_end_date": "2026-08-03",
        "ingest_address": addr,
    })
    assert r.status_code == 409
    assert "ingest address" in r.json()["detail"].lower()


def test_query_token_auth():
    mid = f"qtok-{uuid.uuid4().hex}@example.com"
    r = client.post(
        f"/api/ingest/email?token={TOKEN}",
        json={"message_id": mid, "subject": "hi", "body": "hello from query token"},
    )
    assert r.status_code == 201, r.text


def test_query_token_rejected_in_prod(monkeypatch):
    """D4: ?token= is a last resort; prod refuses unless INGEST_ALLOW_QUERY_TOKEN=1."""
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.delenv("INGEST_ALLOW_QUERY_TOKEN", raising=False)
    mid = f"qtok-prod-{uuid.uuid4().hex}@example.com"
    r = client.post(
        f"/api/ingest/email?token={TOKEN}",
        json={"message_id": mid, "subject": "hi", "body": "should fail"},
    )
    assert r.status_code == 401, r.text
    assert "query-string" in r.json()["detail"].lower() or "header" in r.json()["detail"].lower()
    # Header still works in prod
    r2 = client.post(
        "/api/ingest/email",
        headers=_headers(),
        json={"message_id": mid + "-h", "subject": "hi", "body": "header ok"},
    )
    assert r2.status_code == 201, r2.text
    # Explicit override re-enables query token
    monkeypatch.setenv("INGEST_ALLOW_QUERY_TOKEN", "1")
    r3 = client.post(
        f"/api/ingest/email?token={TOKEN}",
        json={"message_id": mid + "-q", "subject": "hi", "body": "override ok"},
    )
    assert r3.status_code == 201, r3.text


def test_webhook_model_work_is_bounded(monkeypatch):
    """A webhook classifies at most the pass budget's worth of leftovers.

    `pass_budget` was set for the feed and bulk paths only, so a webhook batch
    made one model round trip per 'other' email inside one request; a slow
    endpoint held the request (and its DB transaction) for minutes.
    """
    monkeypatch.setenv("EMAIL_LLM", "1")
    monkeypatch.setenv("EMAIL_LLM_MAX_CALLS", "2")
    monkeypatch.setenv("EMAIL_LLM_PASS_SECONDS", "120")
    monkeypatch.delenv("EMAIL_LLM_PROVIDER", raising=False)
    monkeypatch.setenv("EMAIL_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
    calls = {"n": 0}

    def fake_complete(prompt):
        calls["n"] += 1
        return '{"intent":"other","confidence":0.2}'

    monkeypatch.setattr("app.email_llm._complete", fake_complete)
    monkeypatch.setattr("app.email_llm._LEFTOVER_LAST", None)
    seen = []

    def spy(subject, body):
        from app.email_llm import active_budget
        seen.append(active_budget())
        return classify_timed(subject, body)

    monkeypatch.setattr("app.email_ingest.classify_timed", spy)

    t = _tournament()
    tag = uuid.uuid4().hex[:8]
    _ok(client.post("/api/ingest/email", headers=_headers(), json={
        "message_id": f"<bound-{tag}-0@example.com>",
        "from_address": "parent@example.com",
        "tournament_id": t["id"],
        "subject": f"Note on the schedule {tag}",
        "body": "Something that matches no keyword.",
    }))
    assert seen and seen[-1] is not None, "ingest classify ran without a pass budget"
    assert seen[-1].max_calls == 2
    assert seen[-1].calls == 1


def test_duplicate_pdf_row_keeps_its_body(monkeypatch):
    """A PDF row matched by tournament + sender + subject is left alone.

    Gmail reports no Message-ID for some mail, so the same PDF thread comes back
    through the feed. Refilling the body and subject replaced the stored copy
    with the new one, and the wide subject match compared twice-lowercased text.
    """
    from app.db import get_conn
    from app.email_ingest import IngestPayload, ingest_email

    t = _tournament()
    with get_conn() as conn:
        with conn.cursor() as cur:
            first = ingest_email(cur, IngestPayload(
                message_id=None,
                from_address="Pdf Parent <pdf@example.com>",
                to_address=None,
                subject="Mixed Case Withdrawal",
                body="original body",
                tournament_id=t["id"],
                ingest_source="pdf",
            ))
            again = ingest_email(cur, IngestPayload(
                message_id="<feed-pdf-1@gmail.com>",
                from_address="pdf@example.com",
                to_address="td@example.com",
                subject="Mixed Case Withdrawal",
                body="body from the feed",
                tournament_id=t["id"],
                ingest_source="gmail",
            ))
            cur.execute(
                "SELECT id, body, subject, classification FROM email_message WHERE id = %s",
                (first["id"],),
            )
            row = cur.fetchone()
        conn.commit()
    # A row the feed matched without a Message-Id keeps the copy it has.
    assert again["duplicate"] is True
    assert again["id"] == first["id"]
    assert decrypt(row["body"]) == "original body"
    assert row["subject"] == "Mixed Case Withdrawal"


def test_restored_hidden_copy_stays_with_its_event():
    """Clear on event A then Get mails on event B keeps A's mail in A.

    Restoring a hidden copy re-homed it onto whichever event fetched last, so
    mail the TD cleared under one tournament reappeared under another.
    """
    from app.db import get_conn
    from app.email_ingest import IngestPayload, ingest_email

    a = _tournament()
    b = _tournament()
    mid = f"<hidden-{uuid.uuid4().hex[:8]}@example.com>"
    with get_conn() as conn:
        with conn.cursor() as cur:
            first = ingest_email(cur, IngestPayload(
                message_id=mid, from_address="p@example.com", to_address=None,
                subject="Cleared under A", body="body", tournament_id=a["id"],
                ingest_source="gmail",
            ))
            cur.execute("UPDATE email_message SET deleted_at = now() WHERE id = %s",
                        (first["id"],))
            restored = ingest_email(cur, IngestPayload(
                message_id=mid, from_address="p@example.com", to_address=None,
                subject="Cleared under A", body="body", tournament_id=b["id"],
                ingest_source="gmail",
            ))
            cur.execute("SELECT tournament_id, deleted_at FROM email_message WHERE id = %s",
                        (first["id"],))
            row = cur.fetchone()
        conn.commit()
    assert restored["duplicate"] is False
    assert row["tournament_id"] == a["id"]
    assert row["deleted_at"] is None


def test_list_valued_to_address_routes(monkeypatch):
    """A JSON 'to' list picks the first address instead of stringifying it."""
    from app.email_ingest import payload_from_mapping

    p = payload_from_mapping({"to": ["B <b@x.com>", "c@y.com"]})
    assert p.to_address == "B <b@x.com>"


def test_sendgrid_headers_block_supplies_the_message_id():
    """SendGrid posts raw RFC822 headers; Message-Id comes from that block."""
    from app.email_ingest import payload_from_mapping

    p = payload_from_mapping({
        "to": "macon@inbox.example.com",
        "subject": "Late entry",
        "text": "Can we still register?",
        "headers": "MIME-Version: 1.0\r\nMessage-Id: <sg-1@sendgrid.net>\r\nSubject: Late entry",
    })
    assert p.message_id == "sg-1@sendgrid.net"


def test_bad_tournament_id_is_rejected_not_dropped():
    """A non-numeric id on either endpoint is a 400, not a silent default."""
    for path, kwargs in (
        ("/api/ingest/email", {"json": {
            "message_id": f"<bad-{uuid.uuid4().hex}@example.com>",
            "from_address": "a@b.com", "subject": "Route me",
            "body": "body", "tournament_id": "macon2026"}}),
        ("/api/ingest/email/form", {"data": {
            "message_id": f"<bad-{uuid.uuid4().hex}@example.com>",
            "from": "a@b.com", "subject": "Route me",
            "text": "body", "tournament_id": "macon2026"}}),
    ):
        r = client.post(path, headers=_headers(), **kwargs)
        assert r.status_code in (400, 422), (path, r.status_code, r.text)
        if r.status_code == 400:
            assert "tournament_id" in r.text
