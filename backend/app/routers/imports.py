"""Spreadsheet import: stage uploads, then merge into the main tables (audit §3.8).

Flow: download a template (CSV/XLSX) -> upload a filled file -> rows land in
`import_row` (staged + per-row validated) -> review the summary -> merge the valid
rows into the real tables. See app/importer.py for the per-type registry.
"""
from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from psycopg.types.json import Json

from .. import importer
from ..db import db_dep

router = APIRouter(prefix="/api/import", tags=["import"])

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


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
        rows = importer.parse_file(file.filename, await file.read(), cfg["cols"])
        cur.execute(
            "INSERT INTO import_batch (tournament_id, import_type, filename) "
            "VALUES (%s,%s,%s) RETURNING id",
            (tournament_id, import_type, file.filename),
        )
        bid = cur.fetchone()["id"]
        errors = []
        valid = 0
        for r in rows:
            err = importer.validate(r["data"], cfg["cols"])
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
        cur.execute("SELECT row_num, data, valid, error, merged FROM import_row "
                    "WHERE batch_id = %s ORDER BY row_num", (batch_id,))
        batch["rows"] = cur.fetchall()
    return batch


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
        merged, errors = 0, []
        for r in rows:
            cur.execute("SAVEPOINT imp")
            try:
                merge(cur, tid, r["data"])
                cur.execute("RELEASE SAVEPOINT imp")
                cur.execute("UPDATE import_row SET merged = true, error = NULL WHERE id = %s", (r["id"],))
                merged += 1
            except Exception as e:  # row-level failure: keep the rest of the batch
                cur.execute("ROLLBACK TO SAVEPOINT imp")
                cur.execute("UPDATE import_row SET error = %s WHERE id = %s", (str(e)[:300], r["id"]))
                errors.append({"row": r["row_num"], "error": str(e)})
        cur.execute("UPDATE import_batch SET status = 'merged' WHERE id = %s", (batch_id,))
    return {"merged": merged, "failed": len(errors), "errors": errors[:50]}


@router.delete("/batches/{batch_id}", status_code=204)
def discard_batch(batch_id: int, conn=Depends(db_dep)):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM import_batch WHERE id = %s", (batch_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="batch not found")
    return Response(status_code=204)
