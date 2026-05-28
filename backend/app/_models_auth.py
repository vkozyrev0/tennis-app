"""Auth-related request bodies (audit A50)."""
from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    # Audit N22: cap lengths so a single request can't pin a CPU on pbkdf2.
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class AccountCreate(BaseModel):
    username: str
    password: str
