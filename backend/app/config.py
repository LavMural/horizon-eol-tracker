"""Static configuration for the Horizon demo.

Everything here describes the (synthetic) program being tracked: which OS versions are
end-of-life, the reporting window, the baseline date, and the point-in-time "as of" date
the mock dataset represents. The app never reads the wall clock for business logic --
"current month" always means the month of AS_OF_DATE, so the dashboard looks the same no
matter when it is opened.
"""
from __future__ import annotations

import os
from datetime import date
from pathlib import Path

APP_NAME = "Horizon"
APP_TAGLINE = "End-of-Life Tracker"

# Name of the system of record the Actuals come from (shown as "Source: CMDB").
SOURCE_NAME = "CMDB"

# The two EOL operating systems the program is retiring.
TRACKED_OS = ["Ubuntu 16.04", "Oracle 7"]

# Reporting window for plans and burndown charts (inclusive), as YYYY-MM.
MONTH_START = "2026-06"
MONTH_END = "2027-07"

# Baseline: the fixed host population the program measures progress against.
BASELINE_DATE = date(2026, 6, 15)

# Point in time the mock dataset represents (the "latest refresh").
AS_OF_DATE = date(2026, 9, 15)

# Bucket for hosts whose portfolio can't be determined.
UNKNOWN = "Unknown"

# Seed for the mock-data generator; the same seed always yields the same dataset.
MOCK_SEED = 20260615

BACKEND_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("HORIZON_DB_PATH", BACKEND_DIR / "data" / "horizon.db"))
FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"


def months() -> list[str]:
    """All YYYY-MM keys in the reporting window."""
    y, m = map(int, MONTH_START.split("-"))
    end = MONTH_END
    out = []
    while True:
        key = f"{y:04d}-{m:02d}"
        out.append(key)
        if key == end:
            return out
        m += 1
        if m > 12:
            y, m = y + 1, 1


def current_month() -> str:
    return AS_OF_DATE.strftime("%Y-%m")


def last_completed_month() -> str | None:
    """Most recent month in the window that has fully ended as of AS_OF_DATE.

    On-track/behind is judged only against decommissions due through this month, so an
    owner isn't marked behind for a month that is still in progress.
    """
    done = [m for m in months() if m < current_month()]
    return done[-1] if done else None
