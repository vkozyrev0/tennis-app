"""Security headers (audit D17) — pure unit tests; no Postgres / full app import."""
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.security_headers import (
    DEFAULT_CSP,
    build_security_headers,
    content_security_policy,
    hsts_enabled,
    security_headers_enabled,
)


def test_build_headers_baseline_no_hsts_in_dev():
    h = build_security_headers(is_prod=False)
    assert h["Content-Security-Policy"] == DEFAULT_CSP
    assert h["X-Content-Type-Options"] == "nosniff"
    assert h["X-Frame-Options"] == "DENY"
    assert h["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "camera=()" in h["Permissions-Policy"]
    assert h["Cross-Origin-Opener-Policy"] == "same-origin"
    assert "Strict-Transport-Security" not in h


def test_build_headers_hsts_in_prod():
    h = build_security_headers(is_prod=True)
    assert h["Strict-Transport-Security"].startswith("max-age=")


def test_csp_override_and_disable(monkeypatch):
    monkeypatch.setenv("COURTOPS_CSP", "default-src 'none'")
    assert content_security_policy() == "default-src 'none'"
    monkeypatch.setenv("COURTOPS_SECURITY_HEADERS", "0")
    assert security_headers_enabled() is False
    monkeypatch.setenv("COURTOPS_SECURITY_HEADERS", "1")
    assert security_headers_enabled() is True


def test_hsts_env_override(monkeypatch):
    monkeypatch.setenv("COURTOPS_HSTS", "1")
    assert hsts_enabled(is_prod=False) is True
    monkeypatch.setenv("COURTOPS_HSTS", "0")
    assert hsts_enabled(is_prod=True) is False


def test_middleware_pattern_attaches_headers():
    """Mirror main.py middleware on a tiny app (no DB, no full CourtOps import)."""
    mini = FastAPI()

    @mini.middleware("http")
    async def _sec(request: Request, call_next):
        response = await call_next(request)
        if security_headers_enabled():
            for name, value in build_security_headers(is_prod=False).items():
                if name not in response.headers:
                    response.headers[name] = value
        return response

    @mini.get("/ping")
    def ping():
        return {"ok": True}

    r = TestClient(mini).get("/ping")
    assert r.status_code == 200
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    csp = r.headers.get("Content-Security-Policy", "")
    assert "default-src 'self'" in csp
    assert "script-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp


def test_csp_allows_inline_styles_not_inline_scripts():
    csp = DEFAULT_CSP
    assert "style-src 'self' 'unsafe-inline'" in csp
    assert "script-src 'self'" in csp
    assert "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]
