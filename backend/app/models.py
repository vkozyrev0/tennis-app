"""Pydantic request/response models for the API."""
from datetime import date
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


class PlayerOut(PlayerCreate):
    id: int


# ---------- Certification rate ----------
CertType = Literal["roving", "chair", "referee"]


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
