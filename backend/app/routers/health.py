from fastapi import APIRouter

from ..db import get_conn
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
