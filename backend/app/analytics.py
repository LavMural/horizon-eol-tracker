"""Shared calculations behind the Insights and Actuals tabs.

Conventions:
  * "remaining" = baseline hosts still on the EOL OS.
  * Planned values are hosts to decommission in a month; planned remaining is the
    baseline minus cumulative planned decommissions.
  * Dates never come from the wall clock: config.AS_OF_DATE is "today".
"""
from __future__ import annotations

import calendar
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from . import config
from .cache import cached
from .models import Host, HostCount, Owner, PlanLine

NO_OWNER = "(no owner)"


@dataclass(frozen=True)
class H:
    hostname: str
    os: str
    current_os: Optional[str]
    status: str
    left_date: Optional[date]
    owner: Optional[str]
    portfolio: str
    host_type: str


def hosts(db: Session) -> list[H]:
    def load():
        rows = db.query(Host.hostname, Host.baseline_os, Host.current_os, Host.status,
                        Host.left_date, Host.owner, Host.portfolio, Host.host_type).all()
        return [H(*r) for r in rows]
    return cached("hosts", load)


def owners(db: Session) -> dict[str, Owner]:
    return cached("owners", lambda: {o.username: o for o in db.query(Owner).all()})


def host_counts(db: Session, os_name: str) -> list[tuple[date, int]]:
    return cached(f"counts:{os_name}", lambda: [
        (r.date, r.count) for r in
        db.query(HostCount).filter(HostCount.os == os_name).order_by(HostCount.date).all()
    ])


def count_on_or_before(series: list[tuple[date, int]], d: date) -> Optional[int]:
    best = None
    for day, c in series:
        if day > d:
            break
        best = c
    return best


def month_end(month: str) -> date:
    y, m = map(int, month.split("-"))
    return date(y, m, calendar.monthrange(y, m)[1])


def is_future(month: str) -> bool:
    return month > config.current_month()


def plans(db: Session, os_name: str) -> list[PlanLine]:
    return db.query(PlanLine).filter(PlanLine.os == os_name).all()


def planned_by(db: Session, os_name: str, key) -> dict:
    """{key(line): {month: planned}} for one OS."""
    out: dict = defaultdict(lambda: defaultdict(int))
    for line in plans(db, os_name):
        for pm in line.months:
            out[key(line)][pm.month] += pm.planned_count
    return out


def remaining_from_decom(base: int, decom: dict[str, int]) -> dict[str, int]:
    out, cum = {}, 0
    for m in config.months():
        cum += decom.get(m, 0)
        out[m] = base - cum
    return out


def flags_for(h: H, owner_map: dict[str, Owner]) -> list[str]:
    """Data-quality flags for one host."""
    out = []
    if h.status == "remaining":
        if h.portfolio == config.UNKNOWN:
            out.append("unmapped")
        if not h.owner:
            out.append("unowned")
        elif owner_map.get(h.owner) and owner_map[h.owner].status == "departed":
            out.append("departed")
    elif h.status == "upgraded" and h.left_date and h.left_date > config.AS_OF_DATE - timedelta(days=1):
        out.append("remediated")
    return out


def owner_buckets(db: Session, os_name: str) -> dict:
    """Split every remaining host into On track / Behind / No plan, judged per owner.

    For each (portfolio, owner) with remaining hosts:
      * no plan  -- the owner has no nonzero plan line for (OS, portfolio);
      * on track -- remaining <= due, where due = owner baseline minus planned
                    decommissions through the last completed month;
      * behind   -- remaining > due (over = remaining - due).
    The three buckets always add up to the OS's remaining host count.
    """
    checkpoint = config.last_completed_month()
    base: dict = defaultdict(int)
    rem: dict = defaultdict(int)
    for h in hosts(db):
        if h.os != os_name:
            continue
        key = (h.portfolio, h.owner or NO_OWNER)
        base[key] += 1
        if h.status == "remaining":
            rem[key] += 1

    planned = planned_by(db, os_name, lambda l: (l.portfolio, l.owner or NO_OWNER))
    buckets = {"on_track": defaultdict(list), "behind": defaultdict(list), "no_plan": defaultdict(list)}
    for key, n in rem.items():
        if not n:
            continue
        pf, user = key
        months = planned.get(key, {})
        total = sum(months.values())
        if total <= 0:
            buckets["no_plan"][pf].append({"username": user, "hosts": n, "planned_total": 0, "over": 0})
            continue
        due_done = sum(c for m, c in months.items() if checkpoint and m <= checkpoint)
        due = base[key] - due_done
        kind = "on_track" if n <= due else "behind"
        buckets[kind][pf].append({"username": user, "hosts": n, "planned_total": total,
                                  "over": max(0, n - due)})

    out = {}
    for kind, by_pf in buckets.items():
        rows = []
        for pf, owners_ in by_pf.items():
            owners_.sort(key=lambda o: -o["hosts"])
            rows.append({"portfolio": pf, "hosts": sum(o["hosts"] for o in owners_), "owners": owners_})
        rows.sort(key=lambda r: -r["hosts"])
        out[kind] = rows
    return out
