// Hilfe-Overlay: erklärt Werkzeuge, Topbar und Tastenkürzel.
import { getLang, t } from "./i18n";
import { icon } from "./icons";

const DE = `
### Linke Werkzeugleiste
- **Karte bewegen** – Standard: Karte schieben/zoomen, Marker per **mittlerer Maustaste** ziehen.
- **Marker verschieben** – nur auf Touch-Geräten sichtbar (am Desktop: mittlere Maustaste).
- **Zeigen** – Karte fixiert, der Cursor wird anderen Nutzern in deren eigener Farbe angezeigt. **Linksklick** = gelbe Hervorhebung + eine Welle über die ganze Karte („hier bin ich"), **rechte Maustaste halten und ziehen** = Pfeil, solange gehalten.
- **Linie** – gerade Segmente klicken (Vorschau-Linie zum Cursor). Grüner Haken oder Doppelklick beendet, roter Papierkorb/**Rechtsklick**/Esc verwirft. Klick auf eine bestehende Linie wählt sie: Punkte ziehen, Zahnrad (Phase/Farbe), Papierkorb löscht.
- **Lineal** – bedient wie Linie: Punkte klicken, je Teilstrecke die Entfernung, am Ende die Summe Σ. Messlinien bleiben (nur lokal) und lassen sich auswählen, ändern und löschen.
- **Radierer** – Kreis um den Cursor (Größe einstellbar, Durchmesser in Metern): Klicken/Ziehen löscht Marker, Linien und Messlinien im Kreis.
- **Textfeld** – auf die Karte klicken → platzierbares Markdown-Notizfeld. Bearbeiten per Doppelklick, verschieben im Bewegen-Modus. Über den Bild-Button in der Notiz lässt sich ein hochgeladenes Bild als Verweis-Chip einfügen, Klick öffnet es groß.
- **Marker** – erst Position auf der Karte klicken, dann öffnet der Auswahl-Wizard (mit „Erweitert" für Modifikatoren). Verbindungs-Marker: weiter klicken, **Rechtsklick** beendet.
- **Ebenen** – Sat/Grid/Orte/Höhenlinien/Peaks einzeln ein- und ausblenden, jeweils mit Deckkraft.
- **Gruppen (ORBAT)** – Verbandsgliederung verwalten, Einheiten klonen (inkl. Untereinheiten), im Plan verwenden.
- **Favoriten** – gespeicherte Marker per Klick platzieren.
- **Rückgängig / Wiederholen** (Topbar) – eigene Verschiebe-/Bearbeiten-Aktionen zurücknehmen (**Strg+Z / Strg+Y**).

### Topbar
- **3D** – Kippen an/aus (in 2D nur Drehen).
- **Navigations-Würfel** – Flächen = frontale Ansicht, obere Ecken = isometrisch, Ziehen dreht/kippt (Achse wird beim Ziehen automatisch gesperrt), Home-Button setzt die Ausgangsansicht zurück, Ring zeigt die Nordrichtung.
- **Text** – blendet Einheits-/Zusatztext an normalen Markern aus; die Beschriftung an Control-Measure-Symbolen (Phase Line, Boundary, CFL, Known Point, …) bleibt dabei immer stehen.
- **Datum/Zeit** – für den Screenshot-Zeitstempel (leer = jetzt).
- **Screenshot** – über den Pfeil neben der Kamera lassen sich Auflösung (Aktuell / feste Größe / benutzerdefinierte Breite×Höhe) und Format (PNG/JPEG/WebP) einstellen; PNG/JPEG/WebP-Export nur mit Karteninhalt (DTG unten links), Dateiname *Plan_Phase_Zeit*.
- **Briefing-PDF** – je Phase eine Seite (Karte auf die Phasen-Marker gerahmt) + Notizen inkl. eingefügter Bilder.
- **Channel** – eigener Funkkanal.
- **Zeitstrahl** – Phasen wählen/anlegen/löschen; Regler = Sichtbarkeit von Markern fremder Phasen.
- **Sprache der Kartenbeschriftung** – Sprache der Orts-/Kartenlabels.
- **Notizen** – verschiebbares Fenster, ein Reiter je Phase, Markdown.
- **Bild-Sidebar** (Bild-Symbol rechts) – Bilder hochladen, benennen, einer Phase zuordnen, Notiz hinterlegen. Ein Bild lässt sich mehrfach und über mehrere Phasen hinweg auf der Karte platzieren (Ziehen aus der Liste), jede Platzierung ist einzeln verschiebbar/skalierbar/löschbar, ohne das Bild selbst zu entfernen.
- **Versionsverlauf** – Stände sichern und wiederherstellen.
- **Präsentationsmodus** – Vollbild, nur Karte + Phasen (‹ ›, Pfeiltasten, Esc beendet).

### Tastenkürzel
- **Esc** – Werkzeug zurück auf „Karte bewegen" / offenes Fenster schließen.
- **Rechtsklick** (Karte bewegen) – Menü mit allen anderen Werkzeugen; verschiebbar und über die Pinnadel fixierbar. Marker, Text, Linie und Lineal starten direkt an der geklickten Stelle. Rechtsklick-Ziehen dreht die Karte (Drehen geht nur in diesem Werkzeug).
- **Rechtsklick** (Linie/Lineal) – laufende Linie verwerfen; (Marker-Kette) beenden.
- **Mittlere Maustaste ziehen** – Marker verschieben (im Karten-Modus).
- **Doppelklick** – bei aktiver Linie/Lineal: beenden.

### Zahnrad-Einstellungen (pro Nutzer)
Anzeigename, Theme, **Größe der oberen Leiste**, **Karte** (Sat-Bild: Helligkeit/Kontrast/Sättigung, Straßenfarben, Orte-Gruppen ein/aus), Tastenkürzel, API-Tokens, eigene Daten.

### Notizen
Markdown wird unterstützt; Leerzeilen erzeugen sichtbare Absätze.

### Marker bearbeiten
Klick auf einen Marker (im Modus „Karte bewegen" oder „Marker verschieben") öffnet das Bearbeiten-Fenster: Texte, Icon-Drehung, Phase, Sperren, **Erweitert** (Modifikatoren), Klonen, als Favorit speichern, Löschen. Klick außerhalb oder **Esc** schließt.

### Bilder auf der Karte
Ein platziertes Bild zeigt beim Überfahren Name/Notiz/Ersteller/Phase als Tooltip. Über das Zahnrad am Bild lässt sich diese Platzierung bearbeiten (eigene Phase, Mitskalieren mit der Karte) oder nur diese Platzierung entfernen – das Bild selbst und seine übrigen Platzierungen bleiben erhalten.
`;

const EN = `
### Left toolbar
- **Pan** – default: move/zoom the map, drag markers with the **middle mouse button**.
- **Move marker** – only shown on touch devices (desktop: middle mouse button).
- **Point** – map locked, your cursor is shown to others in your own colour. **Left-click** = yellow highlight + a wave across the whole map ("I'm here"), **hold right button and drag** = arrow while held.
- **Line** – click straight segments (preview line to the cursor). Green check or double-click finishes, red trash/**right-click**/Esc discards. Clicking an existing line selects it: drag points, gear (phase/colour), trash deletes.
- **Ruler** – works like Line: click points, distance per segment, total Σ at the end. Measure lines stay (local only) and can be selected, edited and deleted.
- **Eraser** – circle around the cursor (adjustable size, diameter in metres): click/drag deletes markers, lines and measure lines inside the circle.
- **Text box** – click the map → a placeable Markdown note. Double-click to edit, drag in pan mode. The image button in a note inserts an uploaded image as a reference chip; clicking it opens the image full-size.
- **Marker** – click the position on the map first, then the picker wizard opens ("Advanced" for modifiers). Multi-point markers: keep clicking, **right-click** ends.
- **Layers** – toggle sat/grid/places/contours/peaks individually, each with opacity.
- **Groups (ORBAT)** – manage the order of battle, clone units (including sub-units), use them in the plan.
- **Favorites** – place a saved marker with one click.
- **Undo / Redo** (top bar) – revert your own move/edit actions (**Ctrl+Z / Ctrl+Y**).

### Top bar
- **3D** – tilt on/off (2D only rotates).
- **Navigation cube** – faces = a straight-on view, top corners = isometric, dragging rotates/tilts (the axis locks automatically once you drag), the home button resets to the starting view, the ring shows north.
- **Text** – hides unit/extra text on normal markers; labels on control-measure symbols (phase line, boundary, CFL, known point, …) always stay visible.
- **Date/time** – for the screenshot timestamp (empty = now).
- **Screenshot** – the arrow next to the camera opens resolution (current / fixed sizes / custom width×height) and format (PNG/JPEG/WebP) options; export is map content only (DTG bottom-left), filename *Plan_Phase_Time*.
- **Briefing PDF** – one page per phase (map framed to that phase's markers) + notes, including any inserted images.
- **Channel** – your radio channel.
- **Timeline** – pick/add/delete phases; slider = visibility of markers from other phases.
- **Map label language** – language of place/map labels.
- **Notes** – movable window, one tab per phase, Markdown.
- **Image sidebar** (image icon, right side) – upload images, name them, assign a phase, add a note. The same image can be placed on the map multiple times and across multiple phases (drag from the list); each placement can be moved/scaled/removed on its own without deleting the image itself.
- **Version history** – save and restore states.
- **Presentation mode** – fullscreen, map + phases only (‹ ›, arrow keys, Esc exits).

### Keyboard
- **Esc** – tool back to "Pan" / close the open window.
- **Right-click** (Pan) – menu with all other tools; movable and pinnable. Marker, text, line and ruler start right at the clicked spot. Right-drag rotates the map (rotation only works in this tool).
- **Right-click** (Line/Ruler) – discard the running line; (marker chain) end it.
- **Middle-mouse drag** – move a marker (in pan mode).
- **Double-click** – with an active line/ruler: finish it.

### Gear settings (per user)
Display name, theme, **top bar size**, **Map** (sat image brightness/contrast/saturation, road colours, place groups on/off), keybinds, API tokens, your data.

### Notes
Markdown is supported; blank lines create visible paragraph gaps.

### Editing a marker
Clicking a marker (in "Pan" or "Move marker" mode) opens the edit window: texts, icon rotation, phase, lock, **Advanced** (modifiers), clone, save as favorite, delete. Click outside or **Esc** closes it.

### Images on the map
Hovering a placed image shows its name/note/author/phase as a tooltip. The gear icon on the image edits that placement (its own phase, scale with map) or removes only that placement – the image itself and its other placements are kept.
`;

// winziger Markdown-Teil-Renderer (nur ###, **, -, Absätze) – Eingabe ist statisch/vertrauenswürdig
function mini(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const out: string[] = [];
  let inList = false;
  for (const raw of md.trim().split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const li = line.match(/^-\s+(.*)$/);
    const fmt = (s: string) =>
      esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/„([^"]+)"/g, "„<em>$1</em>“");
    if (h) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<h4>${fmt(h[2])}</h4>`);
    } else if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${fmt(li[1])}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<p>${fmt(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

export function openHelp(): void {
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card help-card">
      <div class="row"><h1 style="flex:1;margin:0">${t("help.title")}</h1><button class="help-x icon-btn">${icon("x")}</button></div>
      <div class="help-body">${mini(getLang() === "en" ? EN : DE)}</div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.querySelector(".help-x")!.addEventListener("click", close);
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", esc);
    }
  });
}
