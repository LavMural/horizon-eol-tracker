"""Rebuild data/horizon.db from scratch with the synthetic demo dataset."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.mockdata import rebuild  # noqa: E402

if __name__ == "__main__":
    stats = rebuild()
    print(f"Wrote {config.DB_PATH}: {stats['hosts']:,} hosts, {stats['owners']} owners, "
          f"{stats['plan_lines']} plan lines")
