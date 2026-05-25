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
class PlayerCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
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
    player_id: int
    age_division: Optional[str] = None
    events: Optional[str] = None
    selection_status: SelectionStatus = "selected"
    t_shirt_size: Optional[str] = None
    dietary_preference: Optional[str] = None


class RosterEntryOut(RosterEntryCreate):
    id: int
    tournament_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None


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
    hotel_name: Optional[str] = None
    lodging_plan: Optional[str] = None
    source_email_id: Optional[int] = None


class TShirtRow(BaseModel):
    player_id: int
    usta_number: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    age_division: Optional[str] = None
    tournament_id: int
    tournament_name: Optional[str] = None
    t_shirt_size: Optional[str] = None


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
