from __future__ import annotations

from collections import Counter, defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import analytics as A
from .. import cache, config
from ..db import get_db
from ..models import Host, Owner, Portfolio, PortfolioMap

router = APIRouter(prefix="/api/mapping", tags=["mapping"])


class OwnerMapIn(BaseModel):
    owner: str
    portfolio: str


class OwnerStatusIn(BaseModel):
    status: str
    note: Optional[str] = None


def rederive(db: Session, owner: str) -> int:
    """Re-apply portfolio derivation to one owner's hosts: feed value, else owner map, else Unknown."""
    pm = db.query(PortfolioMap).filter(PortfolioMap.owner == owner).first()
    target = pm.portfolio if pm else config.UNKNOWN
    n = (db.query(Host)
         .filter(Host.owner == owner, Host.feed_portfolio.is_(None), Host.portfolio != target)
         .update({Host.portfolio: target}, synchronize_session=False))
    return n


@router.get("/portfolios")
def portfolios(db: Session = Depends(get_db)):
    """Every portfolio with its full name, where it comes from, and remaining hosts per OS."""
    counts: dict = defaultdict(Counter)
    for h in A.hosts(db):
        if h.status == "remaining":
            counts[h.portfolio][h.os] += 1
    mapped = Counter(pm.portfolio for pm in db.query(PortfolioMap).all())
    return [{"code": p.code, "full_name": p.full_name, "origin": p.origin,
             "mapped_owners": mapped[p.code],
             "remaining": {os_name: counts[p.code][os_name] for os_name in config.TRACKED_OS}}
            for p in sorted(db.query(Portfolio).all(),
                            key=lambda p: (p.code == config.UNKNOWN, p.code.lower()))]


@router.get("/owner-map")
def owner_map(db: Session = Depends(get_db)):
    owners = A.owners(db)
    return [{"owner": pm.owner, "display_name": owners[pm.owner].display_name if pm.owner in owners else "",
             "portfolio": pm.portfolio, "updated_at": pm.updated_at.isoformat() if pm.updated_at else None}
            for pm in db.query(PortfolioMap).order_by(PortfolioMap.owner).all()]


@router.post("/owner-map")
def upsert_owner_map(body: OwnerMapIn, db: Session = Depends(get_db)):
    """Assign an owner to a portfolio and re-derive their hosts immediately."""
    if not db.get(Portfolio, body.portfolio) or body.portfolio == config.UNKNOWN:
        raise HTTPException(400, f"Unknown portfolio: {body.portfolio}")
    if not db.get(Owner, body.owner):
        raise HTTPException(404, f"Unknown owner: {body.owner}")
    pm = db.query(PortfolioMap).filter(PortfolioMap.owner == body.owner).first()
    if pm:
        pm.portfolio = body.portfolio
    else:
        db.add(PortfolioMap(owner=body.owner, portfolio=body.portfolio))
    db.flush()
    moved = rederive(db, body.owner)
    db.commit()
    cache.invalidate()
    return {"owner": body.owner, "portfolio": body.portfolio, "hosts_updated": moved}


@router.delete("/owner-map/{owner}")
def delete_owner_map(owner: str, db: Session = Depends(get_db)):
    pm = db.query(PortfolioMap).filter(PortfolioMap.owner == owner).first()
    if not pm:
        raise HTTPException(404, "No mapping for that owner")
    db.delete(pm)
    db.flush()
    moved = rederive(db, owner)
    db.commit()
    cache.invalidate()
    return {"owner": owner, "hosts_updated": moved}


@router.get("/owners")
def owner_status(db: Session = Depends(get_db)):
    return [{"username": o.username, "display_name": o.display_name, "status": o.status,
             "first_seen": o.first_seen.isoformat(), "note": o.note}
            for o in db.query(Owner).order_by(Owner.username).all()]


@router.put("/owners/{username}")
def set_owner_status(username: str, body: OwnerStatusIn, db: Session = Depends(get_db)):
    if body.status not in ("active", "departed", "unknown"):
        raise HTTPException(400, "status must be active, departed or unknown")
    o = db.get(Owner, username)
    if not o:
        raise HTTPException(404, "Unknown owner")
    o.status, o.note = body.status, body.note
    db.commit()
    cache.invalidate()
    return {"username": username, "status": o.status}
