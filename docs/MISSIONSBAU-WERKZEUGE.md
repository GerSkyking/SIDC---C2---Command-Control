# Missionsbau-Werkzeuge – Entwurf (Vorarbeit & Planung)

Ergänzt `docs/PROJEKTE.md`. Ziel: Story, Konzept und Absprachen so strukturieren, dass daraus später die Pläne entstehen –
ohne zusätzliche Tools für Mod-Listen und Slotlisten (kommen aus anderen Werkzeugen).

## Phasen

| Phase | Inhalt | Status |
|---|---|---|
| 1 | Verknüpfungen (`{{typ:id}}`), Einfügen-Fenster, Suche (Titel + Inhalt), Vorlagen, Verzeichnisse, Zeitleiste | umgesetzt |
| 2 | Feedback-Schnittstelle (intern + extern per API), Status/Meilensteine, Kommentare/Versionen/Export für Dokumente | Backend umgesetzt |
| 3 | Projekt-Verweise im Plan (Referenz-Pins, Chips in Textfeldern, Rückverweise von der Karte) | umgesetzt |

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

## Phase 2

### Feedback
* Tabelle `project_feedback`: `id, project_id, title(200), text(Text, max 5000), kind (bug|idea|praise|other), status (new|doing|done|rejected), source (internal|external), author_name(80), author_user_id?, plan_id?, doc_id?, task_id?, created_at, updated_at, handled_by?`.
* Intern (`/api/projects/{pid}/feedback`): `GET` (Filter `status`, `kind`, `q`), `POST` (auch Betrachter), `PATCH` Status/Notiz (Editor), `DELETE` (Owner),
  `POST …/{id}/to-task` erzeugt eine Aufgabe (verknüpft, `task_id` gesetzt). Missionsbau-Dateien/Pläne als Bezug nur wählbar, wenn sichtbar.
* **Externe Schnittstelle** (ohne Login): pro Projekt ein **Feedback-Token** (`projects.feedback_token`, 40 Zeichen, nullable = aus).
  Owner: `GET/POST/DELETE /api/projects/{pid}/feedback-token` (anzeigen / neu erzeugen / abschalten).
  Öffentlich: `GET /api/public/feedback/{token}` → `{"project":"Name","kinds":[…]}`; `POST /api/public/feedback/{token}`
  Body `{title,text,kind,name,website}` (`website` ist ein Honeypot-Feld: gefüllt → still verwerfen). Rate-Limit je IP und je Token,
  Textgrenzen, Projekt archiviert → 410, Token unbekannt → 404. Quelle = `external`.
  Frontend-Route `#/feedback/<token>` (öffentliches Formular, einbettbar per `<iframe>`), Doku mit `curl`-Beispiel im Handbuch.
* Tab **Feedback**: Liste mit Filter/Suche, Status ändern, „zu Aufgabe machen“, Token-Verwaltung für Owner (Link kopieren, neu erzeugen, abschalten).

### Status & Meilensteine
* `projects.stage` (`draft|review|test|release`, Standard `draft`), per `PATCH /projects/{pid}` (Editor).
* Tabelle `project_milestones(id, project_id, title(120), due_date?, done, ordering)`; `GET/POST/PATCH/DELETE /api/projects/{pid}/milestones` (Schreiben: Editor).
* Übersicht: Stufen-Anzeige (Stepper) und Meilenstein-Liste mit Fortschritt, überfällige hervorgehoben; Feedback-Zähler „neu“.

### Dokumente
* **Kommentare**: Tabelle `doc_comments` (wie `task_comments`, mit Erwähnungen), Endpunkte `…/docs/{doc_id}/comments` (GET/POST/PATCH/DELETE), Rechte wie die Datei (Missionsbau nur Builder), Betrachter dürfen kommentieren.
* **Versionen**: Tabelle `project_doc_versions(id, doc_id, project_id, name, content, saved_by, created_at)`. Beim Speichern von geändertem Inhalt wird der **vorherige** Stand
  gesichert, außer der letzte Eintrag ist von demselben Nutzer und jünger als 5 Minuten; höchstens 50 pro Datei (älteste fallen weg).
  `GET …/docs/{id}/versions`, `GET …/versions/{vid}` (mit Inhalt), `POST …/versions/{vid}/restore` (Editor; sichert den aktuellen Stand vorher).
* **Export**: im Frontend – „Als Markdown herunterladen“ und „Drucken / PDF“ (Druck-Stylesheet, nur die gerenderte Datei).

### Umsetzung Backend: Abweichungen und Ergänzungen
* **Pfade:** intern wie alle Projekt-Endpunkte ohne `/api` (`/projects/{pid}/feedback` …); nur die öffentliche Schnittstelle liegt unter `/api/public/feedback/{token}`.
* `project_feedback` hat zusätzlich `note` (interne Notiz, per `PATCH` setzbar). `PATCH` ändert `status`, `kind`, `note`; `handled_by` = wer zuletzt den Status gesetzt hat (bei „new“ leer).
* `to-task` antwortet `201 {"feedback":…,"task":…}`, setzt ein neues Feedback auf `doing`, übernimmt Plan/Datei nur, wenn für den Nutzer sichtbar; hat das Feedback schon eine (noch vorhandene) Aufgabe → 409. Löschen der Aufgabe/Datei leert `task_id`/`doc_id`.
* Feedback-Token: `GET/POST/DELETE …/feedback-token` liefert `{"enabled","token","path"}`; nur Owner. 40 Zeichen (`secrets.token_urlsafe(30)`), eindeutiger Index.
* Öffentlich: Rate-Limit 10 POST je IP/10 min, 60 POST je Projekt/Stunde, 120 GET je IP/min (→ 429); Honeypot antwortet `201 {"ok":true}`, speichert aber nichts; Postfach voll (5000) → 429; intern → 400.
* `PATCH /projects/{pid}`: `stage` darf der Editor setzen; sobald ein anderes Feld im Body steht (Name, Beschreibung, `archived`, `folder_id`), bleibt es Owner-Recht. Stufe steht in Projektobjekt, Projektliste und Übersicht.
* Übersicht: `stage`, `milestones {open, done, overdue, next{id,title,due_date}|null}` (nächster offener Termin ab heute), `feedback_new`.
* Meilensteine: höchstens 200 je Projekt; `due_date: null` im `PATCH` entfernt den Termin.
* Dokument-Versionen: leere Stände werden nicht gesichert; Wiederherstellen setzt nur den Inhalt (Name bleibt) und zählt wie ein Speichern (Verweise/Zeitleiste neu). Lesen darf jeder mit Zugriff auf die Datei.
* Dokument-Kommentare und Feedback lösen **keine** Benachrichtigung aus (die Benachrichtigungsarten sind fest an Frontend/Kanäle gebunden); Erwähnungen werden aber aufgelöst und gespeichert. Aktivitätsfeed: kein Eintrag für Feedback, Meilensteine, Kommentare.
* Der öffentliche Teil setzt keine eigenen CORS-/Frame-Header; die CSP der App verbietet das Einbetten per `<iframe>` (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) – für das einbettbare Formular braucht die Route `#/feedback/<token>` im Frontend/Proxy eine Ausnahme.

## Phase 3: Projekt-Verweise im Plan

Es gibt **keine neue Marker-Art**: Ein **Referenz-Pin** ist eine gewöhnliche **Annotation** (frei platzierbares Markdown-Textfeld,
per WebSocket synchronisiert), deren Text nur aus Verknüpfungs-Codes (Phase 1) besteht. Die Ebene ergibt sich wie bei jeder
Annotation aus der Phase (Missionsbau-Phase = nur Missionsbauer).

* **Projekt-ID im Frontend:** kommt aus dem Plan-Snapshot (`snapshot.plan.project_id`, schon vorhanden) – keine Backend-Änderung.
* **Chips im Plan:** Annotationen, Annotations-Vorschau und Phasen-Notizen rufen `wireRefChips(root, project_id, opts)` auf, wenn der Plan
  zu einem Projekt gehört (sonst bleiben die Chips inaktiv). Ziele (Datei, Aufgabe, Plan, Notiz) öffnen in einem **neuen Tab**
  (`opts.newTab`), damit Entwürfe/Live-Zustand nicht verloren gehen. `{{img:…}}` bleibt beim Lightbox-Verhalten des Plans (`opts.skipImg`).
* **Ort-Chip:** gehört der Ort zur Karte des Plans (`mapId` gleich), fliegt die Karte zu den Koordinaten aus `locations.json`
  (`[lon, lat]` wie die Ortsebene, `opts.onPlace`); andere Karten zeigen das Popover aus Phase 1.
* **Editor:** Annotations- und Phasen-Notizen-Editor bekommen über `attachMdToolbar(ta, { projectId })` den Knopf „Verweis einfügen".
  Ohne Projekt erscheint er nicht.
* **Werkzeug „Verweis platzieren"** (Plan-Werkzeugleiste, nur mit Projekt und Bearbeiten-Recht): Auswahlfenster → Klick auf die Karte legt
  eine Annotation (Breite 160, aktive Phase) mit dem Code an; `Esc` bricht ab, es wird nie eine leere Annotation angelegt.
  Annotationen aus reinen Codes erhalten die CSS-Klasse `annot-ref` (kompakter Pin).
* **Rückverweise:** `project_refs` kennt die Quelle `annotation` (`source_id` = Annotation-ID). Der Index wird in `routers/live.py`
  beim Anlegen/Ändern des **Textes**/Löschen aufgebaut, außerdem beim Verschieben eines Plans in/aus einem Projekt, bei der
  Versions-Wiederherstellung, beim Löschen von Missionsbau-Phasen und beim endgültigen Löschen eines Plans. Pläne ohne Projekt haben
  keine Einträge. Beim Auflösen zählt die Annotation nur, wenn der Plan zum Projekt gehört, nicht im Papierkorb liegt, der Nutzer
  Plan-Zugriff hat und – bei Missionsbau-Phase – Missionsbauer ist. `refs/backlinks` und `refs/resolve` liefern dann Label
  `<Planname> (Karte)` und `href` `#/plans/<plan_id>`. Die Suche bleibt unverändert.
* **Klonen:** Plan-Klone enthalten bisher keine Annotationen (bestehendes Verhalten) – daher entsteht dort auch kein Index.
* Tests: `backend/tests/test_plan_refs.py`.

## Stern-Pins und Layer „Missionsbau-Notizen“ (Stand 2026-11-11, ersetzt die beiden folgenden Abschnitte teilweise)

* **Werkzeug „Ort markieren“** (Kartennadel mit Stern) ersetzt „Verweis platzieren“: erst Klick auf die Karte (Entwurfs-Stern als
  MapLibre-Marker), dann Dialog „Was ist hier?“ → *Aufgabe* (`POST /projects/{pid}/tasks` mit `plan_id`), *Haftnotiz*
  (`POST /projects/{pid}/notes`, pink bei Missionsbau), *Bestehendes verknüpfen* (Auswahlfenster) oder *Nur Kartennotiz*.
  Danach `annotation.create` mit Text `{{typ:id}}` (+ optional Bezeichnung/Beschreibung in den Folgezeilen).
* **Stern-Pin** = Annotation, deren **erste Zeile** nur aus Verknüpfungs-Codes besteht (Rest = Beschreibung, beim Überfahren).
  Darstellung als Stern genau am Punkt: gelb = normale Notiz, pink (pulsierend) = Layer *Missionsbau-Notizen*.
* **Layer statt Phase:** Annotationen in Projekt-Plänen liegen nur noch auf der notes-Phase, wenn ein Missionsbauer
  `mb_layer: true` schickt (`annotation.create`/`annotation.modify`); sonst wie überall in der gewählten Phase (auch für
  Nicht-Missionsbauer erlaubt). `mb_layer: false` + `phase_id` holt eine Notiz zurück. Wechselt eine Notiz auf den Layer, geht
  zuerst ein `annotation.delete` an alle Sockets, dann das `annotation.upsert` an den Missionsbau. `annotation.move` ändert
  die Phase nie. Die notes-Phase erscheint im Frontend nicht im Zeitstrahl und in keiner Phasenauswahl, sondern als Eintrag
  im Menü *Layer* (je Nutzer ein-/ausblendbar); Missionsbauer sehen sie in jeder Ansicht außer Zeus.
* Neue Phasen dieser Rolle heißen „Missionsbau-Notizen“. Zeus-Einzelfreigabe unverändert, Standard im Frontend 72 h.
* `GET /projects/{pid}/map-notes` liefert jetzt **alle** Annotationen der Projekt-Pläne mit Feld `mb` (Layer ja/nein).

## Karten-Notizen (feste Ebene in Projekt-Plänen) – ursprüngliche Fassung

Jede Annotation (Textfeld/Verweis-Pin) eines Plans mit `project_id` liegt automatisch auf einer **festen Missionsbau-Ebene** „Karten-Notizen“.

* **Modell:** `phases.role = 'notes'` (Migration `0043_notes_layer`), `plane = 'builder'`, **`parent_id` bleibt leer** (eine an die gesperrte Base-Phase
  gehängte Builder-Phase mit `sub_ordering 0` gilt als „Spiegel“ und wäre für alle sichtbar). `GET /plans/{id}/phases` und der Snapshot liefern `role`.
* **Anlage:** `services/notes_layer.ensure_notes_phase` (idempotent) bei Plan-Erstellung im Projekt, Verschieben in ein Projekt, Klonen in ein Projekt,
  Versions-Wiederherstellung und lazy beim Anlegen/Ändern einer Annotation (Altpläne). Daten-Migration legt sie für alle Projekt-Pläne an;
  bestehende Annotationen werden **nicht** verschoben. Beim Herauslösen aus dem Projekt verliert die Phase die Rolle (bleibt samt Inhalt).
* **Sichtbarkeit:** nur Missionsbauer. **Zeus sieht nur einzeln freigegebene Pins** (Migration `0044_annotation_zeus`: `annotations.zeus_released`,
  `zeus_until`). Die Ebene selbst ist nicht freigebbar (`PATCH` der Phase mit `zeus_released`/`player_released` → 400). Freigabe per Live-Nachricht
  `annotation.modify` mit `zeus_released` (+ optional `zeus_hours`; leer/0 = unbegrenzt), nur Missionsbauer (bei anderen wird das Feld ignoriert). Spieler sehen
  die Ebene nie. Zeus darf freigegebene Pins nur ansehen (kein Anlegen/Ändern/Löschen). Snapshot und Live-Broadcast liefern Zeus nur freigegebene,
  nicht abgelaufene Pins; Rücknahme/Löschen schickt Zeus ein `annotation.delete` (`Hub.broadcast(..., zeus_only=True)`). Abgelaufene Fristen greifen
  beim nächsten Laden (kein Push beim Ablauf, wie bei Phasen).
* **Live:** `annotation.create/move/modify` mit `phase_id`/`extra_phase_ids` setzen serverseitig `phase_id` = notes-Phase und `extra_phase_ids = []`
  (Client-Werte werden ignoriert) – vor der Rechteprüfung; Nicht-Missionsbauer werden daher abgelehnt (Zeus nur bei Freigabe).
* **Schutz:** `DELETE` der Phase → 400, `role` ist per API nicht änderbar, Umbenennen erlaubt.
* **Liste „Auf der Karte“:** `GET /projects/{pid}/map-notes` (nur Missionsbauer, sonst 404; nur Pläne mit Zugriff, nicht im Papierkorb):
  `[{id, plan_id, plan_name, text, title, world_x, world_y, updated_at, updated_by_label, href}]`, sortiert nach Planname, dann Änderung absteigend, max. 2000.
* Tests: `backend/tests/test_map_notes.py`.
