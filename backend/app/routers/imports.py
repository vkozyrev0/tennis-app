"""Spreadsheet import: stage uploads, then merge into the main tables (audit §3.8).

Flow: download a template (CSV/XLSX) -> upload a filled file -> rows land in
`import_row` (staged + per-row validated) -> review the summary -> merge the valid
rows into the real tables. See app/importer.py for the per-type registry.
"""
from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel
from psycopg.types.json import Json

from .. import importer
from ..db import db_dep

router = APIRouter(prefix="/api/import", tags=["import"])

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class ImportRowUpdate(BaseModel):
    data: dict


def _batch_counts(cur, batch_id: int) -> dict:
    """Aggregate valid/invalid/total for a staging batch's not-yet-merged rows —
    the live feed the preview grid's Merge button reads."""
    cur.execute(
        "SELECT count(*) AS total, "
        "       count(*) FILTER (WHERE valid AND NOT merged) AS valid, "
        "       count(*) FILTER (WHERE NOT valid AND NOT merged) AS invalid "
        "FROM import_row WHERE batch_id = %s",
        (batch_id,),
    )
    r = cur.fetchone()
    return {"total": r["total"], "valid": r["valid"], "invalid": r["invalid"]}


@router.get("/types")
def list_types():
    return importer.types_meta()


@router.get("/template/{import_type}")
def download_template(import_type: str, fmt: str = "csv"):
    if import_type not in importer.TYPES:
        raise HTTPException(status_code=404, detail="unknown import type")
    if fmt == "xlsx":
        body, media, ext = importer.template_xlsx(import_type), _XLSX, "xlsx"
    else:
        body, media, ext = importer.template_csv(import_type), "text/csv", "csv"
    return Response(content=body, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{import_type}-template.{ext}"'})


@router.post("/tournaments/{tournament_id}/{import_type}", status_code=201)
async def upload(tournament_id: int, import_type: str,
                 file: UploadFile = File(...), conn=Depends(db_dep)):
    """Parse + validate an uploaded file into a staging batch (no main-table writes)."""
    cfg = importer.TYPES.get(import_type)
    if cfg is None:
        raise HTTPException(status_code=404, detail="unknown import type")
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM tournament WHERE id = %s", (tournament_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="tournament not found")
        # Parse failures (corrupt xlsx, binary garbage, etc.) used to surface
        # as raw 500s. Catch them at the boundary and return a friendly 400 so
        # the user sees "this file couldn't be parsed" instead of a stack trace.
        try:
            rows = importer.parse_file(file.filename, await file.read(), cfg["cols"])
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"couldn't parse {file.filename!r} — is it a valid CSV/XLSX? ({type(e).__name__})",
            )
        cur.execute(
            "INSERT INTO import_batch (tournament_id, import_type, filename) "
            "VALUES (%s,%s,%s) RETURNING id",
            (tournament_id, import_type, file.filename),
        )
        bid = cur.fetchone()["id"]
        errors = []
        valid = 0
        for r in rows:
            err = importer.validate(r["data"], cfg["cols"], cur)
            if err is None:
                valid += 1
            else:
                errors.append({"row": r["row_num"], "error": err})
            cur.execute(
                "INSERT INTO import_row (batch_id, row_num, data, valid, error) "
                "VALUES (%s,%s,%s,%s,%s)",
                (bid, r["row_num"], Json(r["data"]), err is None, err),
            )
    return {"batch_id": bid, "import_type": import_type, "total": len(rows),
            "valid": valid, "invalid": len(rows) - valid, "errors": errors[:50]}


@router.get("/batches/{batch_id}")
def get_batch(batch_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("SELECT id, tournament_id, import_type, filename, status, created_at "
                    "FROM import_batch WHERE id = %s", (batch_id,))
        batch = cur.fetchone()
        if batch is None:
            raise HTTPException(status_code=404, detail="batch not found")
        cur.execute("SELECT id, row_num, data, valid, error, merged FROM import_row "
                    "WHERE batch_id = %s ORDER BY row_num", (batch_id,))
        batch["rows"] = cur.fetchall()
    return batch


@router.patch("/batches/{batch_id}/rows/{row_id}")
def edit_row(batch_id: int, row_id: int, body: ImportRowUpdate, conn=Depends(db_dep)):
    """Overwrite a staged row's data and re-validate it (same validate() the
    upload ran), so the preview grid's inline fixes persist and the valid/error
    badge always matches what merge will accept. Refuses on an already-merged
    batch."""
    with conn.cursor() as cur:
        cur.execute("SELECT import_type, status FROM import_batch WHERE id = %s", (batch_id,))
        batch = cur.fetchone()
        if batch is None:
            raise HTTPException(status_code=404, detail="batch not found")
        if batch["status"] == "merged":
            raise HTTPException(status_code=409, detail="this batch was already merged — re-upload to make changes")
        cfg = importer.TYPES.get(batch["import_type"])
        if cfg is None:
            raise HTTPException(status_code=400, detail="unknown import type")
        cur.execute("SELECT merged FROM import_row WHERE id = %s AND batch_id = %s", (row_id, batch_id))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="row not found")
        if row["merged"]:
            raise HTTPException(status_code=409, detail="this row was already merged")
        # Only keep recognized columns; ignore anything the grid sends extra.
        canon = {c.canon for c in cfg["cols"]}
        data = {k: (v if v not in ("",) else None) for k, v in body.data.items() if k in canon}
        err = importer.validate(data, cfg["cols"], cur)
        cur.execute(
            "UPDATE import_row SET data = %s, valid = %s, error = %s WHERE id = %s",
            (Json(data), err is None, err, row_id),
        )
        return {"id": row_id, "data": data, "valid": err is None, "error": err,
                "counts": _batch_counts(cur, batch_id)}


@router.delete("/batches/{batch_id}/rows/{row_id}")
def delete_row(batch_id: int, row_id: int, conn=Depends(db_dep)):
    """Drop one staged row (e.g. a stray totals line) without re-uploading."""
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM import_batch WHERE id = %s", (batch_id,))
        batch = cur.fetchone()
        if batch is None:
            raise HTTPException(status_code=404, detail="batch not found")
        if batch["status"] == "merged":
            raise HTTPException(status_code=409, detail="this batch was already merged")
        cur.execute("DELETE FROM import_row WHERE id = %s AND batch_id = %s AND NOT merged", (row_id, batch_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="row not found (or already merged)")
        return {"deleted": row_id, "counts": _batch_counts(cur, batch_id)}


@router.post("/batches/{batch_id}/merge")
def merge_batch(batch_id: int, conn=Depends(db_dep)):
    """Merge the valid, not-yet-merged rows into the main tables (per-row savepoint)."""
    with conn.cursor() as cur:
        cur.execute("SELECT tournament_id, import_type, status FROM import_batch WHERE id = %s",
                    (batch_id,))
        batch = cur.fetchone()
        if batch is None:
            raise HTTPException(status_code=404, detail="batch not found")
        merge = importer.TYPES[batch["import_type"]]["merge"]
        tid = batch["tournament_id"]
        cur.execute("SELECT id, row_num, data FROM import_row "
                    "WHERE batch_id = %s AND valid AND NOT merged ORDER BY row_num", (batch_id,))
        rows = cur.fetchall()
        merged, errors, conflicts = 0, [], []
        for r in rows:
            cur.execute("SAVEPOINT imp")
            try:
                note = merge(cur, tid, r["data"])  # conflict note (str) or None
                cur.execute("RELEASE SAVEPOINT imp")
                # Audit M10: the bookkeeping UPDATE runs outside the merge
                # savepoint — wrap it so a constraint hit here doesn't abort
                # the whole batch transaction.
                cur.execute("SAVEPOINT imp_bk")
                try:
                    cur.execute("UPDATE import_row SET merged = true, error = %s WHERE id = %s",
                                (note, r["id"]))
                    cur.execute("RELEASE SAVEPOINT imp_bk")
                except Exception:
                    cur.execute("ROLLBACK TO SAVEPOINT imp_bk")
                merged += 1
                if note:
                    conflicts.append({"row": r["row_num"], "detail": note})
            except HTTPException as e:
                # Audit T3: preserve the helpful 400 detail instead of stringifying
                # the HTTPException repr (which leaked status codes into the UI).
                cur.execute("ROLLBACK TO SAVEPOINT imp")
                msg = str(e.detail)[:300]
                cur.execute("SAVEPOINT imp_bk")
                try:
                    cur.execute("UPDATE import_row SET error = %s WHERE id = %s", (msg, r["id"]))
                    cur.execute("RELEASE SAVEPOINT imp_bk")
                except Exception:
                    cur.execute("ROLLBACK TO SAVEPOINT imp_bk")
                errors.append({"row": r["row_num"], "error": msg})
            except Exception as e:  # row-level failure: keep the rest of the batch
                cur.execute("ROLLBACK TO SAVEPOINT imp")
                msg = str(e)[:300]
                cur.execute("SAVEPOINT imp_bk")
                try:
                    cur.execute("UPDATE import_row SET error = %s WHERE id = %s", (msg, r["id"]))
                    cur.execute("RELEASE SAVEPOINT imp_bk")
                except Exception:
                    cur.execute("ROLLBACK TO SAVEPOINT imp_bk")
                errors.append({"row": r["row_num"], "error": msg})
        cur.execute("UPDATE import_batch SET status = 'merged' WHERE id = %s", (batch_id,))
    return {"merged": merged, "failed": len(errors), "conflicts": conflicts[:50],
            "errors": errors[:50]}


@router.delete("/batches/{batch_id}", status_code=204)
def discard_batch(batch_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM import_batch WHERE id = %s", (batch_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="batch not found")
    return Response(status_code=204)
