// Hilfe-Overlay: erklärt Werkzeuge, Topbar und Tastenkürzel.
import { getLang, t } from "./i18n";

const DE = `
### Linke Werkzeugleiste
- **✋ Karte bewegen** – Standard: Karte schieben/zoomen, Marker per **mittlerer Maustaste** ziehen.
- **✥ Marker verschieben** – Marker anfassen und ziehen.
- **👉 Zeigen** – Karte fixiert, der Cursor wird anderen Nutzern angezeigt.
- **✏️ Linie** – gerade Segmente klicken; **Rechtsklick** oder „Linie fertig" beendet.
- **📏 Lineal** – 2 Punkte klicken → gestrichelte Linie mit Entfernung; 3. Klick löscht.
- **🧽 Radierer** – Klick auf Marker oder Linie löscht sofort.
- **📍 Marker** – erst Position auf der Karte klicken, dann öffnet der Auswahl-Wizard (mit „Erweitert" für Modifikatoren). Verbindungs-Marker: weiter klicken, **Rechtsklick** beendet.
- **★ Favoriten** – gespeicherte Marker per Klick platzieren.

### Topbar
- **3D** – Kippen an/aus (in 2D nur Drehen).
- **↑ Kompass** – zeigt Norden; Klick richtet die Karte nach Norden aus.
- **📅 Datum/Zeit** – für den Screenshot-Zeitstempel (leer = jetzt).
- **📷 Screenshot** – PNG nur mit Karteninhalt (DTG unten links), Dateiname *Plan_Phase_Zeit*.
- **Channel** – eigener Funkkanal.
- **Zeitstrahl** – Phasen wählen/anlegen/löschen; Regler = Sichtbarkeit von Markern fremder Phasen.
- **🗒️ Notizen** – verschiebbares Fenster, ein Reiter je Phase, Markdown.
- **☰ Ebenen** – Sat/Grid/Orte ein- und ausblenden.
- **Versionsverlauf** – Stände sichern und wiederherstellen.

### Tastenkürzel
- **Esc** – Werkzeug zurück auf „Karte bewegen" / offenes Fenster schließen.
- **Rechtsklick** – laufende Linie oder Verbindungs-Marker-Kette beenden.
- **Mittlere Maustaste ziehen** – Marker verschieben (im Karten-Modus).
- **Doppelklick** – bei aktiver Linie: Linie beenden.

### Marker bearbeiten
Klick auf einen Marker (im Modus „Karte bewegen" oder „Marker verschieben") öffnet das Bearbeiten-Fenster: Texte, Icon-Drehung, Phase, Sperren, **Erweitert** (Modifikatoren), Klonen, als Favorit speichern, Löschen. Klick außerhalb oder **Esc** schließt.
`;

const EN = `
### Left toolbar
- **✋ Pan** – default: move/zoom the map, drag markers with the **middle mouse button**.
- **✥ Move marker** – grab a marker and drag it.
- **👉 Point** – map locked, your cursor is shown to other users.
- **✏️ Line** – click straight segments; **right-click** or "Finish line" ends it.
- **📏 Ruler** – click 2 points → dashed line with distance; a 3rd click clears it.
- **🧽 Eraser** – clicking a marker or line deletes it immediately.
- **📍 Marker** – click the position on the map first, then the picker wizard opens ("Advanced" for modifiers). Multi-point markers: keep clicking, **right-click** ends.
- **★ Favorites** – place a saved marker with one click.

### Top bar
- **3D** – tilt on/off (2D only rotates).
- **↑ Compass** – shows north; click to face the map north.
- **📅 Date/time** – for the screenshot timestamp (empty = now).
- **📷 Screenshot** – PNG with map content only (DTG bottom-left), filename *Plan_Phase_Time*.
- **Channel** – your radio channel.
- **Timeline** – pick/add/delete phases; slider = visibility of markers from other phases.
- **🗒️ Notes** – movable window, one tab per phase, Markdown.
- **☰ Layers** – toggle sat/grid/places.
- **Version history** – save and restore states.

### Keyboard
- **Esc** – tool back to "Pan" / close the open window.
- **Right-click** – end the current line or multi-point marker chain.
- **Middle-mouse drag** – move a marker (in pan mode).
- **Double-click** – with an active line: finish the line.

### Editing a marker
Clicking a marker (in "Pan" or "Move marker" mode) opens the edit window: texts, icon rotation, phase, lock, **Advanced** (modifiers), clone, save as favorite, delete. Click outside or **Esc** closes it.
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
      <div class="row"><h1 style="flex:1;margin:0">${t("help.title")}</h1><button class="help-x">✕</button></div>
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
