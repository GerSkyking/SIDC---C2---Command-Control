# SIDC – C2 – Command & Control

Browser-basiertes, mehrbenutzerfähiges Einsatz-Planungstool auf Basis der Karten- und
Markerlogik von **ATAKmaps** – aber ohne Ingame-Anbindung. Nutzer melden sich an,
wählen eine Karte, und setzen gemeinsam in Echtzeit Marker und Zeichnungen.

> Status: **Phase 0** (Grundgerüst). Siehe [`PLAN.md`](PLAN.md) für den vollständigen Stufenplan.

## Features (Zielbild)

- Login: lokaler Bootstrap-Admin **+** optional externes OIDC
- Nutzer, Gruppen, feingranulare Rechte pro Plan (`viewer` / `editor` / `owner`) und
  Capability „darf Pläne erstellen"
- Karten liegen als vorbereitete Pakete in einem Datenverzeichnis; Import per Download-Link
  über die Admin-UI
- Echtzeit-Kollaboration (WebSocket, autoritativer Server) – Marker & Freihandzeichnen
- Pläne: erstellen, klonen, versioniert speichern/laden, exportieren/importieren, löschen

## Architektur

| Komponente | Technik |
|---|---|
| Backend | FastAPI (Python), SQLAlchemy + Alembic |
| Frontend | TypeScript + Vite + MapLibre-GL (im Backend-Image mitgebaut) |
| DB | PostgreSQL |
| Realtime-Backplane | Redis Pub/Sub |
| TLS / externer Zugriff | **extern** (z. B. Nginx Proxy Manager) – kein Proxy im Stack |

Der Backend-Container ist der einzige Einstiegspunkt und liefert Frontend + API + WebSocket
auf einem Port (`HTTP_PORT`, Default `8080`).

## Schnellstart

```bash
cp deploy/.env.example .env
# .env anpassen: Passwörter, SECRET_KEY (oder leer -> auto), FORWARDED_ALLOW_IPS
docker compose up -d
```

Anschließend im **Nginx Proxy Manager** einen Proxy Host auf `http://<docker-host>:8080`
anlegen und **„Websockets Support"** aktivieren.

Erst-Login mit `BOOTSTRAP_ADMIN_USER` / `BOOTSTRAP_ADMIN_PASSWORD` aus der `.env`.

## Entwicklung

```bash
# Backend
cd backend && python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8080

# Frontend (zweites Terminal)
cd frontend && npm install && npm run dev
```

## Lizenz

[AGPL-3.0](LICENSE)
