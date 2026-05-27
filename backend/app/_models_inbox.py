"""Part B (inbox-filed) models: email, late entry, withdrawal, doubles,
pairing avoidance, player hotel, scheduling avoidance, division flex
(audit A50)."""
from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, model_validator

from ._models_common import EmailStatus


# ---------- Email inbox ----------
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


# ---------- Late entry ----------
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
    past_deadline: bool = False


class LateEntryUpdate(BaseModel):
    age_division: Optional[str] = None
    events: Optional[str] = None
    request_date: Optional[date] = None
    request_time: Optional[str] = None


# ---------- Withdrawal ----------
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


# ---------- Doubles ----------
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
        # Audit F13: reject self-as-partner outright.
        if (self.partner_usta and self.usta_number
                and self.partner_usta.strip() == self.usta_number.strip()):
            raise ValueError("partner_usta must differ from the requester's own USTA #")
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


# ---------- Pairing avoidance ----------
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


# ---------- Player hotel ----------
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


# ---------- Scheduling avoidance ----------
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


# ---------- Division flexibility ----------
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
