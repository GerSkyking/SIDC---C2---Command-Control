# Missionsbau-Rolle · Parallele Ebenen · ORBAT — Design

Stand 2026-09-08. Mit dem Nutzer abgestimmt. Umsetzung in drei Bausteinen (A → B → C).
Alle Entscheidungen unten sind final, sofern nicht als *offen* markiert.

---

## Baustein A — Rolle „Missionsbau" + parallele Ebenen/Phasen

### Rolle
- Neue **globale** Capability `is_mission_builder`, setzbar pro **User** und pro **Gruppe**
  (analog zu `can_create_plans`). `admin` impliziert sie.
- `effective_mission_builder(db, user)` = User-Flag ∨ eine Gruppen-Flag ∨ `is_admin`.
- Orthogonal zur Plan-ACL: ein Missionsbauer braucht trotzdem ACL-Zugriff auf einen Plan,
  um ihn zu sehen. Wirkt dann in **jedem** Plan, den er über die ACL sieht.
- Sidebar bekommt (nur für Missionsbauer) eine Gruppe **„Missionsbau"** neben
  „Administration" → Einträge: *ORBAT-Bibliothek* (Baustein B).

### Ebenen & Phasen
- `Phase` bekommt:
  - `plane`: `"player"` (Default) | `"builder"`
  - `parent_id` (FK `phases.id`, nullable) — bei `plane="builder"` die zugehörige
    **initiale Spieler-Phase**. Bei Spieler-Phasen `NULL`.
  - `sub_ordering` (Int) — Reihenfolge der Builder-Phasen innerhalb einer Spieler-Phase
    (ergibt „1.1", „1.2" … alle bezogen auf Spieler-Phase 1).
- **Auto-Paarung:** legt ein Editor eine Spieler-Phase an, entsteht automatisch **eine**
  Builder-Phase (`plane="builder"`, `parent_id` = neue Phase, gleicher Name, `sub_ordering=0`).
  Löscht jemand die Spieler-Phase → alle Builder-Kinder mit weg.
- Ein Missionsbauer darf **zusätzliche** Builder-Phasen unter einer Spieler-Phase anlegen
  (1.1, 1.2 …). Kein Spieler-Gegenstück.
- Phasen anlegen bleibt für jeden Editor erlaubt (Punkt 3).

### Sichtbarkeit — **serverseitig** erzwungen
- **Spieler** (nicht-Missionsbauer): Snapshot / Live enthalten **nur** `plane="player"`-Phasen
  und **nur** Marker/Annotationen/Strokes, deren `phase_id` auf eine Spieler-Phase (oder
  `NULL`) zeigt. Builder-Daten verlassen den Server nie.
- **Missionsbauer:** sieht beide Ebenen. Die jeweils „andere" Ebene wird mit einstellbarer
  Transparenz gezeichnet — **zweiter Regler** in der Topbar, getrennt vom
  Fremdphasen-Regler (`outOpacity`).
- **Öffentliche Links:** immer nur Spieler-Ebene (Punkt 7).

### Arbeiten als Missionsbauer
- In der Phasen-Leiste zusätzlich ein Umschalter **„wirke als: Spieler | Missionsbau"**.
- Wählt der Missionsbauer eine **Spieler-Phase** (statt seiner Builder-Phase):
  volle Spieler-Sicht **inkl. der freigegebenen ORBAT-Marker**, und er darf **alles
  bearbeiten/löschen** (voller Editor-Zugriff auf den Spieler-Layer).
- Im Modus „Missionsbau" setzt/ändert er Builder-Marker; Spieler-Marker sind dann nur
  transparent sichtbar, nicht anfassbar.

### Auswirkungen auf Bestehendes
- **Snapshot / Live:** Filter nach `plane` je Verbindung. `hub.broadcast` bekommt einen
  optionalen `to_builders_only`-Filter; Builder-Ops (`*.upsert`/`*.delete` für Marker auf
  Builder-Phasen) werden nur an Missionsbau-Sockets ausgeliefert.
- **Versionen / Wiederherstellen / Klonen:** speichern/kopieren beide Ebenen.
- **Screenshot:** aus Spieler-Sicht nur Spieler-Ebene; aus Missionsbau-Sicht beide.
- **Briefing-PDF:** zwei Varianten — **Spieler-Briefing** (nur Spieler-Ebene) und
  **Missionsbau-Briefing** (beide, Spieler transparent).

### Datenmodell A (Zusammenfassung)
```
User.is_mission_builder      : bool  (Default false)
Group.is_mission_builder     : bool  (Default false)
Phase.plane                  : "player" | "builder"
Phase.parent_id              : phases.id | NULL
Phase.sub_ordering           : int
```

---

## Baustein B — ORBAT als globale Entität + Baumdiagramm

### Entitäten
```
Orbat            id, name, affiliation ("own"|"enemy"|"neutral"|"unknown"),
                 notes, created_by, created_at
OrbatNode        id, orbat_id, parent_id (nullable), name, sidc,
                 qty_planned (int), qty_current (int),
                 status ("active"|"damaged"|"destroyed"),   # spiegelt SIDC-Statusstelle
                 ordering (int), notes,
                 # Freigabe an Spieler (Punkt 15 — komplett dynamisch):
                 rel_visible (bool),        # Existenz sichtbar?
                 rel_show_type (bool),      # Symbol/Typ sichtbar (sonst „unbekannt")?
                 rel_strength (int)         # -1 = Stärke verborgen, sonst % der qty_planned,
                                            # das den Spielern gezeigt wird
OrbatAcl         id, orbat_id, subject_type ("user"|"group"), subject_id,
                 level ("viewer"|"editor")   # owner = created_by / admin
PlanOrbat       plan_id, orbat_id           # ORBAT einem Plan zugeschaltet
```
- **Bestand ist global pro ORBAT** (Punkt 18): dieselbe ORBAT kann in mehreren Plänen
  aktiv sein, `qty_current` / `status` sind geteilt.
- **Freigabe ist global pro ORBAT** (Punkt 16): was Spieler sehen, ist am Knoten
  konfiguriert und gilt überall, wo die ORBAT genutzt wird.

### UI
- **ORBAT-Bibliothek** (Sidebar → Missionsbau): ORBATs anlegen/löschen, ACL verwalten,
  Baum bearbeiten. Bearbeiten nur Missionsbau + ORBAT-`editor`; Lesen je ORBAT-ACL.
- **Im Plan:** „ORBAT hinzufügen" (berechtigter Missionsbauer) → danach sehen **alle
  Spieler** dieses Plans die ORBAT — in der **freigegebenen** Sicht.
- **Baumdiagramm:** Org-Chart (Boxen + Linien, top-down), **Ein-/Ausklappen** und
  **Drag & Drop** zum Umhängen. Aufklappen erlaubt, aus einem Platoon einzelne Squads auf
  die Karte zu setzen (Baustein C).
- Anzeige der Stärke als **Ist / Soll** (z. B. „Panzer 10/14").

---

## Baustein C — Verknüpfung Marker ↔ ORBAT, Aufklärung, Pflege

### Marker ↔ Knoten (Punkt 13 = **beides**)
- `Marker.orbat_node_id` (FK, nullable).
- (a) **Aus dem Baum platzieren:** Knoten auf die Karte ziehen → Marker mit dem SIDC des
  Knotens, `orbat_node_id` gesetzt.
- (b) **Am Marker zuweisen:** im Marker-Editor ein Feld „ORBAT-Knoten".
- Ein Knoten kann mehrere Marker haben (z. B. 3 Züge = 3 Marker unter einem Zug-Knoten).

### Status / „zerstört" (Punkt 14)
- Steuerung an **beiden Orten** über den **Status** (= SIDC-Statusstelle 6:
  `0` einsatzbereit … `3` beschädigt … `4` zerstört).
  - Marker-Status ändern → verknüpfter Knoten übernimmt (`active`/`damaged`/`destroyed`).
  - Knoten-Status ändern → alle verknüpften Marker übernehmen die SIDC-Statusstelle.
- **Effekt:** zerstörter Marker halbtransparent; `qty_current` des Knotens wird neu
  berechnet (verknüpfte, nicht-zerstörte Marker + manuelle Korrektur).
- Zerstörte Knoten/Marker bleiben sichtbar (durchgestrichen / grau), verschwinden nicht.

### Aufklärungs-Freigabe (Punkt 15 — komplett dynamisch)
Pro Knoten frei kombinierbar:
| `rel_visible` | `rel_show_type` | `rel_strength` | Spieler sehen |
|---|---|---|---|
| false | – | – | nichts |
| true | false | -1 | „Feindkräfte unbekannter Art/Stärke" |
| true | true | -1 | Symboltyp, Stärke unbekannt |
| true | true | 50 | Symboltyp + „~50 % von Soll" (gerundet/als Bereich) |
| true | true | 100 | volle Sicht |
- „Vermeintlicher Feind" wird als ORBAT `affiliation="enemy"` gepflegt; die Freigabe
  bestimmt, wie unscharf die Spieler das sehen.

### Briefing-Integration (Punkt 17)
- Eigene Seite **„Kräfteübersicht"** im Briefing-PDF.
- **Nur Knoten, die (in der betreffenden Phase) einen Marker auf der Karte haben**, kommen
  ins Briefing — nicht der komplette ORBAT-Baum.
- Missionsbau-Briefing: voller Stand. Spieler-Briefing: freigegebene Sicht.
- Darstellung als gerendertes Baumdiagramm (SVG → Bild).

### Datenmodell C (Zusammenfassung)
```
Marker.orbat_node_id : orbat_nodes.id | NULL
```

---

## Reihenfolge & offene Micro-Punkte

1. **Baustein A** — Rolle + parallele Phasen + serverseitige Sicht-Filter + 2. Regler +
   „wirke als"-Umschalter. Größter Umbau (Snapshot/Live/Versionen).
2. **Baustein B** — ORBAT-Entitäten + Bibliothek + Baum-UI (Drag&Drop, Ein-/Ausklappen) +
   ORBAT-ACL + „ORBAT zum Plan".
3. **Baustein C** — Marker↔Knoten (beide Wege), Status-Sync, Freigabe-Rendering für Spieler,
   Briefing-Seite.

**Noch zu klären (klein, kann während der Umsetzung):**
- A: Bekommt der „wirke als"-Umschalter ein Tastenkürzel? Merkt er sich die letzte Wahl?
- B: `qty_current` — automatisch aus verknüpften Markern **oder** frei editierbar mit
  Auto-Vorschlag? (Vorschlag: frei editierbar, Marker-Zerstörung schlägt Dekrement vor.)
- B: Braucht ein ORBAT eine Phase-/Zeitbindung, oder ist es zeitlos und nur der
  Marker-Status trägt den Verlauf? (Vorschlag: zeitlos.)
- C: Wenn ein Spieler einen freigegebenen Enemy-Marker sieht — darf er ihn verschieben
  (eigene Lagebeurteilung) oder ist er für Spieler read-only? (Vorschlag: read-only,
  Spieler legen eigene „vermutete Feind"-Marker an.)
- C: „~50 %"-Anzeige — als konkrete gerundete Zahl oder als Bereich („1–2 Kp")?
