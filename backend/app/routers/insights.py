from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import analytics as A
from .. import config
from ..cache import cached
from ..db import get_db

router = APIRouter(prefix="/api/insights", tags=["insights"])


def _check_os(os_name: str) -> str:
    if os_name not in config.TRACKED_OS:
        raise HTTPException(404, f"Not a tracked OS: {os_name}")
    return os_name


@router.get("/summary")
def summary(db: Session = Depends(get_db)):
    """One summary card per tracked OS."""
    return cached("summary", lambda: [_card(db, os_name) for os_name in config.TRACKED_OS])


def _card(db: Session, os_name: str) -> dict:
    series = A.host_counts(db, os_name)
    baseline = A.count_on_or_before(series, config.BASELINE_DATE) or 0
    current = series[-1][1]
    previous = series[-2][1] if len(series) > 1 else current
    ninety_ago = A.count_on_or_before(series, config.AS_OF_DATE - timedelta(days=90)) or baseline
    run_rate = (ninety_ago - current) / (90 / 30.44)
    projected = None
    if run_rate > 0:
        projected = (config.AS_OF_DATE + timedelta(days=current / run_rate * 30.44)).strftime("%Y-%m")

    owner_map = A.owners(db)
    dq = sum(1 for h in A.hosts(db) if h.os == os_name and A.flags_for(h, owner_map))
    b = A.owner_buckets(db, os_name)
    totals = {k: sum(r["hosts"] for r in rows) for k, rows in b.items()}
    return {
        "os": os_name,
        "baseline_date": config.BASELINE_DATE.isoformat(),
        "baseline": baseline,
        "current_remaining": current,
        "pct_complete": round((baseline - current) / baseline * 100, 1) if baseline else 0,
        "net_change": current - previous,
        "run_rate_per_month": round(run_rate),
        "projected_completion": projected,
        "data_quality_flags": dq,
        "current_month": config.current_month(),
        "checkpoint_month": config.last_completed_month(),
        "on_track_hosts": totals["on_track"],
        "behind_hosts": totals["behind"],
        "no_plan_hosts": totals["no_plan"],
        "remaining_snapshot": sum(totals.values()),
        "on_track_list": b["on_track"],
        "behind_list": b["behind"],
        "no_plan_list": b["no_plan"],
    }


@router.get("/series")
def series(os: str = Query(...), by: str = Query("total", pattern="^(total|portfolio)$"),
           db: Session = Depends(get_db)):
    """Monthly planned vs actual, for the OS total or per portfolio."""
    os_name = _check_os(os)
    return cached(f"series:{os_name}:{by}", lambda: _series(db, os_name, by))


def _month_actuals(base: int, remaining_at) -> tuple[dict, dict]:
    remaining, decom, prev = {}, {}, base
    for m in config.months():
        if A.is_future(m):
            remaining[m] = decom[m] = None
            continue
        r = remaining_at(min(A.month_end(m), config.AS_OF_DATE))
        remaining[m], decom[m], prev = r, prev - r, r
    return remaining, decom


def _pack(base: int, planned: dict, remaining_at) -> dict:
    months = config.months()
    planned_decom = {m: planned.get(m, 0) for m in months}
    actual_rem, actual_decom = _month_actuals(base, remaining_at)
    return {
        "baseline": base,
        "planned_decom": planned_decom,
        "planned_remaining": A.remaining_from_decom(base, planned_decom),
        "actual_remaining": actual_rem,
        "actual_decom": actual_decom,
    }


def _series(db: Session, os_name: str, by: str) -> dict:
    months = config.months()
    if by == "total":
        counts = A.host_counts(db, os_name)
        base = A.count_on_or_before(counts, config.BASELINE_DATE) or 0
        planned = A.planned_by(db, os_name, lambda l: "total").get("total", {})
        return {"os": os_name, "months": months,
                **_pack(base, planned, lambda d: A.count_on_or_before(counts, d))}

    cohort = defaultdict(list)
    for h in A.hosts(db):
        if h.os == os_name:
            cohort[h.portfolio].append(h.left_date)
    planned = A.planned_by(db, os_name, lambda l: l.portfolio)
    out = {}
    for pf in sorted(set(cohort) | set(planned)):
        lefts = cohort.get(pf, [])
        out[pf] = _pack(len(lefts), planned.get(pf, {}),
                        lambda d, lefts=lefts: sum(1 for x in lefts if x is None or x > d))
    return {"os": os_name, "months": months, "portfolios": out}


@router.get("/decommissions")
def decommissions(os: str = Query(...), month: Optional[str] = None, db: Session = Depends(get_db)):
    """Baseline hosts that left the EOL OS (decommissioned or upgraded), for the drill-down."""
    os_name = _check_os(os)
    rows = cached(f"decom:{os_name}", lambda: sorted(
        ({"hostname": h.hostname, "portfolio": h.portfolio, "os": h.current_os or "-",
          "left_date": h.left_date.isoformat(), "month": h.left_date.strftime("%Y-%m"),
          "status": h.status}
         for h in A.hosts(db) if h.os == os_name and h.left_date),
        key=lambda r: (r["left_date"], r["hostname"])))
    if month:
        rows = [r for r in rows if r["month"] == month]
    return {"os": os_name, "month": month, "count": len(rows), "hosts": rows}
