"""Pydantic request/response models — re-exported from per-domain sub-modules.

Audit A50: the original single-file `models.py` had grown to ~600 lines. It is
now a thin façade re-exporting from:

- `_models_common`    — shared Literals (Gender, TournamentType, CertType, …)
- `_models_setup`     — site / tournament / official / player / hotel /
                        rate / distance / division / event catalog rows
- `_models_workspace` — roster / assignment / availability / t-shirt
- `_models_inbox`     — Part B email-filed requests (late entries, withdrawals,
                        doubles, pairings, player hotels, scheduling, divflex)
- `_models_auth`      — login + account-create bodies

External callers continue to use `from app.models import X` unchanged.
"""

from ._models_common import (  # noqa: F401
    CertType,
    EmailStatus,
    Gender,
    SelectionStatus,
    TournamentType,
)
from ._models_setup import (  # noqa: F401
    CertificationRateCreate,
    CertificationRateOut,
    DistanceAuto,
    DistanceCreate,
    DistanceOut,
    DivisionCreate,
    DivisionOut,
    HotelCreate,
    HotelOut,
    OfficialCreate,
    OfficialOut,
    PlayerCreate,
    PlayerHistoryOut,
    PlayerOut,
    RoomBlockCreate,
    RoomBlockOut,
    SiteCreate,
    SiteIds,
    SiteOut,
    StaffCreate,
    StaffOut,
    TournamentCreate,
    TournamentEventCreate,
    TournamentEventOut,
    TournamentOut,
)
from ._models_workspace import (  # noqa: F401
    AssignmentBulkCreate,
    AssignmentDayStatus,
    RosterSignIn,
    AssignmentCreate,
    AssignmentDayCreate,
    CoverageFillCreate,
    AssignmentResponse,
    AvailabilityOut,
    AvailabilitySet,
    CertificationCreate,
    CertificationOut,
    MyAvailabilitySet,
    RosterEntryCreate,
    RosterEntryOut,
    TShirtInventoryUpdate,
    TShirtOrderOut,
    TShirtOrderRow,
    TShirtRow,
)
from ._models_inbox import (  # noqa: F401
    EmailAmend,
    DivFlexCreate,
    DivFlexOut,
    DivFlexUpdate,
    DoublesPairOut,
    DoublesPairUpdate,
    DoublesRequestCreate,
    DoublesRequestOut,
    DoublesRequestUpdate,
    EmailBulkClassify,
    EmailBulkDetect,
    EmailBulkPopulate,
    EmailBulkReassign,
    EmailCreate,
    EmailDetectResult,
    EmailOut,
    EmailUpdate,
    LateEntryCreate,
    LateEntryOut,
    LateEntryUpdate,
    PairingAvoidanceCreate,
    PairingAvoidanceOut,
    PairingAvoidanceUpdate,
    PairingMemberIn,
    PairingMemberOut,
    PlayerHotelCreate,
    PlayerHotelOut,
    PlayerHotelUpdate,
    SchedAvoidCreate,
    SchedAvoidOut,
    SchedAvoidUpdate,
    WithdrawalCreate,
    WithdrawalOut,
    WithdrawalUpdate,
)
from ._models_auth import (  # noqa: F401
    AccountCreate,
    AdminUserCreate,
    AdminUserOut,
    LoginIn,
    PasswordChange,
    PasswordReset,
)
