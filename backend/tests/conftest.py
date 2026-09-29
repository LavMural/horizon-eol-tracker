import os
import sys
import tempfile
from pathlib import Path

# Use a throwaway database so tests never touch data/horizon.db.
os.environ["HORIZON_DB_PATH"] = str(Path(tempfile.mkdtemp()) / "test.db")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="session")
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c
