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


class FakeOidcClient:
    """Ersetzt den authlib-Client: liefert die gesetzten Claims so, wie authlib sie nach
    geprüftem ID-Token unter ``token["userinfo"]`` ablegt. Kein Netz, kein Provider."""

    issuer = "https://idp.example.test/application/o/c2/"

    def __init__(self) -> None:
        self.claims: dict = {}

    async def authorize_access_token(self, request, **kwargs):
        return {"access_token": "fake", "userinfo": dict(self.claims)}

    def callback(self, client, **claims):
        """Einen OIDC-Rückruf mit diesen Claims auslösen (ohne Redirects zu folgen)."""
        self.claims = {"iss": self.issuer, **claims}
        return client.get("/auth/oidc/callback?code=fake&state=fake", follow_redirects=False)


@pytest.fixture
def oidc(monkeypatch):
    """OIDC einschalten und den Provider fälschen (authlib wird nicht aufgerufen)."""
    from types import SimpleNamespace

    from app.routers import auth

    fake = FakeOidcClient()
    monkeypatch.setattr(auth, "_OIDC_READY", True)
    monkeypatch.setattr(auth, "_oauth", SimpleNamespace(oidc=fake))
    return fake


@pytest.fixture
def cfg(monkeypatch):
    """Einstellungen für einen Test setzen: ``cfg(oidc_required_groups="a,b")``."""
    from app.config import get_settings

    s = get_settings()

    def _set(**values):
        for key, value in values.items():
            assert hasattr(s, key), key
            monkeypatch.setattr(s, key, value)

    return _set
