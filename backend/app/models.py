"""Pydantic request/response models for the API."""
from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


# ---------- Site ----------
class SiteCreate(BaseModel):
    code: Optional[str] = None
    name: str
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


class SiteOut(SiteCreate):
    id: int


# ---------- Tournament ----------
class TournamentCreate(BaseModel):
    name: str
    type: Literal["junior", "adult"]
    play_start_date: date
    play_end_date: date
    registration_deadline: Optional[date] = None
    late_entry_deadline: Optional[date] = None

    @model_validator(mode="after")
    def _dates_ok(self):
        if self.play_end_date < self.play_start_date:
            raise ValueError("play_end_date must be on or after play_start_date")
        return self


class TournamentOut(TournamentCreate):
    id: int


class SiteIds(BaseModel):
    site_ids: list[int] = []


# ---------- Official ----------
class OfficialCreate(BaseModel):
    first_name: str
    last_name: str
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    dietary_restrictions: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


class OfficialOut(OfficialCreate):
    id: int


# ---------- Player ----------
Gender = Literal["male", "female"]


class PlayerCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    gender: Optional[Gender] = None
    birthdate: Optional[date] = None
    city: Optional[str] = None
    state: Optional[str] = None


class PlayerOut(PlayerCreate):
    id: int
    updated_at: Optional[datetime] = None


class PlayerHistoryOut(BaseModel):
    id: int
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    birthdate: Optional[date] = None
    valid_from: datetime
    valid_to: datetime
    change_type: str


# ---------- Certification rate ----------
CertType = Literal[
    "roving_official",
    "chair_umpire",
    "tournament_referee",
    "deputy_referee",
    "referee_in_training",
]


class CertificationRateCreate(BaseModel):
    cert_type: CertType
    rate_per_day: float = Field(ge=0)
    effective_from: date = Field(default_factory=date.today)


class CertificationRateOut(CertificationRateCreate):
    id: int


# ---------- Hotel (property) ----------
class HotelCreate(BaseModel):
    name: str
    website: Optional[str] = None
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    phone: Optional[str] = None


class HotelOut(HotelCreate):
    id: int


# ---------- Room block (inventory at a hotel) ----------
class RoomBlockCreate(BaseModel):
    hotel_id: int
    tournament_id: Optional[int] = None
    kind: Literal["player", "official"] = "player"
    confirmation_number: Optional[str] = None
    cancellation_info: Optional[str] = None
    check_in: Optional[date] = None
    check_out: Optional[date] = None
    room_count: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def _dates_ok(self):
        if self.check_in and self.check_out and self.check_out < self.check_in:
            raise ValueError("check_out must be on or after check_in")
        return self


class RoomBlockOut(RoomBlockCreate):
    id: int
    rooms_remaining: Optional[int] = None  # room_count - assignments using it


# ---------- Official <-> Site distance ----------
class DistanceCreate(BaseModel):
    official_id: int
    site_id: int
    one_way_miles: float = Field(ge=0)
    source: Literal["geocoded", "manual"] = "manual"


class DistanceOut(DistanceCreate):
    id: int


# ---------- Roster (tournament_entry) ----------
SelectionStatus = Literal["selected", "alternate", "withdrawn"]


class RosterEntryCreate(BaseModel):
    # Either an existing player_id OR a usta_number (with optional first/last
    # names + gender) — the handler upserts the player when player_id is
    # omitted, so a TD can add a walk-in player without first creating them
    # in Setup.
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

    @model_validator(mode="after")
    def _id_or_usta(self):
        if self.player_id is None and not (self.usta_number and self.usta_number.strip()):
            raise ValueError("either player_id or usta_number is required")
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


# ---------- Assignment ----------
class AssignmentCreate(BaseModel):
    official_id: int
    site_id: Optional[int] = None
    room_block_id: Optional[int] = None


class AssignmentDayCreate(BaseModel):
    work_date: date
    working_as: CertType


# ---------- Official certifications ----------
class CertificationCreate(BaseModel):
    cert_type: CertType


class CertificationOut(BaseModel):
    id: int
    official_id: int
    cert_type: CertType


# ---------- Part B: email inbox + late entries ----------
EmailStatus = Literal["new", "filed", "needs_followup"]


class EmailCreate(BaseModel):
    tournament_id: Optional[int] = None
    message_id: Optional[str] = None
    from_address: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None


class EmailUpdate(BaseModel):
    tournament_id: Optional[int] = None
    classification: str = "unclassified"
    status: EmailStatus = "new"


class EmailOut(BaseModel):
    id: int
    tournament_id: Optional[int] = None
    message_id: Optional[str] = None
    received_at: datetime
    from_address: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    classification: str
    status: EmailStatus


class LateEntryCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    events: Optional[str] = None
    request_date: Optional[date] = None
    request_time: Optional[str] = None
    source_email_id: Optional[int] = None


class LateEntryOut(BaseModel):
    id: int
    tournament_id: int
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    events: Optional[str] = None
    request_date: Optional[date] = None
    request_time: Optional[str] = None
    source_email_id: Optional[int] = None
    past_deadline: bool = False  # request_date after the tournament's late-entry deadline


class LateEntryUpdate(BaseModel):
    age_division: Optional[str] = None
    events: Optional[str] = None
    request_date: Optional[date] = None
    request_time: Optional[str] = None


class WithdrawalCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    events: Optional[str] = None
    reason: Optional[str] = None
    notes: Optional[str] = None
    source_email_id: Optional[int] = None


class WithdrawalOut(BaseModel):
    id: int
    tournament_id: int
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    events: Optional[str] = None
    reason: Optional[str] = None
    notes: Optional[str] = None
    was_alternate: bool = False
    source_email_id: Optional[int] = None


class WithdrawalUpdate(BaseModel):
    events: Optional[str] = None
    reason: Optional[str] = None
    notes: Optional[str] = None


class DoublesRequestCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    wants_random: bool = False
    partner_usta: Optional[str] = None
    source_email_id: Optional[int] = None

    @model_validator(mode="after")
    def _partner_or_random(self):
        if not self.wants_random and not (self.partner_usta and self.partner_usta.strip()):
            raise ValueError("a mutual request needs a partner USTA number (or set wants_random)")
        return self


class DoublesRequestUpdate(BaseModel):
    age_division: Optional[str] = None


class DoublesPairUpdate(BaseModel):
    age_division: Optional[str] = None


class DoublesRequestOut(BaseModel):
    id: int
    tournament_id: int
    age_division: Optional[str] = None
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    partner_usta: Optional[str] = None
    wants_random: bool
    status: str
    source_email_id: Optional[int] = None


class DoublesPairOut(BaseModel):
    id: int
    tournament_id: int
    age_division: Optional[str] = None
    pairing_type: str
    verified: bool
    player1_id: int
    player2_id: int
    player1: Optional[str] = None
    player2: Optional[str] = None


class PairingMemberIn(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None


class PairingAvoidanceUpdate(BaseModel):
    age_division: Optional[str] = None
    relationship: Optional[Literal["same_club", "siblings"]] = None


class PairingAvoidanceCreate(BaseModel):
    age_division: Optional[str] = None
    relationship: Optional[Literal["same_club", "siblings"]] = None
    members: list[PairingMemberIn] = []
    source_email_id: Optional[int] = None

    @model_validator(mode="after")
    def _two_members(self):
        if len(self.members) < 2:
            raise ValueError("a pairing avoidance needs at least two players")
        return self


class PairingMemberOut(BaseModel):
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None


class PairingAvoidanceOut(BaseModel):
    id: int
    tournament_id: int
    age_division: Optional[str] = None
    relationship: Optional[str] = None
    source_email_id: Optional[int] = None
    members: list[PairingMemberOut] = []


class PlayerHotelCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    hotel_name: Optional[str] = None
    lodging_plan: Optional[str] = None
    source_email_id: Optional[int] = None


class PlayerHotelOut(BaseModel):
    id: int
    tournament_id: int
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    hotel_id: Optional[int] = None
    hotel_name: Optional[str] = None
    lodging_plan: Optional[str] = None
    source_email_id: Optional[int] = None


class PlayerHotelUpdate(BaseModel):
    hotel_name: Optional[str] = None
    lodging_plan: Optional[str] = None


class TShirtRow(BaseModel):
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    tournament_id: int
    tournament_name: Optional[str] = None
    t_shirt_size: Optional[str] = None


# T-shirt order tracking — one row per tournament (see migration 0024). The
# on_hand / snapshot dicts are size-code → count, sized in the canonical order
# YS, YM, YL, AS, AM, AL, AXL on the way out.
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
    totals: dict  # { requested, on_hand, to_order, snapshot? }


class TShirtInventoryUpdate(BaseModel):
    # Sparse map: only the sizes the TD edited are present; missing sizes
    # keep their current value.
    on_hand: dict[str, int] = {}


class SchedAvoidUpdate(BaseModel):
    avoid_day: Optional[str] = None
    avoid_time_range: Optional[str] = None


class SchedAvoidCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    avoid_day: Optional[str] = None
    avoid_time_range: Optional[str] = None
    source_email_id: Optional[int] = None


class SchedAvoidOut(BaseModel):
    id: int
    tournament_id: int
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    avoid_day: Optional[str] = None
    avoid_time_range: Optional[str] = None
    source_email_id: Optional[int] = None


class DivFlexUpdate(BaseModel):
    home_division: Optional[str] = None
    willing_divisions: Optional[str] = None


class DivFlexCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    home_division: Optional[str] = None
    willing_divisions: Optional[str] = None
    source_email_id: Optional[int] = None


class DivFlexOut(BaseModel):
    id: int
    tournament_id: int
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    home_division: Optional[str] = None
    willing_divisions: Optional[str] = None
    source_email_id: Optional[int] = None


# ---------- Auth ----------
class LoginIn(BaseModel):
    username: str
    password: str


class AccountCreate(BaseModel):
    username: str
    password: str


class MyAvailabilitySet(BaseModel):
    dates: list[date] = []
    hotel_needed: bool = False


# ---------- Availability ----------
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
