"""Tournament-workspace operations: roster, assignment, certification,
availability, t-shirt order (audit A50)."""
from datetime import date
from typing import Literal, Optional

from pydantic import BaseModel, model_validator

from ._models_common import CertType, Gender, SelectionStatus


# ---------- Roster (tournament_entry) ----------
class RosterEntryCreate(BaseModel):
    # Either an existing player_id OR a usta_number (with optional first/last
    # names + gender) — the handler upserts the player when player_id is
    # omitted, so a TD can add a walk-in player without first creating them.
    player_id: Optional[int] = None
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    gender: Optional[Gender] = None
    age_division: Optional[str] = None
    events: Optional[str] = None
    selection_status: SelectionStatus = "selected"
    t_shirt_size: Optional[str] = None
    dietary_preference: Optional[str] = None
    # B3 — lodging plan editable from the roster grid so a TD can upgrade a
    # raw free-text answer into a canonical bucket without re-importing.
    lodging_plan: Optional[str] = None

    @model_validator(mode="after")
    def _id_or_usta(self):
        if self.player_id is None:
            if not (self.usta_number and self.usta_number.strip()):
                raise ValueError("either player_id or usta_number is required")
            if self.gender is None:
                raise ValueError("gender is required when creating a new player")
        return self


class RosterEntryOut(BaseModel):
    id: int
    tournament_id: int
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    events: Optional[str] = None
    selection_status: SelectionStatus = "selected"
    t_shirt_size: Optional[str] = None
    dietary_preference: Optional[str] = None
    # B2a (migration 0028) — payment snapshot from Full Player Data import.
    payment_status: Optional[str] = None
    amount_paid: Optional[float] = None
    amount_refunded: Optional[float] = None
    amount_due: Optional[float] = None
    amount_outstanding: Optional[float] = None
    card_stored: Optional[bool] = None
    # B2b — populated by the Correction-status importer.
    signed_in: Optional[bool] = None
    suspension_points: Optional[int] = None
    # B3 combined-import lodging fields. lodging_plan is the canonical value
    # (one of "Hotel" / "Local / family" / "Commuter" variants); lodging_plan_raw
    # holds the original free-text answer when it didn't match the mapping
    # table — surfaced so the TD can triage on the player-hotels grid.
    lodging_plan: Optional[str] = None
    lodging_plan_raw: Optional[str] = None


# ---------- Assignment ----------
class AssignmentCreate(BaseModel):
    official_id: int
    site_id: Optional[int] = None
    room_block_id: Optional[int] = None


class AssignmentBulkCreate(BaseModel):
    """Invite several officials to a tournament at once — one pending assignment
    each. site_id/room_block_id are optional defaults applied to all."""
    official_ids: list[int]
    site_id: Optional[int] = None
    room_block_id: Optional[int] = None


class AssignmentDayCreate(BaseModel):
    work_date: date
    working_as: CertType


class AssignmentResponse(BaseModel):
    """An official accepting or declining their assignment (self-service)."""
    status: Literal["accepted", "declined", "pending"]


# ---------- Official certifications ----------
class CertificationCreate(BaseModel):
    cert_type: CertType


class CertificationOut(BaseModel):
    id: int
    official_id: int
    cert_type: CertType


# ---------- Availability ----------
class MyAvailabilitySet(BaseModel):
    dates: list[date] = []
    hotel_needed: bool = False


class AvailabilityOut(BaseModel):
    id: int
    official_id: int
    tournament_id: int
    available_date: date
    hotel_needed: bool = False


class AvailabilitySet(BaseModel):
    official_id: int
    dates: list[date] = []
    hotel_needed: bool = False


# ---------- T-shirts ----------
class TShirtRow(BaseModel):
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    tournament_id: int
    tournament_name: Optional[str] = None
    t_shirt_size: Optional[str] = None


# T-shirt order tracking — one row per tournament (see migration 0024).
class TShirtOrderRow(BaseModel):
    size: str
    label: str
    requested: int = 0      # live count from selected players right now
    on_hand: int = 0        # current inventory the TD entered
    to_order: int = 0       # max(0, requested - on_hand)
    snapshot: Optional[int] = None  # what was needed when the order was placed


class TShirtOrderOut(BaseModel):
    tournament_id: int
    ordered_at: Optional[date] = None
    rows: list[TShirtOrderRow]
    totals: dict


class TShirtInventoryUpdate(BaseModel):
    # Sparse map: only the sizes the TD edited are present; missing sizes
    # keep their current value.
    on_hand: dict[str, int] = {}
