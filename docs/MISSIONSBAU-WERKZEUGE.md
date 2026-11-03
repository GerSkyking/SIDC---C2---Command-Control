# Missionsbau-Werkzeuge – Entwurf (Vorarbeit & Planung)

Ergänzt `docs/PROJEKTE.md`. Ziel: Story, Konzept und Absprachen so strukturieren, dass daraus später die Pläne entstehen –
ohne zusätzliche Tools für Mod-Listen und Slotlisten (kommen aus anderen Werkzeugen).

## Phasen

| Phase | Inhalt | Status |
|---|---|---|
| 1 | Verknüpfungen (`{{typ:id}}`), Einfügen-Fenster, Suche (Titel + Inhalt), Vorlagen, Verzeichnisse, Zeitleiste | offen |
| 2 | Feedback-Schnittstelle (intern + extern per API), Status/Meilensteine, Kommentare/Versionen/Export für Dokumente | offen |
| 3 | Referenz-Marker im Plan (Aufgaben/Dokumente/Orte auf der Karte platzieren) | offen |

## Phase 1

### 1. Verknüpfungs-Codes
Eine UUID ist für Menschen unlesbar, deshalb gibt es **kopierbare Codes** und ein **Einfügen-Fenster**:

| Code | Ziel |
|---|---|
| `{{doc:<id>}}` | Datei (Öffentlich oder Missionsbau) |
| `{{task:<id>}}` | Aufgabe |
| `{{plan:<id>}}` | Plan |
| `{{note:<id>}}` | Haftnotiz (Whiteboard) |
| `{{img:<id>}}` | Bild (besteht bereits) |
| `{{place:<karte>:<ortsname>}}` | Ort einer Karte (aus `locations.json`) |

* Im Text wird der Code als Chip mit dem **aktuellen Namen** dargestellt (Umbenennen bricht nichts). Klick springt zum Ziel.
  Nicht (mehr) vorhandene oder nicht erlaubte Ziele erscheinen als grauer Chip „nicht verfügbar“ – ohne Namen preiszugeben.
* An jeder Datei, Aufgabe, jedem Plan und jeder Notiz gibt es **„Code kopieren“** (Klick kopiert den Code).
* Die Markdown-Leiste bekommt **„Einfügen“**: eigenes Fenster mit Suche; Karten als Untermenü → Karte → Orte durchsuchen.
* **Rückverweise**: Jede Datei/Aufgabe/Notiz zeigt „Erwähnt in …“.

Rechte: Missionsbau-Bereich, Pläne (Plan-Rechte) und Notizen/Aufgaben gelten wie bisher; die Auflösung filtert serverseitig.

**API**
* `POST /api/projects/{pid}/refs/resolve` Body `{"refs":[{"type","id"}]}` (max. 200) →
  `[{"type","id","label","sub","href","ok"}]` – `ok:false` wenn fehlend/unerlaubt (dann `label:""`).
* `GET  /api/projects/{pid}/refs/backlinks?type=&id=` → `[{"type","id","label","href"}]`
* Index-Tabelle `project_refs(project_id, source_type, source_id, target_type, target_id)`; wird beim Speichern von
  Dateien, Aufgaben (Titel + Beschreibung) und Notizen neu aufgebaut (Quelle im Missionsbau-Bereich nur für Missionsbauer lesbar).
* **Umsetzung (Backend, `routers/project_tools.py`)**: `href` je Typ: `doc` → `#/projects/<pid>/<public|builder>?doc=<id>`,
  `task` → `#/projects/<pid>/tasks?task=<id>`, `plan` → `#/plans/<id>` (bestehende Route), `note` → `#/projects/<pid>/whiteboard?note=<id>`,
  `img` → `#/projects/<pid>/<public|builder>?img=<id>`, `place` → `#/projects/<pid>/places?map=<karte>&name=<name>`
  (diese Query-Parameter und der Tab `places` gibt es im Frontend noch nicht; `main.ts` erlaubt bisher keine Query im Hash).
  `sub`: Datei = Bereich (Öffentlich/Missionsbau), Aufgabe = Status, Plan = Kartenname, Notiz = „Haftnotiz“, Bild = Planname, Ort = Kartenname.
  Ein Ort ist `ok`, wenn die Karte existiert **und** der Name (in irgendeiner Sprache) in deren `locations.json` steht.
  Ordner sind keine gültigen `doc`-Ziele. Rückverweise: ist das Ziel selbst nicht sichtbar, kommt `[]`.

### 2. Suche
`GET /api/projects/{pid}/search?q=&types=doc,task,plan,note,img&space=&limit=`
→ `[{"type","id","label","sub","href","snippet"}]`, Treffer in **Titel und Inhalt** (Dateien, Aufgaben inkl. Beschreibung,
Notizen, Plan-Namen, Bildnamen), Titeltreffer zuerst; `snippet` = kurzer Ausschnitt um den Treffer. Mindestens 2 Zeichen.
Rechte-gefiltert wie die Auflösung. `space` beschränkt nur Dateien und Bilder; Suchbegriff < 2 Zeichen → 400; `limit` 1-50 (Standard 20);
`%`/`_` werden wörtlich gesucht. Titeltreffer = Name/Titel/Dateiname/Bildunterschrift, Notizen zählen als Inhaltstreffer. Im Projektkopf gibt es ein Suchfeld; dasselbe Fenster dient als Einfügen-Auswahl.

### 3. Vorlagen & Verzeichnisse
* `project_docs.doc_type` (String 16, Standard `""`): `mission | briefing | opord | character | faction | place | scene`.
* Neue Datei → Auswahl **Vorlage** (leer, Missionskonzept, Befehl 5-Absatz, Briefing, Charakter, Fraktion, Ort, Szene).
  Vorlagen sind Konstanten im Frontend (i18n), setzen `doc_type` und den Startinhalt.
* `GET /api/projects/{pid}/docs?space=…&type=…` filtert optional; `doc_type` steht in `_doc_out`; `POST`/`PATCH` setzen es (ungültiger Wert → 422; Ordner haben keinen Typ: beim Anlegen `""`, `PATCH` mit Typ → 400).
* Tab **Verzeichnis**: Dateien nach Typ gruppiert (Personen, Fraktionen, Orte, Szenen …), Suche nach Titel **und** Inhalt.

### 4. Zeitleiste
Überschriften mit Zeitangabe am Anfang werden automatisch einsortiert:

| Schreibweise | Bedeutung |
|---|---|
| `## 06:30 Anmarsch` | Uhrzeit (Tag 1) |
| `## Tag 2 · 06:30 Angriff` / `## T2 06:30 …` | Uhrzeit an Tag 2 |
| `## T+01:30 Feindkontakt` / `## H+90 …` | relativ zum Missionsbeginn (Minuten bei `H+`) |

* Weitere Schreibweisen: `Day 2 06:30`, `T+90`, `H+1:30`, `06:30 Uhr`. Überschriften der Ebenen 1-6; Code-Blöcke (``` und ~~~) werden ignoriert.
  Absolute Einträge sortieren nach (Tag, Minuten) **vor** den relativen (nach Minuten); relative Einträge haben `day: null`.
* Parser serverseitig (`services/timeline.py`), Index-Tabelle `project_timeline(project_id, doc_id, space, ord_key, heading, level, day, minutes, relative, position)`; beim Speichern neu aufgebaut.
* `GET /api/projects/{pid}/timeline` → sortierte Einträge `{doc_id, doc_name, space, heading, level, day, minutes, relative, position, href}`
  (`heading` ohne Zeitangabe; `position` = Zeilennummer, `href` endet auf `&line=<position>`);
  Missionsbau-Einträge nur für Missionsbauer.
* Tab **Zeitleiste**: vertikaler Zeitstrahl, Klick öffnet die Datei an der Überschrift.

## Phase 2 (Skizze)
* **Feedback**: `project_feedback` (Titel, Text, Art bug/idee/lob, Status neu/in Arbeit/erledigt/abgelehnt, Quelle, Absendername, optional Plan/Datei, Zeitstempel).
  Oberfläche im Projekt (Tab „Feedback“, Filter, Status ändern, zu Aufgabe machen).
  Extern: pro Projekt ein **Feedback-Token** (rotierbar) → `POST /api/public/feedback/{token}` (rate-limitiert, ohne Login) plus
  einbettbares Formular; angemeldet über API-Token (`feedback:write`).
* **Status/Meilensteine**: Missionsstatus Entwurf → Review → Test → Freigabe, Meilensteine mit Termin, Anzeige in der Übersicht.
* **Dokumente**: Kommentare (Thread je Datei, wie Aufgaben), Versionsverlauf (letzte 50, Wiederherstellen), Export als Markdown/PDF.

## Phase 3 (Skizze)
Referenz-Marker im Missionsbau-Layer eines Plans: Aufgabe, Datei oder Ort wird als Pin auf der Karte platziert; Klick öffnet
das Ziel. Baut auf den Codes aus Phase 1 auf.
