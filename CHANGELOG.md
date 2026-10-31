# Changelog

Alle nennenswerten Änderungen an **SIDC – C2 – Command & Control**.
Format lose nach [Keep a Changelog](https://keepachangelog.com/), Versionierung [SemVer](https://semver.org/lang/de/).

## [Unreleased]

### 2026-10-31 – Externe Benachrichtigungen (Discord, Push, Matrix …) & Antworten aus dem System-Feed
- **Kanäle pro Nutzer** (Einstellungen → Benachrichtigungen): Discord-Webhook, ntfy, Gotify, Matrix, generischer Webhook
  (JSON, optional HMAC-signiert), E-Mail (SMTP) und **Web-Push** (Browser/Smartphone ohne Drittanbieter, VAPID-Schlüssel
  werden automatisch erzeugt). Je Kanal einstellbar, welche Arten (Erwähnung in Aufgabe/Chat, Zuweisung) ankommen; Testknopf.
- Als Plugin-Registry gebaut (`services/channels.py`): ein neuer Dienst ist eine Klasse, das Formular entsteht aus der
  Feldbeschreibung. Geheimnisse (Tokens, Webhook-URLs) sind verschlüsselt gespeichert und gehen nie zurück an den Browser.
- SSRF-Schutz: interne Adressen sind als Ziel gesperrt (`NOTIFY_ALLOW_PRIVATE_HOSTS=true` erlaubt LAN-Dienste), keine Redirects.
- Zustellung durch einen Hintergrund-Task (`dispatched_at` in `notifications`); bereits gelesene Einträge werden nicht gepusht.
- **Antworten im System-Feed:** je Eintrag „Antworten" – landet im Chat bzw. als Aufgaben-Kommentar und markiert gelesen.
- Neue Umgebungsvariablen `PUBLIC_URL`, `NOTIFY_ALLOW_PRIVATE_HOSTS`, `SMTP_*`; Migration `0035`; Abhängigkeit `pywebpush`.
- Noch offen: Gruppenchats mit Discord/Matrix-Räumen synchronisieren (Antworten von dort), Telegram/Slack-Kanäle.

### 2026-10-31 – Aktivitätsfeeds, Aufgaben-Threads, Chat & System-Feed
- **Aktivität (Projekt-Reiter):** wer war wie aktiv (24 h / 7 / 30 Tage / 1 Jahr) und ein Feed, wer wann was getan hat
  (Aufgaben: erstellt, Status, Zuständige, Priorität, Frist, Umbenennen, Löschen; Dateien; Notizen; Mitglieder).
  Häufiges Speichern derselben Datei/Notiz wird zusammengefasst; Missionsbau-Einträge sehen nur Missionsbauer.
  Neue Tabelle `project_activity`, Endpunkte `GET /projects/{id}/activity` (`?task_id=`, `?before=`) und `/activity/summary`.
- **Aufgaben-Thread:** im Aufgaben-Dialog „Diskussion" (auch für Betrachter) mit `@name`, `@gruppe`, `@projekt` und
  Autovervollständigung; aufklappbarer „Verlauf" je Aufgabe. Neue Tabelle `task_comments`.
- **Chat (neuer Reiter):** Direktnachrichten, freie Gruppen sowie Chats zu bestehenden Admin-Gruppen oder Projekten
  (Mitglieder folgen automatisch der Quelle); Erwähnungen mit Autovervollständigung, Ungelesen-Badge in der Seitenleiste.
  Tabellen `conversations`, `conversation_members`, `messages`; Zustellung per Polling (3 s offener Chat, 10 s Badge).
- **System-Feed:** Benachrichtigungen für Erwähnungen (Aufgaben-Thread, Chat) und Zuweisungen, als „System"-Unterhaltung im
  Chat (gelesen/alle gelesen/aufräumen). Tabelle `notifications`. Antworten direkt aus dem Feed und E-Mail/Push folgen später.
- Hilfe-Overlay zeigt die aktuelle (anpassbare) Tastenbelegung der Werkzeuge.
- Migrationen `0031_note_links` (Whiteboard-Pfeile, Notiz-Verknüpfung), `0032`–`0034`.

### 2026-10-31 – Kleinigkeiten aus dem Test
- Dialoge (Ordner anlegen/umbenennen): Enter schließt jetzt wirklich, der Dialog öffnet nicht mehr neu.
- Pläne-Seite: neuer Knoten „Projekte → Projektname → Plan" für alle Projekt-Pläne mit eigener Plan-Freigabe (auch ohne Projektmitgliedschaft). Neuer Endpunkt `GET /plans/in-projects`.
- Whiteboard: Pfeil-Knöpfe und Ziehen auf freier Fläche zum Verschieben der Ansicht (Trackpad/Touch).
- Missionsbau-Link in der Seitenleiste öffnet das zuletzt gewählte Projekt (pro Nutzer gespeichert, `ui_settings.last_project`).

### 2026-10-29 – Missionsbau-Projekte, Pläne-Seite, Review-Fixes

**Neu: Missionsbau (Projekte)** – siehe `docs/PROJEKTE.md`, Handbuch §3b
- Projekte als Ordnerstruktur (mit Unterordnern, Drag & Drop) mit den Bereichen Öffentlich · Missionsbau · Pläne,
  Markdown-Dateibaum, Aufgaben-Kanban, Haftnotizen-Whiteboard, Übersicht und Mitgliederverwaltung (Rollen je Projekt).
- Bilder liegen automatisch im Projekt des Plans; Admin-Reiter „Bilder" entfällt, dafür Speicher-Übersicht je Projekt.
- Pläne behalten ihre Freigabe pro Plan; Projektrollen geben keine automatischen Plan-Rechte.
- Migrationen `0028_missing_indexes`, `0029_projects`, `0030_project_folders`.

**Pläne-Seite:** Erstellen-Karte mit beschrifteten Schritten (Name, Karte, Ordner), „Alle Pläne" als klappbarer
Wurzelordner, Drag & Drop mit Hervorhebung/Auto-Aufklappen, Ordnerwahl als Ziel für neue Pläne.
Plan-Ordner: Umbenennen/Verschieben/Löschen nur Admin/Ersteller.

**Review (`REVIEW-2026-10.md`) – Sicherheit & Stabilität**
- Missionsbau-Gate prüft auch das bestehende Objekt; Builder-Inhalte werden beim Phasen-Löschen mitgelöscht und nicht
  mehr in Klone von Nicht-Missionsbauern kopiert; öffentlicher Live-Link prüft vor jeder Änderung die Phase.
- Offene WebSockets verlieren Rechte bei ACL-Änderung/Deaktivierung/Link-Widerruf; Redis-Pump mit Reconnect;
  Broadcast mit Timeout; Fehler pro Nachricht statt Verbindungsabbruch; Limits für Linienpunkte/Cursor/Share-Nachrichten.
- Stored XSS in Phasen-Tabs, Versionsverlauf, Klon-Dialog, Katalog-Wizard behoben.
- Resync nach WebSocket-Reconnect (Plan-Ansicht + öffentliche Freigabe), Hinweis bei nicht gesendeten Änderungen,
  Aufräumen von Karte/Listenern beim Verlassen der Plan-Ansicht, diverse Touch-/Drag-Fehler.
- Backend: atomare ORBAT-Mengen, Restore-Broadcast, ORBAT-Hierarchie-Prüfung, Längenlimits, Tile-Cache-Invalidierung,
  Rate-Limit für Share-Kacheln, `backup.sh` rotiert nur nach erfolgreichem Dump, Platzhalter-Passwörter werden
  abgelehnt, neue DB-Indizes; Handler mit DB-Zugriff blockieren den Event-Loop nicht mehr.
- Dialoge mit `role=dialog`, Fokusfalle und Fokus-Rückgabe; fehlende/fest deutsche Texte über i18n.
### 2026-10-24 – Sicherheits-Nachaudit

- Bilder aus verborgenen Missionsbau-Phasen sind für normale Viewer nicht mehr per Liste/Raw abrufbar.
- Öffentliche Share-Links erhalten Live-Updates nur noch im Umfang ihrer Freigabe (ohne interne Nutzernamen).
- Fehlendes HTML-Escaping in ORBAT, ACL-Dialog, Presence-Leiste und Admin-Config behoben; Anzeigenamen ohne `<>"'`&`.
- Admin-Passwort-Reset widerruft API-Tokens; Karten-ID-Validierung, strengerer ZIP-Import, Upload-Limits beim Einlesen.
- Details: `SECURITY-AUDIT.md` (Abschnitt „Nachaudit 2026-10-24“). Neue Tests in `test_plan_images.py` und `test_client_api.py`.

### 2026-10-24 – Markdown-Toolbar

- **Tastatur-Icon** über jedem Markdown-Feld (Phasen-Notizen, Textfeld auf der Karte, Bild-Notiz, Lightbox-Notiz) blendet eine
  **Formatierungsleiste** ein/aus (Zustand wird gemerkt): fett, kursiv, durchgestrichen, hervorheben, Quelltext inline/Block,
  Mathe inline/Block, Kommentar, Überschriften (Auswahl), Aufzählung, Nummerierung, Aufgaben, Zitat, Hinweise/Callouts (Auswahl),
  Trennlinie, Tabelle, Link. Erneutes Anwenden hebt die Formatierung wieder auf; Undo (Strg+Z) funktioniert.
- **Renderer erweitert:** `~~durch~~`, `==hervorgehoben==`, verschachtelte Listen, Aufgabenlisten `- [ ]`, Tabellen,
  Hinweise `> [!note] Titel`, Mathe `$…$`/`$$…$$` (als Formeltext), Kommentare `%%…%%`/`<!-- -->`, zusammenhängende Zitate.
- Nicht im Browser getestet (nur Typecheck, Build und Renderer-Probelauf).

### 2026-10-23 – Taktische Layer, Zeus, Mehrfach-Phasen, Werkzeug-Feinschliff

**Taktische Layer statt Channels**
- `SIDC_ChannelSettings.json`, Channel-Auswahl (Topbar, Wizard, Baukasten, Marker-/Linien-Editor), Channel-Hotkeys
  und die Katalog-Route `channels` sind **entfernt**.
- Neues Listen-Symbol neben „Ebenen": **Auto-Layer** BLUFOR / REDFOR / Zivil-GREENFOR / Unbekannt (nach SIDC-Identität)
  plus **eigene Layer pro Plan** (anlegen/löschen durch Editoren). Haken + Deckkraft-Regler gelten nur lokal je Nutzer.
- Auswahl **„Taktischer Layer"** (Standard **Auto**) im Wizard, Baukasten, Marker-Editor, Linien-Menü, Lineal-Menü und
  „Linie bearbeiten". API `GET/POST /plans/{id}/layers`, `PATCH/DELETE …/layers/{layer_id}`, WS-Event `layers.changed`.
  Der Standard-Layer „Allgemein" ist geschützt; reservierte Namen (BLUFOR, REDFOR, …) sind gesperrt.

**Zeus-Rolle**
- Neue Eigenschaft **Zeus** für Nutzer und Gruppen (Admin-Bereich), Migration `0024`.
- Missionsbauer geben einzelne **Missionsbau-Phasen für Zeus frei** (Standard 48 h, alternativ unbegrenzt) – Schalter in
  den Phasen-Notizen. Abgelaufene Freigaben schließen sich automatisch; WS-Event `phases.changed` lädt alle Clients nach.
- Umschalter **Spieler / (Missionsbau) / Zeus** im Zeitstrahl: Zeus sieht die Spieler-Phase nur zum Ansehen und arbeitet in
  den freigegebenen Missionsbau-Phasen; in Spieler-Phasen wird nichts gesetzt. Missionsbauer können die Zeus-Ansicht testen.
- Server-seitig geprüft (Gate in `live.py`, gezielte Zustellung der Builder-Nachrichten an Zeus-Sockets).

**Phasen für Spieler freigeben**
- Neue Checkbox „Für Spieler freigeben (wirkt wie Base)" an Missionsbau-Phasen (`phases.player_released`, Migration `0025`):
  der Inhalt erscheint bei Spielern wie die Base-Phase, die Phase selbst bleibt verborgen; Bearbeiten bleibt dem Missionsbau vorbehalten.

**Mehrere Phasen & Pflicht-Phase**
- **Marker, Linien, Lineal und Notizen** können zusätzlich in **weiteren Phasen derselben Ebene** erscheinen
  (Mehrfachauswahl „Weitere Phasen"; Spalten `markers|strokes|annotations.extra_phase_ids`, Migrationen `0024`, `0026`, `0027`).
- **Jedes Element gehört zu einer Phase**: die Option „global" ist überall entfernt, Standard ist die aktuelle Phase
  (folgt dem Phasenwechsel); der Server setzt ohne Angabe die erste Spieler-Phase.
- Briefing-PDF berücksichtigt Zusatzphasen.

**Werkzeuge**
- **Marker-Hover:** Icons Löschen (rot, mit Bestätigung) · Verschieben · Bearbeiten.
- **Marker setzen:** Bricht man den Erstellen-Dialog ab, bleibt der Modus aktiv (neue Position anklicken).
- **Lineal:** eigenes Menü wie „Zeichnen" (Phase, Weitere Phasen, Taktischer Layer); Messlinien nach Phase/Layer ein-/ausgeblendet.
- **Zeichnen:** Phase/Weitere Phasen/Layer im Menü; Löschen gespeicherter Linien/Messlinien mit Bestätigung.
- **Baukasten:** SIDC-Nummer (ganz oder teilweise) eingeben → nächstpassender Marker wird gewählt und platziert.
- **QuickMenü:** Kategorien mit „↳" vor dem Namen (Marker ohne); Button **„Platzieren" zusätzlich oben** neben „Zurück".
- **Zeigen:** Zuziehkreis entfernt; gelbe Hervorhebung 3× größer bei 75 % Sichtbarkeit; **Mittelklick** pannt die Karte in allen Werkzeugen.
- **Tasten:** **S = Radierer**, **F = Lineal**; Marker-Verschieben → **M**, Favoriten → **R** (gespeicherte alte Standardbelegungen werden umgezogen).

**Oberfläche**
- **ViewCube** immer sichtbar unten rechts (2D + 3D, auch öffentliche Ansicht), Top-Fläche mit „TOP", Beschriftung N/S + O/W an den
  sichtbaren Seiten, Kartendrehung dreht nur die Top-Fläche, Abstand zum Rand 56 px.
- **UI Scale:** die Box mit Marker-/Textgröße trägt den Titel „UI Scale" und ist einklappbar (Zustand wird gemerkt).
- **Doppelklick auf eine Phase** im Zeitstrahl öffnet das Phasen-Notizen-Fenster.
- Bilder-Tab: Ausklapp-Knopf auf Höhe des Schließen-Knopfs.
- Karten-Einstellungen (Satellit, Straßenfarben, Orte) im Zahnrad pro Nutzer, Topbar-Größe einstellbar, Absätze in Notizen.

**Deploy-Hinweis:** Backend neu bauen (Migrationen `0024`–`0027` laufen beim Start), Frontend wird mitgebaut:
`ssh root@192.168.1.115 "cd /opt/sidc-c2 && git pull && docker compose up -d --build"`.

### Neu (Nachtrag)
- **Markerfarbe im QuickMenü/Baukasten:** Farbwähler direkt beim Platzieren.
- **Favoriten speichern die Farbe** (`favorites.tint`, Migration `0023`); jeder Favorit ist ein eigener
  Eintrag, ein gefärbter überschreibt keinen ungefärbten.
- **Straßen-Standardfarben per `.env`:** `ROAD_COLOR_MAIN/SECONDARY/PATH` (`GET /api/ui-defaults`);
  Nutzer-Änderungen gelten pro Browser nur für die geänderten Farben.
- **„Marker Info"-Checkbox** in der Topbar: der große Beschreibungsblock im Marker-Hover ist standardmäßig aus.

### Neu (Marker-Farbe, Nur-Text-Marker, Kartenanpassung)
- **Markerfarbe:** im Marker-Editor eine eigene Farbe wählen — färbt die schwarzen Symbolanteile
  (Rahmenfarben bleiben); für alle sichtbar (Spalte `markers.tint`, Migration `0022_marker_tint`).
- **Nur-Text-Marker** („Spezial → Clear for Text"): zeigt nur noch den Text, ohne Icon/Punkt;
  Textfarbe frei wählbar.
- **Straßenfarben** im Ebenen-Panel: Hauptstraße/Piste, Nebenstraße, Wege/Pfade (pro Browser).
- **Sat-Bild anpassen:** Helligkeit, Kontrast, Sättigung; neue Ebene **Sat (vereinfacht)**
  (weichgezeichnet, auf wenige Flächenfarben reduziert; Tiles serverseitig per Pillow).
- Marker-Baukasten: Vorauswahl BLUFOR statt Unknown; im QuickMenü gewählte Fraktion wird übernommen.

### Neu (Enfusion-TopoExport-Layer)
- **5 neue Karten-Ebenen** aus dem ATAKmaps-Mappack: Gebäude, Straßen & Wege, Gewässer,
  Stromleitungen, Bäume (`buildings|roads|water|powerlines|trees.geojson`). Routen
  `GET /api/maps/{id}/{layer}.geojson` (Cookie/Bearer) und `/public/plans/{token}/{layer}.geojson`;
  im Ebenen-Panel (Editor + öffentliche Ansicht) schaltbar, standardmäßig aus, mit Deckkraft-Regler.

### Neu (Kartenserver für den lokalen ATAKmaps-Client)
- **API-Tokens** (Einstellungen → „API-Tokens"): persönliche Tokens mit Scope `maps:read`,
  nur als SHA-256-Hash gespeichert (Klartext einmalig beim Erstellen), optionales Ablaufdatum,
  Widerrufen, `last_used_at`.
- **Token-Zugriff nur auf Karten-Lesen:** `GET /api/maps`, `/api/maps/{id}/tiles/…`, `style.json`,
  `topo.geojson`, `locations.json`, `contours.geojson`, `peaks.geojson` akzeptieren zusätzlich zur
  Cookie-Session einen `Authorization: Bearer`-Token (Rate-Limit pro Token). Pläne, Marker,
  Admin, Kartenverwaltung und Token-Verwaltung bleiben Cookie-only.
- `GET /api/client/ping` (Verbindungstest: Nutzer, Token, Protokoll) und `imported_at` in der
  Kartenliste (Cache-Version für den Client).
- Migration `0021_api_tokens`. Tests: `tests/test_client_api.py`.

### Neu (Roadmap-Batches)
- **ACL beim Erstellen** ("Erstellen + Zugriff"), **Papierkorb** (`/plans/trash`,
  undelete/purge, `#/trash`), **Plan umbenennen** für Editor (nicht nur Owner).
- **Präsentationsmodus** (Vollbild, nur Karte + Phasen-Umschalter, ‹ › / Pfeile / Esc).
- **Plan-Thumbnails** (Vorschaubild in der Baumzeile, erzeugt beim Versions-Speichern).
- **Undo/Redo** für eigene Aktionen (verschieben / bearbeiten / sperren), Strg+Z / Strg+Y.
- **Platzierbare Markdown-Textfelder** auf der Karte (`Annotation`-Entität, WS-synchron,
  Werkzeug „Textfeld", Doppelklick = bearbeiten, im Bewegen-Modus verschiebbar).
- **Briefing-PDF** – je Phase eine Seite: Karte auf die Marker der Phase gerahmt (+10 %)
  plus die Phasen-Notizen, militärischer DTG. (jsPDF, lazy geladen.)
- **`DEFAULT_USER_GROUP`** – neue Nutzer (lokal + OIDC) automatisch einer Gruppe zuordnen.
- **pg_dump-Backup-Container** (`backup`-Service, Volume `backups`, rotierend).
- **Alembic** – Baseline + `stamp`/`upgrade` beim Start; `_add_missing_columns` +
  `create_all` bleiben als Übergangs-Sicherheitsnetz.

### Neu (2. Runde)
- **Pläne**: Zielordner schon beim Anlegen wählbar; **umbenennen** (Owner) und
  **„Verschieben nach…"**-Dropdown je Plan (zusätzlich zu Drag & Drop).
- **Admin-Bereich kategorisiert**: Sidebar mit *Benutzer & Gruppen* / *Log* /
  *Config* (Karten + Gitea-Quellen + SIDC-Kataloge); Routen `#/admin/users|log|config`.
  Karten-Verwaltung aus der Plan-Übersicht nach *Config* verschoben.
- **Gitea-Import**: gleiche Karten-ID → vorhandene Karte wird **ersetzt/erneuert**
  statt 409. Token-Feld beim Anlegen der Quelle.
- **SIDC-Kataloge**: klare **Aktualisieren/Löschen**-Buttons wie bei den Karten.
- **Freigaben-Dialog**: Rollen als *Lesen / Bearbeiten / Voll*, Erklärtext zu
  User- vs. Gruppen-Zugriff.

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
