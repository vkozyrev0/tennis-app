"""Attach a venue site to a tournament so chair/referee days can be saved."""
import uuid


def attach_venue_site(client, ok, tournament_id):
    s = ok(client.post("/api/sites", json={"name": "VS " + uuid.uuid4().hex[:6]}))
    ok(client.put(f"/api/tournaments/{tournament_id}/sites",
                  json={"site_ids": [s["id"]]}), 200)
    return s
