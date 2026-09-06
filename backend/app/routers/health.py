from fastapi import APIRouter

from ..shirtops import SHIRT_LABELS

router = APIRouter(tags=["health"])


# Audit M28/M29: single endpoint exposing the canonical enums so the frontend
# can populate selects from one source. The values mirror Pydantic Literals
# in models.py + the shirt label list in shirtops.py.
@router.get("/api/enums")
def enums():
    return {
        "gender": ["male", "female"],
        "tournament_type": ["junior", "adult"],
        "selection_status": ["selected", "alternate", "withdrawn"],
        "cert_type": [
            {"value": "roving_official", "label": "Roving official"},
            {"value": "chair_umpire", "label": "Chair umpire"},
            {"value": "tournament_referee", "label": "Tournament referee"},
            {"value": "deputy_referee", "label": "Deputy referee"},
            {"value": "referee_in_training", "label": "Referee in training"},
        ],
        "shirt_sizes": SHIRT_LABELS,
    }


@router.get("/api/health")
def health():
    from ..email_llm import probe_llm
    from ..config import settings
    import psycopg
    from psycopg.rows import dict_row
    info = {"status": "ok", "db": "down", "llm": "off"}
    try:
        info["llm"] = probe_llm(timeout=1.0)
    except Exception:
        info["llm"] = "down"
    try:
        conn = psycopg.connect(
            settings.dsn, row_factory=dict_row, connect_timeout=2,
        )
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


@router.get("/api/health/llm")
def llm_health():
    """Sidecar-only probe (same values as ``GET /api/health`` ``llm``)."""
    from ..email_llm import probe_llm
    return {"status": probe_llm()}
