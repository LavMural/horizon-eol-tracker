from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import cache, config
from ..db import get_db
from ..mockdata import rebuild
from ..models import Meta, PlanLine

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/meta")
def meta(db: Session = Depends(get_db)):
    kv = {m.key: m.value for m in db.query(Meta).all()}
    return {
        "app_name": config.APP_NAME,
        "tagline": config.APP_TAGLINE,
        "source": config.SOURCE_NAME,
        "dataset": kv.get("dataset"),
        "last_refresh": kv.get("last_refresh"),
        "as_of": config.AS_OF_DATE.isoformat(),
        "planned_last_saved": (lambda v: v.isoformat() if v else None)(
            db.query(func.max(PlanLine.updated_at)).scalar()),
    }


@router.get("/config")
def get_config():
    return {
        "tracked_os": config.TRACKED_OS,
        "months": config.months(),
        "baseline_date": config.BASELINE_DATE.isoformat(),
        "as_of": config.AS_OF_DATE.isoformat(),
        "current_month": config.current_month(),
        "checkpoint_month": config.last_completed_month(),
        "source": config.SOURCE_NAME,
        "unknown_bucket": config.UNKNOWN,
    }


@router.post("/demo/reset")
def reset_demo():
    """Throw away every edit and regenerate the synthetic dataset."""
    stats = rebuild()
    cache.invalidate()
    return {"reset": True, **stats}
