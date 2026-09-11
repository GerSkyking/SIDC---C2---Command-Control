// Rechte, ausklappbare Bild-Sidebar für die Planansicht. Listet die Bilder der
// aktuellen Phase/Ebene, erlaubt Upload, Beschriftung, Phasen-Zuordnung,
// "auf Karte zeigen" und Löschen. Klick aufs Thumbnail öffnet die Lightbox.
import { api, type ImagePlacement, type PlanImage } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { esc } from "./esc";
import { toast, toastError } from "./notify";
import type { LightboxItem } from "./lightbox";
import { renderImageSettings, isEditingImageNote, type ImgPanelPhase } from "./imagePanel";

/** MIME-Type für die Drag&Drop-Nutzlast (Sidebar -> Karte). */
export const IMAGE_DND_TYPE = "application/x-sidc-image";

export interface ImageRailCtx {
  planId: string;
  images: Map<string, PlanImage>;
  placements: Map<string, ImagePlacement>;
  phases: ImgPanelPhase[];
  isMB: boolean;
  canEdit: boolean;
  imageMaxMb: number;
  getCurrentPhaseId: () => string;
  send: (m: { type: string; [k: string]: unknown }) => void;
  map: { getCenter(): { lng: number; lat: number }; getZoom(): number };
  onOpenLightbox: (items: LightboxItem[], start?: number) => void;
}

export interface ImageRail {
  refresh: () => void;
}

const OPEN_KEY = "sidc_imgrail_open";

export function mountImageRail(root: HTMLElement, ctx: ImageRailCtx): ImageRail {
  const rail = document.createElement("aside");
  rail.className = "img-rail";
  let open = false;
  try {
    open = localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    /* ignore */
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/gif,image/webp";
  fileInput.hidden = true;

  rail.innerHTML = `
    <div class="ir-head">
      <strong>${t("imgrail.title")}</strong>
      <span class="grow"></span>
      ${ctx.canEdit ? `<button class="icon-btn" data-ir-up title="${t("imgrail.upload")}">${icon("plus", 16)}</button>` : ""}
      <button class="icon-btn" data-ir-close title="${t("lightbox.close")}">${icon("chevron", 16)}</button>
    </div>
    <div class="ir-list"></div>`;
  rail.appendChild(fileInput);
  root.appendChild(rail);

  // Toggle-Griff am rechten Rand
  const tab = document.createElement("button");
  tab.className = "img-rail-tab";
  tab.title = t("imgrail.toggle");
  tab.innerHTML = icon("chevron", 16);
  root.appendChild(tab);

  const listEl = rail.querySelector<HTMLElement>(".ir-list")!;

  const apply = () => {
    rail.classList.toggle("open", open);
    tab.classList.toggle("hidden", open);
    document.body.classList.toggle("rail-open", open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  const setOpen = (v: boolean) => {
    open = v;
    apply();
    if (open) render();
  };
  tab.addEventListener("click", () => setOpen(true));
  rail.querySelector("[data-ir-close]")!.addEventListener("click", () => setOpen(false));
  rail.querySelector("[data-ir-up]")?.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    if (f.size > ctx.imageMaxMb * 1024 * 1024) {
      toast(t("img.tooLarge").replace("{mb}", String(ctx.imageMaxMb)), { kind: "error" });
      return;
    }
    try {
      const dim = await readDims(f);
      const img = await api.uploadPlanImage(ctx.planId, f, {
        phase_id: ctx.getCurrentPhaseId() || null,
        w: dim?.w,
        h: dim?.h,
      });
      // Server broadcastet image.upsert an alle Peers (auch uns) -> Liste aktualisiert sich.
      ctx.images.set(img.id, img);
      render();
    } catch (e) {
      toastError(e);
    }
  });

  // Alle für den Nutzer sichtbaren Bilder (Missionsbau-Phasen bleiben für
  // Nicht-Missionsbauer weiterhin unsichtbar — Sicherheitsgrenze bleibt bestehen).
  function visibleImages(): PlanImage[] {
    const builderIds = new Set(ctx.phases.filter((p) => p.plane === "builder").map((p) => p.id));
    return [...ctx.images.values()].filter((i) => ctx.isMB || !i.phase_id || !builderIds.has(i.phase_id));
  }

  function currentList(): PlanImage[] {
    const pid = ctx.getCurrentPhaseId();
    return visibleImages().filter((i) => i.phase_id === (pid || null) || i.phase_id == null);
  }

  function otherLists(): { builder: PlanImage[]; player: PlanImage[] } {
    const pid = ctx.getCurrentPhaseId();
    const builderIds = new Set(ctx.phases.filter((p) => p.plane === "builder").map((p) => p.id));
    const other = visibleImages().filter((i) => i.phase_id && i.phase_id !== (pid || null));
    return {
      builder: other.filter((i) => builderIds.has(i.phase_id!)),
      player: other.filter((i) => !builderIds.has(i.phase_id!)),
    };
  }

  // Reihenfolge, in der die Lightbox beim Klick "vor/zurück" blättert — alle
  // sichtbaren Bilder über alle Gruppen hinweg, in Anzeige-Reihenfolge.
  function flatOrder(): PlanImage[] {
    const other = otherLists();
    return [...currentList(), ...other.builder, ...other.player];
  }

  function phaseName(id: string | null): string {
    return ctx.phases.find((p) => p.id === id)?.name ?? "";
  }

  // Welche Zeile ihr Zahnrad-Panel gerade offen hat — bleibt über einen Neuaufbau
  // hinweg erhalten (z. B. nach Phasenwechsel), außer die Zeile fällt aus der Liste.
  const openGear = new Set<string>();

  function rowHtml(i: PlanImage, faded: boolean): string {
    return `<div class="ir-item${faded ? " ir-other" : ""}" data-iid="${esc(i.id)}">
      <img class="ir-thumb" src="${esc(api.planImageUrl(ctx.planId, i.id))}" alt=""
        loading="lazy" data-ir-open ${ctx.canEdit ? 'draggable="true" data-ir-drag' : ""}
        title="${ctx.canEdit ? esc(t("imgrail.dragHint")) : ""}" />
      <div class="ir-meta">
        <div class="ir-name-row">
          ${
            ctx.canEdit
              ? `<input class="ir-cap" data-ir-cap value="${esc(i.caption)}" placeholder="${t("img.caption")}" title="${t("img.captionHint")}" />`
              : `<div class="ir-cap-ro">${esc(i.caption || i.filename)}</div>`
          }
          ${ctx.canEdit ? `<button class="icon-btn" data-ir-gear title="${t("settings.title")}">${icon("settings", 14)}</button>` : ""}
        </div>
        ${faded && i.phase_id ? `<div class="ir-phase-badge">${esc(phaseName(i.phase_id))}</div>` : ""}
        ${ctx.canEdit ? `<div class="ir-gear-panel" data-ir-gearpanel ${openGear.has(i.id) ? "" : "hidden"}></div>` : ""}
      </div>
    </div>`;
  }

  function wireRow(row: HTMLElement): void {
    const id = row.dataset.iid!;
    row.querySelector("[data-ir-open]")?.addEventListener("click", () => {
      const order = flatOrder();
      const items = order.map((x) => ({
        url: api.planImageUrl(ctx.planId, x.id),
        caption: x.caption || x.filename,
        note: x.note,
        onNoteSave: ctx.canEdit
          ? (v: string) => {
              const cur = ctx.images.get(x.id);
              if (cur) cur.note = v;
              ctx.send({ type: "image.modify", id: x.id, data: { note: v, phase_id: cur?.phase_id ?? null } });
            }
          : undefined,
      }));
      ctx.onOpenLightbox(items, order.findIndex((x) => x.id === id));
    });
    row.querySelector<HTMLImageElement>("[data-ir-drag]")?.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(IMAGE_DND_TYPE, id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    });
    row.querySelector<HTMLInputElement>("[data-ir-cap]")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value;
      const cur = ctx.images.get(id);
      if (cur) cur.caption = v;
      ctx.send({ type: "image.modify", id, data: { caption: v, phase_id: cur?.phase_id ?? null } });
    });
    const panel = row.querySelector<HTMLElement>("[data-ir-gearpanel]");
    const openPanel = () => {
      const img = ctx.images.get(id);
      if (!panel || !img) return;
      renderImageSettings(panel, img, {
        isMB: ctx.isMB,
        phases: ctx.phases,
        send: ctx.send,
        getMapCenter: ctx.map.getCenter.bind(ctx.map),
        getMapZoom: ctx.map.getZoom.bind(ctx.map),
        getCurrentPhaseId: ctx.getCurrentPhaseId,
        placementsOf: (imageId) => [...ctx.placements.values()].filter((p) => p.image_id === imageId),
        onChanged: () => render(),
        onDeleted: () => {
          openGear.delete(id);
          render();
        },
      });
    };
    row.querySelector("[data-ir-gear]")?.addEventListener("click", () => {
      if (!panel) return;
      panel.hidden = !panel.hidden;
      if (panel.hidden) openGear.delete(id);
      else {
        openGear.add(id);
        openPanel();
      }
    });
    if (panel && !panel.hidden) openPanel();
  }

  function render(): void {
    if (!open) return;
    if (isEditingImageNote()) return; // Notiz wird gerade getippt — kein destruktiver Rebuild
    const current = currentList();
    const other = otherLists();
    if (!current.length && !other.builder.length && !other.player.length) {
      listEl.innerHTML = `<p class="muted" style="padding:.6rem">${t("imgrail.empty")}</p>`;
      return;
    }
    const sections: string[] = [];
    sections.push(current.map((i) => rowHtml(i, false)).join(""));
    if (other.builder.length || other.player.length) {
      sections.push(`<div class="ir-sep"><span>${t("imgrail.otherPhases")}</span></div>`);
      if (other.builder.length) {
        sections.push(`<div class="ir-group-title">${t("imgrail.groupBuilder")}</div>`);
        sections.push(other.builder.map((i) => rowHtml(i, true)).join(""));
      }
      if (other.player.length) {
        sections.push(`<div class="ir-group-title">${t("imgrail.groupPlayer")}</div>`);
        sections.push(other.player.map((i) => rowHtml(i, true)).join(""));
      }
    }
    listEl.innerHTML = sections.join("");
    listEl.querySelectorAll<HTMLElement>(".ir-item").forEach(wireRow);
  }

  apply();
  render();

  return { refresh: render };
}

function readDims(f: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      resolve({ w: im.naturalWidth, h: im.naturalHeight });
      URL.revokeObjectURL(url);
    };
    im.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    im.src = url;
  });
}
