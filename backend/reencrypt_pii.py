"""Re-encrypt PII columns under the primary MultiFernet key (H2.3 rotation).

Run after deploying with ``PII_ENCRYPTION_KEYS=NEW,OLD`` so ciphertext still
readable under OLD is re-wrapped under NEW. Safe to re-run (idempotent).

  cd backend
  python reencrypt_pii.py              # dry-run counts
  python reencrypt_pii.py --apply      # commit re-wraps
  python reencrypt_pii.py --apply --batch 200

Never logs plaintext or ciphertext. See docs/pii-h2-key-management.md §4.
"""
from __future__ import annotations

import argparse
import sys

from app import crypto
from app.db import get_conn

# (table, pk column, encrypted text columns)
TARGETS: list[tuple[str, str, list[str]]] = [
    ("email_message", "id", ["body"]),
    ("player", "id", ["emails", "phones", "birthdate"]),
]


def _looks_like_token(value: str | None) -> bool:
    if not value or len(value) < 40:
        return False
    # Fernet tokens are urlsafe-base64; reject obvious plaintext early.
    try:
        crypto._fernet().decrypt(value.encode())
        return True
    except Exception:
        return False


def run(*, apply: bool, batch: int) -> int:
    print(f"primary key fingerprint: {crypto.primary_key_id()}")
    print(f"mode: {'APPLY' if apply else 'dry-run'}  batch={batch}")
    total_scanned = total_rotated = total_skipped = 0

    with get_conn() as conn:
        with conn.cursor() as cur:
            for table, pk, cols in TARGETS:
                col_sql = ", ".join(cols)
                cur.execute(f"SELECT {pk}, {col_sql} FROM {table} ORDER BY {pk}")
                rows = cur.fetchall()
                scanned = rotated = skipped = 0
                pending: list[tuple[dict, dict]] = []

                for row in rows:
                    scanned += 1
                    sets: dict[str, str] = {}
                    for c in cols:
                        raw = row.get(c)
                        if not _looks_like_token(raw):
                            continue
                        new = crypto.rotate_token(raw)
                        if new is not None and new != raw:
                            sets[c] = new
                    if sets:
                        pending.append((row, sets))
                    else:
                        skipped += 1

                    if len(pending) >= batch:
                        if apply:
                            _flush(cur, table, pk, pending)
                        rotated += len(pending)
                        pending = []

                if pending:
                    if apply:
                        _flush(cur, table, pk, pending)
                    rotated += len(pending)

                if apply:
                    conn.commit()
                print(
                    f"  {table}: scanned={scanned} rotate={rotated} "
                    f"unchanged/non-token={skipped}"
                )
                total_scanned += scanned
                total_rotated += rotated
                total_skipped += skipped

    print(
        f"done: scanned={total_scanned} rotated={total_rotated} "
        f"skipped={total_skipped}"
        + ("" if apply else " (dry-run — re-run with --apply)")
    )
    return 0


def _flush(cur, table: str, pk: str, pending: list[tuple[dict, dict]]) -> None:
    for row, sets in pending:
        assigns = ", ".join(f"{c} = %s" for c in sets)
        cur.execute(
            f"UPDATE {table} SET {assigns} WHERE {pk} = %s",
            (*sets.values(), row[pk]),
        )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--apply",
        action="store_true",
        help="commit re-wraps (default is dry-run)",
    )
    p.add_argument(
        "--batch",
        type=int,
        default=100,
        help="commit every N rows (default 100)",
    )
    args = p.parse_args(argv)
    if args.batch < 1:
        print("--batch must be >= 1", file=sys.stderr)
        return 2
    try:
        return run(apply=args.apply, batch=args.batch)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
