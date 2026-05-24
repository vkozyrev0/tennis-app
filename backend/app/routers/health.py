from fastapi import APIRouter

from ..db import get_conn

router = APIRouter(tags=["health"])


@router.get("/api/health")
def health():
    info = {"status": "ok", "db": "down"}
    try:
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            info["db"] = "ok"
        finally:
            conn.close()
    except Exception as e:  # pragma: no cover - exercised when DB is down
        info["status"] = "degraded"
        info["error"] = str(e)
    return info
