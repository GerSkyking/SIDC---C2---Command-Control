// Rechte, ausklappbare Bild-Sidebar für die Planansicht. Listet die Bilder der
// aktuellen Phase/Ebene, erlaubt Upload, Beschriftung, Phasen-Zuordnung,
// "auf Karte zeigen" und Löschen. Klick aufs Thumbnail öffnet die Lightbox.
import { api, type PlanImage } from "./api";
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

  function currentList(): PlanImage[] {
    const pid = ctx.getCurrentPhaseId();
    const builderIds = new Set(ctx.phases.filter((p) => p.plane === "builder").map((p) => p.id));
    return [...ctx.images.values()].filter((i) => {
      if (!ctx.isMB && i.phase_id && builderIds.has(i.phase_id)) return false;
      return i.phase_id === (pid || null) || i.phase_id == null;
    });
  }

  // Welche Zeile ihr Zahnrad-Panel gerade offen hat — bleibt über einen Neuaufbau
  // hinweg erhalten (z. B. nach Phasenwechsel), außer die Zeile fällt aus der Liste.
  const openGear = new Set<string>();

  function render(): void {
    if (!open) return;
    if (isEditingImageNote()) return; // Notiz wird gerade getippt — kein destruktiver Rebuild
    const list = currentList();
    if (!list.length) {
      listEl.innerHTML = `<p class="muted" style="padding:.6rem">${t("imgrail.empty")}</p>`;
      return;
    }
    listEl.innerHTML = list
      .map(
        (i) => `<div class="ir-item" data-iid="${esc(i.id)}">
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
            ${ctx.canEdit ? `<div class="ir-gear-panel" data-ir-gearpanel ${openGear.has(i.id) ? "" : "hidden"}></div>` : ""}
          </div>
        </div>`,
      )
      .join("");

    listEl.querySelectorAll<HTMLElement>(".ir-item").forEach((row) => {
      const id = row.dataset.iid!;
      row.querySelector("[data-ir-open]")?.addEventListener("click", () => {
        const items = currentList().map((x) => ({
          url: api.planImageUrl(ctx.planId, x.id),
          caption: x.caption || x.filename,
          note: x.note,
        }));
        ctx.onOpenLightbox(items, currentList().findIndex((x) => x.id === id));
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
    });
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
