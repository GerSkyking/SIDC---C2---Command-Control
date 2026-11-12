// Annotationen: platzierbare Markdown-Textfelder und Stern-Pins auf der Karte (Anzeige, Ziehen,
// Größe ändern, Editor, Sichtbarkeit „Alle“ / „Nur Missionsbau“ inkl. Zeus-Freigabe).
import { t } from "../i18n";
import { icon } from "../icons";
import { renderMarkdown } from "../md";
import { attachMdToolbar } from "../mdtoolbar";
import { esc } from "../esc";
import { phaseMultiHtml, readPhaseMulti } from "../sidc/layerui";
import { cid } from "../ws";
import { api } from "../api";
import { toast, toastError } from "../notify";
import { STAR_SVG, ZEUS_DEFAULT_H, type Annot, type PlanCtx } from "./ctx";
import { fmtInput, parseUtc } from "./geo";

export function initAnnots(ctx: PlanCtx): void {
  const { map, socket, root, planId, annots, canEdit, caps, isMB, projectId, sig, phaseListeners } = ctx;
  const { annotZeusOpen, isNotesAnnot, annotOpacity, selectablePhases, samePlanePhases, wireNoteImageRefs, wireRefs } = ctx.model;
  // ── Annotationen (platzierbare Markdown-Textfelder) ───────────────────
  const annotsEl = root.querySelector<HTMLDivElement>("#annots")!;
  let annotDragId: string | null = null;
  const ANNOT_COLL_KEY = `sidc_annot_coll_${planId}`;
  const collapsedAnnots = new Set<string>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(ANNOT_COLL_KEY) || "[]");
      } catch {
        return [];
      }
    })(),
  );
  const saveCollapsed = () => {
    try {
      localStorage.setItem(ANNOT_COLL_KEY, JSON.stringify([...collapsedAnnots]));
    } catch {
      /* ignore */
    }
  };
  // Stern-Pin: die erste Zeile besteht nur aus Verknüpfungs-Codes (darunter optional eine Beschreibung).
  const REF_CODE_RE = /\{\{(?:(?:doc|task|plan|note|img):[0-9a-f]{32}|place:[^{}\n]+)\}\}/g;
  const splitStar = (s: string): { head: string; rest: string } | null => {
    const lines = s.split("\n");
    const i = lines.findIndex((l) => l.trim());
    if (i < 0) return null;
    const head = lines[i];
    if (!head.match(REF_CODE_RE) || head.replace(REF_CODE_RE, "").trim()) return null;
    return { head: head.trim(), rest: lines.slice(i + 1).join("\n").trim() };
  };
  const annotFirstLine = (s: string): string =>
    (s.split("\n").find((l) => l.trim()) ?? "").replace(/^#{1,6}\s+/, "").trim() || t("annot.placeholder");
  // Referenz-Zoom für Notizen ohne eigenen ref_zoom (Altbestand): der Zoom beim
  // ersten Zeichnen der Notizen — so skalieren sie ab jetzt mit der Karte mit.
  let annotRefFallback = 0;
  // scale_fixed === true  → Notiz skaliert MIT der Karte (zoomt mit)
  // scale_fixed === false → konstante Bildschirmgröße (Standard)
  const annotScale = (a: Annot): number => {
    if (!a.scale_fixed) return 1;
    const ref = a.ref_zoom && a.ref_zoom > 0 ? a.ref_zoom : annotRefFallback;
    if (!ref) return 1;
    return Math.max(0.3, Math.min(3, 2 ** (map.getZoom() - ref)));
  };

  function positionAnnots(): void {
    for (const el of Array.from(annotsEl.children) as HTMLElement[]) {
      const a = annots.get(el.dataset.aid ?? "");
      if (!a) continue;
      const p = map.project([a.world_x, a.world_y]);
      el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${annotScale(a)})`;
    }
  }

  // ── Sichtbarkeit einer Notiz/eines Stern-Pins ──
  // Projekt-Plan + Missionsbau: „Alle" (normale Notiz in einer Phase) oder „Nur Missionsbau" (Layer
  // Missionsbau-Notizen, optional für Zeus freigegeben). Alle anderen wählen wie gewohnt die Phase.
  function annotVisHtml(a: Pick<Annot, "phase_id" | "extra_phase_ids" | "zeus_released" | "zeus_until"> & { mb?: boolean }): string {
    const mb = a.mb ?? isNotesAnnot(a as Annot);
    const pid = mb ? ctx.currentPhaseId : a.phase_id ?? ctx.currentPhaseId;
    const zOpen = annotZeusOpen(a as Annot);
    const phaseBlock =
      `<div data-avphase ${mb && isMB && projectId ? "hidden" : ""}>` +
      `<label style="margin-top:.4rem">${t("phase.assign")}</label>` +
      `<select data-aphase title="${t("tip.draw.phase")}" aria-label="${t("phase.assign")}">${selectablePhases()
        .map(
          (ph) =>
            `<option value="${esc(ph.id)}" ${ph.id === pid ? "selected" : ""}>${ph.plane === "builder" ? "⚑ " : ""}${esc(ph.name)}</option>`,
        )
        .join("")}</select>` +
      `<label style="margin-top:.4rem">${t("phase.extra")}</label>` +
      `<div data-ax>${phaseMultiHtml("data-xphases", samePlanePhases(pid), mb ? [] : a.extra_phase_ids ?? [], pid)}</div>` +
      `</div>`;
    if (!(isMB && projectId)) return phaseBlock;
    return (
      `<label style="margin-top:.4rem">${t("annot.visibleFor")}</label>` +
      `<div class="segmented" data-avis role="group" aria-label="${t("annot.visibleFor")}">` +
      `<button type="button" class="seg-btn ${mb ? "" : "active"}" data-v="all" title="${t("tip.annot.visAll")}">${t("annot.visAll")}</button>` +
      `<button type="button" class="seg-btn vis-mb ${mb ? "active" : ""}" data-v="mb" title="${t("annot.visMbHint")}">${t("annot.visMb")}</button>` +
      `</div>` +
      `<div data-avmb ${mb ? "" : "hidden"}>` +
      `<p class="muted" style="margin:.3rem 0 0;font-size:.78rem">${t("annot.visMbHint")}</p>` +
      `<label style="margin-top:.4rem">${t("zeus.release")}</label>` +
      `<select data-azeus title="${t("tip.annot.zeus")}" aria-label="${t("zeus.release")}">` +
      `<option value="off" ${zOpen ? "" : "selected"}>${t("annot.zeusOff")}</option>` +
      `<option value="keep" ${zOpen ? "selected" : "hidden"}>${t("annot.zeusOn")}${
        a.zeus_until ? ` (${t("zeus.until")} ${fmtInput(new Date(parseUtc(a.zeus_until)))})` : ""
      }</option>` +
      `<option value="${ZEUS_DEFAULT_H}">${ZEUS_DEFAULT_H} h</option>` +
      `<option value="unl">${t("zeus.unlimited")}</option>` +
      `</select></div>` +
      phaseBlock
    );
  }
  function wireAnnotVis(host: HTMLElement): void {
    const asel = host.querySelector<HTMLSelectElement>("[data-aphase]");
    asel?.addEventListener("change", () => {
      host.querySelector<HTMLElement>("[data-ax]")!.innerHTML = phaseMultiHtml(
        "data-xphases", samePlanePhases(asel.value), readPhaseMulti(host, "data-xphases"), asel.value,
      );
    });
    host.querySelectorAll<HTMLButtonElement>("[data-avis] [data-v]").forEach((b) =>
      b.addEventListener("click", () => {
        const mb = b.dataset.v === "mb";
        host.querySelectorAll("[data-avis] [data-v]").forEach((x) => x.classList.toggle("active", x === b));
        host.querySelector<HTMLElement>("[data-avmb]")!.hidden = !mb;
        host.querySelector<HTMLElement>("[data-avphase]")!.hidden = mb;
      }),
    );
  }
  /** Felder für annotation.create/modify aus dem Sichtbarkeits-Block (``a`` = bisheriger Stand oder null). */
  function readAnnotVis(host: HTMLElement, a: Annot | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const visBtn = host.querySelector<HTMLElement>("[data-avis] .active");
    const mb = !!visBtn && visBtn.dataset.v === "mb";
    if (visBtn) out.mb_layer = mb;
    if (mb) {
      const z = host.querySelector<HTMLSelectElement>("[data-azeus]")?.value ?? "off";
      if (z !== "keep") {
        out.zeus_released = z !== "off";
        if (z !== "off" && z !== "unl") out.zeus_hours = Number(z);
      }
    } else {
      const ps = host.querySelector<HTMLSelectElement>("[data-aphase]");
      out.phase_id = ps?.value || ctx.currentPhaseId || null;
      out.extra_phase_ids = readPhaseMulti(host, "data-xphases");
      if (a && isNotesAnnot(a) && a.zeus_released) out.zeus_released = false;
    }
    return out;
  }

  const isStarText = (s: string): boolean => !!splitStar(s);
  /** Farbwahl für Sterne: Auswahlfeld + „Standard“-Knopf (leer = Standardfarbe nach Sichtbarkeit). */
  function starColorHtml(cur: string): string {
    return `<div data-starcolor class="row" style="margin-top:.4rem;gap:.4rem;align-items:center">
      <label style="margin:0">${t("star.color")}</label>
      <input type="color" data-scol value="${cur || "#ffc21a"}" data-set="${cur ? "1" : ""}" aria-label="${t("star.color")}" title="${t("tip.star.color")}" />
      <button type="button" data-scol-reset title="${t("tip.star.colorReset")}">${t("star.colorReset")}</button></div>`;
  }
  function wireStarColor(host: HTMLElement): void {
    const inp = host.querySelector<HTMLInputElement>("[data-scol]");
    if (!inp) return;
    inp.addEventListener("input", () => (inp.dataset.set = "1"));
    host.querySelector("[data-scol-reset]")?.addEventListener("click", () => {
      inp.dataset.set = "";
      inp.value = "#ffc21a";
    });
  }
  const readStarColor = (host: HTMLElement): string => {
    const inp = host.querySelector<HTMLInputElement>("[data-scol]");
    return inp && inp.dataset.set ? inp.value : "";
  };

  function openAnnotEditor(id: string, isNew = false): void {
    const a = annots.get(id);
    if (!a || !canEdit) return;
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.innerHTML = `<div class="card" style="width:min(34rem,96vw)">
      <div class="row"><h1 style="flex:1;margin:0">${t("annot.title")}</h1><button class="icon-btn" data-x title="${t("common.close")}">${icon("x")}</button></div>
      <textarea class="notes-edit annot-edit" rows="6" placeholder="${t("annot.hint")}"></textarea>
      ${isStarText(a.text) ? starColorHtml(a.color || "") : ""}
      ${annotVisHtml(a)}
      <label class="ph-op" style="margin-top:.4rem">${t("annot.width")}
        <input type="range" min="140" max="480" step="10" value="${a.width}" data-w /></label>
      <label class="chk" style="margin-top:.3rem"><input type="checkbox" data-fix ${a.scale_fixed ? "checked" : ""}/> <span>${t("annot.scaleWithMap")}</span></label>
      <p class="muted" style="margin:.2rem 0 0;font-size:.75rem">${t("annot.resizeHint")}</p>
      <div class="notes-view annot-prev"></div>
      <div class="row" style="margin-top:.6rem">
        <button class="primary" data-save style="flex:1">${t("common.save")}</button>
        <button class="danger" data-del>${icon("trash", 14)} ${t("common.delete")}</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    const ta = back.querySelector<HTMLTextAreaElement>(".annot-edit")!;
    attachMdToolbar(ta, { projectId: projectId ?? undefined, isBuilder: isMB });
    ta.value = a.text;
    const prev = back.querySelector<HTMLDivElement>(".annot-prev")!;
    const wIn = back.querySelector<HTMLInputElement>("[data-w]")!;
    const fixIn = back.querySelector<HTMLInputElement>("[data-fix]")!;
    wireAnnotVis(back);
    wireStarColor(back);
    const upd = () => {
      prev.innerHTML = renderMarkdown(ta.value);
      wireRefs(prev);
    };
    ta.addEventListener("input", upd);
    upd();
    setTimeout(() => ta.focus(), 0);
    const removeIfEmpty = () => {
      if (isNew && !ta.value.trim()) socket.send({ type: "annotation.delete", id });
    };
    const close = () => {
      removeIfEmpty();
      back.remove();
    };
    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.querySelector("[data-x]")!.addEventListener("click", close);
    back.querySelector("[data-save]")!.addEventListener("click", () => {
      const text = ta.value.trim();
      if (!text) {
        socket.send({ type: "annotation.delete", id }); // leere Notiz nicht speichern
        back.remove();
        return;
      }
      const wantScale = fixIn.checked; // true = mit der Karte mitskalieren
      const sc = annotScale(a);
      const data: Record<string, unknown> = {
        text: ta.value,
        // Wird das Mitskalieren abgeschaltet, aktuelle Bildschirmgröße einfrieren:
        width:
          !wantScale && a.scale_fixed
            ? Math.round(Number(wIn.value) * sc)
            : Number(wIn.value),
        height:
          !wantScale && a.scale_fixed && a.height ? Math.round(a.height * sc) : a.height ?? 0,
        scale_fixed: wantScale,
      };
      Object.assign(data, readAnnotVis(back, a));
      if (back.querySelector("[data-starcolor]")) data.color = readStarColor(back);
      if (wantScale && (!a.scale_fixed || !a.ref_zoom || a.ref_zoom <= 0))
        data.ref_zoom = map.getZoom(); // aktuelle Größe = natürliche Größe
      socket.send({ type: "annotation.modify", id, data });
      back.remove();
    });
    back.querySelector("[data-del]")!.addEventListener("click", () => {
      socket.send({ type: "annotation.delete", id });
      back.remove();
    });
  }

  function onAnnotDown(ev: MouseEvent, id: string): void {
    if (!canEdit || (ctx.mode !== "move" && ctx.mode !== "markermove")) return;
    if ((ev.target as HTMLElement).closest(".annot-tools, .ref-chip")) return; // Chip = Klick, kein Ziehen
    // Untere rechte Ecke = CSS-resize-Griff → Browser die Größenänderung machen
    // lassen und erst beim Loslassen synchronisieren (kein Neuaufbau währenddessen).
    const el0 = annotsEl.querySelector<HTMLElement>(`[data-aid="${id}"]`);
    if (el0) {
      const a0 = annots.get(id);
      const sc = a0 ? annotScale(a0) || 1 : 1;
      const r = el0.getBoundingClientRect();
      const lx = (ev.clientX - r.left) / sc;
      const ly = (ev.clientY - r.top) / sc;
      if (!el0.classList.contains("annot-star") && lx > el0.clientWidth - 22 && ly > el0.clientHeight - 22) {
        if (!canEdit) return;
        ctx.annotResizingId = id;
        const finish = () => {
          document.removeEventListener("mouseup", finish);
          if (ctx.annotResizingId !== id) return;
          ctx.annotResizingId = null;
          const cur = annots.get(id);
          if (cur) {
            const w = Math.round(el0.offsetWidth);
            const h = Math.round(el0.offsetHeight);
            if (Math.abs(w - cur.width) > 2 || Math.abs(h - (cur.height ?? 0)) > 2) {
              cur.width = w;
              cur.height = h;
              socket.send({
                type: "annotation.modify",
                id,
                data: { width: w, height: h, phase_id: cur.phase_id },
              });
            }
          }
          renderAnnots();
        };
        document.addEventListener("mouseup", finish, { signal: sig });
        return; // nativen Resize laufen lassen
      }
    }
    ev.stopPropagation();
    ev.preventDefault();
    annotDragId = id;
    const el = annotsEl.querySelector<HTMLElement>(`[data-aid="${id}"]`)!;
    el.classList.add("dragging");
    if (ctx.mode === "move") map.dragPan.disable();
    const canvasRect = () => map.getCanvas().getBoundingClientRect();
    // Versatz zwischen Greifpunkt und dem Notiz-Anker merken (siehe onImageDown).
    const a0 = annots.get(id);
    const anchorPx0 = a0 ? map.project([a0.world_x, a0.world_y]) : { x: 0, y: 0 };
    const cr0 = canvasRect();
    const grabDx = ev.clientX - cr0.left - anchorPx0.x;
    const grabDy = ev.clientY - cr0.top - anchorPx0.y;
    // Ein Bereich am Pin wandert beim Verschieben mit
    const area0 = a0?.area ? a0.area.pts.map((p) => [p[0], p[1]] as [number, number]) : null;
    const start0 = a0 ? [a0.world_x, a0.world_y] : [0, 0];
    const shiftArea = (a: Annot, lng: number, lat: number): void => {
      if (!area0 || !a.area) return;
      const dx = lng - start0[0];
      const dy = lat - start0[1];
      a.area = { ...a.area, pts: area0.map((p) => [p[0] + dx, p[1] + dy] as [number, number]) };
    };
    const onMove = (e: MouseEvent) => {
      const r = canvasRect();
      const ll = map.unproject([e.clientX - r.left - grabDx, e.clientY - r.top - grabDy]);
      const a = annots.get(id);
      if (a) {
        a.world_x = ll.lng;
        a.world_y = ll.lat;
        positionAnnots();
        if (area0) {
          shiftArea(a, ll.lng, ll.lat);
          ctx.ui.refreshAreas();
        }
      }
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      el.classList.remove("dragging");
      if (ctx.mode === "move") map.dragPan.enable();
      annotDragId = null;
      const r = canvasRect();
      const ll = map.unproject([e.clientX - r.left - grabDx, e.clientY - r.top - grabDy]);
      const a = annots.get(id);
      if (a && area0) shiftArea(a, ll.lng, ll.lat);
      socket.send({
        type: "annotation.move",
        id,
        data: { world_x: ll.lng, world_y: ll.lat, ...(a && area0 ? { area: a.area } : {}) },
      });
    };
    document.addEventListener("mousemove", onMove, { signal: sig });
    document.addEventListener("mouseup", onUp, { signal: sig });
  }
  /** Stern-Pin löschen: nur von der Karte oder zusätzlich das verknüpfte Projekt-Objekt (Dokument/Aufgabe/Notiz). */
  function deleteStarDialog(id: string, head: string): void {
    const targets = [...head.matchAll(/\{\{(doc|task|note):([0-9a-f]{32})\}\}/g)].map((m) => ({ kind: m[1], id: m[2] }));
    const canProject = !!projectId && targets.length > 0;
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    back.innerHTML = `<div class="card stack" style="width:min(26rem,94vw)">
      <h1 style="margin:0;font-size:1.05rem">${t("star.del.title")}</h1>
      <p class="muted" style="margin:0">${t(canProject ? "star.del.msg" : "star.del.msgMap")}</p>
      <div class="stack" style="gap:.4rem">
        <button class="danger" data-map>${icon("trash", 16)} ${t("star.del.mapOnly")}</button>
        ${canProject ? `<button class="danger" data-proj>${icon("trash", 16)} ${t("star.del.withProject")}</button>` : ""}
        <button data-c>${t("common.cancel")}</button>
      </div></div>`;
    document.body.appendChild(back);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    const close = (): void => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
    };
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.querySelector("[data-c]")!.addEventListener("click", close);
    back.querySelector("[data-map]")!.addEventListener("click", () => {
      close();
      socket.send({ type: "annotation.delete", id });
    });
    back.querySelector("[data-proj]")?.addEventListener("click", async () => {
      close();
      let failed = false;
      for (const tg of targets) {
        try {
          if (tg.kind === "doc") await api.deleteProjectDoc(projectId!, tg.id);
          else if (tg.kind === "task") await api.deleteProjectTask(projectId!, tg.id);
          else await api.deleteProjectNote(projectId!, tg.id);
        } catch (e) {
          failed = true;
          toastError(e);
        }
      }
      if (!failed) toast(t("star.del.done"), { kind: "success" });
      socket.send({ type: "annotation.delete", id });
    });
  }
  function renderAnnots(): void {
    if (ctx.annotResizingId) return; // Neuaufbau würde das laufende Ziehen abbrechen
    if (!annotRefFallback) annotRefFallback = map.getZoom();
    annotsEl.innerHTML = "";
    for (const a of annots.values()) {
      const collapsed = collapsedAnnots.has(a.id);
      const star = splitStar(a.text);
      const el = document.createElement("div");
      el.dataset.aid = a.id;
      el.style.opacity = String(annotOpacity(a));
      let body: string;
      if (star) {
        // Stern-Pin: auffälliges Symbol am Ort, daneben die verknüpften Ziele, Beschreibung beim Überfahren
        el.className = "annot annot-star" + (isNotesAnnot(a) ? " star-mb" : "") + (collapsed ? " annot-collapsed" : "");
        el.title = isNotesAnnot(a) ? t("star.mbHint") : "";
        if (a.color) {
          el.style.setProperty("--star", a.color);
          el.style.setProperty("--star-mb", a.color);
        }
        body =
          `<div class="star-pin">${STAR_SVG}</div>` +
          // Größe des Bereichs (Fläche bzw. Länge) klein unter dem Stern — Text setzt areas.ts (updateAreaSizes)
          `<div class="star-area-size" data-area-size="${esc(a.id)}" hidden></div>` +
          (collapsed ? "" : `<div class="annot-body">${renderMarkdown(star.head)}</div>`) +
          (star.rest && !collapsed ? `<div class="star-desc notes-view">${renderMarkdown(star.rest)}</div>` : "");
      } else {
        el.className = "annot" + (collapsed ? " annot-collapsed" : "");
        el.style.width = `${a.width}px`;
        if (a.height && !collapsed) el.style.height = `${a.height}px`;
        else el.style.height = "";
        body = collapsed
          ? `<div class="annot-body">${esc(annotFirstLine(a.text))}</div>`
          : `<div class="annot-body">${renderMarkdown(a.text || "")}</div>`;
      }
      el.innerHTML =
        body +
        `<div class="annot-tools">` +
        `<button class="icon-btn" data-acoll title="${t(collapsed ? "annot.expand" : "annot.collapse")}">${icon(collapsed ? "chevron" : "chevronDown", 14)}</button>` +
        (canEdit && isMB && projectId && isNotesAnnot(a)
          ? `<button class="icon-btn annot-zeus ${annotZeusOpen(a) ? "on" : ""}" data-azq title="${t(annotZeusOpen(a) ? "annot.zeusTipOn" : "annot.zeusTipOff")}">${icon("eye", 14)}</button>`
          : "") +
        (star && ctx.ui.canEditArea(a)
          ? `<button class="icon-btn" data-aarea title="${t(a.area ? "area.edit" : "area.draw")}">${icon("line", 14)}</button>`
          : "") +
        (canEdit
          ? `<button class="icon-btn" data-aedit title="${t("common.rename")}">${icon("edit", 14)}</button>` +
            `<button class="icon-btn" data-adel title="${t("common.delete")}">${icon("x", 14)}</button>`
          : "") +
        `</div>`;
      el.querySelector("[data-aarea]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (a.area) ctx.ui.setEditArea(a.id);
        else ctx.ui.startAreaDraw(a.id);
      });
      el.querySelector("[data-acoll]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        collapsed ? collapsedAnnots.delete(a.id) : collapsedAnnots.add(a.id);
        saveCollapsed();
        renderAnnots();
      });
      el.querySelector("[data-azq]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rel = !annotZeusOpen(a);
        socket.send({ type: "annotation.modify", id: a.id, data: rel ? { zeus_released: true, zeus_hours: ZEUS_DEFAULT_H } : { zeus_released: false } });
      });
      el.querySelector("[data-aedit]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openAnnotEditor(a.id);
      });
      el.querySelector("[data-adel]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (star) {
          void deleteStarDialog(a.id, star.head);
          return;
        }
        const tools = el.querySelector<HTMLElement>(".annot-tools")!;
        tools.innerHTML =
          `<label class="annot-delok" title="${t("tip.common.delConfirm")}"><input type="checkbox" data-adok/> ${t("common.delete")}</label>` +
          `<button class="icon-btn" data-adcancel title="${t("common.cancel")}">${icon("back", 12)}</button>`;
        tools.querySelector("[data-adok]")!.addEventListener("change", () =>
          socket.send({ type: "annotation.delete", id: a.id }),
        );
        tools.querySelector("[data-adcancel]")!.addEventListener("click", (e) => {
          e.stopPropagation();
          renderAnnots(); // Abbrechen → Werkzeuge wiederherstellen
        });
        el.addEventListener("mouseleave", () => renderAnnots(), { once: true });
      });
      el.addEventListener("mousedown", (ev) => onAnnotDown(ev, a.id));
      el.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        openAnnotEditor(a.id);
      });
      annotsEl.appendChild(el);
    }
    wireNoteImageRefs(annotsEl);
    wireRefs(annotsEl);
    positionAnnots();
    try {
      if (ctx.editAreaId && !annots.has(ctx.editAreaId)) ctx.ui.setEditArea(null);
      ctx.ui.refreshAreas();
    } catch {
      /* Bereichs-Teil noch nicht initialisiert (erster Aufbau) */
    }
  }

  map.on("move", () => {
    if (!annotDragId && !ctx.annotResizingId) positionAnnots();
    ctx.ui.positionLineDone();
  });
  map.on("zoomend", () => ctx.ui.refreshChains());
  phaseListeners.push(() => renderAnnots());
  phaseListeners.push(() => ctx.ui.redrawMeasure()); // Messlinien: Ebene (Missionsbau/Spieler)
  renderAnnots();
  function createAnnotAt(pos: [number, number]): void {
    const ac = cid();
    ctx.pendingAnnotCid = ac; // Antwort öffnet direkt den Editor
    socket.send({
      type: "annotation.create",
      cid: ac,
      data: {
        world_x: pos[0],
        world_y: pos[1],
        text: "",
        width: 220,
        phase_id: ctx.currentPhaseId || null,
        // Missionsbau in der Missionsbau-Ansicht: neue Notiz zuerst auf den Layer „Missionsbau-Notizen“ (im Editor änderbar)
        ...(projectId && isMB && ctx.actAs === "builder" ? { mb_layer: true } : {}),
        ref_zoom: map.getZoom(),
      },
    });
  }
  ctx.tools.text = {
    click: (e) => {
      if (!caps.place) return;
      createAnnotAt([e.lngLat.lng, e.lngLat.lat]);
      ctx.ui.setMode("move");
    },
  };
  Object.assign(ctx.ui, {
    renderAnnots,
    positionAnnots,
    openAnnotEditor,
    annotVisHtml,
    wireAnnotVis,
    readAnnotVis,
    createAnnotAt,
    starColorHtml,
    wireStarColor,
    readStarColor,
  });
}
