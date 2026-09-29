"""End-to-end checks of the API against the generated demo dataset.

The most important ones are the reconciliation invariants: the numbers on different
parts of the dashboard must add up to each other.
"""
import io

OSES = ["Ubuntu 16.04", "Oracle 7"]


def test_health_and_meta(client):
    assert client.get("/api/health").json() == {"ok": True}
    meta = client.get("/api/meta").json()
    assert meta["app_name"] == "Horizon"
    assert meta["source"] == "CMDB"
    assert meta["as_of"] == "2026-09-15"


def test_summary_badges_reconcile_with_headline(client):
    for card in client.get("/api/insights/summary").json():
        buckets = card["on_track_hosts"] + card["behind_hosts"] + card["no_plan_hosts"]
        assert buckets == card["remaining_snapshot"] == card["current_remaining"]
        for kind in ("on_track_list", "behind_list", "no_plan_list"):
            for row in card[kind]:
                assert row["hosts"] == sum(o["hosts"] for o in row["owners"])
        assert card["on_track_hosts"] > 0 and card["behind_hosts"] > 0 and card["no_plan_hosts"] > 0
        assert card["checkpoint_month"] == "2026-08"


def test_partially_planned_portfolio_splits_across_badges(client):
    # DPE has exactly one planned owner per OS; its other owners must land in "no plan".
    for card in client.get("/api/insights/summary").json():
        planned = [r for k in ("on_track_list", "behind_list") for r in card[k] if r["portfolio"] == "DPE"]
        unplanned = [r for r in card["no_plan_list"] if r["portfolio"] == "DPE"]
        assert sum(len(r["owners"]) for r in planned) == 1
        assert unplanned and len(unplanned[0]["owners"]) >= 3


def test_series_stops_actuals_at_current_month(client):
    for os_name in OSES:
        s = client.get("/api/insights/series", params={"os": os_name}).json()
        assert s["actual_remaining"]["2026-09"] is not None
        assert s["actual_remaining"]["2026-10"] is None
        assert s["planned_remaining"]["2026-06"] == s["baseline"] - s["planned_decom"]["2026-06"]
        # Ticking every portfolio must give the same numbers as "All portfolios".
        by_pf = client.get("/api/insights/series", params={"os": os_name, "by": "portfolio"}).json()
        packs = by_pf["portfolios"].values()
        assert sum(p["baseline"] for p in packs) == s["baseline"]
        for m in ("2026-06", "2026-08", "2026-09"):
            assert sum(p["actual_remaining"][m] for p in packs) == s["actual_remaining"][m]
            assert sum(p["planned_decom"][m] for p in packs) == s["planned_decom"][m]


def test_decommission_drilldown_matches_departures(client):
    cards = {c["os"]: c for c in client.get("/api/insights/summary").json()}
    for os_name in OSES:
        d = client.get("/api/insights/decommissions", params={"os": os_name}).json()
        assert d["count"] == cards[os_name]["baseline"] - cards[os_name]["current_remaining"]
        aug = client.get("/api/insights/decommissions", params={"os": os_name, "month": "2026-08"}).json()
        assert aug["count"] > 0 and all(h["month"] == "2026-08" for h in aug["hosts"])


def test_quality_and_needs_review(client):
    q = client.get("/api/actuals/quality").json()
    oracle = next(x for x in q if x["os"] == "Oracle 7")
    assert oracle["flags"]["unowned"] > 0 and oracle["flags"]["departed"] > 0
    flagged = client.get("/api/actuals/flagged", params={"os": "Oracle 7"}).json()
    assert flagged["count"] > 0 and all(h["os"] == "Oracle 7" for h in flagged["hosts"])


def test_triage_assign_moves_owner_out_of_unknown(client):
    triage = client.get("/api/actuals/triage").json()
    reasons = {r for row in triage for r in row["reasons"]}
    assert {"no owner", "new this refresh", "departed", "unknown portfolio"} <= reasons
    target = next(r for r in triage if "unknown portfolio" in r["reasons"] and r["assignable"])
    res = client.post("/api/mapping/owner-map", json={"owner": target["owner"], "portfolio": "SRE"}).json()
    assert res["hosts_updated"] > 0
    after = client.get("/api/actuals/triage").json()
    assert target["owner"] not in {r["owner"] for r in after if "unknown portfolio" in r["reasons"]}
    client.delete(f"/api/mapping/owner-map/{target['owner']}")
    assert target["owner"] in {r["owner"] for r in client.get("/api/actuals/triage").json()}


def test_planned_crud_writes_audit(client):
    hdr = {"X-Changed-By": "tester"}
    body = {"os": "Ubuntu 16.04", "portfolio": "sre", "application": "Test App", "owner": "",
            "months": {"2026-10": 5}}
    line = client.post("/api/planned", json=body, headers=hdr).json()
    assert line["portfolio"] == "SRE"  # canonicalized

    before = len(client.get("/api/planned/audit").json())
    client.put(f"/api/planned/{line['id']}", json={**body, "portfolio": "SRE"}, headers=hdr)
    assert len(client.get("/api/planned/audit").json()) == before  # no-op edit logs nothing

    body["months"] = {"2026-10": 8, "2026-11": 2}
    client.put(f"/api/planned/{line['id']}", json=body, headers=hdr)
    log = client.get("/api/planned/audit", params={"limit": 2}).json()
    assert {a["field"] for a in log} == {"month:2026-10", "month:2026-11"}
    assert all(a["actor"] == "tester" for a in log)

    listed = next(l for l in client.get("/api/planned").json() if l["id"] == line["id"])
    assert listed["last_changed_by"] == "tester"

    client.delete(f"/api/planned/{line['id']}", headers=hdr)
    assert client.get("/api/planned/audit", params={"limit": 1}).json()[0]["action"] == "delete"
    assert client.post("/api/planned", json={**body, "portfolio": "Nope"}).status_code == 400


def test_import_upserts_and_reports_problems(client):
    csv_text = (
        "OS,Portfolio,Application,Owner,2026-10,Oct-2026,Nov 2026\n"
        "Ubuntu 16.04,cdp,Import Test,,4,6,1\n"
        "Ubuntu 16.04,CDP,Import Test,,,,3\n"      # duplicate key: last value wins
        "Ubuntu 16.04,Not A Portfolio,X,,1,,\n"    # skipped, reported
        "Windows 2012,CDP,X,,1,,\n"                # untracked OS, skipped
        "Oracle 7,SMB,Import Test,ghost.user,2,,\n"  # unknown owner, reported
    )
    files = {"file": ("plan.csv", io.BytesIO(csv_text.encode()), "text/csv")}
    res = client.post("/api/planned/import", files=files).json()
    assert res["created"] == 2 and res["skipped"] == 2
    assert res["unmatched"] == [{"portfolio": "Not A Portfolio", "rows": 1}]
    assert res["unknown_owners"] == ["ghost.user"]
    line = next(l for l in client.get("/api/planned").json()
                if l["application"] == "Import Test" and l["os"] == "Ubuntu 16.04")
    assert line["months"] == {"2026-10": 6, "2026-11": 3}


def test_reset_restores_seed(client):
    before = client.get("/api/insights/summary").json()
    oracle = next(c for c in before if c["os"] == "Oracle 7")
    dpe = next(r for r in oracle["no_plan_list"] if r["portfolio"] == "DPE")
    owner = dpe["owners"][0]["username"]
    client.post("/api/planned", json={"os": "Oracle 7", "portfolio": "DPE", "owner": owner,
                                      "months": {"2026-06": 1}})
    assert client.get("/api/insights/summary").json() != before
    client.post("/api/demo/reset")
    assert client.get("/api/insights/summary").json() == before


def test_demo_story_one_on_track_one_at_risk(client):
    cards = {c["os"]: c for c in client.get("/api/insights/summary").json()}
    window_end = client.get("/api/config").json()["months"][-1]
    assert cards["Oracle 7"]["projected_completion"] <= window_end
    assert cards["Ubuntu 16.04"]["projected_completion"] > window_end


def test_removed_endpoints_are_gone(client):
    for path in ("/api/insights/remediation", "/api/insights/history", "/api/no-such-thing"):
        assert client.get(path, params={"os": "Ubuntu 16.04"}).status_code == 404
