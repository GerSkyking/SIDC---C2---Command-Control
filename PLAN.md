# SIDC – C2 – Command & Control — Umsetzungsplan

Browser-basiertes, mehrbenutzerfähiges Einsatz-Planungstool, abgeleitet vom
ATAKmaps-Mod (`D:\Mods\ATAKmaps`). **Keine Ingame-Daten** — reines Online-Planungstool.
Auslieferung als Docker-Compose-Stack, installierbar auf einem Linux-Server.
Später Open Source (AGPL-3.0).

## Architektur-Entscheidungen

| Bereich | Entscheidung |
|---|---|
| Backend | FastAPI (Python). Übernimmt Marker-/SIDC-Logik, `maps_registry` und Tileserver-Routen weitgehend 1:1 aus ATAKmaps. |
| Frontend | TS + Vite + MapLibre-GL. `web/src/sidc-marker` wird portiert (Game-Bridge & SSE-Livewatcher raus, WebSocket rein). |
| DB | PostgreSQL (SQLAlchemy + Alembic). |
| Realtime | Autoritativer Server + WebSocket, ein Raum pro Plan. Anlegen/Freihandmalen = optimistisch clientseitig, danach Server-Bestätigung. Verschieben/Ändern/Löschen/Sperren = nur über Server-Auth. Redis als Pub/Sub-Backplane. |
| Auth | Lokaler Bootstrap-Admin aus `.env` + optional externes OIDC (generisch, `authlib`). Vorbild: Arma-Reforger-Mod-Manager — signierter HttpOnly-Session-Cookie, PBKDF2-SHA256, Login-Ratelimit, unbekannte OIDC-User → Rolle `user`. |
| Kartendaten | Admin trägt in der Web-UI einen Download-Link ein → Backend lädt die exportierte ZIP, entpackt nach `/data/maps/<id>` (eigenes, quasi-statisches Volume). |
| Reverse Proxy | **Nicht im Stack.** Extern via Nginx Proxy Manager (192.168.1.100), macht TLS + externen Zugriff. Backend-Container = einziger Einstiegspunkt, serviert Frontend + API + WS auf einem Port (`HTTP_PORT`, Default 8080). |

## Berechtigungsmodell

- **Globale Rolle:** `admin` (Vollzugriff) / `user`.
- **Gruppen:** benannt, n:m zu Usern.
- **Plan-ACL:** Einträge `{subjekt: user|gruppe, level: viewer|editor|owner}`
  - `viewer` – Plan + Marker sehen, nichts ändern
  - `editor` – Marker anlegen/verschieben/ändern/löschen + zeichnen
  - `owner` – wie editor + ACL verwalten, Plan umbenennen/klonen/löschen
- **Capability** `can_create_plans` – Flag auf User oder Gruppe.
- **Karten-Sichtbarkeit** (optional): pro Gruppe/User einschränkbar, welche Karten als Plan-Basis erlaubt sind.
- **Objekt-Lock:** Marker sperrbar (wie ATAKmaps `locked`); gesperrte Marker nur von Plan-`owner` änderbar.

## Zeitstrahl · Phasen · Layer

- **Zeitstrahl** oben in der UI. Start = **global**; der User kann **Phasen** anlegen
  (optional mit Zeitpunkt).
- Jeder Marker/Stroke gehört zu **einer Phase** (oder global, `phase_id = NULL`).
- Innerhalb einer Phase gibt es **Layer** (z. B. je Platoon). Ein Layer kann an eine
  **Gruppe** gebunden sein → nur diese Gruppe (plus Plan-`owner`/`admin`) sieht/bearbeitet
  ihn. Zusätzlich blendet jeder User Layer clientseitig ein/aus.
- Datenmodell steht bereits (`phases`, `layers`, `markers.phase_id/layer_id`,
  `strokes.phase_id/layer_id`); UI + CRUD + Live-Events folgen in Phase 7.

---

## Stufenplan

**Stand 2026-09-06:** Phasen 0–2 ✅, Phase 3 teilweise (Verwaltung ✅, Tile-Routen offen),
Phasen 5 & 6 als minimaler Durchstich ✅ (CRUD/ACL/Klonen/Versionen + Live-Marker mit
Server-Autorität, 5 pytest grün). **Bereit für ersten Deploy-Test auf dem Server.**
Offen bis „fertig": Alembic-Baseline (aktuell `create_all`), Tile-/style.json-Portierung,
volles sidc-marker-Frontend, Zeitstrahl/Phasen/Layer-UI, Admin-UI, Hardening.

### Phase 0 – Repo & Grundgerüst  ✅
- [ ] Monorepo-Struktur: `backend/`, `frontend/`, `deploy/`, `data/` (gemountet, im Repo leer).
- [ ] `docker-compose.yml`-Skelett: `db` (Postgres), `redis`, `backend`. Portmapping `${HTTP_PORT:-8080}:8080`.
- [ ] `deploy/.env.example` vollständig: `HTTP_PORT`, `POSTGRES_*`, `DATABASE_URL`, `REDIS_URL`, `SECRET_KEY`, `BOOTSTRAP_ADMIN_USER/PASSWORD`, `FORWARDED_ALLOW_IPS`, `COOKIE_SECURE=auto|true|false`, `OIDC_*` (optional), `MAP_IMPORT_MAX_MB`.
- [ ] `LICENSE` (AGPL-3.0), `.gitignore` (`data/`, `*.env`, Volume-Files), `README` (Grundgerüst).
- [ ] Bestehende ATAKmaps-Module markieren, die übernommen werden: `sidc_profiles`, `sidc_marker_requests` (→ DB-Variante), `pipeline/maps_registry`, Tile-Reader aus `server/app.py`.

### Phase 1 – Datenmodell & Migrationen (Alembic)
- [ ] Tabellen: `users`, `groups`, `group_members`, `oidc_identities`, `sessions` (oder Cookie-signiert), `maps`, `plans`, `plan_acl`, `plan_capabilities`, `markers`, `strokes`, `plan_versions`, `audit_log`.
- [ ] Marker-Schema aus ATAKmaps `SidcMarkerCreate` übernehmen (sidc, worldX/Y, rotation, unitText, aiText, linkedGroupId, pointIndex, lineColor/lineWidth, locked …) + `plan_id`, `created_by`, `updated_at`.

### Phase 2 – Auth
- [ ] Bootstrap-Admin aus `.env` beim Start (idempotent).
- [ ] `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`. Signierter HttpOnly-Cookie, 7-Tage-TTL, Ratelimit (IP+User).
- [ ] OIDC: `GET /auth/oidc/login`, `GET /auth/oidc/callback` → User anlegen/verknüpfen, Rolle `user`. Per `.env` an-/abschaltbar, lokaler Login bleibt parallel.
- [ ] uvicorn `--proxy-headers`, `FORWARDED_ALLOW_IPS` aus `.env`. Cookie `Secure` gemäß `COOKIE_SECURE` / `X-Forwarded-Proto`.
- [ ] `SECRET_KEY` aus `.env`; falls leer, beim ersten Start generieren und in Volume-File schreiben.
- [ ] FastAPI-Dependencies `current_user`, `require_admin`, `require_plan_level(plan_id, level)`.

### Phase 3 – Kartendaten-Verwaltung
- [ ] `POST /admin/maps/import {url}` → ZIP streamen (Größenlimit), Struktur validieren, nach `/data/maps/<id>` entpacken, `maps`-Eintrag.
- [ ] `GET /maps` (nach Sichtbarkeit gefiltert), `DELETE /admin/maps/<id>`.
- [ ] Tile-Routen + `style.json` + `/api/meta` aus ATAKmaps `server/app.py` übernehmen (map_id kommt aus dem Plan).
- [ ] SIDC-Katalog-Endpoints (`/api/sidc/catalog`, `/quick-menu`, `/phaseline-style`) auf das Map-Verzeichnis umbiegen.

### Phase 4 – Frontend-Shell
- [ ] Login-Seite, Session-Guard, Karten-/Plan-Auswahlseite nach Login.
- [ ] `sidc-marker`-Modul portieren: `bridge.ts` + `liveState.ts` durch WebSocket-Client + lokalen Store ersetzen. Rendering, Edit-Panel, Context-Menu, DirectionPicker, QuickMenu bleiben.

### Phase 5 – Plan-CRUD + Rechte
- [ ] `POST /plans` (braucht `can_create_plans`), `GET /plans`, `GET /plans/<id>`, `PATCH`, `DELETE` (Soft-Delete/Trash).
- [ ] `GET/PUT /plans/<id>/acl` (nur owner/admin).
- [ ] Plan-Picker-UI mit Rollen-Badges; „Neuer Plan" nur bei Capability.

### Phase 6 – Realtime-Kollaboration
- [ ] `WS /plans/<id>/live` – Handshake per Cookie authentifiziert, prüft Plan-Level.
- [ ] Protokoll: `marker.create|move|modify|delete|lock`, `stroke.begin|append|commit`, `presence.cursor`, `snapshot`.
- [ ] Server-Autorität: create/stroke annehmen → DB → Broadcast (Client-Reconcile per Server-ID). move/modify/delete/lock serverseitig gegen Rechte + Lock prüfen → persistieren → Broadcast; Ablehnung → `reject` mit Rollback.
- [ ] Redis Pub/Sub-Backplane. Presence/Cursor anderer User.
- [ ] NPM-Proxy-Host: „Websockets Support" aktivieren (Doku).

### Phase 7 – Marker-/Zeichen-Funktionsparität
- [ ] SIDC-QuickMenu, Katalog, Phase-Lines, Freihand, Marker-Edit (Text/Rotation/SIDC/Lock), Sichtbarkeits-/Layer-Logik aus ATAKmaps — ohne „client verified".
- [ ] Undo/Redo pro User (lokaler Stack, sendet inverse Server-Kommandos).

### Phase 8 – Plan-Lifecycle
- [ ] Klonen: `POST /plans/<id>/clone` (ACL übernehmen/leeren wählbar).
- [ ] Versionierte Snapshots: `plan_versions`, `POST /plans/<id>/versions`, `POST /plans/<id>/restore/<ver>`.
- [ ] Export/Import: JSON-Download/-Upload eines Plans.
- [ ] Löschen: Trash + endgültig (admin/owner).

### Phase 9 – Admin-UI
- [ ] User-Verwaltung (anlegen, Passwort-Reset, Rolle, `can_create_plans`), Gruppen + Mitglieder, Karten-Import/-Liste, Audit-Log-Ansicht.

### Phase 10 – Hardening & Deployment
- [ ] Security-Header, CORS zu (same-origin über einen Port).
- [ ] Healthchecks, `restart: unless-stopped`, Resource-Limits.
- [ ] `pg_dump`-Backup-Container (Cron) auf ein Volume.
- [ ] Strukturiertes Logging.
- [ ] README: NPM-Setup (Proxy Host, Websockets an, Port 8080), Bootstrap-Admin, Karten-Import.
- [ ] GHCR-Image-Build via GitHub Actions → User macht nur `docker compose up -d`.
- [ ] Tests: pytest (Auth, Rechte-Matrix, Marker-CRUD), WS-Integrationstest (zwei Clients, Konfliktfall).
