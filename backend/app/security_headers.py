"""HTTP security headers (audit D17).

Applied on every response by middleware in ``main.py``. Caddy/TLS terminator
can still set HSTS; the app sets a baseline CSP + framing / MIME / referrer
protections so bare uvicorn / Docker demos are not headerless.

CSP notes for this SPA:
- Scripts are same-origin only (``/app.js``, ``/vendor/ag-grid-…``).
- Many ``style=`` attributes and dynamic style strings need ``'unsafe-inline'``
  for styles (not scripts).
- Favicon is a ``data:`` SVG; print/blob paths use ``blob:`` for images.
- No third-party CDNs in the default shell.
"""
from __future__ import annotations

import os

# Tight default for a same-origin admin SPA + static frontend.
DEFAULT_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'; "
    "form-action 'self'"
)


def security_headers_enabled() -> bool:
    """COURTOPS_SECURITY_HEADERS=0 disables the middleware (debug only)."""
    raw = os.getenv("COURTOPS_SECURITY_HEADERS", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def hsts_enabled(*, is_prod: bool) -> bool:
    """HSTS only when opted in or ENV is prod (TLS terminator expected)."""
    raw = os.getenv("COURTOPS_HSTS", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return is_prod


def content_security_policy() -> str:
    override = os.getenv("COURTOPS_CSP", "").strip()
    return override or DEFAULT_CSP


def build_security_headers(*, is_prod: bool = False) -> dict[str, str]:
    """Return header name → value for one response."""
    headers = {
        "Content-Security-Policy": content_security_policy(),
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Cross-Origin-Opener-Policy": "same-origin",
    }
    if hsts_enabled(is_prod=is_prod):
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return headers
