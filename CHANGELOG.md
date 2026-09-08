# Changelog

Alle nennenswerten Änderungen an **SIDC – C2 – Command & Control**.
Format lose nach [Keep a Changelog](https://keepachangelog.com/), Versionierung [SemVer](https://semver.org/lang/de/).

## [Unreleased]

### Neu
- **UI-Redesign**: Dunkel als Standard + vollwertiger Hell-Modus, Orange-Akzent
  (`#ff9900`), Schrift **Inter** (selbst-gehostet). **Theme-Schalter** (Dunkel/Hell/
  System) dauerhaft oben rechts. Einheitliches Duotone-Icon-Set statt Emojis in
  allen Ansichten. Einklappbare **Sidebar** für Plan-Liste + Admin.
- **Einstellungs-Menü** (⚙ in der Topbar) mit **umbelegbaren Tastenkürzeln** für die
  Karten-Werkzeuge (V/M/Q/L/R/E/P, pro Browser gespeichert).
- **Gitea-Import**: Admin trägt eine Repo-URL ein (`Karten-Quellen`), das Backend
  listet die `*.zip` über die Gitea-Contents-API; Datei auswählen → Import über den
  vorhandenen Streaming-Weg. Optionaler Token, SSRF-Schutz (nur der konfigurierte Host).
  Neues Modell `MapSource`, Endpunkte unter `/api/map-sources` + `/api/maps/import-from-source`.

## [1.0.0] – 2026-09-07

Erste stabile Version. Browser-basiertes, mehrbenutzerfähiges Einsatz-Planungstool
auf Basis der Karten- und Markerlogik von **ATAKmaps**, ohne Ingame-Anbindung,
ausgeliefert als Docker-Compose-Stack.

### Enthalten

- **Auth & Rechte** – lokaler Bootstrap-Admin + optionales externes OIDC; signierter
  HttpOnly-Session-Cookie (argon2), Login-Ratelimit. Rollen `viewer` / `editor`
  (Einzelrechte setzen/bewegen/löschen/malen) / `owner`, Capability „darf Pläne
  erstellen", Nutzergruppen.
- **Karten** – Import per Download-Link **oder** Direkt-Upload (gestreamt), Karten-Update,
  DLC-Zoomstufen; MBTiles-Tileserver + `style.json` pro Karte; Kamera-Grenzen.
- **Marker** – vollständiger Wizard (QuickMenü + Katalog + „Advanced"-Modifikatoren aus
  `SIDC_ModifierCatalog.json`), Symbol-Rendering **milsymbol.js** mit PNG-Fallback,
  Richtungspfeile, dauerhafte Beschriftung (Name + Modifikatoren) und Hover-Tooltip
  (Channel / Ersteller / Phase).
- **Werkzeuge** – Bewegen, Marker verschieben (Modus + mittlere Maustaste), Zeigen
  (Laser-Cursor), gerade Linien, **Lineal**, Radierer, Marker, Favoriten; Linien enden
  per Rechtsklick.
- **Zeitstrahl / Phasen** – Marker je Phase, einstellbare Transparenz für Fremdphasen;
  verschiebbares **Markdown-Notizfenster** mit Reiter je Phase.
- **Ebenen** – Sat / Grid / Terrain, **Höhenlinien** (alle 10 m) und **dominante
  Höhenpunkte** (aus der Heightmap, im ATAKmaps-Importer vorberechnet), Orte; je Ebene
  ein Deckkraft-Regler.
- **Topbar** – Kompass + „nach Norden", **Screenshot** (nur Karteninhalt, militärischer
  DTG, Dateiname `<Plan>_<Phase>_<Zeit>.png`), Datums-/Zeitfeld, Hilfe-Overlay.
- **Pläne** – Ordner / Unterordner mit Drag & Drop, Klonen (in Zielordner),
  **Versionsverlauf** mit Wiederherstellen (Auto-Sicherung), Papierkorb.
- **Echtzeit** – WebSocket, autoritativer Server (`live.py`), Redis-Pub/Sub-Backplane;
  Anlegen/Malen optimistisch + Server-Bestätigung, Bewegen/Ändern/Löschen/Sperren nur
  server-autoritativ.
- **Öffentliche Freigaben** – Nur-Ansehen-Links ohne Login.
- **Admin-Bereich** – Nutzer, Gruppen, Kataloge (5 Dateien), Karten, Audit-Log;
  UI zweisprachig DE/EN, Karten-Labels in 13 Sprachen.

### Technik

- Backend FastAPI (Python 3.12), SQLAlchemy 2.0, PostgreSQL, Redis.
- Frontend Vanilla-TypeScript + Vite 6 + MapLibre-GL 5 + milsymbol@3, in das
  Backend-Image gebaut; ein Container serviert Frontend + API + WebSocket.
- TLS / externer Zugriff über einen vorgelagerten Reverse Proxy (kein Proxy im Stack).
- Schema über `create_all` + automatisches `ALTER TABLE ADD COLUMN` beim Start
  (noch kein Alembic).
