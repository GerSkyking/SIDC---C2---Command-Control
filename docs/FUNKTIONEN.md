# SIDC – C2 – Funktionsübersicht

Kompakte Übersicht, **was das Tool heute kann** (Stand 2026-10-23). Details und Bedienung: [`HANDBUCH.md`](HANDBUCH.md),
Änderungen: [`../CHANGELOG.md`](../CHANGELOG.md).

## 1. Plattform
- Browser-Tool für gemeinsame Einsatzplanung in **Echtzeit** (WebSocket, autoritativer Server, Redis-Backplane).
- FastAPI + PostgreSQL, Frontend TypeScript/Vite/MapLibre, Docker-Stack; UI **Deutsch/Englisch**, Kartenlabels in 13 Sprachen.
- Login lokal (Bootstrap-Admin) und optional **OIDC**; Sessions per HttpOnly-Cookie.

## 2. Rollen & Rechte
| Rolle / Recht | Bedeutung |
|---|---|
| Admin | Vollzugriff, Admin-Bereich |
| Nutzer / Gruppen | Rechte auch über Gruppen; „darf Pläne erstellen" |
| Plan-ACL viewer / editor / owner | Editor mit Einzelrechten setzen · bewegen · löschen · malen |
| **Missionsbau** | sieht/bearbeitet die parallele Missionsbau-Ebene der Phasen, ORBAT-Verknüpfung |
| **Zeus** | arbeitet in Missionsbau-Phasen, die der Missionsbau für ihn freigibt (Standard 48 h oder unbegrenzt) |
| Marker-Lock | gesperrte Marker nur vom Owner änderbar |

Alle Rechte werden serverseitig je Operation geprüft.

## 3. Pläne
- Ordner/Unterordner mit Drag & Drop, klonen (inkl. Phasen, Layer, Marker, Linien), Papierkorb.
- **Versionsverlauf** mit Wiederherstellen, **öffentliche Nur-Ansehen-Links** (Token, Ablauf, widerrufbar, Phasen/Zeit-Eingrenzung).
- ACL-Editor, Briefing-**PDF-Export** (je Phase eine Seite inkl. Notizen und Bilder), **Screenshot** (Auflösung/Format wählbar, DTG).

## 4. Karte
- 2D/3D (Terrain), Kompass, „nach Norden", Koordinaten-Grid, Höhenlinien, Höhenpunkte, Orte.
- Ebenen mit Deckkraft: Sat, Sat (vereinfacht), Gitter, Gebäude, Straßen, Gewässer, Stromleitungen, Bäume, Orte (Karten-Einstellungen pro Nutzer im Zahnrad).
- **ViewCube** unten rechts (TOP + N/S/O/W + Ecken, Ziehen dreht/kippt, Home).
- Karten-Import per Link, Upload oder Gitea-Quelle; DLC-Zoomstufen; Kartenserver für den lokalen ATAKmaps-Client.

## 5. Marker
- **Wizard**: QuickMenü (Kategorien mit ↳), Katalog, **Marker-Baukasten** (Dropdowns, Live-Vorschau, **SIDC-Nummer-Eingabe**), Modifikatoren, Echelon, Richtung, Texte, Farbe, Sperren/Zeitstempel.
- Symbole über milsymbol.js; Nur-Text-Marker; eigene Farbe; Icon-Größe je Marker + persönlicher Größenregler („UI Scale", einklappbar).
- **Hover**: Info + Icons Löschen (mit Bestätigung) · Verschieben · Bearbeiten.
- Favoriten (inkl. Farbe), Kopieren/Ausschneiden/Einfügen, Undo/Redo.
- **ORBAT**-Verknüpfung (Stärke, Verluste, Freigabe von Feindmarkern für Spieler).

## 6. Taktische Layer
- Auto-Layer **BLUFOR / REDFOR / Zivil-GREENFOR / Unbekannt** nach Identität.
- Eigene Layer pro Plan (anlegen/löschen); Zuordnung bei Markern, Linien, Lineal („Auto" = Auto-Layer).
- Haken + Deckkraft je Nutzer lokal.

## 7. Phasen (Zeitstrahl)
- Spieler-Phasen und parallele **Missionsbau-Phasen** (Zwischenphasen), Zeiten ziehbar, H-Hour, Base-Phase gesperrt.
- **Jedes Element gehört zu mindestens einer Phase** (Standard: aktuelle); **Mehrfach-Phasen** für Marker, Linien, Lineal, Notizen.
- Fremdphasen mit einstellbarer Transparenz; Präsentationsmodus; Phasen für Spieler oder Zeus freigeben.
- **Phasen-Notizen** (Markdown, Bilder einbettbar), Doppelklick auf eine Phase öffnet sie.
- **Markdown-Toolbar** (Tastatur-Icon) in allen Markdown-Feldern: Formatierung per Klick – fett/kursiv/durchgestrichen/hervorheben, Listen, Aufgaben, Tabellen, Hinweise, Code, Mathe, Kommentare, Trennlinie.

## 8. Werkzeuge
| Werkzeug | Taste | Funktion |
|---|---|---|
| Karte bewegen | W | Pan/Drehen, Marker ziehen, Linien/Messlinien auswählen |
| Zeigen | A | Laser-Punkt mit Spielerfarbe, gelber Ring, Pfeil (rechte Maustaste) |
| Zeichnen | D | Phase-Lines mit Farbe/Breite, Phase, Weitere Phasen, Layer |
| Marker verschieben | M | (mobil) Marker per Touch ziehen |
| Lineal | F | mehrsegmentig, Teil-/Gesamtstrecke (3D-Höhe), Phase/Layer-Menü |
| Radierer | S | Kreis mit einstellbarer Größe (Panel verschiebbar/fixierbar) |
| Text | T | Markdown-Textfelder auf der Karte (einklappbar, mit Karte skalierbar) |
| Marker setzen | Leertaste | Position wählen, Wizard; „Platzieren" auch oben im QuickMenü |
| Favoriten | R | Schnellauswahl gespeicherter Marker |

- Mittlere Maustaste pannt in allen Werkzeugen; Rechtsklick-Menü im Karten-Werkzeug; Panels frei verschiebbar + fixierbar.
- Tasten sind im Zahnrad pro Nutzer änderbar.

## 9. Bilder
- Bild-Sidebar: hochladen, benennen, Phase zuordnen, Notiz; mehrfach auf der Karte platzierbar (verschieben/skalieren), Lightbox.

## 10. Zeus-Workflow
1. Admin setzt „Zeus" an Nutzer oder Gruppe.
2. Missionsbau öffnet die Phasen-Notizen einer Missionsbau-Phase → „Für Zeus freigeben" (+ Frist in Stunden).
3. Zeus schaltet im Zeitstrahl auf **Zeus**: sieht Spieler-Inhalt nur zum Ansehen, bearbeitet die freigegebenen Phasen.
4. Alternativ „Für Spieler freigeben": Inhalt erscheint bei Spielern wie die Base-Phase.

## 11. Admin
- Nutzer/Gruppen (Rollen, Missionsbau, **Zeus**, Passwort-Reset), Log, Config (SIDC-Kataloge, Übersetzungen, Karten, Quellen), Service-Neustart.
- Persönliche API-Tokens für den lokalen Client.
