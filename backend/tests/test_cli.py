from app.cli import main, reset_password


def test_reset_password_keeps_account_and_kills_sessions(admin, client):
    me = admin.get("/auth/me").json()
    assert reset_password("admin", "short") is not None
    assert reset_password("nobody", "a-long-enough-pass-1") is not None
    assert main(["reset-password", "admin", "--password", "brand-new-pass-123"]) == 0
    assert admin.get("/auth/me").status_code == 401  # alte Session ungültig
    r = client.post("/auth/login", json={"username": "admin", "password": "brand-new-pass-123"})
    assert r.status_code == 200
    assert client.get("/auth/me").json()["id"] == me["id"]  # gleiche ID
    # Zustand für andere Tests zurücksetzen
    assert reset_password("admin", "test-admin-pass-123") is None
