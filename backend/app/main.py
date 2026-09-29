"""Horizon API. Also serves the built frontend, so the whole app runs on one port."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .db import init_db
from .mockdata import rebuild
from .routers import actuals, insights, mapping, meta, planned


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # First launch (or deleted database): generate the synthetic dataset.
    if not config.DB_PATH.exists():
        rebuild()
    init_db()
    yield


app = FastAPI(title="Horizon | EOL Tracker API", version="1.0.0", lifespan=lifespan)
for r in (meta, insights, planned, actuals, mapping):
    app.include_router(r.router)

if config.FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "Not found")
        target = config.FRONTEND_DIST / path
        if path and target.is_file():
            return FileResponse(target)
        return FileResponse(config.FRONTEND_DIST / "index.html")
