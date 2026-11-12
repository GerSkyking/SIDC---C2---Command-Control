// Suche im Plan: Suchfeld (Topbar-Knopf, Strg+F bzw. „/“), durchsucht Marker, Notizen/Stern-Pins,
// benannte Linien/Flächen, Kartenbilder, Kartenorte und Phasen. Auswahl → ggf. Phase wechseln bzw.
// ausgeblendeten Layer einblenden, zum Objekt fliegen und es ~3 s hervorheben.
// Es wird nur gefunden, was die aktuelle Ansicht (Spieler/Missionsbau/Zeus, Rechte) überhaupt zeigen darf.
import * as maplibregl from "maplibre-gl";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { toast } from "../notify";
import { actionForKey } from "../settings";
import { isTextMarker } from "../sidc/sidc";
import type { Annot, LngLat2, PlanCtx, Stroke, TacAuto } from "./ctx";

type Kind = "marker" | "note" | "star" | "line" | "dot" | "area" | "image" | "place" | "phase";

interface Hit {
  kind: Kind;
  id: string;
  label: string;
  /** Nebenzeile: Phase / Layer / Hinweise */
  sub: string;
  /** Suchfelder: [Text, Gewicht] — Gewicht 0 = Hauptname, 1 = Zusatz */
  fields: [string, number][];
  /** Phase, in die bei Auswahl gewechselt wird (null = keine Umschaltung nötig) */
  phase: string | null;
  /** auszublendender Layer, der vor dem Sprung eingeblendet wird */
  layerKey: string | null;
  layerName: string;
  /** Kamera-Ziel */
  pts: LngLat2[];
  area: boolean;
  /** DOM-Element zum Aufleuchten (Notiz/Bild) */
  domSel?: string;
  /** Pixel-Versatz des Mittelpunkts (Bilder: Ecke oben links) */
  offset?: [number, number];
  score?: number;
}

const KIND_ICON: Record<Kind, string> = {
  marker: "marker",
  note: "textbox",
  star: "star",
  line: "line",
  dot: "dot",
  area: "spot",
  image: "image",
  place: "pin",
  phase: "clock",
};
const KIND_ORDER: Kind[] = ["phase", "marker", "star", "note", "area", "line", "dot", "image", "place"];

// ── Normalisierung: Groß/klein egal, Umlaute tolerant (ä ≈ ae ≈ a) ──
const UML: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", æ: "ae", ø: "oe", œ: "oe" };
const stripMarks = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
/** [mit ae-Ersetzung, ohne Akzente] */
const norms = (s: string): [string, string] => {
  const l = s.toLowerCase();
  return [stripMarks(l.replace(/[äöüßæøœ]/g, (c) => UML[c] ?? c)), stripMarks(l)];
};
/** 0 = Textanfang, 1 = Wortanfang, 2 = Teiltreffer, -1 = kein Treffer */
const matchScore = (hay: string, q: string): number => {
  const i = hay.indexOf(q);
  if (i < 0) return -1;
  if (i === 0) return 0;
  // Wortanfang irgendwo im Text?
  let j = i;
  while (j >= 0) {
    if (j === 0 || !/[\p{L}\p{N}]/u.test(hay[j - 1])) return 1;
    j = hay.indexOf(q, j + 1);
  }
  return 2;
};

/** Verknüpfungs-Codes in Notiz-Texten lesbar machen (Ort/Bild direkt, Rest über die gerenderten Chips). */
const REF_RE = /\{\{(\w+):([^{}\n]+)\}\}/g;

export function initSearch(ctx: PlanCtx): void {
  const { root, map, markers, strokes, annots, images, placements, phases, isMB, sig } = ctx;
  const m = ctx.model;

  // ── Sichtbarkeit ──
  const isReleasedBuilder = (id: string): boolean => {
    const p = phases.find((x) => x.id === id);
    if (!p || p.plane !== "builder") return false;
    return !!p.player_released || !!phases.find((x) => x.id === p.parent_id)?.locked;
  };
  /** Darf die aktuelle Ansicht Inhalte dieser Phase überhaupt zeigen (egal welche Phase gewählt ist)? */
  const phaseAllowed = (pid: string | null | undefined): boolean => {
    if (pid == null) return true;
    const p = phases.find((x) => x.id === pid);
    if (!p) return false;
    if (m.isNotesPhase(p)) return false; // Missionsbau-Notizen: eigene Regel (siehe Notizen in candidates)
    if (p.plane !== "builder") return true;
    if (isReleasedBuilder(pid)) return true;
    if (ctx.actAs === "zeus") return m.zeusOpen(pid);
    return isMB && ctx.actAs === "builder";
  };
  /** Ist eine der Phasen schon in der aktuellen Phasenwahl voll zu sehen? */
  const inCurrent = (pids: (string | null)[]): boolean =>
    pids.some(
      (p) =>
        p == null ||
        p === ctx.currentPhaseId ||
        isReleasedBuilder(p) || // für alle dauerhaft sichtbar
        (!m.isBuilderPhase(p) && ctx.actAs !== "player" && p === m.activePlayerId()),
    );
  /** Ziel-Phase für den Sprung: aktuelle bevorzugt, sonst Hauptphase, sonst erste erlaubte Zusatzphase. */
  const targetPhase = (pid: string | null, extras: string[] | undefined): string | null | false => {
    const all = [pid, ...(extras ?? [])].filter((p) => phaseAllowed(p));
    if (!all.length) return false; // gar nicht sichtbar
    if (inCurrent(all)) return null;
    return (all[0] as string) ?? null;
  };
  const autoName = (a: TacAuto): string =>
    ({ bluefor: t("tac.blufor"), redfor: t("tac.redfor"), civgreen: t("tac.civgreen"), unknown: t("tac.unknown") })[a];
  const autoOf = (sidc: string): TacAuto | null => {
    if (isTextMarker(sidc)) return null;
    const id = sidc[3];
    if (id === "2" || id === "3") return "bluefor";
    if (id === "5" || id === "6" || id === "7" || id === "8") return "redfor";
    if (id === "4") return "civgreen";
    return "unknown";
  };
  /** Ausgeblendeter taktischer Layer eines Objekts (Auto-Layer oder eigener Layer). */
  const hiddenLayer = (sidc: string | null, layerId: string | null | undefined): [string, string] | null => {
    const a = sidc ? autoOf(sidc) : null;
    if (a && m.tacVis("auto:" + a) <= 0) return ["auto:" + a, autoName(a)];
    const l = layerId ? ctx.tacLayers.find((x) => x.id === layerId) : undefined;
    if (l && m.tacVis(l.id) <= 0) return [l.id, l.name];
    return null;
  };
  const layerNameOf = (layerId: string | null | undefined): string =>
    (layerId && ctx.tacLayers.find((x) => x.id === layerId)?.name) || "";
  const phaseLabel = (pid: string | null): string => m.phaseNameOf(pid);
  const subLine = (pid: string | null, layer: string, jump: string | null, hidden: [string, string] | null): string =>
    [
      phaseLabel(pid),
      layer,
      jump ? t("search.otherPhase") : "",
      hidden ? t("search.hiddenLayer").replace("{layer}", hidden[1]) : "",
    ]
      .filter(Boolean)
      .join(" · ");

  // ── Treffer-Kandidaten sammeln (jedes Mal frisch, Daten ändern sich live) ──
  const resolveCodes = (s: string): string =>
    s.replace(REF_RE, (_s, ty: string, val: string) => {
      if (ty === "place") return " " + (val.split(":").slice(1).join(":") || val) + " ";
      if (ty === "img") {
        const im = images.get(val);
        return " " + (im ? im.caption || im.filename : "") + " ";
      }
      return " ";
    });
  const clean = (s: string): string => s.replace(/[#*_`>[\]]+/g, " ").replace(/\s+/g, " ").trim();
  /** Titel der aufgelösten Verweis-Chips (Dokument/Aufgabe/…) aus dem gerenderten Pin. */
  const chipText = (a: Annot): string => {
    const el = root.querySelector<HTMLElement>(`#annots [data-aid="${a.id}"]`);
    return el ? [...el.querySelectorAll<HTMLElement>(".ref-chip .ref-lbl")].map((c) => c.textContent ?? "").join(" ") : "";
  };
  /** [Beschriftung, gesamter Suchtext] einer Notiz bzw. eines Stern-Pins */
  const annotText = (a: Annot, star: boolean): [string, string] => {
    const lines = a.text.split("\n");
    const i = lines.findIndex((l) => l.trim());
    const chips = chipText(a);
    const head = i >= 0 ? clean(resolveCodes(lines[i])) : "";
    const label = star ? clean(head + " " + chips) || clean(resolveCodes(lines.slice(i + 1).join(" "))) : head;
    return [label.slice(0, 80), clean(resolveCodes(a.text) + " " + chips)];
  };  const isStar = (a: Annot): boolean => {
    const first = a.text.split("\n").find((l) => l.trim()) ?? "";
    return !!first.match(REF_RE) && !first.replace(REF_RE, "").trim();
  };

  function candidates(): Hit[] {
    const out: Hit[] = [];
    // Marker
    for (const mk of markers.values()) {
      const jp = targetPhase(mk.phase_id, mk.extra_phase_ids);
      if (jp === false) continue;
      const hid = hiddenLayer(mk.sidc, mk.layer_id);
      const key = mk.sidc.slice(4, 6) + mk.sidc.slice(10, 16);
      const label = m.markerLabel(mk) || ctx.nameBySidc.get(key) || "Marker";
      out.push({
        kind: "marker",
        id: mk.id,
        label,
        sub: subLine(mk.phase_id, layerNameOf(mk.layer_id), jp, hid),
        fields: [
          [mk.unit_text, 0],
          [label, 0],
          [mk.ai_text, 1],
          [ctx.nameBySidc.get(key) ?? "", 1],
        ],
        phase: jp,
        layerKey: hid?.[0] ?? null,
        layerName: hid?.[1] ?? "",
        pts: [[mk.world_x, mk.world_y]],
        area: false,
      });
    }
    // Notizen + Stern-Pins (werden nur mit Bearbeiten-Recht auf der Karte gezeigt, siehe plan.ts)
    if (ctx.canEdit)
      for (const a of annots.values()) {
        let jp: string | null | false;
        let hid: [string, string] | null = null;
        if (m.isNotesAnnot(a)) {
          // Layer „Missionsbau-Notizen“: Missionsbau in jeder Ansicht, Zeus nur freigegebene Pins
          if (ctx.actAs === "zeus") jp = m.annotZeusOpen(a) ? null : false;
          else jp = isMB ? null : false;
          if (jp === null && ctx.actAs !== "zeus" && m.tacVis("mbnotes") <= 0) hid = ["mbnotes", t("tac.mbNotes")];
        } else jp = targetPhase(a.phase_id, a.extra_phase_ids);
        if (jp === false) continue;
        const star = isStar(a);
        const [lbl, txt] = annotText(a, star);
        const label = lbl || t("annot.placeholder");
        const pts: LngLat2[] = [[a.world_x, a.world_y], ...(a.area?.pts ?? [])];
        out.push({
          kind: star ? "star" : "note",
          id: a.id,
          label,
          sub: m.isNotesAnnot(a)
            ? [t("tac.mbNotes"), hid ? t("search.hiddenLayer").replace("{layer}", hid[1]) : ""].filter(Boolean).join(" · ")
            : subLine(a.phase_id, "", jp, null),
          fields: [
            [label, 0],
            [txt, 1],
          ],
          phase: jp,
          layerKey: hid?.[0] ?? null,
          layerName: hid?.[1] ?? "",
          pts,
          area: pts.length > 1,
          domSel: `#annots [data-aid="${a.id}"]`,
        });
      }
    // Benannte Linien / Flächen und Punkte mit Text
    for (const s0 of strokes.values()) {
      const s = s0 as Stroke & { name?: string; closed?: boolean };
      const dot = s.kind === "dot";
      const name = (s.name ?? "").trim();
      if (!name || !s.points?.length) continue;
      const jp = targetPhase(s.phase_id ?? null, s.extra_phase_ids);
      if (jp === false) continue;
      const hid = hiddenLayer(null, s.layer_id);
      out.push({
        kind: dot ? "dot" : s.closed ? "area" : "line",
        id: s.id,
        label: name,
        sub: subLine(s.phase_id ?? null, layerNameOf(s.layer_id), jp, hid),
        fields: [[name, 0]],
        phase: jp,
        layerKey: hid?.[0] ?? null,
        layerName: hid?.[1] ?? "",
        pts: dot ? s.points.slice(0, 1) : s.points,
        area: !dot, // Punkt: hinfliegen (flyTo) statt Rahmen
      });
    }
    // Kartenbilder (je Platzierung)
    if (ctx.canEdit)
      for (const p of placements.values()) {
        const im = images.get(p.image_id);
        if (!im) continue;
        const jp = targetPhase(p.phase_id, undefined);
        if (jp === false) continue;
        const label = im.caption || im.filename;
        out.push({
          kind: "image",
          id: p.id,
          label,
          sub: subLine(p.phase_id, "", jp, null),
          fields: [
            [im.caption ?? "", 0],
            [im.filename ?? "", 1],
            [im.note ?? "", 1],
          ],
          phase: jp,
          layerKey: null,
          layerName: "",
          pts: [[p.world_x, p.world_y]],
          area: false,
          domSel: `#plan-images [data-pid="${p.id}"]`,
        });
      }
    // Kartenorte
    for (const pl of ctx.ui.listPlaces())
      out.push({
        kind: "place",
        id: `${pl.name}@${pl.lng},${pl.lat}`,
        label: pl.name,
        sub: "",
        fields: [[pl.name, 0], ...pl.names.filter((n) => n !== pl.name).map((n) => [n, 1] as [string, number])],
        phase: null,
        layerKey: null,
        layerName: "",
        pts: [[pl.lng, pl.lat]],
        area: false,
      });
    // Phasen (wie im Zeitstrahl der aktuellen Ansicht)
    for (const p of phases) {
      if (m.isNotesPhase(p)) continue;
      const b = p.plane === "builder";
      if (b && !(ctx.actAs === "zeus" ? m.zeusOpen(p.id) : isMB && ctx.actAs === "builder")) continue;
      out.push({
        kind: "phase",
        id: p.id,
        label: (b ? "⚑ " : "") + p.name,
        sub: [b ? t("search.kind.subphase") : "", p.id === ctx.currentPhaseId ? t("search.curPhase") : ""].filter(Boolean).join(" · "),
        fields: [[p.name, 0]],
        phase: p.id,
        layerKey: null,
        layerName: "",
        pts: [],
        area: false,
      });
    }
    return out;
  }

  function search(q: string): Hit[] {
    const tokens = q.trim().split(/\s+/).filter(Boolean).map(norms);
    if (!tokens.length) return [];
    const res: Hit[] = [];
    for (const h of candidates()) {
      const hay = h.fields.filter(([s]) => s).map(([s, w]) => [norms(s), w] as [[string, string], number]);
      let total = 0;
      let ok = true;
      for (const [qa, qb] of tokens) {
        let best = Infinity;
        for (const [[ha, hb], w] of hay) {
          const s1 = matchScore(ha, qa);
          const s2 = matchScore(hb, qb);
          const s = Math.min(s1 < 0 ? Infinity : s1, s2 < 0 ? Infinity : s2);
          if (s !== Infinity) best = Math.min(best, s + w * 3);
        }
        if (best === Infinity) {
          ok = false;
          break;
        }
        total += best;
      }
      if (ok) res.push({ ...h, score: total });
    }
    res.sort(
      (a, b) =>
        a.score! - b.score! ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.label.length - b.label.length ||
        a.label.localeCompare(b.label),
    );
    return res.slice(0, 40);
  }

  // ── Oberfläche ──
  const box = document.createElement("div");
  box.className = "psearch";
  box.id = "planSearch";
  box.hidden = true;
  box.innerHTML =
    `<div class="psearch-row">${icon("search", 16)}` +
    `<input type="search" id="planSearchIn" autocomplete="off" spellcheck="false" placeholder="${esc(t("search.placeholder"))}" aria-label="${esc(t("search.open"))}" />` +
    `<button type="button" class="icon-btn" data-psx title="${esc(t("common.close"))}">${icon("x", 14)}</button></div>` +
    `<div class="psearch-list" role="listbox" hidden></div>`;
  root.appendChild(box);
  const input = box.querySelector<HTMLInputElement>("#planSearchIn")!;
  const list = box.querySelector<HTMLDivElement>(".psearch-list")!;
  let hits: Hit[] = [];
  let sel = 0;
  let timer = 0;
  let dirty = false; // Eingabe noch nicht ausgewertet (Entprellung läuft)

  const kindLabel = (k: Kind): string => t("search.kind." + k);
  function renderList(): void {
    const q = input.value.trim();
    if (!q) {
      list.hidden = true;
      list.innerHTML = "";
      return;
    }
    list.hidden = false;
    if (!hits.length) {
      list.innerHTML = `<div class="psearch-empty muted">${esc(t("search.none"))}</div>`;
      return;
    }
    list.innerHTML = hits
      .map(
        (h, i) =>
          `<div class="psearch-item ${i === sel ? "sel" : ""} ${h.phase && h.kind !== "phase" ? "other" : ""}" role="option" data-i="${i}" aria-selected="${i === sel}">` +
          `<span class="psearch-ic" title="${esc(kindLabel(h.kind))}">${icon(KIND_ICON[h.kind], 16)}</span>` +
          `<span class="psearch-txt"><span class="psearch-name">${esc(h.label)}</span>` +
          `<span class="psearch-sub">${esc(kindLabel(h.kind))}${h.sub ? " · " + esc(h.sub) : ""}</span></span></div>`,
      )
      .join("");
    list.querySelector<HTMLElement>(".psearch-item.sel")?.scrollIntoView({ block: "nearest" });
  }
  const run = (): void => {
    clearTimeout(timer);
    dirty = false;
    hits = search(input.value);
    sel = 0;
    renderList();
  };

  function open(): void {
    box.hidden = false;
    // Mobil: aufgeklapptes Topbar-Menü schließen, damit das Feld frei liegt
    root.querySelector(".topbar")?.classList.remove("tb-open");
    input.focus();
    input.select();
    if (input.value.trim()) run();
  }
  function close(): void {
    box.hidden = true;
    clearTimeout(timer);
    input.blur();
  }
  const isOpen = (): boolean => !box.hidden;

  root.querySelector("#planSearchBtn")?.addEventListener("click", () => (isOpen() ? close() : open()));
  box.querySelector("[data-psx]")!.addEventListener("click", close);
  input.addEventListener("input", () => {
    dirty = true;
    clearTimeout(timer);
    timer = window.setTimeout(run, 140);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (input.value) {
        input.value = "";
        run();
      } else close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (dirty) run();
      if (!hits.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (dirty) run(); // Eingabe noch nicht ausgewertet → jetzt suchen, erster Treffer
      const h = hits[sel];
      if (h) pick(h);
      else renderList();
    }
  });
  // Klick/Tipp auf einen Treffer (mousedown nicht blurren lassen)
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const it = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    const h = it ? hits[+it.dataset.i!] : undefined;
    if (h) pick(h);
  });
  // Außerhalb klicken schließt (Karte bleibt bedienbar)
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!isOpen()) return;
      const tg = e.target as HTMLElement;
      if (box.contains(tg) || tg.closest("#planSearchBtn")) return;
      close();
    },
    { signal: sig, capture: true },
  );
  // Strg+F / „/“ öffnet, Esc schließt
  document.addEventListener(
    "keydown",
    (e) => {
      if (document.querySelector(".edit-modal, .wiz-backdrop")) return; // Dialog offen
      if (root.classList.contains("presenting")) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k === "f") {
        e.preventDefault();
        open();
      } else if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !actionForKey(e)) {
        const tg = e.target as HTMLElement | null;
        if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
        e.preventDefault();
        open();
      } else if (e.key === "Escape" && isOpen() && document.activeElement !== input) {
        close();
      }
    },
    { signal: sig },
  );

  // ── Auswahl: Phase/Layer umschalten, hinfliegen, hervorheben ──
  function switchPhase(pid: string): void {
    const p = phases.find((x) => x.id === pid);
    if (!p) return;
    if (p.plane === "builder" || ctx.actAs === "player") ctx.ui.selectPhase(pid);
    else ctx.ui.selectPlayerPhase(pid); // Missionsbau/Zeus: Spieler-Phase als aktive Ebene darunter
  }
  function pick(h: Hit): void {
    close();
    if (h.kind === "phase") {
      if (h.phase && h.phase !== ctx.currentPhaseId) switchPhase(h.phase);
      toast(t("search.phaseSet").replace("{name}", h.label), { timeout: 1800 });
      return;
    }
    if (h.layerKey) {
      ctx.ui.showTacLayer(h.layerKey);
      ctx.ui.refreshAreas();
      toast(t("search.layerShown").replace("{layer}", h.layerName), { timeout: 2600 });
    }
    if (h.phase) {
      switchPhase(h.phase);
      toast(t("search.phaseSwitched").replace("{name}", m.phaseNameOf(h.phase)), { timeout: 2200 });
    }
    fly(h);
  }

  const maxZ = (): number => Math.min(map.getMaxZoom(), 22);
  // Zoom, bei dem die ganze Karte zu sehen ist (Kamera-Grenzen aus plan.ts: minZoom = Gesamtansicht − 0,5)
  const fullZ = (): number => (map.getMinZoom() > 0 ? map.getMinZoom() + 0.5 : 12);
  function fly(h: Hit): void {
    // Die Karte liegt unter der Topbar (#map: inset var(--topbar-h)) → kein Versatz nötig
    const pad = { top: 60, bottom: 60, left: 60, right: 60 };
    if (h.area && h.pts.length > 1) {
      const b = new maplibregl.LngLatBounds(h.pts[0], h.pts[0]);
      for (const p of h.pts) b.extend(p);
      const w = map.getCanvas().clientWidth;
      const hh = map.getCanvas().clientHeight;
      // Fenster zu klein für den Rand (Handy) → kleinerer Rand
      const fits = w > pad.left + pad.right + 40 && hh > pad.top + pad.bottom + 40;
      map.fitBounds(b, { padding: fits ? pad : 20, maxZoom: Math.min(fullZ() + 4, maxZ()), essential: true, duration: 900 });
    } else {
      const zoom = Math.min(maxZ(), Math.max(map.getZoom(), fullZ() + (h.kind === "place" ? 2 : 3)));
      let offset: [number, number] = [0, 0];
      const el = h.domSel ? root.querySelector<HTMLElement>(h.domSel) : null;
      if (h.kind === "image" && el) {
        // Bild: Ankerpunkt = linke obere Ecke → Bildmitte in die Kartenmitte
        const r = el.getBoundingClientRect();
        offset = [-r.width / 2, -r.height / 2];
      }
      map.flyTo({ center: h.pts[0], zoom, offset, essential: true, duration: 900 });
    }
    let done = false;
    const go = (): void => {
      if (done) return;
      done = true;
      highlight(h);
    };
    map.once("moveend", go);
    setTimeout(go, 1300); // keine Bewegung nötig (schon dort) → trotzdem hervorheben
  }

  // Hervorhebung: pulsierender Ring (Punkte), aufleuchtender Umriss (Linien/Flächen), CSS-Blitz (Notiz/Bild)
  const HL_MS = 3000;
  let ringMarker: maplibregl.Marker | null = null;
  let hlTimer = 0;
  let hlAnim = 0;
  const HL_SRC = "psearch-hl";
  function clearHighlight(): void {
    clearTimeout(hlTimer);
    cancelAnimationFrame(hlAnim);
    ringMarker?.remove();
    ringMarker = null;
    if (map.getLayer(HL_SRC)) map.removeLayer(HL_SRC);
    if (map.getLayer(HL_SRC + "-glow")) map.removeLayer(HL_SRC + "-glow");
    if (map.getSource(HL_SRC)) map.removeSource(HL_SRC);
    root.querySelectorAll(".psearch-flash").forEach((el) => el.classList.remove("psearch-flash"));
  }
  function highlight(h: Hit): void {
    clearHighlight();
    if (h.area && h.pts.length > 1) {
      const pts = h.kind === "star" || h.kind === "note" ? h.pts.slice(1) : h.pts;
      const closed = h.kind === "area" || (h.kind !== "line" && pts.length >= 3);
      const ring = closed && pts.length >= 3 ? [...pts, pts[0]] : pts;
      const data: GeoJSON.Feature = { type: "Feature", geometry: { type: "LineString", coordinates: ring }, properties: {} };
      try {
        map.addSource(HL_SRC, { type: "geojson", data });
        map.addLayer({
          id: HL_SRC + "-glow",
          type: "line",
          source: HL_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#ffe14d", "line-width": 14, "line-opacity": 0.35, "line-blur": 6 },
        });
        map.addLayer({
          id: HL_SRC,
          type: "line",
          source: HL_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#fff6a8", "line-width": 4, "line-opacity": 1 },
        });
        const t0 = performance.now();
        const step = (now: number): void => {
          const k = (now - t0) / HL_MS;
          if (k >= 1 || !map.getLayer(HL_SRC)) return;
          const pulse = 0.5 + 0.5 * Math.sin(k * Math.PI * 6);
          map.setPaintProperty(HL_SRC + "-glow", "line-width", 10 + pulse * 12);
          map.setPaintProperty(HL_SRC + "-glow", "line-opacity", (0.25 + pulse * 0.4) * (1 - k * 0.6));
          map.setPaintProperty(HL_SRC, "line-opacity", 1 - k * 0.5);
          hlAnim = requestAnimationFrame(step);
        };
        hlAnim = requestAnimationFrame(step);
      } catch {
        /* Stil wird gerade neu geladen */
      }
    }
    if (!h.area || h.kind === "star" || h.kind === "note") {
      const el = document.createElement("div");
      el.className = "psearch-ring" + (h.kind === "place" ? " place" : "");
      el.innerHTML = "<span></span><span></span>";
      ringMarker = new maplibregl.Marker({ element: el }).setLngLat(h.pts[0]).addTo(map);
      if (h.kind === "image") {
        const img = h.domSel ? root.querySelector<HTMLElement>(h.domSel) : null;
        if (img) {
          const r = img.getBoundingClientRect();
          ringMarker.setOffset([r.width / 2, r.height / 2]);
        }
      }
    }
    if (h.domSel) root.querySelector(h.domSel)?.classList.add("psearch-flash");
    hlTimer = window.setTimeout(clearHighlight, HL_MS);
  }
  window.addEventListener("hashchange", () => clearHighlight(), { once: true });

}
