from __future__ import annotations

from collections import Counter, defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from .. import analytics as A
from .. import config
from ..cache import cached
from ..db import get_db
from ..models import Portfolio

router = APIRouter(prefix="/api/actuals", tags=["actuals"])

FLAG_KEYS = ["unmapped", "unowned", "departed", "remediated"]


def _os_filter(os: Optional[list[str]]) -> list[str]:
    return [o for o in (os or config.TRACKED_OS) if o in config.TRACKED_OS]


@router.get("/quality")
def quality(db: Session = Depends(get_db)):
    """Per-OS data-quality counts and the remaining hosts by portfolio."""
    def compute():
        owner_map = A.owners(db)
        names = {p.code: p.full_name for p in db.query(Portfolio).all()}
        out = []
        for os_name in config.TRACKED_OS:
            flags, by_pf, owners_by_pf = Counter(), Counter(), defaultdict(set)
            remaining = 0
            for h in A.hosts(db):
                if h.os != os_name:
                    continue
                for f in A.flags_for(h, owner_map):
                    flags[f] += 1
                if h.status == "remaining":
                    remaining += 1
                    by_pf[h.portfolio] += 1
                    owners_by_pf[h.portfolio].add(h.owner or A.NO_OWNER)
            out.append({
                "os": os_name,
                "remaining": remaining,
                "flags": {k: flags[k] for k in FLAG_KEYS},
                "portfolios": [{"portfolio": pf, "full_name": names.get(pf, pf), "hosts": n,
                                "owners": len(owners_by_pf[pf])} for pf, n in by_pf.most_common()],
            })
        return out
    return cached("quality", compute)


@router.get("/flagged")
def flagged(os: Optional[list[str]] = Query(None), db: Session = Depends(get_db)):
    """Hosts with at least one data-quality flag (the "Needs review" list)."""
    wanted = set(_os_filter(os))
    owner_map = A.owners(db)
    rows = []
    for h in A.hosts(db):
        if h.os not in wanted:
            continue
        flags = A.flags_for(h, owner_map)
        if flags:
            o = owner_map.get(h.owner) if h.owner else None
            rows.append({"hostname": h.hostname, "os": h.os, "current_os": h.current_os,
                         "host_type": h.host_type, "portfolio": h.portfolio,
                         "owner": h.owner or A.NO_OWNER,
                         "owner_status": o.status if o else "unknown", "flags": flags})
    rows.sort(key=lambda r: (r["os"], r["portfolio"], r["owner"], r["hostname"]))
    return {"as_of": config.AS_OF_DATE.isoformat(), "count": len(rows), "hosts": rows}


@router.get("/triage")
def triage(db: Session = Depends(get_db)):
    """Owners that need attention: new, unmapped (Unknown portfolio), departed or missing."""
    def compute():
        owner_map = A.owners(db)
        agg: dict = defaultdict(lambda: {"hosts": 0, "os": Counter(), "portfolios": Counter()})
        for h in A.hosts(db):
            if h.status != "remaining":
                continue
            a = agg[h.owner or A.NO_OWNER]
            a["hosts"] += 1
            a["os"][h.os] += 1
            a["portfolios"][h.portfolio] += 1
        rows = []
        for user, a in agg.items():
            o = owner_map.get(user)
            reasons = []
            if user == A.NO_OWNER:
                reasons.append("no owner")
            if o and o.first_seen == config.AS_OF_DATE:
                reasons.append("new this refresh")
            if o and o.status == "departed":
                reasons.append("departed")
            if a["portfolios"].get(config.UNKNOWN):
                reasons.append("unknown portfolio")
            if not reasons:
                continue
            rows.append({
                "owner": user,
                "display_name": o.display_name if o else "",
                "status": o.status if o else "unknown",
                "first_seen": o.first_seen.isoformat() if o else None,
                "hosts": a["hosts"],
                "os": dict(a["os"]),
                "portfolio": a["portfolios"].most_common(1)[0][0],
                "reasons": reasons,
                "assignable": o is not None,
            })
        rows.sort(key=lambda r: -r["hosts"])
        return rows
    return cached("triage", compute)


@router.get("/owners")
def owners(db: Session = Depends(get_db)):
    """Owners with remaining hosts; powers the Planned tab's owner autocomplete."""
    def compute():
        owner_map = A.owners(db)
        agg: dict = defaultdict(Counter)
        for h in A.hosts(db):
            if h.status == "remaining" and h.owner:
                agg[h.owner][h.portfolio] += 1
        return sorted(({"username": u, "display_name": owner_map[u].display_name if u in owner_map else "",
                        "hosts": sum(c.values()), "portfolio": c.most_common(1)[0][0]}
                       for u, c in agg.items()), key=lambda r: r["username"])
    return cached("owners_list", compute)


@router.get("/snapshots")
def snapshots(limit: int = 30, db: Session = Depends(get_db)):
    """Most recent daily refreshes with the host count for each EOL OS."""
    by_date: dict = defaultdict(dict)
    for os_name in config.TRACKED_OS:
        for d, c in A.host_counts(db, os_name)[-limit:]:
            by_date[d.isoformat()][os_name] = c
    return [{"date": d, "counts": by_date[d]} for d in sorted(by_date, reverse=True)]
