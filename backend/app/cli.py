"""Betriebs-CLI (im Container):  python -m app.cli reset-password <benutzer> [--password ...]

Setzt das Passwort eines lokalen Kontos neu (z. B. das geschützte Bootstrap-Admin-Konto,
dessen Passwort sich nicht über die Oberfläche ändern lässt). Das Konto bleibt erhalten
(gleiche ID, alle Daten und Rechte unverändert); aktive Sessions und API-Tokens werden
ungültig. Ohne --password wird ein zufälliges Passwort erzeugt und einmalig ausgegeben.
"""
from __future__ import annotations

import argparse
import getpass
import secrets
import sys
from datetime import datetime, timezone

from sqlalchemy import select

from .db import SessionLocal
from .models import ApiToken, User
from .security import MIN_PASSWORD_LEN, hash_password


def reset_password(username: str, password: str) -> str | None:
    """Gibt None bei Erfolg zurück, sonst eine Fehlermeldung."""
    if len(password) < MIN_PASSWORD_LEN:
        return f"Passwort min. {MIN_PASSWORD_LEN} Zeichen"
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == username))
        if user is None:
            return f"Benutzer '{username}' nicht gefunden"
        if not user.password_hash:
            return f"'{username}' ist ein OIDC-Konto ohne lokales Passwort"
        user.password_hash = hash_password(password)
        user.session_epoch = (user.session_epoch or 0) + 1  # alle Sessions ungültig
        now = datetime.now(timezone.utc)
        for tok in db.scalars(select(ApiToken).where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))):
            tok.revoked_at = now
        db.commit()
    return None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    rp = sub.add_parser("reset-password", help="Passwort eines lokalen Kontos neu setzen")
    rp.add_argument("username")
    rp.add_argument("--password", help="Neues Passwort (sonst zufällig; --prompt zum Eintippen)")
    rp.add_argument("--prompt", action="store_true", help="Passwort interaktiv abfragen")
    args = p.parse_args(argv)

    generated = False
    if args.prompt:
        pw = getpass.getpass("Neues Passwort: ")
        if pw != getpass.getpass("Wiederholen: "):
            print("Passwörter stimmen nicht überein", file=sys.stderr)
            return 1
    elif args.password:
        pw = args.password
    else:
        pw, generated = secrets.token_urlsafe(18), True

    err = reset_password(args.username, pw)
    if err:
        print(f"Fehler: {err}", file=sys.stderr)
        return 1
    print(f"Passwort für '{args.username}' gesetzt. Sessions und API-Tokens wurden widerrufen.")
    if generated:
        print(f"Neues Passwort (nur jetzt sichtbar): {pw}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
