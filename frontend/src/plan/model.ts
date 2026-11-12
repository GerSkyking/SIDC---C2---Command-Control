// Abgeleitete Hilfsfunktionen der Plan-Ansicht: Phasen-/Ebenen-Logik, Sichtbarkeit (Deckkraft),
// Marker-Beschriftung, Notiz-Verweise. Liest den veränderlichen Zustand immer frisch aus ctx.
import type * as maplibregl from "maplibre-gl";
import { api } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { openLightbox } from "../lightbox";
import { toast } from "../notify";
import { wireRefChips, type WireOpts } from "../projectRefs";
import { getKeybinds, keyLabel, type HotAction } from "../settings";
import { describe } from "../sidc/catalog";
import { phaseMultiHtml, readPhaseMulti, type PhaseOpt, type TplCtx } from "../sidc/layerui";
import { isTextMarker } from "../sidc/sidc";
import type { Annot, Marker, PhaseT, PlanCtx, TacAuto } from "./ctx";
import { parseUtc } from "./geo";

export type PlanModel = ReturnType<typeof createModel>;

export function createModel(ctx: PlanCtx) {
  const { planId, phases, images, peers, isMB, projectId, tacState } = ctx;

  // Kleiner Bild-Wähler für "Bild in Notiz einfügen".
  const pickPlanImage = (): Promise<string | null> =>
    new Promise((resolve) => {
      const list = [...images.values()];
      const back = document.createElement("div");
      back.className = "edit-modal";
      back.innerHTML = `<div class="card stack" style="width:min(34rem,92vw)">
        <div class="row"><strong style="flex:1">${t("img.pickTitle")}</strong>
          <button class="icon-btn" data-x title="${t("common.close")}">${icon("x", 16)}</button></div>
        <div class="ir-pick">${
          list.length
            ? list
                .map(
                  (i) =>
                    `<button class="ir-pick-item" data-pick="${esc(i.id)}">
                       <img src="${esc(api.planImageUrl(planId, i.id))}" alt="" loading="lazy" />
                       <span>${esc(i.caption || i.filename)}</span></button>`,
                )
                .join("")
            : `<p class="muted">${t("imgrail.empty")}</p>`
        }</div></div>`;
      const done = (v: string | null) => {
        back.remove();
        resolve(v);
      };
      back.addEventListener("mousedown", (e) => {
        if (e.target === back) done(null);
      });
      back.querySelector("[data-x]")!.addEventListener("click", () => done(null));
      back.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((b) =>
        b.addEventListener("click", () => done(b.dataset.pick!)),
      );
      document.body.appendChild(back);
    });

  // Notiz-Bild-Chips ({{img:id}}) mit Text füllen + Klick -> Lightbox.
  const wireNoteImageRefs = (container: HTMLElement): void => {
    container.querySelectorAll<HTMLElement>(".note-img-ref").forEach((el) => {
      const id = el.dataset.img ?? "";
      const img = images.get(id);
      if (img) el.textContent = "🖼︎ " + (img.caption || img.filename);
      el.addEventListener("click", (e) => {
        e.preventDefault();
        openLightbox([
          { url: api.planImageUrl(planId, id), caption: img?.caption || img?.filename || "" },
        ]);
      });
    });
  };
  // Projekt-Verweise: gehört der Plan zu einem Projekt, werden {{…}}-Codes in Textfeldern/Phasen-Notizen
  // zu Chips (Ziele öffnen in neuem Tab, damit hier nichts verloren geht); sonst bleiben sie inaktiv.
  const refOpts: WireOpts = { newTab: true, skipImg: true, onPlace: (m, n) => ctx.ui.flyToPlace(m, n) };
  const wireRefs = (el: HTMLElement): void => {
    if (projectId) void wireRefChips(el, projectId, refOpts);
  };

  const markerInfoText = (sidc: string): string =>
    describe(ctx.langKeyBySidc.get(sidc.slice(4, 6) + sidc.slice(10, 16)));

  // Marker-Beschriftung: Name + (falls gesetzt) Modifikatoren, per Komma getrennt.
  const MOD_SLOTS: [string, (s: string) => string][] = [
    ["modifier1", (s) => s.slice(16, 18)],
    ["modifier2", (s) => s.slice(18, 20)],
    ["modifier3", (s) => s.slice(7, 8)],
    ["modifier4", (s) => s.slice(6, 7)],
  ];
  const markerModifierLabels = (sidc: string): string[] => {
    const sub = ctx.subCatBySidc.get(sidc.slice(4, 6) + sidc.slice(10, 16));
    const defs = sub && ctx.modCat ? ctx.modCat[sub] : undefined;
    if (!defs) return [];
    const out: string[] = [];
    for (const [slot, pick] of MOD_SLOTS) {
      const code = Number(pick(sidc) || "0");
      if (!code) continue;
      const opt = (defs[slot] ?? []).find((o) => Number(o.code) === code);
      if (opt?.description) out.push(opt.description);
    }
    return out;
  };
  const markerLabel = (m: Marker): string => {
    if (isTextMarker(m.sidc)) return m.unit_text || "Text";
    const base = m.unit_text || ctx.nameBySidc.get(m.sidc.slice(4, 6) + m.sidc.slice(10, 16)) || "";
    return [base, ...markerModifierLabels(m.sidc)].filter(Boolean).join(", ");
  };

  // Jede Person bekommt eine eigene, aus der User-ID abgeleitete Farbe.
  const peerColor = (uid: string): string => {
    let h = 0;
    for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
    return `hsl(${Math.round((h * 137.508) % 360)} 85% 62%)`;
  };
  const upsertPeer = (uid: string, name: string, lng: number, lat: number, hl: boolean, arrow: [number, number] | null) => {
    const prev = peers.get(uid);
    const hlUntil = hl ? Infinity : prev && prev.hl === Infinity ? Date.now() + 1200 : (prev?.hl ?? 0);
    peers.set(uid, { name, lng, lat, t: Date.now(), color: peerColor(uid), hl: hlUntil, arrow });
  };

  const isNotesPhase = (p: PhaseT | undefined): boolean => p?.role === "notes";
  const isBuilderPhase = (id: string | null | undefined): boolean =>
    !!id && phases.some((p) => p.id === id && p.plane === "builder");
  // Die an eine gesperrte Spieler-Phase (aktuell nur "Base") gekoppelte Missionsbau-
  // "Spiegel"-Phase ist für ALLE dauerhaft sichtbar (Server liefert sie non-MB-Usern
  // ohnehin mit) — Bearbeiten bleibt server- wie clientseitig Missionsbauern vorbehalten.
  const isReleasedBuilderPhase = (id: string | null | undefined): boolean => {
    const p = id ? phases.find((x) => x.id === id) : undefined;
    if (!p || p.plane !== "builder") return false;
    if (p.player_released) return true;
    const parent = phases.find((x) => x.id === p.parent_id);
    return !!parent?.locked;
  };
  const playerPhases = (): PhaseT[] => phases.filter((p) => (p.plane ?? "player") === "player");
  const builderChildren = (playerId: string): PhaseT[] =>
    phases
      .filter((p) => p.plane === "builder" && p.parent_id === playerId)
      .sort((a, b) => (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0));

  // Zeus-Freigabe einer Missionsbau-Phase: aktiv, solange keine Frist gesetzt ist oder sie noch nicht abgelaufen ist.
  const zeusOpen = (id: string | null | undefined): boolean => {
    const ph = id ? phases.find((x) => x.id === id) : undefined;
    return !!ph && ph.plane === "builder" && !!ph.zeus_released && (!ph.zeus_until || parseUtc(ph.zeus_until) > Date.now());
  };
  const zeusChildren = (playerId: string): PhaseT[] => builderChildren(playerId).filter((p) => zeusOpen(p.id));
  // Zeus-Ansicht: in Spieler-Phasen wird nichts gesetzt.
  const zeusBlocked = (): boolean => {
    if (ctx.actAs !== "zeus" || isBuilderPhase(ctx.currentPhaseId)) return false;
    toast(t("zeus.noPlayerPhase"), { kind: "error" });
    return true;
  };
  const activePlayerId = (): string => {
    const cur = phases.find((p) => p.id === ctx.currentPhaseId);
    return cur?.plane === "builder" ? cur.parent_id ?? "" : ctx.currentPhaseId;
  };
  const unitAiOpacityExpr = (on: boolean): maplibregl.ExpressionSpecification =>
    on ? ["get", "opacity"] : ["*", ["get", "opacity"], ["match", ["get", "labelcat"], "default", 0, 1]];

  const autoLayerOf = (sidc: string): TacAuto | null => {
    if (isTextMarker(sidc)) return null;
    const id = sidc[3];
    if (id === "2" || id === "3") return "bluefor";
    if (id === "5" || id === "6" || id === "7" || id === "8") return "redfor";
    if (id === "4") return "civgreen";
    return "unknown";
  };
  const tacVis = (key: string): number => {
    const st = tacState[key];
    if (!st) return 1;
    return st.on === false ? 0 : Math.max(0, Math.min(100, st.op ?? 100)) / 100;
  };
  const tacOpacity = (sidc: string | null, layerId: string | null | undefined): number => {
    const a = sidc ? autoLayerOf(sidc) : null;
    return (a ? tacVis("auto:" + a) : 1) * (layerId && ctx.tacLayers.some((l) => l.id === layerId) ? tacVis(layerId) : 1);
  };
  // Phasen derselben Ebene (Spieler/Missionsbau) zur Mehrfach-Auswahl
  const samePlanePhases = (pid: string | null | undefined): PhaseOpt[] => {
    const b = isBuilderPhase(pid);
    return phases
      .filter((p) => !isNotesPhase(p) && (p.plane === "builder") === b && (ctx.actAs !== "zeus" || !b || zeusOpen(p.id)))
      .map((p) => ({ id: p.id, name: p.name, builder: p.plane === "builder" }));
  };
  // Phasen, die ich zuordnen darf: Spieler-Phasen, für Missionsbauer alles, für Zeus die freigegebenen
  const selectablePhases = (): PhaseT[] =>
    phases.filter((p) => !isNotesPhase(p) && (p.plane !== "builder" || isMB || zeusOpen(p.id)));
  // Mehrfach-Phasen-Auswahl in einem Container: folgt der gewählten Hauptphase, speichert über set()
  const bindXPhases = (
    host: HTMLElement,
    getPid: () => string | null,
    get: () => string[],
    set: (v: string[]) => void,
  ): (() => void) => {
    const render = (): void => {
      const pid = getPid();
      const opts = samePlanePhases(pid);
      const valid = get().filter((x) => x !== pid && opts.some((p) => p.id === x));
      set(valid);
      host.innerHTML = phaseMultiHtml("data-xphases", opts, valid, pid);
      host.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) =>
        cb.addEventListener("change", () => set(readPhaseMulti(host, "data-xphases"))),
      );
    };
    render();
    return render;
  };
  const multiPhaseOpacity = (pid: string | null | undefined, extras?: string[]): number =>
    Math.max(phaseOpacityOf(pid), ...(extras ?? []).map((x) => phaseOpacityOf(x)));
  const tplCtx = (): TplCtx => ({
    layers: ctx.tacLayers.map((l) => ({ id: l.id, name: l.name })),
    layerId: null,
    phases: samePlanePhases(ctx.currentPhaseId),
    phaseId: ctx.currentPhaseId,
  });

  const phaseOpacityOf = (phaseId: string | null | undefined): number => {
    if (phaseId == null) return 1;
    const mB = isBuilderPhase(phaseId);
    // Freigegebene Base-Missionsbau-Phase: immer voll sichtbar, auch in der
    // echten Spieler-Vorschau — unabhängig von der aktuell gewählten Phase.
    if (mB && isReleasedBuilderPhase(phaseId)) return 1;
    // Feste Ebene „Karten-Notizen“: ohne Phasen-Abdunklung, solange sie in der aktuellen Ansicht überhaupt sichtbar ist
    if (isNotesPhase(phases.find((x) => x.id === phaseId))) {
      if (ctx.actAs === "zeus") return zeusOpen(phaseId) ? 1 : 0;
      return isMB && ctx.actAs === "builder" ? 1 : 0;
    }
    // Zeus-Ansicht: Spieler-Inhalt (nur ansehen) + für Zeus freigegebene Missionsbau-Phasen
    if (ctx.actAs === "zeus") {
      const outO = Math.max(0, Math.min(100, ctx.outOpacity)) / 100;
      if (mB) return zeusOpen(phaseId) ? (phaseId === ctx.currentPhaseId ? 1 : outO) : 0;
      return phaseId === activePlayerId() || phaseId === ctx.currentPhaseId ? 1 : outO;
    }
    if (mB && !isMB) return 0; // Zeus-freigegebene Phasen nur in der Zeus-Ansicht
    // Missionsbau in Spieler-Ansicht = echte Spieler-Vorschau: Missionsbau-Inhalte weg.
    if (mB && isMB && ctx.actAs === "player") return 0;
    const curB = isBuilderPhase(ctx.currentPhaseId);
    if (mB !== curB) return Math.max(0, Math.min(100, ctx.crossOpacity)) / 100; // andere Ebene
    if (phaseId === ctx.currentPhaseId) return 1;
    return Math.max(0, Math.min(100, ctx.outOpacity)) / 100; // Fremdphase (gleiche Ebene)
  };
  const phaseOpacity = (m: Marker): number =>
    Math.max(phaseOpacityOf(m.phase_id), ...(m.extra_phase_ids ?? []).map((x) => phaseOpacityOf(x))) *
    (m.released ? 0.6 : 1) *
    tacOpacity(m.sidc, m.layer_id);
  const phaseNameOf = (id: string | null): string => {
    const ph = id ? phases.find((p) => p.id === id) : undefined;
    if (!id) return t("phase.global");
    // Für Spieler freigegebene Missionsbau-Phase: erscheint als die Spieler-Phase darüber
    if (ph && ph.plane === "builder" && !isMB) return phases.find((p) => p.id === ph.parent_id)?.name ?? ph.name;
    return ph?.name ?? "—";
  };
  // Hotkey-Hinweis " (Taste)" für Tooltips, aus den (änderbaren) Nutzer-Keybinds.
  const hk = (action: HotAction): string => {
    const k = getKeybinds()[action];
    return k ? ` (${keyLabel(k)})` : "";
  };
  // Messlinie sichtbar? (Phase/Ebene wie Phasenlinien, plus taktischer Layer)
  const measureVisible = (ml: { phase_id: string | null; extra_phase_ids: string[]; layer_id: string | null }): boolean =>
    multiPhaseOpacity(ml.phase_id, ml.extra_phase_ids) * tacOpacity(null, ml.layer_id) > 0;

  // Einzelfreigabe für Zeus: aktiv, solange keine Frist gesetzt ist oder sie noch nicht abgelaufen ist.
  const annotZeusOpen = (a: Annot): boolean =>
    !!a.zeus_released && (!a.zeus_until || parseUtc(a.zeus_until) > Date.now());
  // Karten-Notiz = Pin auf der festen Ebene; Zeus kennt die Ebene selbst nicht (nur die freigegebenen Pins).
  const isNotesAnnot = (a: Annot): boolean =>
    isNotesPhase(phases.find((x) => x.id === a.phase_id)) ||
    (!!a.phase_id && !phases.some((x) => x.id === a.phase_id) && !!a.zeus_released);
  const annotOpacity = (a: Annot): number => {
    if (isNotesAnnot(a)) {
      // Layer „Missionsbau-Notizen“: der Missionsbau sieht ihn in jeder Ansicht (pink markiert, im Layer-Menü abschaltbar)
      if (ctx.actAs === "zeus") return annotZeusOpen(a) ? 1 : 0;
      return isMB ? tacVis("mbnotes") : 0;
    }
    return multiPhaseOpacity(a.phase_id, a.extra_phase_ids);
  };

  return {
    pickPlanImage,
    wireNoteImageRefs,
    wireRefs,
    markerInfoText,
    markerLabel,
    upsertPeer,
    isNotesPhase,
    isBuilderPhase,
    playerPhases,
    builderChildren,
    zeusOpen,
    zeusChildren,
    zeusBlocked,
    activePlayerId,
    unitAiOpacityExpr,
    tacVis,
    tacOpacity,
    samePlanePhases,
    selectablePhases,
    bindXPhases,
    multiPhaseOpacity,
    tplCtx,
    phaseOpacityOf,
    phaseOpacity,
    phaseNameOf,
    hk,
    measureVisible,
    annotZeusOpen,
    isNotesAnnot,
    annotOpacity,
  };
}
