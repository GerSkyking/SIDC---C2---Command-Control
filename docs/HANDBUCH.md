# SIDC – C2 – Handbuch

Stand **2026-09-07**. Deckt den aktuellen Funktionsumfang von Backend + Web-Frontend ab.
Für Architektur/Stufenplan siehe [`../PLAN.md`](../PLAN.md), für Betrieb [`../README.md`](../README.md).

---

## 1. Anmeldung & Rollen

- **Lokaler Login** mit Benutzername/Passwort. Erst-Login über `BOOTSTRAP_ADMIN_USER` /
  `BOOTSTRAP_ADMIN_PASSWORD` aus der `.env`.
- **OIDC** (optional, per `.env` aktiviert): Button „Mit OIDC anmelden". Unbekannte Nutzer
  bekommen die Rolle `user`.
- **Globale Rolle:** `admin` (Vollzugriff, Admin-Bereich) oder `user`.
- **Session:** signierter HttpOnly-Cookie (`sidc_session`), 7 Tage. Login-Ratelimit
  (8 Fehlversuche / 60 s pro IP+User).

## 2. Berechtigungen

| Ebene | Bedeutung |
|---|---|
| **`can_create_plans`** | Capability auf User **oder** Gruppe – erlaubt das Anlegen von Plänen. |
| **Plan-ACL `viewer`** | Plan + Marker + Zeichnungen ansehen, nichts ändern. |
| **Plan-ACL `editor`** | mit vier Einzel-Häkchen: **setzen / bewegen / löschen / malen** (je an/aus). |
| **Plan-ACL `owner`** | alles + ACL verwalten, Plan umbenennen/klonen/löschen, Versionen wiederherstellen, öffentliche Links. |
| **Marker-Lock** | Ein gesperrter Marker ist nur vom Plan-`owner` änder-/verschieb-/löschbar. |

Alle Rechte werden **serverseitig** pro WebSocket-Operation geprüft (`live.py` /
`effective_caps()`), nicht nur im Frontend.

## 3. Pläne organisieren

Die Plan-Liste ist ein **Ordnerbaum**:

- **Ordner & Unterordner** anlegen (`+ Neuer Ordner`, `＋` an einem Ordner = Unterordner),
  umbenennen (`✎`), löschen (`✕` – der Inhalt rückt eine Ebene nach oben).
- **Drag & Drop:** Plan oder Ordner auf einen Zielordner ziehen = verschieben; auf
  „Alle Pläne" ziehen = auf die oberste Ebene. Zyklen werden verhindert.
- Der Klapp-Zustand der Ordner wird pro Browser gemerkt.
- Ordner sind eine **globale Organisationsstruktur** (für alle angemeldeten Nutzer sichtbar).

**Plan klonen:** Button `Klonen` an einem Plan → Dialog mit neuem Namen, **Zielordner**
und Option „Freigaben mitkopieren". Kopiert Phasen (inkl. Notizen), Layer, Marker und
Zeichnungen.

## 4. Kartenansicht

### 4.1 Werkzeugleiste (links, nur mit Bearbeitungsrecht)

| Icon | Werkzeug | Bedienung |
|---|---|---|
| ✋ | **Karte bewegen** | Standard. Schieben/Zoomen. Marker per **gehaltener mittlerer Maustaste** ziehen. |
| ✥ | **Marker verschieben** | Marker anfassen und ziehen; beim Loslassen server-autoritativ gespeichert. |
| 👉 | **Zeigen** | Karte fixiert; der eigene Cursor wird anderen Nutzern live angezeigt. |
| ✏️ | **Linie** | Gerade Segmente klicken. **Rechtsklick**, Doppelklick oder „Linie fertig" beendet. Farbe/Stärke aus dem PhaseLine-Katalog. |
| 📏 | **Lineal** | 2 Punkte klicken → gestrichelte Linie mit Entfernung (m/km). 3. Klick löscht. |
| 🧽 | **Radierer** | Klick auf Marker **oder** Linie löscht sofort (braucht Löschrecht). |
| 📍 | **Marker setzen** | Erst Position auf der Karte klicken, **dann** öffnet der Auswahl-Wizard. Danach direkt platziert. |
| ★ | **Favoriten** | Persönliche gespeicherte Marker per Klick platzieren / löschen. |

**Verbindungs-Marker** (`isMultiPointLine` im Katalog): nach der Auswahl weiter auf die
Karte klicken für weitere Punkte; **Rechtsklick** beendet die Kette. Zwischen den
Instanzen wird eine Linie gezogen (`linked_group_id` / `point_index`).

### 4.2 Marker-Wizard

- **QuickMenü** (Baum aus `SIDC_QuickMarkerMenuCatalog.json`) **oder** **Katalog**-Browser
  (nach Kategorie), mit Suche.
- Pro Marker einstellbar: **Zugehörigkeit** (Unknown / Friend / Neutral / Hostile – ohne
  „Assumed"), **Echelon** (nur Land-Einheiten), **Richtung** (8 + stationär → Richtungspfeil),
  **Einheitstext**, **Zusatztext**, **Channel**, **Sperren**, **Zeitstempel**.
- **Erweitert** (Button, wenn der Marker-Typ Modifikatoren hat): rechte Spalte mit Dropdowns
  für **Modifikator 1/2**, **HQ / Task Force / Dummy** und **Zustand / Einsatzbereitschaft**
  aus `SIDC_ModifierCatalog.json`. Die Icon-Vorschau rendert live mit.

### 4.3 Marker bearbeiten

Klick auf einen Marker (Modus „Karte bewegen" oder „Marker verschieben") öffnet ein
**zentriertes Fenster** (Klick außerhalb oder **Esc** schließt): Einheits-/Zusatztext,
Icon-Drehung, **Phase**, Sperren, **Erweitert** (Modifikatoren aus dem SIDC gelesen und
änderbar), **Klonen**, **Als Favorit speichern**, **Löschen**.

### 4.4 Symbol-Rendering

Zwei Wege wie in ATAKmaps:

1. **milsymbol.js** – rendert das Symbol live aus dem SIDC (deckt praktisch alle
   Affiliation-/Echelon-/Modifier-Kombinationen ab).
2. **Vorgerendertes PNG** unter `/assets/app6d-icons/<sidc>.png` als Rückfall für die
   Funktions-IDs, die milsymbol nicht kennt.
3. Schlägt beides fehl → ein **Ersatzpunkt**, damit der Marker sichtbar/anklickbar bleibt.

**Richtungspfeile** an Markern mit `rotation_degrees ≥ 0` (Air- und Boden-Variante wie
ATAKmaps, als Vektor-Geometrie).

### 4.5 Topbar

| Element | Funktion |
|---|---|
| **3D** | Kippen an/aus. In 2D lässt sich die Karte nur **drehen**, nicht kippen (`maxPitch 0`). Terrain bleibt für die Höhenanzeige aktiv. |
| **↑ Kompass** | Zeigt Norden (dreht mit dem Kartenwinkel). Klick = Karte nach Norden ausrichten. |
| **📅 Datum/Zeit** | Für den Screenshot-Zeitstempel. Leer = aktuelle Zeit. |
| **📷 Screenshot** | PNG **nur mit Karteninhalt** (Sat/Grid + Orte + Marker + Zeichnungen + Pfeile + Grid-Beschriftung), keine Bedienelemente, kein MapLibre-Logo. Unten links ein militärischer DTG `DDHHMMZ MMM YY`. Dateiname `<Plan>_<Phase>_<DDMMYYYY-HHMMSS>.png`. |
| **Channel** | Eigener Funkkanal (aus `SIDC_ChannelSettings.json`). |
| **Zeitstrahl** | Phasen – siehe 4.6. |
| **🗒️ Notizen** | Phasen-Notizfenster – siehe 4.7. |
| **Karten-Sprache** | 13 Sprachen für die Orts-Labels auf der Karte (separat von der UI-Sprache). |
| **☰ Ebenen** | Sat / Grid / Terrain, **Höhenlinien**, **Höhenpunkte** und die Orts-Gruppen einzeln ein-/ausblenden. |
| **🕑 Versionen** | Versionsverlauf – siehe 4.8. |
| **? Hilfe** | Overlay mit Werkzeugen, Topbar und Tastenkürzeln (DE/EN). |
| **Freigaben** (nur Owner) | Öffentliche Links + ACL – siehe 5 und 6. |
| **Cursor-HUD** (rechts) | X / Y (Welt-Koordinaten via Kalibrierung) + Höhe (aus dem Terrain-DEM, auch in 2D). |
| **Koordinaten-Grid** | Linien aus `grid.mbtiles`, X/Y-Beschriftung an den Bildschirmrändern, mehrstufig (10/100/1000/10000 m), mitlaufend beim Pan/Zoom, horizon-sicher bei Pitch – wie ATAKmaps. |
| **Höhenlinien / Höhenpunkte** | Zwei Terrain-Ebenen aus der Heightmap (`contours.geojson` / `peaks.geojson` im Mappack, standardmäßig **aus**). Höhenlinien alle 10 m, jede 5. Linie (50 m) fett + beschriftet. Höhenpunkte = lokal dominante Erhebungen mit Höhe; `▲ NNN m`, Farbe nach Typ (Kuppe/Grat/Plateau/dominanter Gipfel). |

### 4.6 Phasen (Zeitstrahl)

- Beim Anlegen eines Plans entsteht die Standard-Phase **„Base"**.
- Phasen wählen (Chip), **`+`** anlegen, **`✕`** löschen (Marker der Phase werden dann „global").
- Jeder Marker gehört zu **einer Phase** (`phase_id`) oder ist **global** (`NULL`, immer sichtbar).
  Neue Marker landen in der aktiven Phase; im Bearbeiten-Fenster umstellbar.
- **Regler „Sichtbarkeit fremder Phasen"** (0–100 %, 5er-Schritte): Marker, die nicht zur
  aktiven Phase gehören, werden entsprechend transparent gezeichnet. Wert bleibt pro Browser.

### 4.7 Phasen-Notizen

- **🗒️**-Button öffnet ein **frei verschiebbares Fenster** (Position pro Browser gemerkt),
  Kopfzeile zum Ziehen, **✕** schließt, **🗒️** holt es zurück.
- **Ein Reiter je Phase.** Beim Phasenwechsel wird automatisch der Reiter dieser Phase aktiv;
  der Text der vorigen Phase bleibt gespeichert.
- **Markdown** (Überschriften, `**fett**` / `*kursiv*` / `` `code` ``, Listen, `>` Zitat,
  Links, `---`) mit Live-Vorschau. Auto-Speichern (leicht verzögert). Viewer sehen nur-lesend.

### 4.8 Versionsverlauf

- **🕑**-Button öffnet die Liste: **Bezeichnung · Datum · Autor · Anzahl Marker/Linien**.
- **Editoren** können den aktuellen Stand mit Bezeichnung **sichern**.
- **Owner** können je Eintrag **Wiederherstellen** – der aktuelle Stand wird **vorher
  automatisch als Sicherungs-Version** gespeichert, dann setzt der Plan auf den gewählten
  Stand zurück (Seite lädt neu).

## 5. Öffentliche Freigaben

Owner erzeugt unter **Freigaben** einen Token-Link (optional mit Ablaufdatum, widerrufbar).
Aufruf über `#/p/<token>` – **nur Ansehen**, ohne Login: Karte, Marker, Zeichnungen, Orte,
Live-Updates über einen Empfangs-WebSocket.

## 6. Admin-Bereich

- **SIDC-Kataloge hochladen** (Format 1:1 wie ingame `LocalMapData`), persistent im
  `uploads`-Volume:
  `SIDC_AllMarkersCatalog.json`, `SIDC_QuickMarkerMenuCatalog.json`,
  `SIDC_PhaseLineStyleCatalog.json`, `SIDC_ChannelSettings.json`, `SIDC_ModifierCatalog.json`.
  Upload als roher `application/json`-Body (kein Multipart) – bei sehr großen Dateien ggf.
  im NPM `client_max_body_size` erhöhen.
- **Karten**: Import per **Download-Link** oder **Direkt-Upload** (Limit per
  `MAP_IMPORT_MAX_MB`), gestreamt auf Platte. Button **Aktualisieren** = neue ZIP für eine
  bestehende Karte hochladen. „Vom Link" = erneut vom hinterlegten Link laden. Löschen.
  DLC-Zoomstufen (`mbtiles/dlc/<layer>_z<N>.mbtiles`) werden für Zoom über die Basis-maxzoom
  hinaus ausgeliefert.
- **Lokale Benutzer**: anlegen, Rolle, `can_create_plans`, aktiv/deaktiviert,
  Passwort-Reset, löschen.
- **Gruppen**: anlegen, Mitglieder verwalten, `can_create_plans` je Gruppe.
- **Log**: Login-Versuche + alle wichtigen Aktionen (Karte/Plan/ACL/Katalog/Version…),
  Filter nach Aktion und Benutzer, lädt beim Öffnen die letzten 20 Ereignisse.
- **Service neu starten**: Button (SIGTERM → Docker-Restart).

## 7. Karten-Pakete (`*_mappack_v*.zip`)

Alles Fertige liegt im Pack – beide Konsumenten (ATAKmaps-Viewer **und** SIDC-C2) zeigen
nur an, es wird **nichts pro Tool verarbeitet**:

```
mappack.json                     (optional Manifest)
calibration.json                 (Ursprung + Skalierung)
mbtiles/sat.mbtiles              (Pflicht)
mbtiles/terrain.mbtiles          (optional, für 3D + Höhenanzeige)
mbtiles/grid.mbtiles             (optional, Koordinatengitter)
mbtiles/dlc/<layer>_z<N>.mbtiles (optional, hochauflösende Zoomstufen)
topo.geojson                     (optional, Straßen/Wege – Anzeige derzeit deaktiviert)
locations.json                   (optional, benannte Orte, nach baseType gruppiert)
contours.geojson                 (optional, Höhenlinien alle 10 m)
peaks.geojson                    (optional, dominante Höhenpunkte)
```

`topo.geojson` und `locations.json` werden **einmalig im ATAKmaps-Importer** erzeugt
(`pipeline/topo_convert.py`, `pipeline/locations_convert.py`) und ins Pack gelegt.
`contours.geojson` / `peaks.geojson` entstehen beim **Heightmap-Import**
(`pipeline/terrain_features.py`): Höhenlinien per Marching-Squares auf einem 2‑m‑Raster,
Höhenpunkte per lokaler Prominenz (Bottleneck-Suche im 300‑m‑Radius auf 4‑m‑Raster) mit
hartem Prominenz-Cutoff (20 m) und räumlichem NMS (250 m). Nur `numpy`/`scipy`.
**Wichtig:** Ältere Packs enthalten evtl. noch die rohe `mapLocations_locations.json` –
Backend/Viewer brauchen die **verarbeitete** `locations.json` (Import-Tab
„Verarbeiten & einpflegen", dann Export).

## 8. Tastenkürzel

| Taste | Wirkung |
|---|---|
| **Esc** | Werkzeug zurück auf „Karte bewegen" / offenes Fenster schließen. |
| **Rechtsklick** | Laufende Linie oder Verbindungs-Marker-Kette beenden. |
| **Mittlere Maustaste ziehen** | Marker verschieben (im Karten-Modus). |
| **Doppelklick** | Bei aktiver Linie: Linie beenden. |

## 9. SIDC – Kurzreferenz

30-stelliger Code. Client-seitig gespleißt (Katalog trägt Platzhalter):

| 0-idx | Feld | gesetzt durch |
|---|---|---|
| 3 | Standard Identity (Zugehörigkeit) | `withAffiliation` |
| 6 | Status / Zustand | Modifikator 4 |
| 7 | HQ / Task Force / Dummy | Modifikator 3 |
| 8–9 | Amplifier / Echelon | `withAffiliationAndEchelon` (nur Land-Einheiten) |
| 10–15 | Entity / Typ / Subtyp (Haupticon) | Katalog |
| 16–17 | Modifikator 1 | Advanced-Menü |
| 18–19 | Modifikator 2 | Advanced-Menü |

`subCategory` des Katalog-Eintrags → Schlüssel in `SIDC_ModifierCatalog.json`.
