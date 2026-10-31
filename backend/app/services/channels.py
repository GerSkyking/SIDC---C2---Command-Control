"""Externe Zustellkanäle für Benachrichtigungen – bewusst als Plugin-Registry gebaut.

Ein Kanal-Typ ist eine ``Provider``-Klasse mit Feldbeschreibung (``fields``, daraus baut das Frontend das
Formular) und einer ``send``-Methode. Neue Anbindungen (Telegram, Slack …) sind eine weitere Klasse mit
``@register`` – Datenbank, API und Oberfläche brauchen dafür keine Änderung.

Geheimnisse (Tokens, Webhook-URLs) werden verschlüsselt gespeichert (Fernet, Schlüssel aus SECRET_KEY) und
nie an den Browser zurückgegeben. Zieladressen werden gegen interne Netze geprüft (SSRF-Schutz), solange
``NOTIFY_ALLOW_PRIVATE_HOSTS`` nicht gesetzt ist.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import smtplib
import socket
import uuid
from dataclasses import dataclass
from email.message import EmailMessage
from typing import ClassVar
from urllib.parse import quote, urlsplit

import httpx
from cryptography.fernet import Fernet, InvalidToken

from ..config import get_settings

log = logging.getLogger("sidc.channels")

_TIMEOUT = 10.0
_ENC = "enc:"


class ChannelError(Exception):
    """Zustellung fehlgeschlagen (Text wird dem Nutzer am Kanal angezeigt)."""


class ChannelGone(ChannelError):
    """Ziel existiert nicht mehr (z. B. abgelaufene Web-Push-Registrierung) – Kanal kann entfernt werden."""


@dataclass
class Msg:
    kind: str
    headline: str
    text: str = ""
    url: str = ""
    actor: str = ""

    def plain(self) -> str:
        parts = [self.headline]
        if self.text:
            parts.append(self.text)
        if self.url:
            parts.append(self.url)
        return "\n".join(parts)


# ─── Geheimnisse ─────────────────────────────────────────────────────────────

def _fernet() -> Fernet:
    key = hashlib.sha256(("notify|" + get_settings().resolved_secret_key()).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def _seal(v: str) -> str:
    return _ENC + _fernet().encrypt(v.encode()).decode()


def _open(v: str) -> str:
    if not v.startswith(_ENC):
        return v
    try:
        return _fernet().decrypt(v[len(_ENC):].encode()).decode()
    except InvalidToken:
        return ""


# ─── SSRF-Schutz ─────────────────────────────────────────────────────────────

def check_url(url: str) -> str:
    """Prüft Schema und Zieladresse einer vom Nutzer angegebenen URL. Gibt die URL (ohne Leerraum) zurück."""
    url = (url or "").strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ChannelError("Ungültige URL (http:// oder https:// erforderlich)")
    if get_settings().notify_allow_private_hosts:
        return url
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80),
                                   type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ChannelError(f"Adresse nicht auflösbar: {parts.hostname}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_unspecified or ip.is_multicast:
            raise ChannelError("Interne Adressen sind nicht erlaubt (NOTIFY_ALLOW_PRIVATE_HOSTS)")
    return url


def _http(method: str, url: str, **kw) -> httpx.Response:
    url = check_url(url)
    try:
        # Keine Weiterleitungen folgen: sonst ließe sich die Prüfung über einen Redirect umgehen.
        r = httpx.request(method, url, timeout=_TIMEOUT, follow_redirects=False, **kw)
    except httpx.HTTPError as exc:
        raise ChannelError(f"Verbindung fehlgeschlagen: {type(exc).__name__}") from exc
    if r.status_code in (404, 410):
        raise ChannelGone(f"HTTP {r.status_code}")
    if r.status_code >= 300:
        raise ChannelError(f"HTTP {r.status_code}: {r.text[:120]}")
    return r


# ─── Provider ────────────────────────────────────────────────────────────────

REGISTRY: dict[str, type["Provider"]] = {}


def register(cls: type["Provider"]) -> type["Provider"]:
    REGISTRY[cls.type] = cls
    return cls


class Provider:
    type: ClassVar[str] = ""
    label: ClassVar[str] = ""
    help: ClassVar[str] = ""
    # Felder: key, label, secret (verschlüsseln + nie zurückgeben), required, placeholder
    fields: ClassVar[list[dict]] = []
    # False = Nutzer legt den Kanal nicht per Formular an (z. B. Web-Push über die Browser-Anmeldung)
    form: ClassVar[bool] = True

    @classmethod
    def available(cls) -> bool:
        return True

    @classmethod
    def validate(cls, cfg: dict) -> None:
        for f in cls.fields:
            if f.get("required") and not str(cfg.get(f["key"], "")).strip():
                raise ChannelError(f"{f['label']} fehlt")

    def send(self, cfg: dict, m: Msg) -> None:  # pragma: no cover - interface
        raise NotImplementedError


def _f(key: str, label: str, *, secret: bool = False, required: bool = True, placeholder: str = "") -> dict:
    return {"key": key, "label": label, "secret": secret, "required": required, "placeholder": placeholder}


@register
class DiscordWebhook(Provider):
    type = "discord"
    label = "Discord (Webhook)"
    help = "Serverkanal → Einstellungen → Integrationen → Webhooks → URL kopieren. Nachrichten erscheinen im Kanal; Erwähnungen werden nicht ausgelöst."
    fields = [_f("url", "Webhook-URL", secret=True, placeholder="https://discord.com/api/webhooks/…")]
    _RE = re.compile(r"^https://(?:[\w-]+\.)?(?:discord|discordapp)\.com/api(?:/v\d+)?/webhooks/\d+/[\w-]+/?$")

    @classmethod
    def validate(cls, cfg: dict) -> None:
        super().validate(cfg)
        if not cls._RE.match(str(cfg["url"]).strip()):
            raise ChannelError("Das ist keine Discord-Webhook-URL")

    def send(self, cfg: dict, m: Msg) -> None:
        body = f"**{m.headline}**" + (f"\n> {m.text[:300]}" if m.text else "") + (f"\n{m.url}" if m.url else "")
        _http("POST", cfg["url"], json={"username": "SIDC C2", "content": body[:1900], "allowed_mentions": {"parse": []}})


@register
class Ntfy(Provider):
    type = "ntfy"
    label = "ntfy (Push aufs Smartphone)"
    help = "App „ntfy“ installieren, ein schwer erratbares Thema abonnieren und hier eintragen. Eigener Server möglich."
    fields = [
        _f("server", "Server (leer = ntfy.sh)", required=False, placeholder="https://ntfy.sh"),
        _f("topic", "Thema", placeholder="sidc-mein-geheimes-thema"),
        _f("token", "Zugriffstoken (optional)", secret=True, required=False),
    ]

    def send(self, cfg: dict, m: Msg) -> None:
        payload = {"topic": cfg["topic"], "title": m.headline[:120], "message": (m.text or m.headline)[:500]}
        if m.url:
            payload["click"] = m.url
        headers = {"Authorization": f"Bearer {cfg['token']}"} if cfg.get("token") else {}
        _http("POST", cfg.get("server") or "https://ntfy.sh", json=payload, headers=headers)


@register
class Gotify(Provider):
    type = "gotify"
    label = "Gotify"
    help = "Eigener Gotify-Server: Anwendung anlegen und deren Token eintragen."
    fields = [_f("server", "Server", placeholder="https://gotify.example.org"), _f("token", "Anwendungs-Token", secret=True)]

    def send(self, cfg: dict, m: Msg) -> None:
        payload: dict = {"title": m.headline[:120], "message": (m.text or m.headline)[:500], "priority": 5}
        if m.url:
            payload["extras"] = {"client::notification": {"click": {"url": m.url}}}
        _http("POST", cfg["server"].rstrip("/") + "/message", json=payload, headers={"X-Gotify-Key": cfg["token"]})


@register
class Matrix(Provider):
    type = "matrix"
    label = "Matrix"
    help = "Bot-/Benutzerkonto auf deinem Homeserver mit Zugriffstoken; das Konto muss im Raum sein."
    fields = [
        _f("homeserver", "Homeserver", placeholder="https://matrix.example.org"),
        _f("room_id", "Raum-ID", placeholder="!abc123:example.org"),
        _f("token", "Zugriffstoken", secret=True),
    ]

    def send(self, cfg: dict, m: Msg) -> None:
        room = quote(cfg["room_id"], safe="")
        url = f"{cfg['homeserver'].rstrip('/')}/_matrix/client/v3/rooms/{room}/send/m.room.message/{uuid.uuid4().hex}"
        _http("PUT", url, json={"msgtype": "m.text", "body": m.plain()}, headers={"Authorization": f"Bearer {cfg['token']}"})


@register
class GenericWebhook(Provider):
    type = "webhook"
    label = "Webhook (JSON)"
    help = "Schickt jede Benachrichtigung als JSON an eine URL (Node-RED, n8n, Home Assistant, eigene Bots …). Optional mit HMAC-Signatur im Header X-SIDC-Signature."
    fields = [_f("url", "URL", placeholder="https://…"), _f("secret", "Signatur-Geheimnis (optional)", secret=True, required=False)]

    def send(self, cfg: dict, m: Msg) -> None:
        body = json.dumps({"kind": m.kind, "headline": m.headline, "text": m.text, "url": m.url, "actor": m.actor},
                          ensure_ascii=False).encode()
        headers = {"Content-Type": "application/json"}
        if cfg.get("secret"):
            headers["X-SIDC-Signature"] = "sha256=" + hmac.new(cfg["secret"].encode(), body, hashlib.sha256).hexdigest()
        _http("POST", cfg["url"], content=body, headers=headers)


@register
class Email(Provider):
    type = "email"
    label = "E-Mail"
    help = "Der Server muss dafür SMTP konfiguriert haben (SMTP_HOST …)."
    fields = [_f("address", "E-Mail-Adresse", placeholder="du@example.org")]

    @classmethod
    def available(cls) -> bool:
        return bool(get_settings().smtp_host and get_settings().smtp_from)

    @classmethod
    def validate(cls, cfg: dict) -> None:
        super().validate(cfg)
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", str(cfg["address"]).strip()):
            raise ChannelError("Ungültige E-Mail-Adresse")

    def send(self, cfg: dict, m: Msg) -> None:
        s = get_settings()
        msg = EmailMessage()
        msg["Subject"] = m.headline[:150].replace("\n", " ")
        msg["From"] = s.smtp_from
        msg["To"] = cfg["address"].strip()
        msg.set_content(m.plain())
        try:
            with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=_TIMEOUT) as smtp:
                if s.smtp_starttls:
                    smtp.starttls()
                if s.smtp_user:
                    smtp.login(s.smtp_user, s.smtp_password)
                smtp.send_message(msg)
        except (OSError, smtplib.SMTPException) as exc:
            raise ChannelError(f"SMTP: {type(exc).__name__}") from exc


# ─── Web-Push (Browser/Smartphone, kein Drittanbieter-Konto nötig) ───────────

def vapid_pem_path():
    return get_settings().uploads_dir / "vapid_private.pem"


def vapid_public_key() -> str:
    """Öffentlicher VAPID-Schlüssel (base64url, unkomprimierter Punkt) – wird beim ersten Aufruf erzeugt."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    path = vapid_pem_path()
    if path.exists():
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    else:
        key = ec.generate_private_key(ec.SECP256R1())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
        path.chmod(0o600)
    raw = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@register
class WebPush(Provider):
    type = "webpush"
    label = "Browser / Smartphone (Web-Push)"
    help = "Mitteilungen direkt im Browser bzw. der installierten Web-App – ohne Zusatzdienst. Auf dem Smartphone die Seite zum Startbildschirm hinzufügen."
    fields = [_f("endpoint", "Endpunkt", secret=True), _f("p256dh", "Schlüssel", secret=True), _f("auth", "Auth", secret=True)]
    form = False

    def send(self, cfg: dict, m: Msg) -> None:
        try:
            from pywebpush import WebPushException, webpush
        except ImportError as exc:  # pragma: no cover
            raise ChannelError("pywebpush nicht installiert") from exc
        vapid_public_key()  # sorgt dafür, dass der Schlüssel existiert
        check_url(cfg["endpoint"])
        payload = json.dumps({"title": m.headline, "body": m.text, "url": m.url, "kind": m.kind}, ensure_ascii=False)
        sub = {"endpoint": cfg["endpoint"], "keys": {"p256dh": cfg["p256dh"], "auth": cfg["auth"]}}
        try:
            webpush(sub, payload, vapid_private_key=str(vapid_pem_path()),
                    vapid_claims={"sub": "mailto:" + (get_settings().smtp_from or "admin@localhost.invalid")}, timeout=_TIMEOUT)
        except WebPushException as exc:
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (404, 410):
                raise ChannelGone(f"HTTP {code}") from exc
            raise ChannelError(f"Web-Push: {str(exc)[:120]}") from exc


# ─── Konfiguration ver-/entschlüsseln, Anzeige ───────────────────────────────

def secret_keys(type_: str) -> set[str]:
    return {f["key"] for f in REGISTRY[type_].fields if f.get("secret")}


def seal_config(type_: str, cfg: dict, old: dict | None = None) -> dict:
    """Prüft ``cfg`` und liefert die zu speichernde (verschlüsselte) Fassung.
    Ein leeres Geheimnisfeld behält den bisherigen Wert (``old``)."""
    prov = REGISTRY[type_]
    plain = {f["key"]: str(cfg.get(f["key"], "") or "").strip() for f in prov.fields}
    for k in secret_keys(type_):
        if not plain[k] and old and old.get(k):
            plain[k] = _open(old[k])
    prov.validate(plain)
    return {k: (_seal(v) if k in secret_keys(type_) and v else v) for k, v in plain.items()}


def open_config(type_: str, cfg: dict) -> dict:
    return {k: (_open(v) if k in secret_keys(type_) and isinstance(v, str) else v) for k, v in (cfg or {}).items()}


def public_config(type_: str, cfg: dict) -> dict:
    """Für den Browser: Nicht-Geheimnisse im Klartext, Geheimnisse nur als gesetzt/nicht gesetzt."""
    sec = secret_keys(type_)
    return {k: ("" if k in sec else v) for k, v in (cfg or {}).items()} | {"_set": [k for k in sec if (cfg or {}).get(k)]}


def type_info() -> list[dict]:
    return [{"type": p.type, "label": p.label, "help": p.help, "fields": p.fields, "form": p.form,
             "available": p.available()} for p in REGISTRY.values()]


def send_to(type_: str, cfg: dict, m: Msg) -> None:
    prov = REGISTRY.get(type_)
    if prov is None:
        raise ChannelError(f"Unbekannter Kanal-Typ {type_}")
    prov().send(open_config(type_, cfg), m)
