"""Auth-related request bodies (audit A50)."""
from datetime import datetime

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    # Audit N22: cap lengths so a single request can't pin a CPU on pbkdf2.
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class AccountCreate(BaseModel):
    username: str
    password: str


# --- Multi-user TD access (D8): admin account management ---
class AdminUserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    # H4.2: new admins default to NO full PII export (least privilege for
    # secondary TDs). Seed/primary admin keeps can_export_pii=true via DEFAULT.
    can_export_pii: bool = False


class AdminUserPatch(BaseModel):
    """Toggle export permission (and later other admin flags)."""
    can_export_pii: bool | None = None


class PasswordReset(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class PasswordChange(BaseModel):
    """Self-service change: prove the current password, then set a new one.
    The new password has a real minimum (the admin reset path allows 1 because
    it's a deliberate operator action; self-service should not weaken it)."""
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=256)


class AdminUserOut(BaseModel):
    id: int
    username: str
    role: str
    can_export_pii: bool = True
    created_at: datetime
