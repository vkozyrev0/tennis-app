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


class PasswordReset(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class AdminUserOut(BaseModel):
    id: int
    username: str
    role: str
    created_at: datetime
