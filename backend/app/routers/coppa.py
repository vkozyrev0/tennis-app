"""COPPA / minors-PII policy surface (audit D16).

`GET /api/coppa/policy` — machine-readable written policy + under-13 gate state.
Admin-only (included with the other TD routers).
"""
from fastapi import APIRouter

from ..coppa import policy

router = APIRouter(prefix="/api/coppa", tags=["coppa"])


@router.get("/policy")
def get_coppa_policy():
    return policy()
