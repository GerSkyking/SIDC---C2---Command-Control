import os
import tempfile
from pathlib import Path

import pytest

_tmp = Path(tempfile.mkdtemp(prefix="sidc-test-"))
os.environ.update(
    DATABASE_URL=f"sqlite:///{_tmp / 'test.db'}",
    SECRET_KEY="test-secret-key-0123456789",
    BOOTSTRAP_ADMIN_USER="admin",
    BOOTSTRAP_ADMIN_PASSWORD="test-admin-pass-123",
    UPLOADS_DIR=str(_tmp),
    MAPS_DIR=str(_tmp / "maps"),
    REDIS_URL="redis://127.0.0.1:0/0",  # nicht erreichbar -> In-Process-Fallback
)

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_ratelimits():
    """Der Login-Limiter (8/min je Nutzer) würde bei vielen Tests mit Admin-Login anschlagen."""
    from app import ratelimit

    ratelimit._hits.clear()
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def admin(client):
    client.post("/auth/login", json={"username": "admin", "password": "test-admin-pass-123"})
    return client
