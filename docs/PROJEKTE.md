# Missionsbau-Projekte – Spezifikation

Neue Kategorie **Missionsbau** (Sidebar, parallel zu „Pläne"). Ein **Projekt** ist der Hauptordner und hat
drei feste Unterbereiche: **Öffentlich**, **Missionsbau**, **Pläne**. Dazu kommen Aufgaben-Board,
Haftnotizen-Whiteboard, Projektübersicht, Mitglieder und (nur Admin) Speicherauswertung.

## 1. Rechte

- **Projekt-Mitglieder** (Nutzer oder Gruppe) mit Rolle `viewer` < `editor` < `owner`. Admin sieht/darf alles.
- **Projekte anlegen:** Admin oder `is_mission_builder_effective`. Ersteller wird `owner`.
- Bereich **Öffentlich**: alle Projekt-Mitglieder (viewer lesen, editor schreiben).
- Bereich **Missionsbau**: zusätzlich nur für Nutzer mit `effective_mission_builder` (oder Admin) – sonst weder sichtbar noch per API erreichbar (404, nicht 403, damit Existenz nicht leakt). Gilt für Dateien UND Bilder dieses Bereichs.
- Bereich **Pläne**: Pläne des Projekts. Die Plan-ACL bleibt maßgeblich, **zusätzlich** galt die Projektrolle implizit (ENTFALLEN, siehe §7.2)
  als Plan-Ebene (`viewer→viewer`, `editor→editor`, `owner→owner`, jeweils Maximum mit der Plan-ACL).
  Missionsbau-Phasen in Plänen bleiben wie bisher nur für Missionsbauer.
- Aufgaben, Whiteboard, Übersicht: alle Mitglieder lesen; `editor`+ schreiben. Aufgaben mit Bezug auf Missionsbau-Dateien/-Pläne sind normal sichtbar (nur der Bezug-Titel wird für Nicht-Missionsbauer ausgeblendet).
- Mitglieder verwalten, Projekt umbenennen/archivieren/löschen: `owner`.
- Speicherauswertung: **nur Admin**.

## 2. Datenmodell (neue Migration `0029_projects.py`)

- `projects`: id, name (≤120), description (Text), archived (bool), created_by, created_at, updated_at.
- `project_members`: project_id, subject_type (`user`|`group`), subject_id, role; PK (project_id, subject_type, subject_id).
- `plans.project_id` (FK projects, ondelete SET NULL, nullable, Index). `plan_folders.project_id` (nullable, Index): Ordner im Bereich „Pläne" eines Projekts.
- `plan_images.project_id` (nullable, Index, wird beim Upload aus `plans.project_id` gesetzt; Backfill in der Migration; beim Verschieben eines Plans in/aus einem Projekt für alle seine Bilder nachziehen).
  Bereich eines Bildes = Missionsbau, wenn seine Phase `plane == "builder"`, sonst Öffentlich.
- `project_docs`: id, project_id, space (`public`|`builder`), parent_id (self-FK, ondelete CASCADE), kind (`folder`|`doc`),
  name (≤200), content (Text, Markdown, ≤200 000 Zeichen, nur kind=doc), ordering, byte_size, created_by, updated_by, created_at, updated_at.
- `project_notes` (Haftnotizen): id, project_id, text (≤4000), color (`yellow|green|blue|pink|orange|gray`), x, y, w (Default 220), h (Default 160), created_by, updated_by, timestamps.
- `project_tasks`: id, project_id, title (≤200), description (Markdown ≤20 000), status (`open|doing|review|done`), priority (`low|normal|high`), assignee_id (User, SET NULL), due_date (Date, nullable),
  ordering (int innerhalb der Spalte), plan_id (nullable, SET NULL), doc_id (nullable, SET NULL), created_by, updated_by, timestamps, done_at.

## 3. REST-API (Router `backend/app/routers/projects.py`, Prefix `/projects`)

Alle Antworten JSON. Fehler wie im Rest der App (`HTTPException`). Schreibzugriffe schreiben `audit.record(...)`.

| Methode + Pfad | Zweck |
|---|---|
| `GET /projects` | Liste der sichtbaren Projekte: `{id,name,description,archived,role,plan_count,open_tasks,my_open_tasks,updated_at}` |
| `POST /projects` `{name,description?}` | anlegen (Builder/Admin) |
| `GET/PATCH/DELETE /projects/{id}` | Details inkl. `role`, `is_builder` (darf Bereich Missionsbau sehen) / ändern (`name,description,archived`) / löschen (owner; Pläne bleiben, `project_id` → NULL) |
| `GET /projects/{id}/members`, `PUT /projects/{id}/members` `[{subject_type,subject_id,role}]`, `GET /projects/{id}/members/candidates` | Mitglieder (owner schreibt) |
| `GET /projects/{id}/overview` | `{open_by_assignee:[{user_id,label,open,doing,review}], due_soon:[tasks ≤7 Tage], overdue:[...], recent_docs:[...], recent_plans:[...], counts:{docs,images,plans,tasks_open}}` |
| `GET /projects/{id}/docs?space=public\|builder` | flacher Baum: `[{id,parent_id,kind,name,byte_size,updated_at,updated_by}]` |
| `POST /projects/{id}/docs` `{space,parent_id?,kind,name,content?}` | anlegen |
| `GET /projects/{id}/docs/{doc_id}` | inkl. `content` |
| `PATCH /projects/{id}/docs/{doc_id}` `{name?,content?,parent_id?,expected_updated_at?}` | ändern/verschieben; bei abweichendem `expected_updated_at` → 409 (Konflikt, damit nichts überschrieben wird); Verschieben nur im selben Bereich, nicht in eigene Nachkommen |
| `DELETE /projects/{id}/docs/{doc_id}` | löschen (Ordner rekursiv) |
| `GET /projects/{id}/images?space=public\|builder` | Bilder des Bereichs: `{id,plan_id,plan_name,filename,caption,byte_size,natural_w,natural_h,created_at,author}`; Rohdaten weiter über `/plans/{plan_id}/images/{id}/raw` (Rechte dort prüfen jetzt zusätzlich Projektrolle) |
| `PATCH/DELETE /projects/{id}/images/{image_id}` | Bildname/Notiz ändern bzw. löschen (editor+, Missionsbau-Bilder nur Builder); Broadcast wie bisher an den Plan-Hub |
| `GET/POST /projects/{id}/notes`, `PATCH/DELETE /projects/{id}/notes/{nid}` | Whiteboard-Notizen (editor+ schreibt) |
| `GET/POST /projects/{id}/tasks`, `PATCH/DELETE /projects/{id}/tasks/{tid}`, `POST /projects/{id}/tasks/{tid}/move` `{status,ordering}` | Aufgaben; Filter `?assignee=me\|<uid>&status=…` |
| `GET /projects/{id}/plans` | Pläne des Projekts (`PlanItem` wie `/plans`) |
| `POST /plans/{plan_id}/project` `{project_id\|null}` | Plan in Projekt verschieben/herauslösen (Plan-owner **und** Projekt-editor); zieht `plan_images.project_id` nach |
| `POST /plans` / `/folders` | akzeptieren optional `project_id` (Projekt-editor nötig); `GET /folders?project_id=…` und `GET /plans` filtern: ohne Parameter nur Einträge **ohne** Projekt |
| `GET /admin/projects/storage` (nur Admin) | `[{project_id,name,images_bytes,docs_bytes,plans_count,total_bytes}]`, absteigend nach total |

- Live-Aktualisierung (v1): Frontend pollt alle 5 s (nicht beim Ziehen/Tippen). Eine spätere Erweiterung kann den Hub mit Raum `project:<id>` nutzen.
- Bilder-Upload bleibt **pro Plan** (`POST /plans/{id}/images`): das Bild wird mit `project_id` des Plans gespeichert und erscheint automatisch im Projekt-Bereich (Öffentlich bzw. Missionsbau).
- **Admin-„Bilder"-Reiter entfällt** (Frontend `admin.ts`/`ui.ts`/`main.ts` + Backend-Endpunkte `GET /api/admin/images`, `DELETE …` entfernen, Tests anpassen). Speicherübersicht pro Projekt ersetzt ihn (Admin-Reiter „Speicher" oder Karte im Admin-Bereich).

## 4. Frontend

Routen: `#/projects` (Liste + „Neues Projekt"), `#/projects/<id>` (Tabs, aktiver Tab als `#/projects/<id>/<tab>`).
Tabs: **Übersicht · Öffentlich · Missionsbau (nur Builder) · Pläne · Aufgaben · Whiteboard · Mitglieder** (+ **Speicher** nur Admin als Karte in der Projektliste/Admin).

- **Pläne:** gleiche Baumansicht wie `planTree.ts` (Drag & Drop, Ordner, Erstellen-Karte), aber auf das Projekt eingeschränkt; „Plan hierher verschieben" für bestehende Pläne.
- **Öffentlich / Missionsbau:** links Dateibaum (Ordner + `.md`-Dokumente, Drag & Drop zum Verschieben, Umbenennen, Löschen), rechts Markdown-Editor mit Vorschau (vorhandene `md.ts`/`mdtoolbar.ts`), Speichern per Strg+S, Konflikthinweis bei 409; darunter/daneben Reiter „Bilder" (Raster der Bereichs-Bilder mit Plan-Name, Löschen, Kopier-Link für Markdown-Einbettung `![](/plans/<plan>/images/<id>/raw)`).
- **Aufgaben:** Kanban mit Spalten Offen / In Arbeit / Review / Erledigt, Karten per Drag & Drop, Zuständige(r), Fälligkeit (überfällig rot), Priorität, optionaler Bezug zu Plan/Dokument; Filter „Meine".
- **Whiteboard:** Haftnotizen wie im KabelMaster (farbig, am Kopf ziehen, Text direkt tippen, Farbe wechseln, löschen), große Fläche mit Scrollen; Touch-fähig; Polling 5 s.
- **Übersicht:** Karten „Offene Aufgaben je Person", „Fällig bald / überfällig", „Zuletzt geändert", Zahlen.
- Sidebar: neuer Punkt **Missionsbau** unter „Pläne"; Texte DE+EN in `i18n.ts`, alle Nutzerdaten per `esc()`.
- Hilfstexte/Platzhalter so, dass jede Schaltfläche selbsterklärend ist (Titel, Leerzustände mit Handlungsaufforderung).

## 5. Qualität

- Backend: pytest-Tests für Rechte (Missionsbau-Bereich unsichtbar für Nicht-Builder, Rollen, implizite Plan-Rechte, Konflikt 409, Zyklus beim Verschieben), Speicherauswertung nur Admin.
- Frontend: `tsc --noEmit` + Vite-Build sauber; Vorschau mit Mock-Backend zur visuellen Prüfung.
- `docs/HANDBUCH.md` um einen Abschnitt „Missionsbau-Projekte" ergänzen, `CHANGELOG.md` + `PLAN.md` kurz nachziehen.

## 6. Backend-Ergänzungen

- **Pfade:** `/projects…` und `/plans…`/`/folders…` ohne `/api`-Präfix (wie bisher). Speicherauswertung: `GET /api/admin/projects/storage` (Admin-Router hat `/api/admin`).
- Zeitstempel (`updated_at` etc.) kommen als UTC-ISO mit `Z`; `expected_updated_at` genau diesen Wert zurückschicken. Konflikt = 409, Text in `detail`.
- `PlanOut`/`PlanListItem` und Ordner (`/folders`) enthalten jetzt `project_id`. `GET /plans` und `GET /folders` ohne `project_id` liefern nur Einträge OHNE Projekt; `?project_id=` liefert die des Projekts (`/folders?project_id=` für Nicht-Mitglieder: 404). `GET /projects/{id}/plans` liefert zusätzlich `level`.
- **Neu:** `GET /projects/{id}/assignees` -> `[{user_id,label}]` (aktive Nutzer mit Projektzugriff, für Aufgaben-Zuständige). `assignee_id` muss ein solcher Nutzer sein (sonst 400).
- `GET /projects/{id}/members` -> `[{subject_type,subject_id,role,name}]` (jedes Mitglied darf lesen); `PUT` verlangt mind. einen `owner`. `GET …/members/candidates` -> `[{subject_type,subject_id,name}]` (owner).
- Doc-Objekte enthalten zusätzlich `space`, `ordering`; Einzel-GET/POST/PATCH liefern `content`. `PATCH` verschiebt nur, wenn `parent_id` im Body steht (`null` = Wurzel). Doc-Liste ohne `space` = `public`.
- Bild-Objekte (`/projects/{id}/images`) zusätzlich: `note`, `phase_id`, `space`. `PATCH` Body `{caption?, note?}`.
- Aufgaben-Objekte: `{id,title,description,status,priority,assignee_id,assignee_label,due_date,ordering,plan_id,plan_name,doc_id,doc_name,created_at,updated_at,done_at}`; `doc_name` ist für Nicht-Missionsbauer bei Missionsbau-Dokumenten `null`. `PATCH` setzt `assignee_id/plan_id/doc_id/due_date` nur bei gesendetem Feld (`null` = leeren). `move` nummeriert die Zielspalte neu (`ordering` = Einfügeposition).
- Notiz-Objekte: `{id,text,color,x,y,w,h,updated_at,created_by,updated_by}`; w/h werden auf 80..2000 bzw. 60..2000 begrenzt.
- Archivierte Projekte sind schreibgeschützt (403), nur `PATCH /projects/{id}` (owner) geht noch.
- (Ersetzt durch §7.2: Projektrolle hat KEINEN Einfluss auf Plan-Rechte.)
- `POST /plans/{id}/project` setzt `folder_id` auf `null` zurück (Ordner gehören zum Projekt-Kontext). Klon in einen Projektordner erbt das Projekt.
- Admin-Bilder-Endpunkte (`/api/admin/images`) sind entfernt.
- Projekt löschen: Pläne bleiben (`project_id`/`folder_id` -> NULL), Projekt-Ordner, Dateien, Notizen, Aufgaben werden gelöscht, Bilder bleiben am Plan (`project_id` -> NULL).

## 7. Änderungen (Runde 2)

### 7.1 Projekt-Ordner (Projekte als Ordnerstruktur)
- Neue Tabelle `project_folders` (id, name ≤120, parent_id self-FK ondelete SET NULL, ordering, created_by, created_at) + `projects.folder_id` (nullable FK ondelete SET NULL, Index); neue Migration `0030_project_folders.py`.
- API (Router eigenständig, Prefix `/project-folders`): `GET` (Admin: alle; sonst Ordner, die ein für den Nutzer sichtbares Projekt enthalten – auch indirekt über Unterordner – inkl. aller Vorfahren, plus selbst angelegte), `POST {name,parent_id?}` (Admin/Missionsbauer), `PATCH /{id}` `{name?,parent_id?,move_to_root?}` (Admin oder Ersteller; Zyklenprüfung), `DELETE /{id}` (Admin oder Ersteller; Inhalt – Unterordner und Projekte – rückt eine Ebene nach oben).
- `POST /projects` und `PATCH /projects/{id}` akzeptieren `folder_id` (null = oberste Ebene); Verschieben eines Projekts: Projekt-`owner` oder Admin, Zielordner muss dem Nutzer gehören/sichtbar sein bzw. Admin/Builder. `GET /projects` liefert `folder_id` je Projekt.
- Frontend: Projektliste als Baum (Wurzel „Alle Projekte", Ordner, Unterordner, Projekt-Karten/-Zeilen), Drag & Drop (Projekte und Ordner), „Neuer Ordner", Umbenennen, Löschen, Auf-/Zuklappen (Zustand in localStorage), Auswahl eines Ordners = Ziel für „Neues Projekt". Optik/Verhalten wie `planTree.ts`.

### 7.2 Plan-Rechte im Projekt (ersetzt die implizite Regel aus §1)
- **Keine** automatische Plan-Ebene aus der Projektrolle mehr: `project_role` darf weder `effective_level` noch `effective_caps` beeinflussen. Pläne im Projekt werden wie bisher **pro Plan** über „Zugriff / Freigaben" (Plan-ACL: Nutzer/Gruppen) freigegeben; der Ersteller ist Plan-`owner`.
- `GET /projects/{id}/plans` und `/folders?project_id=` liefern nur Pläne, die der Nutzer per Plan-ACL sehen darf (Admin: alle). Planerstellung im Projekt: Projekt-`editor`+ (wie bisher). Das Projekt steuert nur Dateien, Bilder-Verwaltung, Aufgaben, Whiteboard, Mitglieder.
- Bilder-Rohdaten (`/plans/{plan}/images/{id}/raw`) folgen wieder ausschließlich den Plan-Rechten.
- UI-Hinweis im Tab „Pläne": „Zugriff auf einen Plan legst du pro Plan über „Zugriff / Freigaben“ fest."

### 7.3 Rechte für Plan-Ordner (normale Planliste)
- `plan_folders.created_by` (nullable FK users, SET NULL) per Migration; neue Ordner speichern den Ersteller.
- Ordner anlegen: `can_create_plans`. Umbenennen/Verschieben/Löschen: Admin oder Ersteller; Alt-Ordner ohne Ersteller (NULL): Admin sowie jeder mit `can_create_plans`. Pläne in Ordner verschieben: weiterhin nur mit Plan-Recht (editor+). Server-seitig erzwingen, UI blendet nicht erlaubte Aktionen aus.

### 7.4 Sonstiges
- Sidebar-Gruppenüberschrift „Missionsbau" (ORBAT-Bibliothek) heißt künftig **„Bibliotheken"** / „Libraries".

## 8. Backend-Ergänzungen Runde 2

**Projekt-Ordner (7.1)** – Router `/project-folders` (ohne `/api`):
- `GET /project-folders` -> `[{id,name,parent_id,ordering,created_by}]` (Admin alle; sonst Ordner mit sichtbaren Projekten inkl. Vorfahren + selbst angelegte inkl. Vorfahren).
- `POST /project-folders` `{name,parent_id?}` (Admin/Missionsbauer; sonst 403) -> 201 Ordner. `PATCH /project-folders/{id}` `{name?,parent_id?,move_to_root?,ordering?}`; `DELETE /project-folders/{id}` -> `{ok:true}`. Beide nur Admin/Ersteller: unsichtbarer Ordner = 404, sichtbar aber fremd = 403, Zyklus = 400, unbekannter/unzulässiger Zielordner = 404. Löschen: Unterordner und Projekte rücken eine Ebene hoch (Wurzel = `null`).
- `GET /projects` und `GET /projects/{id}` liefern `folder_id`. `POST /projects` akzeptiert `folder_id`; `PATCH /projects/{id}` ändert `folder_id` nur, wenn das Feld im Body steht (`null` = oberste Ebene; owner/Admin). Zielordner: Admin, Missionsbauer oder für den Nutzer sichtbar, sonst 404.

**Plan-Rechte (7.2)** – `effective_level`/`effective_caps` ignorieren die Projektrolle komplett (auch WebSocket, Bild-Rohdaten, Klonen, Export laufen darüber). `GET /projects/{id}/plans`, `GET /projects` (`plan_count`) und `/overview` (`counts.plans`, `recent_plans`) zählen/zeigen nur per Plan-ACL sichtbare Pläne (Admin alle). Aufgaben können nur auf sichtbare Pläne des Projekts verweisen (sonst 400). Planerstellung im Projekt weiterhin Projekt-`editor`+; der Ersteller wird Plan-`owner`. `GET /folders?project_id=` ist weiterhin für alle Projektmitglieder lesbar (Ordner-Struktur, keine Plan-Inhalte).

**Plan-Ordner (7.3)** – `GET/POST/PATCH /folders` liefern zusätzlich `created_by`. `POST /folders` (ohne `project_id`) braucht `can_create_plans` (sonst 403). `PATCH`/`DELETE /folders/{id}` (ohne Projekt): Admin oder Ersteller; Alt-Ordner mit `created_by = null`: Admin und jeder mit `can_create_plans`; sonst 403. Projekt-Ordner: unverändert Projekt-`editor`+. Migration `0030_project_folders.py` ergänzt `plan_folders.created_by`, `project_folders`, `projects.folder_id`.

