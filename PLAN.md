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
  - `editor` – mit feingranularen Häkchen: **setzen / bewegen / löschen / malen** (je an/aus)
  - `owner` – alles + ACL verwalten, Plan umbenennen/klonen/löschen
  - serverseitig durchgesetzt (`live.py` gated jede WS-Op einzeln, `effective_caps()`);
    Editor im Frontend unter „Freigaben" (Plan-Liste + Plan-Kopfleiste, nur Owner). ✅
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

**Version 1.0 (2026-09-07):** Phasen 0–9 umgesetzt und auf dem Server deployt
(11 pytest grün). Vollständige Funktionsbeschreibung: [`docs/HANDBUCH.md`](docs/HANDBUCH.md),
Änderungen: [`CHANGELOG.md`](CHANGELOG.md).

Umgesetzt: Auth (lokal + OIDC), Rollen/Gruppen/ACL mit Einzel-Häkchen + `can_create_plans`,
Karten-Import (Link **und** Direkt-Upload, Update, DLC), Tileserver + `style.json`,
Katalog-Upload (5 Dateien inkl. `SIDC_ModifierCatalog.json`), voller Marker-Wizard
(QuickMenü + Katalog + Advanced-Modifikatoren), Symbol-Rendering milsymbol.js + PNG-Fallback,
Richtungspfeile, Werkzeugleiste (Bewegen/Marker-verschieben/Zeigen/Linie/Lineal/Radierer/
Marker/Favoriten), Rechtsklick-Ende, Zeitstrahl/**Phasen** + Fremdphasen-Transparenz,
**Phasen-Notizen** (verschiebbares Markdown-Fenster, Reiter je Phase), Grid mit
Randbeschriftung, Kompass + Nach-Norden, **Screenshot** (nur Karteninhalt, DTG, Dateiname),
2D-nur-Drehen + Kamera-Grenzen, Map-Locations (nach `baseType`, Sprachwahl), i18n DE/EN,
Public Shares, Audit-Log-UI, **Plan-Ordner** (Baum + Drag & Drop) + Klonen in Ordner,
**Versionsverlauf-UI** (Liste + Wiederherstellen mit Auto-Sicherung), **Hilfe-Overlay**.

Offen bis „fertig": Alembic-Baseline (aktuell `create_all` + `_add_missing_columns`),
Layer-UI innerhalb der Phasen, `.topo`-Straßen-Overlay (Parser noch nicht sauber → in
C2 + ATAKmaps-Viewer deaktiviert), Undo/Redo pro User, Plan-JSON-Export/-Import,
`pg_dump`-Backup-Container, Security-Header-Feinschliff.

### Erweiterungen über den ursprünglichen Plan hinaus

- **Plan-Ordner / Unterordner** mit Drag & Drop (`plan_folders`, `/folders`-CRUD,
  `POST /plans/{id}/move`); Klon-Dialog mit Zielordner.
- **Phasen-Notizen** als eigenes, verschiebbares Fenster mit Markdown und Reiter je Phase
  (`Phase.notes`).
- **Advanced-Modifikatoren**: `SIDC_ModifierCatalog.json` als 5. Katalog; Dropdowns im
  Wizard **und** im Marker-Bearbeiten-Fenster; `withModifiers()` spleißt Stellen 6/7/16-19.
- **Screenshot** mit militärischem DTG-Overlay + datetime-Feld in der Topbar.
- **Kompass** + „nach Norden"-Funktion; **2D = nur Drehen** (kein Pitch); **Kamera-Grenzen**
  (`setMaxBounds` + MinZoom).
- **Lineal**-Werkzeug (Distanz), **Marker-verschieben**-Modus + mittlere Maustaste.
- **Symbol-Rendering hybrid** milsymbol.js (primär) + vorgerendertes PNG (Fallback) +
  Ersatzpunkt; **Richtungspfeile** als Vektor-Geometrie.
- **Hilfe-Overlay** (`?`) mit Werkzeugen/Topbar/Tastenkürzeln.
- **Schema-Drift** wird ohne Alembic über `bootstrap._add_missing_columns()` abgefangen
  (ALTER TABLE ADD COLUMN für neue einfache Spalten beim Start).
- **Höhenlinien + dominante Höhenpunkte** aus der Heightmap: `pipeline/terrain_features.py`
  (Marching-Squares 10 m + lokale Prominenz mit Cutoff/NMS, nur numpy/scipy) erzeugt beim
  Heightmap-Import `contours.geojson` / `peaks.geojson`; Mappack packt sie mit; C2 + ATAKmaps
  laden sie als zuschaltbare Ebene. Heightmap-Loader auf 2‑Pass-Streaming umgestellt
  (3‑GB‑CSV läuft nicht mehr in den RAM).

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
Ziel: **UI und Marker-Workflow so identisch wie möglich zu ATAKmaps** (`D:\Mods\ATAKmaps`).

**7a – Marker-Katalog (serverseitig, Admin-verwaltet)**
- [ ] Admin lädt im Admin-Panel die JSONs aus `LocalMapData` hoch, Server speichert unter `/data/catalog/`:
  `SIDC_AllMarkersCatalog.json`, `SIDC_QuickMarkerMenuCatalog.json`, `SIDC_PhaseLineStyleCatalog.json`,
  `SIDC_ChannelSettings.json`. Endpunkte: `GET /api/catalog/{name}`, `POST /api/admin/catalog/{name}`,
  `DELETE /api/admin/catalog/{name}`. Format = 1:1 wie ingame (nichts umbauen).
- [ ] APP-6D-Icons + Richtungspfeile aus `web/assets/` (852 PNGs, 3 MB) ins Frontend vendored.
- [ ] SIDC-Zusammenbau portiert (`sidc/lookup.ts`: withAffiliation / withAffiliationAndEchelon).

**7b – Marker setzen wie ATAKmaps (voller Wizard)**
- [ ] QuickMarkerMenü-Baum (CategoryRow→Category→SubCategory→Row→Button) dynamisch aus dem Katalog,
  inkl. Suche, `setsIdentity`, `needsAmp`, `needsDirection`, `placeOnClick`.
- [ ] Voller Katalog-Browser (nach Kategorie gruppiert) als Alternative zum QuickMenü.
- [ ] Pro Marker setzbar (alles wie ingame): Affiliation (6), Echelon/Amplifier (14, nur LandUnits),
  Richtung (8 + stationär) → `rotation_degrees`, freie Icon-Rotation → `icon_rotation`,
  `unit_text`, `ai_text`, `channel`, `locked`, `timestamp_visible`.
- [ ] Phase-Line-/Multipoint-Marker (`isMultiPointLine`): Kette aus `linked_group_id`/`point_index`,
  Farbe/Breite aus `SIDC_PhaseLineStyleCatalog.json`, `maxLinePoints`.
- [ ] Marker-Edit-Panel + Kontextmenü (Rechtsklick): alle o. g. Felder nachträglich änderbar, löschen, klonen.

**7c – Werkzeugleiste links**
- [ ] **Bewegen** – Karte greifen/pannen (Standard).
- [ ] **Zeigen** – eigener Cursor wird anderen Nutzern live angezeigt (Laser); nutzt vorhandenes
  `presence.cursor`-Event.
- [ ] **Stift** – Modus zum Malen (Freihand-Stroke) bzw. Marker setzen.
- [ ] **Stern / Favoriten** (pro User): Marker anklicken → „Add favorite" speichert Icon (SIDC) +
  Beschriftung; Favoriten in einer Scroll-Box, auswählbar, per Linksklick platzierbar, löschbar.
  Backend: `GET/POST/DELETE /api/favorites`.

**7d – Kopfleiste / HUD**
- [ ] 2D/3D-Umschalter (Terrain an/aus, Pitch 0↔60). Grid + Maßstab in beiden Modi.
- [ ] Channel-Dropdown (aktueller Channel des Users, aus `SIDC_ChannelSettings.json`).
- [ ] Zeitstrahl oben für Phasen (global + Phasen, optional Zeit) — siehe Abschnitt „Zeitstrahl".
- [ ] Oben rechts: Cursor-Position X/Y (Welt-Koordinaten via Kalibrierung aus Karten-Meta).
- [ ] Grid-Layer (aus `grid.mbtiles`) ein/aus, `maplibregl.ScaleControl` + `NavigationControl`.
- [ ] **Koordinaten-Grid mit Beschriftung an den Bildschirmrändern** (wie ATAKmaps
  `#grid-canvas` / `updateGrid()`): Gitterlinien + X/Y-Beschriftung am Rand, mitlaufend
  beim Pan/Zoom, in 2D und 3D.
- [ ] **Sprachauswahl oben rechts:**
  - global **EN / DE** (UI-Sprache + eigene Labels)
  - separat **Karten-Sprache** (13 Sprachen) für Map-Location-Labels (`_translations.json`)

### Phase 7f – Karten-Import erweitern
- [ ] **Direkt-Upload vom Rechner** (Limit 10 GB) — gestreamt auf Platte, kein Voll-Puffer;
  **plus** weiterhin Download-Link. NPM: `client_max_body_size 10g`.
  ⚠️ Server hat aktuell nur 32 GB Platte — 10-GB-Packs passen nicht (ZIP + Entpackt).
- [ ] **DLC-Zoomstufen:** ZIP kann `mbtiles/dlc/<layer>_z<N>.mbtiles` mitbringen;
  `tiles.py` liefert für Zoom > Basis-maxzoom aus den DLC-mbtiles (ATAKmaps `_effective_maxzoom`).
  DLC auch einzeln nachladbar (`atakmaps-dlc`-ZIP).
- [ ] **`topo` + Map-Locations** in die Mappack-ZIP. Zusammenstellen/Verarbeiten passiert in
  `D:\Mods\ATAKmaps` (`pipeline/map_packages.py` erweitern): raw `.topo` + `mapLocations_*.json`
  mit ins `*_mappack_v*.zip`. `.topo`→GeoJSON und Locations-Parsing dann in **unserem** Backend
  beim Import (Parser testbar an einem Ort).

- [ ] Undo/Redo pro User (lokaler Stack, sendet inverse Server-Kommandos).

**7e – Sammlung (noch offen, Feedback aus dem Test)**
- [ ] **Zeigen-Modus:** Karte fixieren (kein Pan/Zoom-Drag), nur Cursor an andere senden.
- [ ] **Radierer-Werkzeug:** eigener Modus nur zum schnellen Löschen — Klick (oder Ziehen)
  auf einen Marker löscht ihn sofort ohne Rückfrage (braucht `can_delete`).
- [ ] **Stift = gerade Linien:** Klick-für-Klick Stützpunkte statt Freihand; „Linie fertig"-Button;
  vor/beim Zeichnen Farbe + Stärke wählen (aus `SIDC_PhaseLineStyleCatalog.json`).
- [ ] **Verbindungs-Marker:** Markertypen mit `isMultiPointLine=true` (steht in
  `SIDC_AllMarkersCatalog.json`) ziehen eine Linie zwischen den gesetzten Instanzen —
  Kette über `linked_group_id`/`point_index`, `maxLinePoints` beachtet, Linienstil am Anker (pointIndex 0).
- [ ] **`.topo` → Vektor (Option B, gewählt):** Parser für die Enfusion-Binärdatei
  (Magic `TOPO`, Chunks `ROAD`/… , float32-Polylinien in Weltkoordinaten, Export-Modus
  „Geometry 2D") → GeoJSON → MapLibre-Vektor-Layer je Feature-Typ (Straßen/Gewässer/Küste),
  einzeln ein-/ausblendbar, scharf bei jedem Zoom. Kommt als `topo`-Datei mit der Karten-ZIP.
- [ ] **Map Locations:** `mapLocations_locations.json` (+ `_translations.json`) aus dem
  World-Editor-Export → beschriftete Punkte auf der Karte. Felder: `name`/`nameLocalized`,
  `gameCoords [x,y]`, `baseType` (Enum: Harbour/Field/Hill/Bay/Military/Infrastructure/…),
  `commentColor`/`commentBold`/`commentItalic`/`commentSizeCoef` fürs Label-Styling.
  **Nach `baseType` gruppiert**, pro Gruppe ein-/ausblendbar. Kommt mit der Karten-ZIP.

### Phase 8a – Öffentliche Freigaben
- [ ] Owner erzeugt einen öffentlichen Link (Token) für einen Plan → **nur Ansehen**,
  ohne Login. Read-only WS oder statischer Snapshot + Polling. Widerrufbar; optional
  Ablaufdatum. `GET /public/plans/{token}` + `/public/plans/{token}/live` (nur Empfang).

### Phase 9a – Audit-Log (Admin)
- [ ] `AuditLog` befüllen bei: Login-Versuch (Erfolg/Fehlschlag + IP), Logout, User/Gruppe
  angelegt/geändert/gelöscht, Katalog-Upload, Karte importiert/gelöscht, Plan
  erstellt/geklont/gelöscht, ACL geändert, Version gespeichert/wiederhergestellt.
  (Marker-Einzelaktionen optional — sonst wird das Log riesig; ggf. nur „Plan X bearbeitet".)
- [ ] Admin-UI: Reiter „Log" mit Filter (User, Aktion, Zeitraum) + Pagination.
- [ ] `GET /api/admin/audit?…` (nur Admin).

### Phase 8 – Plan-Lifecycle
- [ ] Klonen: `POST /plans/<id>/clone` (ACL übernehmen/leeren wählbar).
- [ ] Versionierte Snapshots: `plan_versions`, `POST /plans/<id>/versions`, `POST /plans/<id>/restore/<ver>`.
- [ ] Export/Import: JSON-Download/-Upload eines Plans.
- [ ] Löschen: Trash + endgültig (admin/owner).

### Phase 9 – Admin-UI
- [ ] **Lokale User anlegen/verwalten** über den Admin-Account: Username + Passwort setzen,
  Rolle (`admin`/`user`), `can_create_plans`, aktiv/deaktiviert, Passwort-Reset, löschen.
  Backend: `GET/POST/PATCH/DELETE /api/admin/users`.
- [ ] Gruppen anlegen + Mitglieder verwalten, `can_create_plans` je Gruppe.
  Backend: `GET/POST/PATCH/DELETE /api/admin/groups`, Mitglieder-Endpunkte.
- [ ] Plan-ACL-UI (Subjekt = User/Gruppe → viewer/editor/owner), Layer-Gruppenbindung.
- [ ] Karten-Import/-Liste (vorhanden), Katalog-Upload (7a), Audit-Log-Ansicht.

### Phase 10 – Hardening & Deployment
- [ ] Security-Header, CORS zu (same-origin über einen Port).
- [ ] Healthchecks, `restart: unless-stopped`, Resource-Limits.
- [ ] `pg_dump`-Backup-Container (Cron) auf ein Volume.
- [ ] Strukturiertes Logging.
- [ ] README: NPM-Setup (Proxy Host, Websockets an, Port 8080), Bootstrap-Admin, Karten-Import.
- [ ] GHCR-Image-Build via GitHub Actions → User macht nur `docker compose up -d`.
- [ ] Tests: pytest (Auth, Rechte-Matrix, Marker-CRUD), WS-Integrationstest (zwei Clients, Konfliktfall).
