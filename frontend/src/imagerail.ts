// Rechte, ausklappbare Bild-Sidebar für die Planansicht. Listet die Bilder der
// aktuellen Phase/Ebene, erlaubt Upload, Beschriftung, Phasen-Zuordnung,
// "auf Karte zeigen" und Löschen. Klick aufs Thumbnail öffnet die Lightbox.
import { api, type PlanImage } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { esc } from "./esc";
import { toast, toastError, confirmDialog } from "./notify";
import type { LightboxItem } from "./lightbox";

interface RailPhase {
  id: string;
  name: string;
  plane?: "player" | "builder";
}

export interface ImageRailCtx {
  planId: string;
  images: Map<string, PlanImage>;
  phases: RailPhase[];
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

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

  const phaseOpts = (sel: string | null): string => {
    const list = ctx.isMB ? ctx.phases : ctx.phases.filter((p) => p.plane !== "builder");
    return (
      `<option value="">${t("phase.global")}</option>` +
      list
        .map(
          (p) =>
            `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${p.plane === "builder" ? "⚑ " : ""}${esc(p.name)}</option>`,
        )
        .join("")
    );
  };

  function currentList(): PlanImage[] {
    const pid = ctx.getCurrentPhaseId();
    const builderIds = new Set(ctx.phases.filter((p) => p.plane === "builder").map((p) => p.id));
    return [...ctx.images.values()].filter((i) => {
      if (!ctx.isMB && i.phase_id && builderIds.has(i.phase_id)) return false;
      return i.phase_id === (pid || null) || i.phase_id == null;
    });
  }

  function render(): void {
    if (!open) return;
    const list = currentList();
    if (!list.length) {
      listEl.innerHTML = `<p class="muted" style="padding:.6rem">${t("imgrail.empty")}</p>`;
      return;
    }
    listEl.innerHTML = list
      .map(
        (i) => `<div class="ir-item" data-iid="${esc(i.id)}">
          <img class="ir-thumb" src="${esc(api.planImageUrl(ctx.planId, i.id))}" alt="" loading="lazy" data-ir-open />
          <div class="ir-meta">
            ${
              ctx.canEdit
                ? `<input class="ir-cap" data-ir-cap value="${esc(i.caption)}" placeholder="${t("img.caption")}" />`
                : `<div class="ir-cap-ro">${esc(i.caption || i.filename)}</div>`
            }
            <div class="muted" style="font-size:.72rem">${esc(i.filename)} · ${fmtBytes(i.byte_size)}</div>
            ${
              ctx.canEdit
                ? `<div class="ir-row">
                     <label class="ir-chk"><input type="checkbox" data-ir-onmap ${i.on_map ? "checked" : ""}/> ${t("img.showOnMap")}</label>
                   </div>
                   <select class="ir-phase" data-ir-phase>${phaseOpts(i.phase_id)}</select>
                   <button class="icon-btn ir-del" data-ir-del title="${t("img.delete")}">${icon("trash", 14)}</button>`
                : ""
            }
          </div>
        </div>`,
      )
      .join("");

    listEl.querySelectorAll<HTMLElement>(".ir-item").forEach((row) => {
      const id = row.dataset.iid!;
      const get = () => ctx.images.get(id);
      row.querySelector("[data-ir-open]")?.addEventListener("click", () => {
        const items = currentList().map((x) => ({
          url: api.planImageUrl(ctx.planId, x.id),
          caption: x.caption || x.filename,
        }));
        ctx.onOpenLightbox(items, currentList().findIndex((x) => x.id === id));
      });
      row.querySelector<HTMLInputElement>("[data-ir-cap]")?.addEventListener("change", (e) => {
        const v = (e.target as HTMLInputElement).value;
        const cur = get();
        if (cur) cur.caption = v;
        ctx.send({ type: "image.modify", id, data: { caption: v, phase_id: cur?.phase_id ?? null } });
      });
      row.querySelector<HTMLInputElement>("[data-ir-onmap]")?.addEventListener("change", (e) => {
        const on = (e.target as HTMLInputElement).checked;
        const cur = get();
        if (!cur) return;
        cur.on_map = on;
        const data: Record<string, unknown> = { on_map: on, phase_id: cur.phase_id };
        if (on && cur.world_x === 0 && cur.world_y === 0) {
          const c = ctx.map.getCenter();
          cur.world_x = c.lng;
          cur.world_y = c.lat;
          cur.ref_zoom = ctx.map.getZoom();
          data.world_x = c.lng;
          data.world_y = c.lat;
          data.ref_zoom = cur.ref_zoom;
        }
        ctx.send({ type: "image.modify", id, data });
      });
      row.querySelector<HTMLSelectElement>("[data-ir-phase]")?.addEventListener("change", (e) => {
        const v = (e.target as HTMLSelectElement).value || null;
        const cur = get();
        if (cur) cur.phase_id = v;
        ctx.send({ type: "image.modify", id, data: { phase_id: v } });
        render();
      });
      row.querySelector("[data-ir-del]")?.addEventListener("click", async () => {
        if (await confirmDialog(t("img.deleteConfirm"), { danger: true })) {
          ctx.send({ type: "image.delete", id });
        }
      });
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
