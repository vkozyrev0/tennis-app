"""Setup-tab catalog models: site/tournament/official/player/hotel/rate/distance,
plus the configurable division + event catalogs (audit A50)."""
from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

from ._models_common import CertType, Gender, TournamentType


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


class SiteIds(BaseModel):
    site_ids: list[int] = []


# ---------- Tournament ----------
class TournamentCreate(BaseModel):
    name: str
    type: Literal["junior", "adult"]
    play_start_date: date
    play_end_date: date
    registration_deadline: Optional[date] = None
    late_entry_deadline: Optional[date] = None
    # Email auto-ingest routing key (D4): local-part or full address matched
    # against the inbound To: header. Null = not auto-routed by address.
    ingest_address: Optional[str] = None

    @model_validator(mode="after")
    def _dates_ok(self):
        if self.play_end_date < self.play_start_date:
            raise ValueError("play_end_date must be on or after play_start_date")
        return self


class TournamentOut(TournamentCreate):
    id: int


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


# ---------- Division + Event catalog ----------
class DivisionCreate(BaseModel):
    code: str
    label: str
    tournament_type: TournamentType
    gender: Optional[Gender] = None
    sort_order: int = 0


class DivisionOut(DivisionCreate):
    id: int


class TournamentEventCreate(BaseModel):
    name: str
    tournament_type: TournamentType
    gender: Optional[Gender] = None
    sort_order: int = 0


class TournamentEventOut(TournamentEventCreate):
    id: int


# ---------- Player ----------
class PlayerCreate(BaseModel):
    usta_number: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    gender: Gender  # required — drives the division/event picker
    # Optional at the API boundary: inline-create from roster + inbox upserts
    # don't have a DOB yet (audit N3). The Setup-page form keeps `required` in
    # HTML so a TD entering a fresh player still has to supply one.
    birthdate: Optional[date] = None
    city: Optional[str] = None
    state: Optional[str] = None
    # B2a (migration 0028) — extended catalog fields from the USTA
    # "Full Player Data" export. All optional and NULLable so the existing
    # /api/players POST/PUT flows keep working.
    birthdate_precision: Optional[str] = None
    district: Optional[str] = None
    section: Optional[str] = None
    emails: Optional[str] = None
    phones: Optional[str] = None
    wtn_singles: Optional[float] = None
    wtn_singles_conf: Optional[str] = None
    wtn_doubles: Optional[float] = None
    wtn_doubles_conf: Optional[str] = None


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
    rooms_remaining: Optional[int] = None


# ---------- Official <-> Site distance ----------
class DistanceCreate(BaseModel):
    official_id: int
    site_id: int
    one_way_miles: float = Field(ge=0, le=1000)
    # 'maps' = authoritative Google driving distance; 'geocoded' = great-circle
    # estimate fallback; 'manual' = TD-entered. (migration 0047 added 'maps'.)
    source: Literal["geocoded", "manual", "maps"] = "manual"


class DistanceOut(DistanceCreate):
    id: int


class DistanceAuto(BaseModel):
    """Request to estimate a distance from stored coordinates (auto-mileage)."""
    official_id: int
    site_id: int


# ---------- Non-official tournament staff ----------
StaffRole = Literal[
    "site_director", "player_amenities", "trainer", "operations", "stringer", "other"
]


class StaffCreate(BaseModel):
    name: str
    role: StaffRole
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    # Flat daily pay rate; report pay = daily_rate × number of scheduled days.
    daily_rate: Optional[float] = Field(default=None, ge=0, le=10000)
    # Optional per-day schedule (the days this person works). When provided on
    # create/update it REPLACES the staff member's existing days.
    days: Optional[list[date]] = None


class StaffOut(StaffCreate):
    id: int
    tournament_id: int
    days: list[date] = []
