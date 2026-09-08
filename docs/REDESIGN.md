# UI-Redesign + Gitea-Import — Umsetzungsplan

Stand: 2026-09-07. Ziel: modernes, konsistentes UI (Dunkel als Standard, vollwertiger
Hell-Modus, Orange-Akzent), einheitliches Icon-Set statt Emojis, plus ein zweiter
Karten-Import-Weg über ein Gitea-Repo. **Alle bestehenden Funktionen bleiben 1:1 erhalten.**

Nach jeder Phase ein Checkpoint — vor allem nach **Phase A** wird der Look beurteilt,
bevor die großen View-Umbauten kommen.

---

## Teil 1 — Gitea als zweiter Import-Weg

Das Repo `https://git.jensr.de/root/ReforgerMapData` ist **öffentlich**; die Pakete liegen
als **direkt committete Dateien** im Repo-Root (`arland_mappack_v1.zip` 87 MB,
`cain_mappack_v1.zip` 848 MB, `eden_mappack_v1.zip` 818 MB). Keine Releases, kein LFS.

### Backend
- Neues Modell `MapSource` (`id`, `kind` = `"gitea"`, `base_url`, `repo` = `owner/name`,
  `token` optional/nullable, `path` default `""`, `created_by`, `created_at`).
  Neue Tabelle über `create_all`.
- Schemas: `MapSourceIn` / `MapSourceOut` (Token wird im Out **nie** zurückgegeben, nur
  `has_token: bool`).
- Router `map_sources` (admin):
  - `GET /api/map-sources` — Liste
  - `POST /api/map-sources` — anlegen (URL wird zu `base_url` + `repo` geparst)
  - `PATCH/DELETE /api/map-sources/{id}`
  - `GET /api/map-sources/{id}/files` — Backend ruft
    `{base_url}/api/v1/repos/{repo}/contents/{path}` auf, filtert `type == "file"` und
    Endung `.zip`, gibt `[{name, size, download_url}]` zurück.
- Import: `POST /api/maps/{map_id}/import-from-source` `{source_id, file}` →
  löst `download_url` auf, ruft den vorhandenen `run_import(map_id, url=…)`-Weg auf.
  `download_to_tmp()` hängt `Authorization: token …` **nur** an, wenn
  `token` gesetzt ist **und** die Ziel-URL exakt auf `base_url`s Host liegt (SSRF-Schutz).
  Das `MAP_IMPORT_MAX_MB`-Limit bleibt.
- 1 Test: Gitea-Contents-Antwort gemockt (`respx`/monkeypatch), Datei-Liste + Import-Trigger.

### Frontend
- Admin-Bereich → Unterpunkt **„Karten-Quellen"**: Repo-URL eintragen, speichern, löschen.
- Karten-Import-Dialog: Auswahl **Direkt-Upload** / **Download-Link** / **Aus Quelle** →
  bei „Aus Quelle": Quelle wählen → Dateiliste → Datei anklicken → Import. Gleicher
  Fortschritts-/Status-Ablauf wie heute (`status`-Polling).

Aufwand: klein, in **Phase C** integriert.

---

## Teil 2 — UI-Redesign

### Design-System (Phase A)

#### Farb-Tokens

Basis-Palette vom Nutzer: `#ff9900 #818181 #454545 #313131 #181818`.

| Token | Zweck | Dunkel (Standard) | Hell (eigens gestaltet) |
|---|---|---|---|
| `--bg` | App-Hintergrund | `#181818` | `#f4f4f5` |
| `--surface` | Panels, Karten, Leisten | `#313131` | `#ffffff` |
| `--surface-2` | eingesenkt / Streifen | `#262626` | `#ececed` |
| `--elevated` | Hover-Fläche | `#3b3b3b` | `#e4e4e6` |
| `--border` | Linien, Umrandungen | `#454545` | `#d9d9dc` |
| `--muted` | Sekundär-/Hilfstext, disabled | `#818181` | `#6b6b6f` |
| `--fg` | Primärtext | `#f2f2f2` | `#1c1c1e` |
| `--accent` | Aktionen, aktiv, Links | `#ff9900` | `#e57e00` |
| `--accent-fg` | Text/Icon auf Orange | `#181818` | `#ffffff` |
| `--accent-weak` | Akzentfläche 12 % (Duotone, Hover) | `rgba(255,153,0,.14)` | `rgba(229,126,0,.12)` |
| `--danger` / `--ok` / `--warn` | Semantik | `#ff5c5c` / `#46c26a` / `#ffb020` | angepasste Töne |
| `--focus` | Fokusring | `#ff9900` | `#e57e00` |
| `--shadow` | Panel-Schatten | `0 8px 30px rgba(0,0,0,.45)` | `0 8px 24px rgba(0,0,0,.12)` |

Radius-/Abstands-Tokens: `--r-sm 6px`, `--r-md 10px`, `--r-lg 14px`, Spacing-Skala
`--s-1 .25rem … --s-6 2rem`.

#### Theme-Umschaltung
- `theme.ts`: liest `localStorage["sidc_theme"]` ∈ `{dark, light, system}` (Default `dark`),
  setzt `document.documentElement.dataset.theme`. Bei `system` folgt es
  `matchMedia("(prefers-color-scheme: dark)")` live (Change-Listener).
- CSS: `:root` = Dunkel-Tokens; `:root[data-theme="light"]` = Hell-Tokens.
- **Dauerhafter 3-Wege-Schalter oben rechts** (Segment *Dunkel / Hell / System*), in
  **jeder** Ansicht sichtbar (Sidebar-Fuß bei Nicht-Karten-Ansichten, Befehlsleiste rechts
  in der Kartenansicht).

#### Schrift
- **Inter**, selbst-gehostet (`frontend/src/assets/Inter*.woff2`, `@font-face`, `font-display: swap`),
  Fallback `system-ui, sans-serif`. Kein externer Request (CSP-konform).

#### Icons
- **Eigenes SVG-Set** in `icons.ts` — `icon(name, {size?}) → string`. ~35 Glyphen:
  `pan, move, marker-move, point, line, ruler, eraser, marker, star, cube3d, compass,
  north, camera, calendar, layers, notes, versions, help, channel, folder, folder-open,
  plan, plus, trash, edit, lock, unlock, clone, drag, chevron, check, x, search,
  sun, moon, monitor, users, groups, map, audit, logout, download, settings, keyboard`.
- Stil **Kachel + Duotone**: `.icon-btn` = abgerundetes Quadrat (`--surface` / `--border`),
  Icon zweifarbig (Kontur `currentColor` + Akzentfläche `--accent-weak`). Aktiv/Toggle-an =
  `--accent`-Kachel, Icon `--accent-fg`. Hover = `--elevated`.
- **Alle Emojis raus** (Toolbar, Topbar, Ordnerbaum, Wizard, Buttons).

#### Basis-Komponenten (`components.css` + `ui.ts`-Helfer)
- Buttons (primär / sekundär / ghost / danger), Inputs/Select/Checkbox/Range, `.icon-btn`,
  `.panel` (einheitlicher Kopf: Titel + `x`, Body, optional Fuß), `.card`, `.table`,
  `.segmented`, `.badge`, `.chip`, `.tooltip`, Sidebar-Items, Menü/Popover.
- `ui.ts`: `iconBtn(name, {title, active})`, `panel({title, body, onClose})`,
  `segmented(options, value, onChange)`, `menu(items)` — damit die `innerHTML`-Templates
  nicht dupliziert werden.

### Layout (Phasen B–D)

- **App-Shell** = **linke Sidebar** (einklappbar) **+ schlanke Topbar** — beide bleiben.
  - Sidebar: Bereichsnavigation (*Pläne*; Admin: *Nutzer / Gruppen / Karten & Quellen /
    Audit-Log*), Fuß: Theme-Schalter, Sprache, **Einstellungen** (⚙), Abmelden.
  - Topbar: kontextbezogen (Titel/Breadcrumb, Kontext-Aktionen wie „Neuer Plan").
- **Einstellungs-Menü** (⚙, neu): pro-Browser-Einstellungen in `localStorage`
  (`sidc_settings`):
  - **Tastenkürzel für die Karten-Modi** (siehe unten) — anzeigen + umbelegbar
  - Standard-Transparenz Fremdphasen, Standard-Channel, Einheiten, Sprache,
    Sidebar ein-/ausgeklappt merken
  - (später optional serverseitig pro Nutzer synchronisierbar)
- **Pläne-Arbeitsbereich**: Ordnerbaum-Panel + Hauptbereich mit Plan-Karten (Name, zuletzt
  bearbeitet, eigene Rolle); „Neuer Plan" prominent.
- **Admin-Bereich**: eigener Unterbereich, saubere Tabellen/Detailansichten; **Gitea-Quellen-UI**.
- **Karten-/Planansicht** (Phase D, größte):
  - Topbar → kompakte **Befehlsleiste** (Theme-Schalter + ⚙ rechts).
  - Linke Werkzeugleiste → **am Rand angedockte Icon-Kachel-Leiste**, bündig mit der
    Befehlsleiste (kein Überlappen mit der Karte).
  - **Tastenkürzel für alle Modi**: `pan, move, marker-move, point, line, ruler, erase,
    place` (Vorbelegung z. B. `V / M / G / Q / L / R / E / P`, im Einstellungs-Menü
    umbelegbar). Damit ist die Werkzeugleiste optional.
  - Alle Panels (Ebenen, Notizen, Wizard, Bearbeiten, Versionen, Hilfe) → **ein
    einheitliches `.panel`-Bauteil** (gleicher Kopf, gleiche Abstände, verschiebbar wo
    schon jetzt).
- **Öffentliche Ansicht**: leichtes Restyling im gleichen Look, weiterhin nur lesend.

### Technik-Rahmen
- Bleibt **Vanilla-TS + Vite**, kein Komponenten-Framework.
- CSS neu gegliedert: `theme.css` (Tokens beide Themes), `base.css` (Reset, Typo, Body),
  `components.css` (siehe oben), View-spezifische Regeln bleiben pro Bereich.
- Rendering weiter über `innerHTML`-Strings + `ui.ts`-Helfer.
- Neue i18n-Keys für Einstellungs-Menü, Tastenkürzel-Namen, Quellen-UI.

---

## Phasen & Checkpoints

| Phase | Inhalt | Status |
|---|---|---|
| **A** | `theme.ts` + Tokens (Dunkel + Hell), Theme-Schalter überall, Inter, `icons.ts` (~35 SVGs), `ui.ts`, Emojis in Toolbar/Topbar ersetzt | ✅ `ee85f15` |
| **B** | App-Shell (Sidebar + Topbar, einklappbar) für Plan-Liste + Admin, Einstellungs-Menü (`settings.ts`) | ✅ |
| **C** | **Gitea-Import** (Backend `MapSource` + Endpunkte + Test, Frontend Quellen-UI + Import-aus-Quelle), Admin-Icons | ✅ |
| **D** | **Modus-Tastenkürzel** (umbelegbar), Emoji-Sweep über alle Views (Wizard, Baum, Hilfe, ACL, Versionen), angedockte Werkzeugleiste, ⚙ in der Topbar | ✅ |
| **E** | Farb-Tokens für Hell/Dunkel in allen Komponenten, Panel-/Overlay-Feinschliff, Fokus-Ringe | ✅ (Grobpass; Detail-Feinschliff bei Bedarf) |

Offen für später: vollständiger „Pläne-Arbeitsbereich" mit Plan-Karten statt Baum,
tieferer Panel-Umbau der Kartenansicht (einheitliches Panel-Bauteil), öffentliche
Ansicht im neuen Look, erschöpfender State-/Kontrast-Pass (WCAG AA).

Build-/Test-Gate pro Phase: `tsc --noEmit` + `vite build` grün, `pytest -q` grün.
Jede Phase = eigener Commit (bzw. wenige), damit rücknehmbar.
