"""Player-reported hotel stays + CVB room-night analytics (audit §1.2).
Also the cumulative cross-tournament t-shirt list (derived from tournament_entry)."""
from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import db_dep
import json
from ..models import (
    PlayerHotelCreate,
    PlayerHotelOut,
    PlayerHotelUpdate,
    TShirtInventoryUpdate,
    TShirtOrderOut,
    TShirtRow,
)
from ..playerops import mark_email_filed, upsert_hotel, upsert_player

router = APIRouter(tags=["player-ops"])

_PH = """
SELECT s.id, s.tournament_id, s.player_id, s.hotel_id, s.hotel_name, s.lodging_plan,
       s.source_email_id, p.usta_number, p.first_name, p.last_name,
       te.age_division
FROM player_hotel_stay s
JOIN player p ON p.id = s.player_id
LEFT JOIN tournament_entry te
       ON te.tournament_id = s.tournament_id AND te.player_id = s.player_id
"""


@router.get("/api/tournaments/{tournament_id}/player-hotels", response_model=list[PlayerHotelOut])
def list_player_hotels(tournament_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute(_PH + " WHERE s.tournament_id = %s ORDER BY s.id", (tournament_id,))
        return cur.fetchall()


@router.post("/api/tournaments/{tournament_id}/player-hotels",
             response_model=PlayerHotelOut, status_code=201)
def create_player_hotel(tournament_id: int, body: PlayerHotelCreate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        pid = upsert_player(cur, body.usta_number, body.first_name, body.last_name, body.gender)
        # One canonical hotel row per name (case-insensitive) — FK keeps names consistent.
        hid, hname = upsert_hotel(cur, body.hotel_name)
        lodging = " ".join((body.lodging_plan or "").split()) or None
        cur.execute(
            "INSERT INTO player_hotel_stay (tournament_id, player_id, hotel_id, hotel_name, lodging_plan, source_email_id) "
            "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
            (tournament_id, pid, hid, hname, lodging, body.source_email_id),
        )
        new_id = cur.fetchone()["id"]
        mark_email_filed(cur, body.source_email_id, "hotel")
        cur.execute(_PH + " WHERE s.id = %s", (new_id,))
        return cur.fetchone()


@router.put("/api/player-hotels/{row_id}", response_model=PlayerHotelOut)
def update_player_hotel(row_id: int, body: PlayerHotelUpdate, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM player_hotel_stay WHERE id = %s", (row_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="not found")
        # Keep the hotel name canonical/consistent via the Hotels table (FK).
        hid, hname = upsert_hotel(cur, body.hotel_name)
        lodging = " ".join((body.lodging_plan or "").split()) or None
        cur.execute(
            "UPDATE player_hotel_stay SET hotel_id = %s, hotel_name = %s, lodging_plan = %s WHERE id = %s",
            (hid, hname, lodging, row_id),
        )
        cur.execute(_PH + " WHERE s.id = %s", (row_id,))
        return cur.fetchone()


@router.delete("/api/player-hotels/{row_id}", status_code=204)
def delete_player_hotel(row_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM player_hotel_stay WHERE id = %s", (row_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


@router.get("/api/tournaments/{tournament_id}/hotel-summary")
def hotel_summary(tournament_id: int, conn=Depends(db_dep)):
    """Per-tournament: players per hotel (selected only, alphabetical, consistent).
    Audit F20: dropped the .format()-over-SQL pattern in favor of an inline
    query; the variant for cross-tournament analytics lives in hotel_analytics."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT min(TRIM(s.hotel_name)) AS hotel_name,
                   count(DISTINCT s.player_id) AS players
            FROM player_hotel_stay s
            JOIN tournament_entry e
              ON e.tournament_id = s.tournament_id AND e.player_id = s.player_id
            WHERE e.selection_status = 'selected'
              AND NULLIF(TRIM(s.hotel_name), '') IS NOT NULL
              AND s.tournament_id = %s
            GROUP BY lower(TRIM(s.hotel_name))
            ORDER BY lower(TRIM(s.hotel_name))
            """,
            (tournament_id,),
        )
        return cur.fetchall()


@router.get("/api/tournaments/{tournament_id}/lodging-summary")
def lodging_summary(tournament_id: int, conn=Depends(db_dep)):
    """Per-tournament: players per lodging plan (Hotel/Commuter/…), selected only."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT min(TRIM(s.lodging_plan)) AS lodging_plan,
                   count(DISTINCT s.player_id) AS players
            FROM player_hotel_stay s
            JOIN tournament_entry e
              ON e.tournament_id = s.tournament_id AND e.player_id = s.player_id
            WHERE s.tournament_id = %s AND e.selection_status = 'selected'
              AND NULLIF(TRIM(s.lodging_plan), '') IS NOT NULL
            GROUP BY lower(TRIM(s.lodging_plan))
            ORDER BY lower(TRIM(s.lodging_plan))
            """,
            (tournament_id,),
        )
        return cur.fetchall()


@router.get("/api/tournaments/{tournament_id}/hotel-confidential-report")
def hotel_confidential_report(tournament_id: int, conn=Depends(db_dep)):
    """Confidential per-hotel roster for the tournament: a summary pivot (hotel
    → players + officials counts), then a detail list of each person as
    "F. Last" (first initial + last name) per the TD's privacy requirement.
    Only selected players (no withdrawals/alternates); officials are pulled
    from their hotel assignment (assignment.room_block → hotel)."""
    with conn.cursor() as cur:
        # Selected players, grouped under their hotel (case-insensitive name).
        cur.execute(
            """
            SELECT TRIM(s.hotel_name) AS hotel_name, p.first_name, p.last_name
            FROM player_hotel_stay s
            JOIN player p ON p.id = s.player_id
            JOIN tournament_entry e
              ON e.tournament_id = s.tournament_id AND e.player_id = s.player_id
            WHERE s.tournament_id = %s
              AND e.selection_status = 'selected'
              AND NULLIF(TRIM(s.hotel_name), '') IS NOT NULL
            ORDER BY lower(TRIM(s.hotel_name)), p.last_name, p.first_name
            """,
            (tournament_id,),
        )
        players = cur.fetchall()
        # Officials whose hotel assignment points at a room_block in a hotel.
        cur.execute(
            """
            SELECT h.name AS hotel_name, o.first_name, o.last_name
            FROM assignment a
            JOIN room_block rb ON rb.id = a.room_block_id
            JOIN hotel h ON h.id = rb.hotel_id
            JOIN official o ON o.id = a.official_id
            WHERE a.tournament_id = %s
            ORDER BY h.name, o.last_name, o.first_name
            """,
            (tournament_id,),
        )
        officials = cur.fetchall()

        def initial_of(s):
            return (s[0] + ". ") if s else ""
        def fmt(row):
            return {"hotel_name": row["hotel_name"],
                    "name": initial_of(row["first_name"]) + (row["last_name"] or "—")}

        # Build the pivot.
        summary = {}
        for p in players:
            key = (p["hotel_name"] or "").strip()
            summary.setdefault(key, {"players": 0, "officials": 0})["players"] += 1
        for o in officials:
            key = (o["hotel_name"] or "").strip()
            summary.setdefault(key, {"players": 0, "officials": 0})["officials"] += 1
        summary_rows = sorted(
            [{"hotel_name": k, "players": v["players"], "officials": v["officials"],
              "total": v["players"] + v["officials"]} for k, v in summary.items()],
            key=lambda x: x["hotel_name"].lower(),
        )

        return {
            "tournament_id": tournament_id,
            "summary": summary_rows,
            "players": [fmt(p) for p in players],
            "officials": [fmt(o) for o in officials],
            "totals": {
                "players": len(players),
                "officials": len(officials),
                "total": len(players) + len(officials),
                "hotels": len(summary_rows),
            },
        }


@router.get("/api/hotel-analytics")
def hotel_analytics(conn=Depends(db_dep)):
    """Stays per hotel across all tournaments (for CVB negotiations) — selected
    players only, names consistent + alphabetical. Audit F1: each
    (player, tournament) is one *stay*, so a returning regular shows up once
    per tournament — not collapsed to a single player_id."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT min(TRIM(s.hotel_name)) AS hotel_name, count(*) AS stays
            FROM player_hotel_stay s
            JOIN tournament_entry e
              ON e.tournament_id = s.tournament_id AND e.player_id = s.player_id
            WHERE e.selection_status = 'selected'
              AND NULLIF(TRIM(s.hotel_name), '') IS NOT NULL
            GROUP BY lower(TRIM(s.hotel_name))
            ORDER BY lower(TRIM(s.hotel_name))
            """
        )
        return cur.fetchall()


# Canonical sizes in display order (smallest → largest) — used by the per-
# tournament order endpoint below.
_SIZE_ORDER = [
    ("YS", "Youth Small"), ("YM", "Youth Medium"), ("YL", "Youth Large"),
    ("AS", "Adult Small"), ("AM", "Adult Medium"), ("AL", "Adult Large"),
    ("AXL", "Adult Extra Large"),
]
_SIZE_LABEL_TO_CODE = {label: code for code, label in _SIZE_ORDER}


def _live_requested(cur, tournament_id: int) -> dict[str, int]:
    """Current per-size t-shirt counts from selected players, keyed by canonical
    size code (YS..AXL). Unknown sizes are bucketed under their literal text."""
    cur.execute(
        """
        SELECT e.t_shirt_size AS size, COUNT(*) AS n
        FROM tournament_entry e
        WHERE e.tournament_id = %s
          AND e.selection_status = 'selected'
          AND e.t_shirt_size IS NOT NULL AND e.t_shirt_size <> ''
        GROUP BY e.t_shirt_size
        """,
        (tournament_id,),
    )
    out: dict[str, int] = {}
    for row in cur.fetchall():
        code = _SIZE_LABEL_TO_CODE.get(row["size"], row["size"])
        out[code] = out.get(code, 0) + row["n"]
    return out


def _order_row(cur, tournament_id: int):
    cur.execute(
        "SELECT tournament_id, ordered_at, snapshot, on_hand FROM tshirt_order WHERE tournament_id = %s",
        (tournament_id,),
    )
    r = cur.fetchone()
    if r is None:
        # Insert a default row so subsequent updates can use UPSERT semantics.
        cur.execute(
            "INSERT INTO tshirt_order (tournament_id, on_hand) VALUES (%s, '{}'::jsonb) "
            "ON CONFLICT (tournament_id) DO NOTHING",
            (tournament_id,),
        )
        return {"tournament_id": tournament_id, "ordered_at": None, "snapshot": None, "on_hand": {}}
    return r


@router.get("/api/tournaments/{tournament_id}/tshirt-order", response_model=TShirtOrderOut)
def get_tshirt_order(tournament_id: int, conn=Depends(db_dep)):
    """Per-tournament t-shirt summary + inventory: a row per canonical size
    with the live requested count, on-hand inventory, computed to-order, and
    (after the order is placed) the requested snapshot at order time so the
    TD can compare the original order to the current need."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        order = _order_row(cur, tournament_id)
        live = _live_requested(cur, tournament_id)
        on_hand = order["on_hand"] or {}
        snap = order["snapshot"]
        rows = []
        tot = {"requested": 0, "on_hand": 0, "to_order": 0, "snapshot": 0 if snap else None}
        for code, label in _SIZE_ORDER:
            req = int(live.get(code, 0))
            oh = int(on_hand.get(code, 0))
            to = max(0, req - oh)
            snap_val = int(snap.get(code, 0)) if snap else None
            rows.append({"size": code, "label": label, "requested": req,
                          "on_hand": oh, "to_order": to, "snapshot": snap_val})
            tot["requested"] += req; tot["on_hand"] += oh; tot["to_order"] += to
            if snap is not None: tot["snapshot"] = (tot["snapshot"] or 0) + (snap_val or 0)
        return {"tournament_id": tournament_id, "ordered_at": order["ordered_at"],
                "rows": rows, "totals": tot}


@router.put("/api/tournaments/{tournament_id}/tshirt-inventory", response_model=TShirtOrderOut)
def put_tshirt_inventory(tournament_id: int, body: TShirtInventoryUpdate, conn=Depends(db_dep)):
    """Merge new on-hand counts into the inventory; missing sizes keep their
    current value, zero is allowed (and meaningful)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        order = _order_row(cur, tournament_id)
        on_hand = dict(order["on_hand"] or {})
        for k, v in (body.on_hand or {}).items():
            on_hand[k] = max(0, int(v))
        cur.execute(
            "INSERT INTO tshirt_order (tournament_id, on_hand, updated_at) "
            "VALUES (%s, %s::jsonb, now()) "
            "ON CONFLICT (tournament_id) DO UPDATE SET on_hand = EXCLUDED.on_hand, updated_at = now()",
            (tournament_id, json.dumps(on_hand)),
        )
    return get_tshirt_order(tournament_id, conn)


@router.post("/api/tournaments/{tournament_id}/tshirt-order", response_model=TShirtOrderOut)
def place_tshirt_order(tournament_id: int, conn=Depends(db_dep)):
    """Freeze the order: today's date + a snapshot of the current per-size
    requested counts. Re-call to update the snapshot (e.g., after a roster
    correction the same day)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        _order_row(cur, tournament_id)  # ensure row exists
        live = _live_requested(cur, tournament_id)
        # Keep only canonical sizes in the snapshot to stay aligned with the
        # display rows; unknown sizes are stored on the live count but skipped here.
        snap = {code: int(live.get(code, 0)) for code, _ in _SIZE_ORDER}
        cur.execute(
            "UPDATE tshirt_order SET ordered_at = CURRENT_DATE, snapshot = %s::jsonb, updated_at = now() "
            "WHERE tournament_id = %s",
            (json.dumps(snap), tournament_id),
        )
    return get_tshirt_order(tournament_id, conn)


@router.delete("/api/tournaments/{tournament_id}/tshirt-order", status_code=204)
def cancel_tshirt_order(tournament_id: int, conn=Depends(db_dep)):
    """Clear the order date + snapshot (inventory is kept)."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE tshirt_order SET ordered_at = NULL, snapshot = NULL, updated_at = now() "
            "WHERE tournament_id = %s",
            (tournament_id,),
        )
    return Response(status_code=204)


@router.get("/api/tshirts", response_model=list[TShirtRow])
def tshirts(conn=Depends(db_dep)):
    """Cumulative cross-tournament t-shirt list (audit §8 F1) — derived from the
    roster, so a player's most recent size is known even for late entrants."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.player_id, p.usta_number, p.first_name, p.last_name,
                   e.age_division, e.tournament_id, t.name AS tournament_name, e.t_shirt_size
            FROM tournament_entry e
            JOIN player p ON p.id = e.player_id
            JOIN tournament t ON t.id = e.tournament_id
            WHERE e.t_shirt_size IS NOT NULL AND e.t_shirt_size <> ''
              AND e.selection_status = 'selected'  -- no withdrawals/alternates
            ORDER BY p.last_name, p.first_name, t.play_start_date DESC
            """
        )
        return cur.fetchall()
