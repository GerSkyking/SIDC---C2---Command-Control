# SIDC – C2 – Handbuch

Stand **2026-11-11**. Das Handbuch ist nach Aufgaben aufgebaut: Teil A erklärt das Grundprinzip, Teil B die typischen
Abläufe Schritt für Schritt, Teil C ist das Nachschlagewerk. Änderungen stehen im [`CHANGELOG`](../CHANGELOG.md),
Betrieb/Installation im [`README`](../README.md).

---

# Teil A – Grundprinzip

## A1. Drei Gruppen

| Gruppe | Was sie tut | Was sie sieht |
|---|---|---|
| **Spieler** | planen selbst auf der Karte: Marker, Linien, Textfelder, Phasen | alles für Spieler – plus das, was der Missionsbau ihnen ausdrücklich freigibt |
| **Missionsbau** | macht die Vorgaben, plant langfristig (Projekte, Dateien, Aufgaben, Missionsbau-Phasen) und verteilt Arbeit an einzelne Leute | **alles** |
| **Zeus** | leitet die Mission im Spiel | alles für Spieler (nur ansehen) + die Teile des Missionsbaus, die freigegeben wurden |

Wer zu welcher Gruppe gehört, legt der Admin unter *Benutzer & Gruppen* fest (Häkchen **Missionsbau** bzw. **Zeus** an
Nutzer oder Gruppe). Ohne Häkchen ist man Spieler.

## A2. Wer sieht was? (auf einen Blick)

| Inhalt | Spieler | Zeus | Missionsbau |
|---|---|---|---|
| Spieler-Phasen und ihre Marker/Linien/Textfelder | ✔ | ✔ (nur ansehen) | ✔ |
| Missionsbau-Phase | – | nur wenn **für Zeus freigegeben** | ✔ |
| Missionsbau-Phase **für Spieler freigegeben** | ✔ (erscheint wie Base) | ✔ | ✔ |
| **Missionsbau-Notizen & pinke Sterne** (Layer) | – | nur einzeln **für Zeus freigegebene** | ✔ |
| Gelbe Sterne / normale Notizen | ✔ | ✔ | ✔ |
| Projekt-Bereich *Missionsbau* (Dateien, Bilder) | – | – | ✔ |

Freigaben für Zeus gelten standardmäßig **72 Stunden** (wählbar: andere Frist oder unbegrenzt) und lassen sich jederzeit
zurücknehmen.

## A3. Begriffe

| Begriff | Bedeutung |
|---|---|
| **Plan** | eine Karte mit Markern, Linien, Textfeldern, Bildern – gemeinsam in Echtzeit bearbeitet |
| **Phase** | ein Zeitabschnitt im Zeitstrahl. Jedes Element gehört zu einer Phase (Standard: die gerade aktive). Es gibt **Spieler-Phasen** (obere Spur) und **Missionsbau-Phasen** (untere Spur, nur Missionsbau) |
| **Layer** | eine Sichtbarkeits-Gruppe, die du ein-/ausblenden und abdunkeln kannst: automatisch nach Identität (BLUFOR/REDFOR/…), eigene Layer pro Plan und – im Projekt-Plan – **Missionsbau-Notizen & Sterne** |
| **Karte** | die Grundkarte selbst (Satellit, Gitter, Höhenlinien, Orte …) – im Menü *Karte* |
| **Projekt** | die Klammer um eine Mission im Bereich *Missionsbau*: Dateien, Pläne, Aufgaben, Whiteboard, Feedback |
| **Stern** | ein markierter Ort im Plan, der auf etwas im Projekt zeigt (Aufgabe, Haftnotiz, Datei …). **Gelb** = für alle, **pink** = nur Missionsbau |

---

# Teil B – Abläufe

## B1. Einen Plan anlegen und teilen

1. Sidebar → **Pläne** → Name und Karte wählen → *Erstellen*. Pläne lassen sich in **Ordnern** ablegen (Drag & Drop).
2. Im Plan oben rechts **Zugriff / Freigaben** (nur Owner): Nutzer oder Gruppen als *Betrachter*, *Bearbeiter* oder
   *Owner* eintragen. Bearbeiter bekommen vier Einzelrechte: **setzen · bewegen · löschen · malen**.
3. Optional einen **öffentlichen Link** (nur ansehen, ohne Login, mit Ablaufdatum, widerrufbar) erzeugen.

*Klonen* kopiert einen Plan samt Phasen, Layern, Markern und Linien in einen Zielordner (Textfelder/Sterne werden nicht
mitkopiert).

## B2. Auf der Karte planen

Werkzeugleiste links (nur mit Bearbeitungsrecht). Tasten sind die Standardbelegung, änderbar im Zahnrad.

| Werkzeug | Taste | So geht's |
|---|---|---|
| Karte bewegen | `W` | Schieben/Zoomen; Marker anklicken = bearbeiten; mittlere Maustaste zieht Marker |
| Zeigen | `A` | dein Cursor erscheint bei allen; rechte Maustaste zieht einen Pfeil |
| Linie | `D` | Punkte klicken, grüner Haken / Doppelklick beendet (Rechtsklick/Esc verwirft); Klick auf den grünen Startpunkt schließt zur **Fläche** (siehe unten); Farbe, Breite, Phase, Layer im Menü |
| Marker verschieben | `M` | (v. a. Touch) Marker ziehen |
| Lineal | `F` | beliebig viele Punkte, Teil- und Gesamtstrecke; Rechtsklick beendet; Messlinien bleiben stehen |
| Radierer | `S` | löscht alles im Kreis (Größe einstellbar) |
| Textfeld | `T` | Markdown-Notiz auf die Karte setzen |
| Marker setzen | `Leertaste` | Position klicken → Marker-Auswahl (QuickMenü, Katalog oder **Marker-Baukasten**) |
| Favoriten | `R` | gespeicherte Marker per Klick setzen |
| **Ort markieren** | – | nur in Projekt-Plänen, siehe **B5** |

Außerdem: `Q`/`E` Rückgängig/Wiederholen, `X`/`C`/`V` Ausschneiden/Kopieren/Einfügen, `←`/`→` Phase wechseln,
`Y` Phasen-Notizen, `N` nach Norden, `Esc` bricht ab bzw. schließt Fenster.

**Im Plan suchen:** Lupe in der Topbar oder `Strg+F` bzw. `/`. Gesucht wird beim Tippen in Markern (Beschriftung,
Zusatztext, Symbolname), Notizen und Sternen (auch verknüpfte Orte/Titel), benannten Linien/Flächen, Kartenbildern
(Name, Notiz), Ortsnamen der Karte und Phasen – Groß/klein egal, Umlaute tolerant (`mueller` = `müller` = `muller`).
Pfeiltasten + `Enter` oder Klick: die Karte fliegt hin und der Treffer leuchtet ~3 s auf. Liegt er in einer anderen
Phase, wechselt die Ansicht dorthin; liegt er in einem ausgeblendeten Layer, wird der Layer wieder eingeblendet (beides
steht vorher in der Trefferliste). Gefunden wird nur, was deine aktuelle Ansicht (Spieler/Missionsbau/Zeus) zeigen darf.
`Esc` leert bzw. schließt. Funktioniert auch mit Nur-Lese-Zugriff und am Handy.

**Benannte Flächen:** Zeichnest du mit dem Linien-Werkzeug mindestens drei Punkte und fährst zurück an den Startpunkt,
wird er grün – ein Klick schließt die Linie zur Fläche. Im folgenden Fenster gibst du optional einen **Namen** und ein
**Symbol** an (*Symbol wählen …* öffnet die Marker-Auswahl; alternativ *SIDC direkt eingeben*) und legst fest, ob die
Fläche **schraffiert** wird. *Übernehmen* speichert, *Ohne Namen* oder Esc lässt sie unbenannt. Auf der Karte steht am
Schwerpunkt das Symbol über dem Namen, darunter klein die Flächengröße. Einheiten-/Punktsymbole werden gezeichnet; Symbole,
die sich nicht als Punkt darstellen lassen, entfallen (dann nur der Name). Nachträglich: Fläche anklicken → Zahnrad
(Name, Symbol, Füllung, *Geschlossene Fläche* an/aus) oder Stützpunkte ziehen. Rückgängig/Wiederholen gilt auch hier.

**Marker bearbeiten:** Maus über den Marker zeigt Ersteller, Phase und Layer plus Schnellknöpfe (Löschen · Verschieben ·
Bearbeiten). Im Bearbeiten-Fenster: Texte, Drehung, Größe, Phase (auch mehrere), Layer, Sperren, Modifikatoren,
Klonen, Als Favorit speichern.

## B3. Mit Phasen arbeiten

- Der **Zeitstrahl** oben zeigt die Phasen als Balken. Klick wählt eine Phase, Ziehen verschiebt sie, an den Kanten
  änderst du die Dauer. **+ Phasen** legt eine neue an. Die erste Phase **Base** ist gesperrt.
- Neue Elemente landen in der **aktiven Phase**. Im Bearbeiten-Fenster lässt sich die Phase ändern; über *Weitere Phasen*
  erscheint ein Element in mehreren Phasen.
- **Sichtbarkeit fremder Phasen** (Regler): wie stark Elemente anderer Phasen durchscheinen.
- **Phasen-Notizen** (`Y` oder Doppelklick auf einen Balken): Markdown-Text je Phase, auch mit Bildern.
- Wird eine Spieler-Phase gelöscht, bleiben ihre Elemente als „global“ (immer sichtbar) erhalten; Inhalte gelöschter
  Missionsbau-Phasen werden mitgelöscht.

## B4. Eine Mission bauen (Missionsbau)

1. **Projekt anlegen:** Sidebar → **Missionsbau** → *Neues Projekt*. Du bist Owner. Unter **Mitglieder** holst du
   Leute oder Gruppen dazu (*Betrachter* lesen, *Bearbeiter* schreiben) – so lagerst du Teile an Einzelne aus.
2. **Konzept schreiben:** Reiter **Missionsbau** = Dateibaum mit Markdown-Dateien (nur Missionsbau). *Neue Datei* bietet
   Vorlagen (Missionskonzept, Befehl 5-Absatz, Briefing, Charakter, Fraktion, Ort, Szene). Überschriften mit Uhrzeit
   (`## 06:30 Anmarsch`, `## T+01:30 Feindkontakt`) erscheinen automatisch in der **Zeitleiste**; der Reiter
   **Verzeichnis** sortiert die Dateien nach Typ.
3. **Plan im Projekt anlegen:** Reiter **Pläne** → Plan erstellen. Pläne behalten ihre eigene Freigabe (B1) – die
   Projektrolle gibt keine Planrechte.
4. **Orte markieren:** im Plan Werkzeug **Ort markieren** (Kartennadel mit Stern) – siehe **B5**.
5. **Arbeit verteilen:** Reiter **Aufgaben** (Kanban: Offen · In Arbeit · Review · Erledigt) mit Zuständigen, Fälligkeit,
   Priorität; Fragen klärst du in der *Diskussion* der Aufgabe (`@name`, `@projekt`).
6. **Vorgaben im Plan:** Missionsbau-Phasen (untere Spur im Zeitstrahl) enthalten, was nur der Missionsbau sehen soll.
   Ansicht oben umschalten: **Spieler** (Vorschau wie ein Spieler, nur deine Sterne/Notizen bleiben sichtbar) ·
   **Missionsbau** · **Zeus**.
7. **Freigeben:** Missionsbau-Phase → Phasen-Notizen öffnen → *Für Spieler freigeben* (erscheint wie Base) oder
   *Für Zeus freigeben* (72 h vorausgewählt, *Unbegrenzt* per Knopf). Einzelne pinke Sterne/Notizen gibst du über das
   **Auge** an der Notiz frei (72 h).
8. **Stand verfolgen:** **Übersicht** (offene Aufgaben je Person, Fälliges, Meilensteine, Projektstufe
   Entwurf → Review → Test → Release), **Aktivität**, **Feedback** (auch von außen, siehe C6).

## B5. Orte markieren (Sterne)

So kommen Orte, Personen, Aufgaben, Notizen und Dateien an einen Ort auf der Karte. Das Werkzeug gibt es nur für den
Missionsbau und nur in Plänen, die zu einem Projekt gehören.

1. Werkzeug **Ort markieren** wählen und **auf die Karte klicken** – der Stern steht sofort.
2. Im Fenster **„Was ist hier?“** festlegen:
   - **Neu im Verzeichnis** – *Ort* (vorausgewählt), *Charakter*, *Fraktion*, *Szene*, *Missionskonzept*,
     *Befehl (5-Absatz)*, *Briefing* oder *Sonstiges*: Name und Beschreibung eingeben, daraus wird eine Datei aus der
     passenden Vorlage im Bereich Missionsbau, die sofort im **Verzeichnis** einsortiert ist und auf den Plan verweist.
   - **Aufgabe** – Titel, *Was soll hier passieren?*, Zuständig, Fällig, Priorität. Die Aufgabe entsteht im Projekt
     (mit Bezug zu diesem Plan).
   - **Haftnotiz** – landet auf dem Whiteboard des Projekts.
   - **Bestehendes verknüpfen** – vorhandene Datei, Aufgabe, Plan, Notiz, Bild oder Ort auswählen; optional mit eigener
     Bezeichnung und Beschreibung.
   - **Nur Kartennotiz** – ein normales Textfeld, ohne Eintrag im Projekt.
3. **Sichtbar für:** *Alle (normale Notiz)* → **gelber Stern** in der gewählten Phase · *Nur Missionsbau* → **pinker
   Stern** auf dem Layer *Missionsbau-Notizen* (phasenunabhängig, Spieler sehen ihn nie, Zeus erst nach Freigabe).
   *Nur Missionsbau* ist vorausgewählt.
4. *Anlegen*. Neues (Verzeichnis-Eintrag, Aufgabe, Haftnotiz) braucht Bearbeiter-Recht im Projekt; fehlt es, sind die
   Knöpfe gesperrt und der Dialog sagt, warum (z. B. „nicht im Projekt eingetragen“).

**Bereich um den Stern:** Wie groß der Platz ist, legst du mit einem Bereich fest – beim Anlegen per Häkchen *Danach
Bereich um den Stern zeichnen* oder später über den Knopf *Bereich* am Stern. Linksklicks setzen die Ecken; ein Klick auf
den (grün markierten) Startpunkt schließt die Fläche, sie wird schraffiert (Füllung 25 %, Rand 50 %). Eine offene Linie
übernimmst du mit ✓, Enter oder Rechtsklick; Esc bricht ab. Später: Bereich anklicken → Ecken ziehen, in der Leiste
*Fertig*, *Neu zeichnen* oder *Entfernen*. Verschiebst du den Stern, wandert der Bereich mit. Farbe und Sichtbarkeit
folgen dem Stern (pink = nur Missionsbau, gelb = alle). Unter dem Stern steht klein die **Größe** des Bereichs (Fläche,
z. B. 2,4 ha; bei offener Linie die Länge) – sie aktualisiert sich beim Zeichnen und Ecken-Ziehen.

Auf der Karte: Neben dem Stern stehen die verknüpften Ziele – Klick öffnet sie (in einem neuen Tab). Die Beschreibung
erscheint beim Überfahren. Darüber erscheinen die Knöpfe Einklappen · Zeus-Freigabe · Bearbeiten · Löschen; sie bleiben
nach dem Verlassen kurz stehen, damit du sie auch beim eingeklappten Stern erreichst. Im Projekt zeigt jedes
Ziel unter **„Erwähnt in …“**, auf welchem Plan es markiert ist, und **Verzeichnis → Auf der Karte** listet alle Sterne
und Notizen aller Pläne (pink/gelb) mit Sprung an die Stelle. Im Menü **Layer** blendest du *Missionsbau-Notizen &
Sterne* aus oder ab.

**Textfelder** (`T`) funktionieren genauso: Ein Missionsbauer wählt im Editor *Sichtbar für* (in der
Missionsbau-Ansicht ist *Nur Missionsbau* vorausgewählt), alle anderen setzen normale Notizen in einer Phase.

## B6. Als Zeus arbeiten

1. Admin setzt das Häkchen **Zeus** an Nutzer oder Gruppe.
2. Im Plan oben auf **Zeus** umschalten. Spieler-Inhalte siehst du nur zum Ansehen.
3. Für Zeus freigegebene Missionsbau-Phasen erscheinen in der unteren Spur – dort darfst du bearbeiten. In Spieler-Phasen
   setzt Zeus nichts.
4. Einzeln freigegebene pinke Sterne/Notizen siehst du nur (nicht bearbeiten). Abgelaufene Freigaben verschwinden beim
   nächsten Laden.

## B7. Briefing und Export

- **Briefing-PDF** (Topbar): je Phase eine Seite mit Kartenausschnitt, Phasen-Notizen und Bildern; Missionsbauer wählen
  *Spieler* oder *Missionsbau*.
- **Screenshot** (Kamera): nur Karteninhalt, Auflösung/Format wählbar, militärischer DTG unten links.
- **Präsentationsmodus**: Vollbild ohne Bedienelemente für die Besprechung.
- Dateien im Projekt: *Als Markdown herunterladen* und *Drucken / PDF*.

## B8. Zusammenarbeit

- **Chat** (Sidebar): Direktnachrichten, Gruppen, Chats zu einer Gruppe oder einem Projekt. Enter sendet,
  Umschalt+Enter = neue Zeile. Oben die feste Unterhaltung **System** mit allen Benachrichtigungen.
- **Benachrichtigungen außerhalb der Seite** (Zahnrad → *Benachrichtigungen*): Erwähnungen, Zuweisungen und neue Zugriffe
  an *Discord-DM*, *Web-Push*, *ntfy*, *Gotify*, *Matrix*, *Webhook* oder *E-Mail*. Pro Kanal wählbar, welche Arten
  ankommen; *Testnachricht* prüft den Kanal. Auf Discord-DMs lässt sich direkt antworten. Web-Push auf dem iPhone nur,
  wenn die Seite zum Home-Bildschirm hinzugefügt wurde.
- **Discord-Brücke:** Ein Gruppen-Chat läuft synchron mit einem Discord-Kanal (Admin → Config → *Discord-Brücke*, oder
  Code aus dem Chat-Kopf mit `/c2 link` in Discord).

---

# Teil C – Nachschlagen

## C1. Rechte im Detail

| Recht | Bedeutung |
|---|---|
| Rolle `admin` / `user` | Admin hat Vollzugriff und den Admin-Bereich |
| **Pläne erstellen** | Häkchen an Nutzer oder Gruppe |
| **Missionsbau** / **Zeus** | Häkchen an Nutzer oder Gruppe (siehe A1) |
| Plan `viewer` | ansehen |
| Plan `editor` | Einzelrechte setzen · bewegen · löschen · malen |
| Plan `owner` | alles + Freigaben, Umbenennen, Klonen, Löschen, Versionen wiederherstellen, öffentliche Links |
| Projekt `viewer` / `editor` / `owner` | lesen / schreiben (Dateien, Aufgaben, Whiteboard) / zusätzlich Mitglieder, Archivieren, Löschen |
| Marker-Sperre | gesperrte Marker ändert/löscht nur der Plan-Owner; sperren und entsperren darf, wer bewegen darf |

Alle Rechte prüft der Server bei jeder Aktion. Plan-Ordner: anlegen darf, wer Pläne erstellen darf; umbenennen, verschieben,
löschen der Ersteller und der Admin. Archivierte Projekte sind schreibgeschützt.

## C2. Topbar im Plan

| Element | Funktion |
|---|---|
| **3D** | Kippen an/aus (in 2D nur drehen) |
| **Lock Rotation** / **↑** | Drehung sperren / nach Norden ausrichten |
| **Datum/Zeit** | Zeitstempel für Screenshot und Briefing (leer = jetzt) |
| **Kamera** | Screenshot |
| **Briefing** | PDF-Export |
| **Kartensprache** | Sprache der Ortsnamen (13 Sprachen) |
| **Lupe** | Im Plan suchen (`Strg+F` oder `/`, siehe B2) |
| **Präsentation**, **Versionen**, **Hilfe** | Vollbild · Versionsverlauf (sichern/wiederherstellen) · Kurzhilfe |
| **Zahnrad** | Einstellungen (siehe C4) |
| **Zugriff / Freigaben** | Freigaben und öffentliche Links (Owner) |
| Cursor-Anzeige rechts | X/Y-Koordinate und Höhe unter dem Mauszeiger |
| **UI Scale** | Marker- und Textgröße nur für dich |

Unter der Topbar liegt der **Zeitstrahl** (B3) mit Phasen-Notizen, Zoom, Ansicht Spieler/Missionsbau/Zeus und den
Reglern *Sichtbarkeit fremder Phasen* und *Transparenz Spieler ↔ Missionsbau*.

## C3. Menüs *Karte* und *Layer* (Werkzeugleiste)

- **Karte:** Satellit (auch vereinfacht), Gitter, Gebäude, Straßen, Gewässer, Stromleitungen, Bäume, Orte, Höhenlinien
  (alle 10 m), Höhenpunkte – je mit Deckkraft-Regler.
- **Layer:** BLUFOR / REDFOR / Zivil-GREENFOR / Unbekannt (automatisch nach Identität), eigene Layer des Plans
  (Bearbeiter legen sie an und ordnen Marker/Linien/Messlinien zu) und im Projekt-Plan für den Missionsbau
  *Missionsbau-Notizen & Sterne*. Haken und Deckkraft gelten nur für dich.
- **ViewCube** unten rechts: Ansicht von oben / N / S / O / W, Ziehen dreht und kippt.

## C4. Einstellungen (Zahnrad)

Theme (Dunkel/Hell/System), Sprache, Tastenkürzel (Taste anklicken, neue Taste drücken, `Esc` bricht ab),
Topbar-Größe, **Marker-Anzeige** (*Marker-Texte anzeigen*, *Ausführliche Marker-Info beim Überfahren*),
Satellitenbild (Helligkeit/Kontrast/Sättigung), Straßenfarben, Benachrichtigungen, API-Tokens.

## C5. Projekt-Reiter

| Reiter | Inhalt |
|---|---|
| **Übersicht** | Stufe, Meilensteine, offene/fällige Aufgaben je Person, zuletzt Geändertes, neues Feedback |
| **Aktivität** | wer wann was gemacht hat |
| **Missionsbau** | Dateibaum + Markdown-Editor (`Strg+S` speichert, Konflikte werden gemeldet), Kommentare, Versionen, Bilder |
| **Verzeichnis** | Dateien nach Typ (Personen, Fraktionen, Orte, Szenen …) und **Auf der Karte** (alle Sterne/Notizen) |
| **Zeitleiste** | alle Überschriften mit Zeitangabe aus allen Dateien |
| **Pläne** | Pläne des Projekts (Ordner, Drag & Drop, bestehende Pläne hierher verschieben) |
| **Aufgaben** | Kanban mit Diskussion und Verlauf |
| **Feedback** | Rückmeldungen (intern und extern), zu Aufgabe machen |
| **Whiteboard** | Haftnotizen |
| **Mitglieder** | Nutzer/Gruppen und Rollen |

**Verknüpfungs-Codes:** Überall in Markdown lassen sich `{{doc:…}}`, `{{task:…}}`, `{{plan:…}}`, `{{note:…}}`,
`{{img:…}}` und `{{place:Karte:Ort}}` einsetzen (Knopf *Verweis einfügen* in der Formatierungsleiste oder *Code kopieren*
am Ziel). Sie erscheinen als Chip mit dem aktuellen Namen; nicht sichtbare Ziele als grauer Chip. Die Suche im
Projektkopf (`/`) findet Titel und Inhalte.

Ältere Projekte mit Dateien im früheren Bereich *Öffentlich* behalten diese; sie bleiben über Verweise, Verzeichnis und
Zeitleiste erreichbar.

## C6. Feedback von außen (ohne Login)

Der Projekt-Owner schaltet im Reiter *Feedback* die Schnittstelle ein (*Token erzeugen*). Wer den Link kennt, kann
Rückmeldungen einsenden und sieht nur den Projektnamen. *Neu erzeugen* macht das alte Token ungültig, *Abschalten*
schließt die Schnittstelle, archivierte Projekte nehmen nichts an. Grenzen: Titel 200, Text 5000, Name 80 Zeichen;
10 Einsendungen je IP und 10 Minuten, 60 je Projekt und Stunde, höchstens 5000 je Projekt. Das Feld `website` ist eine
Bot-Falle und muss leer bleiben. Hinweis: Die Sicherheitsrichtlinie der App verbietet das Einbetten per `<iframe>`; dafür
braucht die Route `#/feedback/<token>` eine Ausnahme im Proxy.

```bash
curl https://c2.example.org/api/public/feedback/<TOKEN>
# -> {"project":"Op Beispiel","kinds":["bug","idea","praise","other"]}
curl -X POST https://c2.example.org/api/public/feedback/<TOKEN> -H "Content-Type: application/json" \
  -d '{"title":"Brücke bei 040/040 fehlt","text":"Im Briefing erwähnt, auf der Karte nicht.","kind":"bug","name":"Max"}'
# -> 201 {"ok":true}   (404 unbekanntes Token, 410 Projekt archiviert, 429 zu viele Anfragen)
```

## C7. Admin-Bereich

Sidebar: **Benutzer & Gruppen**, **Log**, **Speicher**, **Config**.

- **Benutzer & Gruppen:** anlegen, Rolle, *Pläne erstellen*, *Missionsbau*, *Zeus*, aktiv/deaktiviert, Passwort-Reset,
  Discord-ID, löschen; Gruppen mit Mitgliedern und denselben Häkchen.
- **Log:** Login-Versuche und alle wichtigen Aktionen, filterbar.
- **Speicher:** belegter Platz je Projekt (Bilder, Dateien).
- **Config:** SIDC-Kataloge hochladen (`SIDC_AllMarkersCatalog.json`, `SIDC_QuickMarkerMenuCatalog.json`,
  `SIDC_PhaseLineStyleCatalog.json`, `SIDC_ModifierCatalog.json`, Übersetzungen `SIDC_Translations.xlsx`),
  **Karten** importieren (Download-Link, Direkt-Upload oder Gitea-Quelle; *Aktualisieren* lädt eine neue ZIP),
  Discord-Brücke, Service-Neustart.

## C8. Karten-Pakete (`*_mappack_v*.zip`)

```
mappack.json                     (optional Manifest)
calibration.json                 (Ursprung + Skalierung)
mbtiles/sat.mbtiles              (Pflicht)
mbtiles/terrain.mbtiles          (optional, 3D + Höhenanzeige)
mbtiles/grid.mbtiles             (optional, Koordinatengitter)
mbtiles/dlc/<layer>_z<N>.mbtiles (optional, hochauflösende Zoomstufen)
topo.geojson                     (optional, Straßen/Wege)
locations.json                   (optional, benannte Orte)
contours.geojson / peaks.geojson (optional, Höhenlinien / Höhenpunkte)
```

Alles wird im ATAKmaps-Importer vorberechnet; C2 zeigt nur an. Ältere Packs mit roher `mapLocations_locations.json`
müssen im Importer verarbeitet und neu exportiert werden.

**Kartenserver für den lokalen ATAKmaps-Client:** Zahnrad → *API-Tokens* → Token erstellen (wird nur einmal angezeigt);
in ATAKmaps unter *Kartenserver* Adresse und Token eintragen. Ein Token gibt nur Lesezugriff auf Kartendaten, nichts
sonst; Widerrufen sperrt sofort. Neu importierte Karten verwirft der Client beim nächsten Abgleich aus dem Cache.

## C9. SIDC – Kurzreferenz

30-stelliger Code, im Client zusammengesetzt:

| Stelle (0-basiert) | Feld | gesetzt durch |
|---|---|---|
| 3 | Zugehörigkeit (Identität) | Marker-Auswahl |
| 6 | Status / Zustand | Modifikator 4 |
| 7 | HQ / Task Force / Dummy | Modifikator 3 |
| 8–9 | Echelon | nur Land-Einheiten |
| 10–15 | Haupticon (Entity/Typ/Subtyp) | Katalog |
| 16–17 / 18–19 | Modifikator 1 / 2 | *Erweitert* |

Symbole rendert milsymbol.js; fehlt eine Funktion, greift ein vorgerendertes PNG, sonst ein Ersatzpunkt.
