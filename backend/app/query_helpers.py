"""Shared list-endpoint helpers (improvement-plan P1 #5).

One implementation of the server-side paging contract — count the full match
set into `X-Total-Count`, then return the (optionally LIMIT/OFFSET-paged)
rows — so players / officials / emails / future lists can't drift on the
header name, clamping, or clause order.
"""


def like_escape(term: str) -> str:
    """Escape LIKE/ILIKE wildcards in USER input so a search for "%" or "_"
    matches those literal characters instead of everything / any-one-char
    (investigation 2026-06-10). Postgres' default LIKE escape is backslash."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def paged_select(cur, response, *, cols: str, from_sql: str, where: str = "",
                 params=(), order_by: str, limit: int | None = None,
                 offset: int = 0):
    """COUNT + page in one shape. `where` includes its leading " WHERE " (or is
    empty); `order_by` includes its leading " ORDER BY ". With limit=None the
    whole match set is returned (back-compatible unpaged callers)."""
    cur.execute(f"SELECT count(*) AS n {from_sql}{where}", params)
    response.headers["X-Total-Count"] = str(cur.fetchone()["n"])
    page, page_params = "", list(params)
    if limit is not None:
        page = " LIMIT %s OFFSET %s"
        page_params += [max(0, limit), max(0, offset)]
    cur.execute(f"SELECT {cols} {from_sql}{where}{order_by}{page}", page_params)
    return cur.fetchall()
