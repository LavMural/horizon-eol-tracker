#!/usr/bin/env bash
# One-command launcher: sets up the backend, builds the frontend, and serves the whole
# app at http://localhost:8000. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

echo "==> Backend: Python environment"
if [ ! -d backend/.venv ]; then
  python3 -m venv backend/.venv
fi
backend/.venv/bin/pip install -q --upgrade pip
backend/.venv/bin/pip install -q -r backend/requirements.txt

if [ -d frontend ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "==> Frontend: install and build"
    (cd frontend && npm install --silent && npm run build --silent)
  elif [ ! -d frontend/dist ]; then
    echo "!! npm not found and no prebuilt frontend; only the API will be available." >&2
  fi
fi

echo "==> Horizon running at http://localhost:${PORT}  (API docs at /docs, Ctrl+C to stop)"
cd backend
exec .venv/bin/uvicorn app.main:app --port "$PORT"
