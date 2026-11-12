// Bilder auf der Karte: Platzierungen anzeigen/ziehen/skalieren, Zahnrad-Popover, Hover,
// Drag&Drop aus der Bild-Sidebar und die Sidebar selbst.
import * as maplibregl from "maplibre-gl";
import { api, type ImagePlacement, type PlanImage } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { mountImageRail, IMAGE_DND_TYPE } from "../imagerail";
import { renderPlacementSettings } from "../imagePanel";
import { openLightbox } from "../lightbox";
import type { PlanCtx } from "./ctx";

export function initImages(ctx: PlanCtx): void {
  const { map, socket, root, planId, images, placements, phases, isMB, canEdit, sig, phaseListeners } = ctx;
  const { phaseOpacityOf, phaseNameOf } = ctx.model;
  let imageRail: { refresh: () => void } | null = null;
  let imgClickSuppressed = false;
  // ── Bilder auf der Karte (platzierbar, wie Annotationen) ─────────────
  const imagesEl = root.querySelector<HTMLDivElement>("#plan-images")!;
  let imgDragId: string | null = null;
  let imgRefFallback = 0;
  const imageScale = (p: ImagePlacement): number => {
    if (!p.scale_fixed) return 1;
    const ref = p.ref_zoom && p.ref_zoom > 0 ? p.ref_zoom : imgRefFallback;
    if (!ref) return 1;
    return Math.max(0.3, Math.min(3, 2 ** (map.getZoom() - ref)));
  };
  function positionImages(): void {
    for (const el of Array.from(imagesEl.children) as HTMLElement[]) {
      const p = placements.get(el.dataset.pid ?? "");
      if (!p) continue;
      const pp = map.project([p.world_x, p.world_y]);
      el.style.transform = `translate(${pp.x}px, ${pp.y}px) scale(${imageScale(p)})`;
    }
    positionImgPopover();
  }

  // ── Zahnrad-Popover direkt am Kartenbild (Name/Notiz/Phase/Skalieren/…) ──
  // Zielt auf eine PLATZIERUNG (nicht das Bild selbst) — dasselbe Bild kann
  // mehrfach/in mehreren Phasen platziert sein, jede Platzierung hat ihr eigenes
  // Popover mit eigener Phase/Skalierung.
  let imgPopoverId: string | null = null;
  let imgPopoverEl: HTMLElement | null = null;
  function closeImgPopover(): void {
    imgPopoverEl?.remove();
    imgPopoverEl = null;
    imgPopoverId = null;
  }
  function positionImgPopover(): void {
    if (!imgPopoverEl || !imgPopoverId) return;
    const p = placements.get(imgPopoverId);
    if (!p) {
      closeImgPopover();
      return;
    }
    const pp = map.project([p.world_x, p.world_y]);
    const w = p.map_width * imageScale(p);
    const mr = map.getContainer().getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const ox = mr.left - rr.left;
    const oy = mr.top - rr.top;
    const popW = imgPopoverEl.offsetWidth || 304;
    let left = ox + pp.x + w / 2 + 10;
    left = Math.max(8, Math.min(left, rr.width - popW - 8));
    const top = Math.max(8, oy + pp.y - 10);
    imgPopoverEl.style.left = `${left}px`;
    imgPopoverEl.style.top = `${top}px`;
  }
  function toggleImgPopover(placementId: string): void {
    if (imgPopoverId === placementId) {
      closeImgPopover();
      return;
    }
    const p = placements.get(placementId);
    const img = p ? images.get(p.image_id) : undefined;
    if (!p || !img) return;
    closeImgPopover();
    imgPopoverId = placementId;
    const el = document.createElement("div");
    el.className = "img-popover";
    el.innerHTML = `
      <div class="img-popover-head">
        <input data-ip-cap value="${esc(img.caption)}" placeholder="${t("img.caption")}" title="${t("img.captionHint")}" />
        <button class="icon-btn" data-ip-close title="${t("lightbox.close")}">${icon("x", 14)}</button>
      </div>
      <div data-ip-body></div>`;
    root.appendChild(el);
    imgPopoverEl = el;
    el.querySelector<HTMLInputElement>("[data-ip-cap]")!.addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value;
      const curImg = images.get(img.id);
      if (curImg) curImg.caption = v;
      socket.send({ type: "image.modify", id: img.id, data: { caption: v, phase_id: curImg?.phase_id ?? null } });
      renderMapImages();
    });
    el.querySelector("[data-ip-close]")!.addEventListener("click", () => closeImgPopover());
    renderPlacementSettings(el.querySelector<HTMLElement>("[data-ip-body]")!, p, {
      isMB,
      phases,
      send: (m) => socket.send(m),
      getMapZoom: () => map.getZoom(),
      onChanged: () => {
        renderMapImages();
        imageRail?.refresh();
      },
      onDeleted: () => closeImgPopover(),
    });
    positionImgPopover();
  }
  // Hover: Name / Notiz / Ersteller / Phase des Kartenbilds (analog Marker-Hover).
  const imgHoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, anchor: "bottom" });
  const showImgHover = (p: ImagePlacement, i: PlanImage) => {
    const tip = document.createElement("div");
    tip.className = "mk-tip";
    const b = document.createElement("b");
    b.textContent = i.caption || i.filename;
    tip.append(b, document.createElement("br"));
    for (const [k, v] of [
      [t("marker.author"), i.author || "—"],
      [t("phase.assign"), phaseNameOf(p.phase_id)],
    ] as [string, string][]) {
      tip.append(`${k}: ${v}`, document.createElement("br"));
    }
    if (i.note) {
      const d = document.createElement("div");
      d.className = "mk-tip-info";
      d.textContent = i.note;
      tip.append(d);
    }
    // world_x/world_y ist die linke obere Ecke des Bilds (siehe positionImages) —
    // Popup horizontal auf die Bildmitte verschieben und über die obere Kante
    // zwingen (anchor "bottom"), sonst rutscht der Tipp bei großen Bildern nach
    // unten (maplibre würde sonst automatisch anchor "top" wählen).
    const w = p.map_width * imageScale(p);
    imgHoverPopup
      .setLngLat([p.world_x, p.world_y])
      .setOffset([w / 2, 0])
      .setDOMContent(tip)
      .addTo(map);
  };
  const hideImgHover = () => imgHoverPopup.remove();

  function renderMapImages(): void {
    if (ctx.imgResizingId) return;
    if (!imgRefFallback) imgRefFallback = map.getZoom();
    imagesEl.innerHTML = "";
    for (const p of placements.values()) {
      const i = images.get(p.image_id);
      if (!i) continue; // Bild noch nicht geladen/bereits gelöscht
      const op = phaseOpacityOf(p.phase_id);
      if (op <= 0.001) continue; // fremde/versteckte Phase
      const el = document.createElement("div");
      el.className = "pimg";
      el.dataset.pid = p.id;
      el.style.width = `${p.map_width}px`;
      el.style.opacity = String(op);
      const tip = i.caption || i.filename;
      el.innerHTML =
        `<img src="${esc(api.planImageUrl(planId, i.id))}" alt="${esc(tip)}" draggable="false" />` +
        (canEdit
          ? `<button class="pimg-gear" data-imggear title="${t("settings.title")}">${icon("settings", 12)}</button>` +
            `<button class="pimg-x" data-imgx title="${t("img.removeFromMap")}">${icon("x", 12)}</button>` +
            `<div class="pimg-rz"></div>`
          : "");
      el.addEventListener("mousedown", (ev) => onImageDown(ev, p.id));
      el.addEventListener("mouseenter", () => {
        const curP = placements.get(p.id);
        const curI = curP ? images.get(curP.image_id) : undefined;
        if (curP && curI) showImgHover(curP, curI);
      });
      el.addEventListener("mouseleave", hideImgHover);
      // Klick ohne vorherigen Drag/Resize -> groß anzeigen (Beschriftung als Notiz darunter).
      // Wird bei einer echten Verschiebung/Größenänderung von onImageDown unterdrückt.
      el.addEventListener("click", () => {
        if (imgClickSuppressed) {
          imgClickSuppressed = false;
          return;
        }
        openLightbox([
          {
            url: api.planImageUrl(planId, i.id),
            caption: i.caption || i.filename,
            note: i.note,
            onNoteSave: canEdit
              ? (v) => {
                  const cur = images.get(i.id);
                  if (cur) cur.note = v;
                  socket.send({ type: "image.modify", id: i.id, data: { note: v, phase_id: cur?.phase_id ?? null } });
                }
              : undefined,
          },
        ]);
      });
      el.querySelector("[data-imggear]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleImgPopover(p.id);
      });
      el.querySelector("[data-imgx]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        placements.delete(p.id);
        socket.send({ type: "placement.delete", id: p.id });
        renderMapImages();
        imageRail?.refresh();
      });
      imagesEl.appendChild(el);
    }
    positionImages();
  }
  function onImageDown(ev: MouseEvent, placementId: string): void {
    if (!canEdit || (ctx.mode !== "move" && ctx.mode !== "markermove")) return;
    const el0 = imagesEl.querySelector<HTMLElement>(`[data-pid="${placementId}"]`);
    const cur = placements.get(placementId);
    if (!el0 || !cur) return;
    const sc = imageScale(cur) || 1;
    const r = el0.getBoundingClientRect();
    if ((ev.clientX - r.left) / sc > el0.clientWidth - 20 && (ev.clientY - r.top) / sc > el0.clientHeight - 20) {
      ev.preventDefault();
      ctx.imgResizingId = placementId;
      const startW = cur.map_width;
      const startX = ev.clientX;
      const mv = (e: MouseEvent) => {
        cur.map_width = Math.max(60, Math.min(2000, startW + (e.clientX - startX) / sc));
        el0.style.width = `${cur.map_width}px`;
      };
      const up = () => {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        ctx.imgResizingId = null;
        imgClickSuppressed = true; // Ecke ziehen endet auf demselben Element -> sonst öffnet Klick die Lightbox
        setTimeout(() => (imgClickSuppressed = false), 0); // click folgt direkt auf mouseup; sonst bliebe das Flag hängen
        socket.send({
          type: "placement.modify", id: placementId,
          data: { map_width: Math.round(cur.map_width), phase_id: cur.phase_id },
        });
        renderMapImages();
      };
      document.addEventListener("mousemove", mv, { signal: sig });
      document.addEventListener("mouseup", up, { signal: sig });
      return;
    }
    ev.stopPropagation();
    ev.preventDefault();
    imgDragId = placementId;
    el0.classList.add("dragging");
    if (ctx.mode === "move") map.dragPan.disable();
    const canvasRect = () => map.getCanvas().getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    let moved = false;
    // Versatz zwischen Greifpunkt und dem Bild-Anker (oben links) merken, damit das
    // Bild beim Ziehen nicht unter den Cursor springt, sondern an der gegriffenen
    // Stelle "kleben" bleibt.
    const anchorPx0 = map.project([cur.world_x, cur.world_y]);
    const cr0 = canvasRect();
    const grabDx = ev.clientX - cr0.left - anchorPx0.x;
    const grabDy = ev.clientY - cr0.top - anchorPx0.y;
    const onMove = (e: MouseEvent) => {
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 4) moved = true;
      const cr = canvasRect();
      const ll = map.unproject([e.clientX - cr.left - grabDx, e.clientY - cr.top - grabDy]);
      cur.world_x = ll.lng;
      cur.world_y = ll.lat;
      positionImages();
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el0.classList.remove("dragging");
      if (ctx.mode === "move") map.dragPan.enable();
      imgDragId = null;
      if (!moved) return; // reiner Klick -> Lightbox öffnet über den click-Listener
      imgClickSuppressed = true;
      setTimeout(() => (imgClickSuppressed = false), 0);
      const cr = canvasRect();
      const ll = map.unproject([e.clientX - cr.left - grabDx, e.clientY - cr.top - grabDy]);
      socket.send({ type: "placement.move", id: placementId, data: { world_x: ll.lng, world_y: ll.lat } });
    };
    document.addEventListener("mousemove", onMove, { signal: sig });
    document.addEventListener("mouseup", onUp, { signal: sig });
  }
  map.on("move", () => {
    if (!imgDragId && !ctx.imgResizingId) positionImages();
  });
  phaseListeners.push(() => {
    closeImgPopover();
    renderMapImages();
  });
  document.addEventListener(
    "mousedown",
    (e) => {
      const t2 = e.target as HTMLElement;
      if (imgPopoverEl && !imgPopoverEl.contains(t2) && !t2.closest("[data-imggear]")) closeImgPopover();
    },
    { signal: sig },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && imgPopoverEl) closeImgPopover();
    },
    { signal: sig },
  );
  renderMapImages();

  // Drag&Drop aus der Bild-Sidebar auf die Karte -> neue Platzierung anlegen
  // (das Bild bleibt dabei unverändert, dasselbe Bild lässt sich so beliebig
  // oft/in mehreren Phasen platzieren).
  if (canEdit) {
    const mapContainer = map.getContainer();
    mapContainer.addEventListener("dragenter", (ev) => {
      if (ev.dataTransfer?.types.includes(IMAGE_DND_TYPE)) ev.preventDefault();
    });
    mapContainer.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes(IMAGE_DND_TYPE)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    });
    mapContainer.addEventListener("drop", (ev) => {
      const imageId = ev.dataTransfer?.getData(IMAGE_DND_TYPE);
      const cur = imageId ? images.get(imageId) : undefined;
      if (!cur) return;
      ev.preventDefault();
      const cr = map.getCanvas().getBoundingClientRect();
      const ll = map.unproject([ev.clientX - cr.left, ev.clientY - cr.top]);
      socket.send({
        type: "placement.create",
        data: {
          image_id: cur.id, phase_id: ctx.currentPhaseId || null,
          world_x: ll.lng, world_y: ll.lat, ref_zoom: map.getZoom(),
        },
      });
    });
  }

  imageRail = mountImageRail(root, {
    planId,
    images,
    placements,
    phases,
    isMB,
    canEdit,
    imageMaxMb: 10,
    getCurrentPhaseId: () => ctx.currentPhaseId,
    send: (m) => socket.send(m),
    map,
    onOpenLightbox: openLightbox,
  });
  phaseListeners.push(() => imageRail?.refresh());
  Object.assign(ctx.ui, {
    renderMapImages,
    positionImages,
    refreshImageRail: () => imageRail?.refresh(),
  });
}
