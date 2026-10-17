"""Route-wide auth matrix: every admin GET without a path parameter must refuse
an anonymous caller. Catches a router that is accidentally mounted outside the
admin dependency loop in app/main.py.

No DB needed for the 401 path, but the app import and other modules assume the
test DB is present; skip cleanly when it is not.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    client.get("/api/health").json().get("db") != "ok",
    reason="Postgres not reachable / not migrated (run migrate.py)",
)

# Open by design: health + canonical enums, login/logout/me, and the
# token-gated ingest webhook.
_OPEN = ("/api/health", "/api/enums", "/api/auth", "/api/me", "/api/ingest")


def _is_open(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in _OPEN)


# The app mounts routers through a wrapper, so enumerate the OpenAPI paths.
ADMIN_GETS = sorted(
    path for path, ops in app.openapi().get("paths", {}).items()
    if "get" in ops
    and path.startswith("/api/")
    and "{" not in path
    and not _is_open(path)
)


@pytest.mark.parametrize("path", ADMIN_GETS)
def test_admin_get_requires_a_session(path):
    r = client.get(path)
    assert r.status_code in (401, 403), f"{path} answered {r.status_code} anonymously"
