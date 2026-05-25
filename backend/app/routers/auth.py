"""Login / logout / me — cookie-session auth (POC)."""
import secrets

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response

from ..db import db_dep
from ..models import LoginIn
from ..security import COOKIE_NAME, get_current_user, verify_pw

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: LoginIn, response: Response, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, username, password_hash, role, official_id "
            "FROM user_account WHERE username = %s",
            (body.username,),
        )
        user = cur.fetchone()
        if user is None or not verify_pw(body.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="invalid username or password")
        token = secrets.token_urlsafe(32)
        cur.execute(
            "INSERT INTO session (token, user_id) VALUES (%s, %s)", (token, user["id"])
        )
    response.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax", path="/")
    return {"username": user["username"], "role": user["role"], "official_id": user["official_id"]}


@router.post("/logout")
def logout(response: Response, sid: str | None = Cookie(default=None), conn=Depends(db_dep)):
    if sid:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM session WHERE token = %s", (sid,))
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(user=Depends(get_current_user)):
    return {"username": user["username"], "role": user["role"], "official_id": user["official_id"]}
