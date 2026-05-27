"""Shared Literal types referenced across model domains (audit A50).

Pulled out so the per-domain model files don't have to re-declare them; they
also can't easily live in any one domain (CertType is used by rates AND by
assignments; Gender is used by player AND roster AND division).
"""
from typing import Literal

Gender = Literal["male", "female"]
TournamentType = Literal["junior", "adult"]
CertType = Literal[
    "roving_official",
    "chair_umpire",
    "tournament_referee",
    "deputy_referee",
    "referee_in_training",
]
SelectionStatus = Literal["selected", "alternate", "withdrawn"]
EmailStatus = Literal["new", "filed", "needs_followup"]
