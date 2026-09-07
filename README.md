# SIDC – C2 – Command & Control

Browser-basiertes, mehrbenutzerfähiges Einsatz-Planungstool auf Basis der Karten- und
Markerlogik von **ATAKmaps** – aber ohne Ingame-Anbindung. Nutzer melden sich an,
wählen eine Karte, und setzen gemeinsam in Echtzeit Marker und Zeichnungen.

> Status (2026-09-07): lauffähig und deployt, Phasen 0–9 im Wesentlichen umgesetzt.
> **Vollständiges Handbuch: [`docs/HANDBUCH.md`](docs/HANDBUCH.md).**
> Stufenplan & Abweichungen: [`PLAN.md`](PLAN.md).

## Features

- Login: lokaler Bootstrap-Admin **+** optional externes OIDC
- Nutzer, Gruppen, feingranulare Rechte pro Plan (`viewer` / `editor` mit
  setzen/bewegen/löschen/malen / `owner`) und Capability „darf Pläne erstellen"
- Karten-Import per **Download-Link oder Direkt-Upload** (Admin-UI), inkl. Karten-Update
  und DLC-Zoomstufen; Tileserver + `style.json` im Backend
- Voller **Marker-Wizard** wie ATAKmaps (QuickMenü + Katalog + „Advanced"-Modifikatoren),
  Symbol-Rendering über milsymbol.js mit PNG-Fallback, Richtungspfeile
- Werkzeuge: Bewegen, Marker verschieben, Zeigen (Laser-Cursor), gerade Linien, **Lineal**,
  Radierer, Marker, Favoriten
- **Zeitstrahl / Phasen** (Marker je Phase, Transparenz für Fremdphasen) + verschiebbares
  **Markdown-Notizfenster** je Phase
- **Kompass**, „nach Norden", **Screenshot** (nur Karteninhalt, militärischer DTG),
  Koordinaten-Grid mit Randbeschriftung, 2D = nur Drehen, Kamera-Grenzen
- **Höhenlinien** (alle 10 m) und **dominante Höhenpunkte** aus der Heightmap –
  im ATAKmaps-Importer vorberechnet, in beiden Tools als Ebene zuschaltbar
- Echtzeit-Kollaboration (WebSocket, autoritativer Server) – Marker & Zeichnungen
- Pläne: **Ordner/Unterordner mit Drag & Drop**, erstellen, klonen (in Zielordner),
  **Versionsverlauf** mit Wiederherstellen, löschen (Trash)
- Öffentliche Nur-Ansehen-Links, Admin-Bereich (Nutzer/Gruppen/Kataloge/Karten/Audit-Log),
  UI zweisprachig DE/EN, Karten-Labels in 13 Sprachen

## Architektur

| Komponente | Technik |
|---|---|
| Backend | FastAPI (Python), SQLAlchemy 2.0 (Schema via `create_all` + Auto-`ALTER TABLE`, noch kein Alembic) |
| Frontend | TypeScript + Vite + MapLibre-GL 5 + milsymbol.js (im Backend-Image mitgebaut) |
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

Tests: `cd backend && pip install -r requirements-dev.txt && pytest -q`

> Hinweis: Enthält der lokale Repo-Pfad ein `&` (wie „SIDC - C2 - Command & Control"),
> brechen npm-Scripts unter Windows. Dann `npm run build` durch
> `node ./node_modules/vite/bin/vite.js build` ersetzen — der Docker-Build ist nicht betroffen.

## Lizenz

[AGPL-3.0](LICENSE)
