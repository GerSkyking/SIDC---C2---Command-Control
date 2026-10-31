// Whiteboard mit Haftnotizen (Vorbild: KabelMaster BoardPage). Die Fläche füllt den Bildschirm (die Seite scrollt nicht);
// Ansicht wird verschoben (Ziehen auf freier Fläche, Pfeiltasten, Pfeil-Knöpfe, Trackpad-Wischen) und gezoomt
// (Strg+Mausrad / Trackpad-Pinch, +/- Knöpfe). Pfeile verbinden Notizen; Notizen können Aufgabe und Nutzer verlinken.
// Pointer-Events (Maus + Touch), Polling alle 5 s.
import { api, type NoteColor, type NoteLink, type ProjectNote } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { confirmDialog, toastError } from "./notify";
import { type ProjCtx, dragWith, modalOpen, startPolling } from "./projectUtil";

const COLORS: NoteColor[] = ["yellow", "green", "blue", "pink", "orange", "gray"];
const MIN_W = 140;
const MIN_H = 100;
const MIN_Z = 0.2;
const MAX_Z = 2.5;
const COORD = 100000; // Server-Grenze für Notiz-Koordinaten

interface View {
  x: number;
  y: number;
  z: number;
}

export function mountWhiteboard(host: HTMLElement, ctx: ProjCtx): void {
  let color: NoteColor = "yellow";
  const viewKey = `sidc_wb_view:${ctx.id}`;
  const view: View = { x: 40, y: 40, z: 1 };
  try {
    const c = localStorage.getItem("sidc_proj_notecolor") as NoteColor | null;
    if (c && COLORS.includes(c)) color = c;
    const v = JSON.parse(localStorage.getItem(viewKey) || "null") as View | null;
    if (v && [v.x, v.y, v.z].every((n) => Number.isFinite(n))) Object.assign(view, { x: v.x, y: v.y, z: Math.min(MAX_Z, Math.max(MIN_Z, v.z)) });
  } catch {
    /* ignore */
  }
  const notes = new Map<string, ProjectNote>();
  const els = new Map<string, HTMLElement>();
  const timers = new Map<string, number>();
  let links = new Map<string, NoteLink>();
  let busyDrag = false;
  let editing = 0; // Anzahl fokussierter Textfelder
  let offset = 0;
  let selLink = "";

  host.innerHTML = `
    <div class="wb-wrap">
      <div class="wb-bar">
        ${
          ctx.canEdit
            ? `<button class="primary" id="wbAdd" title="${t("proj.wb.addHint")}">${icon("plus", 14)} ${t("proj.wb.add")}</button>
               <span class="wb-colors" role="radiogroup" aria-label="${t("proj.wb.color")}">${COLORS.map(
                 (c) => `<button type="button" class="wb-sw sticky-${c}" data-c="${c}" role="radio" aria-checked="${c === color}" title="${t("proj.wb.color")}: ${t("proj.color." + c)}" aria-label="${t("proj.color." + c)}"></button>`,
               ).join("")}</span>`
            : ""
        }
        <span class="wb-zoom" role="group" aria-label="${t("proj.wb.zoom")}">
          <button type="button" class="icon-btn" data-zoom="out" title="${t("proj.wb.zoomOut")}" aria-label="${t("proj.wb.zoomOut")}">${icon("minus", 16)}</button>
          <button type="button" class="wb-zoomval" data-zoom="reset" title="${t("proj.wb.zoomReset")}">100%</button>
          <button type="button" class="icon-btn" data-zoom="in" title="${t("proj.wb.zoomIn")}" aria-label="${t("proj.wb.zoomIn")}">${icon("plus", 16)}</button>
          <button type="button" data-zoom="fit" title="${t("proj.wb.fitHint")}">${t("proj.wb.fit")}</button>
        </span>
        <span class="wb-pan" role="group" aria-label="${t("proj.wb.pan")}">${(["up", "left", "right", "down"] as const)
          .map((d) => `<button type="button" class="icon-btn wb-pan-${d}" data-pan="${d}" title="${t("proj.wb.pan." + d)}" aria-label="${t("proj.wb.pan." + d)}">${icon("chevron", 16)}</button>`)
          .join("")}</span>
        <span class="muted wb-hint">${ctx.canEdit ? t("proj.wb.hint") : t("proj.wb.hintRo")}</span>
      </div>
      <div class="wb-view" id="wbView" tabindex="0" aria-label="${t("proj.tab.whiteboard")}">
        <div class="wb-world" id="wbWorld">
          <svg class="wb-links" id="wbLinks" width="1" height="1" aria-hidden="true">
            <g id="wbLinkG"></g>
            <line id="wbTmp" class="wb-tmp" x1="0" y1="0" x2="0" y2="0" visibility="hidden"></line>
          </svg>
        </div>
      </div>
    </div>`;
  const viewEl = host.querySelector<HTMLElement>("#wbView")!;
  const world = host.querySelector<HTMLElement>("#wbWorld")!;
  const linkG = host.querySelector<SVGGElement>("#wbLinkG")!;
  const tmp = host.querySelector<SVGLineElement>("#wbTmp")!;
  const zoomVal = host.querySelector<HTMLElement>(".wb-zoomval")!;

  // ─── Ansicht (Verschieben + Zoom) ──────────────────────────────────────
  let saveTimer = 0;
  const applyView = () => {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    const g = 24 * view.z;
    viewEl.style.backgroundSize = `${g}px ${g}px`;
    viewEl.style.backgroundPosition = `${view.x}px ${view.y}px`;
    zoomVal.textContent = `${Math.round(view.z * 100)}%`;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(viewKey, JSON.stringify(view));
      } catch {
        /* ignore */
      }
    }, 300);
  };
  const panBy = (dx: number, dy: number) => {
    view.x += dx;
    view.y += dy;
    applyView();
  };
  /** Zoom um einen Bildschirmpunkt (Standard: Mitte der Fläche), sodass dieser Punkt stehen bleibt. */
  const zoomTo = (nz: number, cx?: number, cy?: number) => {
    nz = Math.min(MAX_Z, Math.max(MIN_Z, nz));
    const r = viewEl.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - r.left;
    const py = (cy ?? r.top + r.height / 2) - r.top;
    const wx = (px - view.x) / view.z;
    const wy = (py - view.y) / view.z;
    view.z = nz;
    view.x = px - wx * nz;
    view.y = py - wy * nz;
    applyView();
  };
  const fitAll = () => {
    const r = viewEl.getBoundingClientRect();
    if (!notes.size) {
      Object.assign(view, { x: 40, y: 40, z: 1 });
      return applyView();
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of notes.values()) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w);
      y1 = Math.max(y1, n.y + n.h);
    }
    const pad = 40;
    const z = Math.min(1.2, Math.max(MIN_Z, Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0))));
    view.z = z;
    view.x = (r.width - (x1 - x0) * z) / 2 - x0 * z;
    view.y = (r.height - (y1 - y0) * z) / 2 - y0 * z;
    applyView();
  };
  applyView();

  host.querySelectorAll<HTMLElement>("[data-zoom]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.zoom;
      if (k === "in") zoomTo(view.z * 1.25);
      else if (k === "out") zoomTo(view.z / 1.25);
      else if (k === "reset") zoomTo(1);
      else fitAll();
    }),
  );

  // Pfeil-Knöpfe: Klick = ein Schritt, gedrückt halten = weiter
  host.querySelectorAll<HTMLElement>("[data-pan]").forEach((b) => {
    const dir = b.dataset.pan!;
    const step = () => {
      const s = Math.round(Math.min(viewEl.clientWidth, viewEl.clientHeight) * 0.25);
      panBy(dir === "left" ? s : dir === "right" ? -s : 0, dir === "up" ? s : dir === "down" ? -s : 0);
    };
    let rep = 0;
    let delay = 0;
    const stop = () => {
      window.clearTimeout(delay);
      window.clearInterval(rep);
    };
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      step();
      stop();
      delay = window.setTimeout(() => (rep = window.setInterval(step, 70)), 400);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"]) b.addEventListener(ev, stop);
    b.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        step();
      }
    });
  });

  // Ziehen auf freier Fläche verschiebt die Ansicht
  viewEl.addEventListener("pointerdown", (e) => {
    const tg = e.target as Element;
    if (e.button !== 0 || !(tg === viewEl || tg === world || tg.id === "wbLinks")) return;
    e.preventDefault();
    viewEl.focus({ preventScroll: true });
    if (selLink) {
      selLink = "";
      renderLinks();
    }
    const x0 = view.x - e.clientX;
    const y0 = view.y - e.clientY;
    viewEl.classList.add("panning");
    dragWith(
      viewEl,
      e,
      (ev) => {
        view.x = x0 + ev.clientX;
        view.y = y0 + ev.clientY;
        applyView();
      },
      () => viewEl.classList.remove("panning"),
    );
  });
  // Trackpad: Zwei-Finger-Wischen verschiebt, Pinch (= Strg+Wheel) und Strg+Mausrad zoomen. Die Seite selbst scrollt nie.
  viewEl.addEventListener(
    "wheel",
    (e) => {
      const ta = (e.target as Element).closest("textarea");
      if (ta && ta.scrollHeight > ta.clientHeight && !e.ctrlKey) return; // langer Notiztext darf selbst scrollen
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomTo(view.z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)), e.clientX, e.clientY);
      else if (e.shiftKey && !e.deltaX) panBy(-e.deltaY, 0);
      else panBy(-e.deltaX, -e.deltaY);
    },
    { passive: false },
  );
  // Pfeiltasten verschieben, +/- zoomen, 0 = 100 % (nicht beim Tippen)
  const onKey = (e: KeyboardEvent) => {
    if (!host.isConnected) {
      document.removeEventListener("keydown", onKey);
      return;
    }
    const tg = e.target as HTMLElement;
    if (tg.closest("input, textarea, select, [contenteditable]") || modalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    const s = (e.shiftKey ? 240 : 80) as number;
    if (e.key === "ArrowLeft") panBy(s, 0);
    else if (e.key === "ArrowRight") panBy(-s, 0);
    else if (e.key === "ArrowUp") panBy(0, s);
    else if (e.key === "ArrowDown") panBy(0, -s);
    else if (e.key === "+" || e.key === "=") zoomTo(view.z * 1.25);
    else if (e.key === "-") zoomTo(view.z / 1.25);
    else if (e.key === "0") zoomTo(1);
    else if (e.key === "Delete" && ctx.canEdit && selLink) void removeLink(selLink);
    else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  // ─── Farben ────────────────────────────────────────────────────────────
  const paintSwatches = () =>
    host.querySelectorAll<HTMLElement>(".wb-sw").forEach((b) => {
      b.classList.toggle("on", b.dataset.c === color);
      b.setAttribute("aria-checked", String(b.dataset.c === color));
    });
  paintSwatches();
  host.querySelectorAll<HTMLElement>(".wb-sw").forEach((b) =>
    b.addEventListener("click", () => {
      color = b.dataset.c as NoteColor;
      try {
        localStorage.setItem("sidc_proj_notecolor", color);
      } catch {
        /* ignore */
      }
      paintSwatches();
    }),
  );

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const place = (el: HTMLElement, n: ProjectNote) => {
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.style.width = `${n.w}px`;
    el.style.height = `${n.h}px`;
  };
  const save = (n: ProjectNote, patch: Partial<ProjectNote>) =>
    api.patchProjectNote(ctx.id, n.id, patch).catch((e) => {
      toastError(e);
    });
  /** Bildschirm-Koordinate → Welt-Koordinate */
  const toWorld = (cx: number, cy: number) => {
    const r = viewEl.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
  };

  // ─── Pfeile ────────────────────────────────────────────────────────────
  const SVG = "http://www.w3.org/2000/svg";
  /** Schnittpunkt der Linie Mitte→Ziel mit dem Rand des Rechtecks (+ kleiner Abstand) */
  const edge = (n: ProjectNote, tx: number, ty: number, gap = 4) => {
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    const k = Math.min(dx ? n.w / 2 / Math.abs(dx) : Infinity, dy ? n.h / 2 / Math.abs(dy) : Infinity);
    const len = Math.hypot(dx, dy) || 1;
    return { x: cx + dx * k + (dx / len) * gap, y: cy + dy * k + (dy / len) * gap, k };
  };
  const renderLinks = () => {
    linkG.replaceChildren();
    for (const l of links.values()) {
      const a = notes.get(l.from_id);
      const b = notes.get(l.to_id);
      if (!a || !b) continue;
      const s = edge(a, b.x + b.w / 2, b.y + b.h / 2);
      const e = edge(b, a.x + a.w / 2, a.y + a.h / 2, 5);
      if (s.k >= 1 || e.k >= 1) continue; // Notizen überlappen sich
      const ang = Math.atan2(e.y - s.y, e.x - s.x);
      const hl = 14;
      const hw = 6;
      const bx = e.x - Math.cos(ang) * hl;
      const by = e.y - Math.sin(ang) * hl;
      const mx = (s.x + e.x) / 2;
      const my = (s.y + e.y) / 2;
      const g = document.createElementNS(SVG, "g");
      g.setAttribute("class", "wb-link" + (selLink === l.id ? " sel" : ""));
      g.innerHTML =
        `<line class="wb-hit" x1="${s.x}" y1="${s.y}" x2="${e.x}" y2="${e.y}"></line>` +
        `<line class="wb-line" x1="${s.x}" y1="${s.y}" x2="${bx}" y2="${by}"></line>` +
        `<polygon class="wb-head-tri" points="${e.x},${e.y} ${bx - Math.sin(ang) * hw},${by + Math.cos(ang) * hw} ${bx + Math.sin(ang) * hw},${by - Math.cos(ang) * hw}"></polygon>` +
        (ctx.canEdit
          ? `<g class="wb-link-x" transform="translate(${mx} ${my})"><title>${esc(t("proj.wb.linkDelete"))}</title><circle r="11"></circle><path d="M-4 -4L4 4M4 -4L-4 4"></path></g>`
          : "");
      if (ctx.canEdit) {
        g.addEventListener("click", (ev) => {
          if ((ev.target as Element).closest(".wb-link-x")) {
            void removeLink(l.id);
            return;
          }
          selLink = selLink === l.id ? "" : l.id;
          renderLinks();
        });
      }
      linkG.appendChild(g);
    }
  };
  const removeLink = async (id: string) => {
    try {
      await api.deleteNoteLink(ctx.id, id);
      links.delete(id);
      if (selLink === id) selLink = "";
      renderLinks();
    } catch (e) {
      toastError(e);
    }
  };

  // ─── Aufgabe / Nutzer verlinken ────────────────────────────────────────
  /** Auswahl-Dialog; Rückgabe: Wert, "" = Verknüpfung entfernen, null = abgebrochen */
  const pickDialog = (title: string, options: { value: string; label: string }[], current: string): Promise<string | null> =>
    new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "edit-modal";
      back.innerHTML = `<div class="card stack" style="width:min(26rem,94vw)">
        <h1 style="margin:0;font-size:1.05rem"></h1>
        <select data-sel size="${Math.min(10, Math.max(4, options.length))}" style="width:100%">${options
          .map((o) => `<option value="${esc(o.value)}" ${o.value === current ? "selected" : ""}>${esc(o.label)}</option>`)
          .join("")}</select>
        ${options.length ? "" : `<p class="muted" style="margin:0">${t("proj.wb.pickEmpty")}</p>`}
        <div class="row" style="justify-content:flex-end;gap:.5rem">
          ${current ? `<button data-clear class="danger">${t("proj.wb.unlink")}</button><span class="grow"></span>` : ""}
          <button data-c>${t("common.cancel")}</button>
          <button class="primary" data-ok>${t("common.ok")}</button>
        </div></div>`;
      back.querySelector("h1")!.textContent = title;
      document.body.appendChild(back);
      const sel = back.querySelector<HTMLSelectElement>("[data-sel]")!;
      const done = (v: string | null) => {
        back.remove();
        resolve(v);
      };
      back.addEventListener("mousedown", (e) => e.target === back && done(null));
      back.querySelector("[data-c]")!.addEventListener("click", () => done(null));
      back.querySelector("[data-clear]")?.addEventListener("click", () => done(""));
      back.querySelector("[data-ok]")!.addEventListener("click", () => done(sel.value || null));
      sel.addEventListener("dblclick", () => sel.value && done(sel.value));
      back.addEventListener("keydown", (e) => {
        if (e.key === "Escape") done(null);
        else if (e.key === "Enter") {
          e.preventDefault();
          done(sel.value || null);
        }
      });
      setTimeout(() => sel.focus(), 0);
    });
  const statusLabel = (s: string) => t("proj.col." + s);
  const linkTask = async (n: ProjectNote) => {
    try {
      const tasks = await api.projectTasks(ctx.id);
      tasks.sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.title.localeCompare(b.title));
      const v = await pickDialog(
        t("proj.wb.linkTask"),
        tasks.map((x) => ({ value: x.id, label: `[${statusLabel(x.status)}] ${x.title}` })),
        n.task_id ?? "",
      );
      if (v === null) return;
      const u = await save(n, { task_id: v });
      if (u) applyRefs(n, u);
    } catch (e) {
      toastError(e);
    }
  };
  const linkUser = async (n: ProjectNote) => {
    try {
      const members = (await api.projectMembers(ctx.id)).filter((m) => m.subject_type === "user");
      const opts = members.map((m) => ({ value: m.subject_id, label: m.name || m.subject_id.slice(0, 8) }));
      if (n.user_id && !opts.some((o) => o.value === n.user_id)) opts.unshift({ value: n.user_id, label: n.user_label || n.user_id.slice(0, 8) });
      opts.sort((a, b) => a.label.localeCompare(b.label));
      const v = await pickDialog(t("proj.wb.linkUser"), opts, n.user_id ?? "");
      if (v === null) return;
      const u = await save(n, { user_id: v });
      if (u) applyRefs(n, u);
    } catch (e) {
      toastError(e);
    }
  };
  const applyRefs = (n: ProjectNote, s: Partial<ProjectNote>) => {
    n.task_id = s.task_id ?? null;
    n.task_title = s.task_title ?? null;
    n.user_id = s.user_id ?? null;
    n.user_label = s.user_label ?? null;
    paintRefs(n);
  };
  const paintRefs = (n: ProjectNote) => {
    const box = els.get(n.id)?.querySelector<HTMLElement>(".wb-refs");
    if (!box) return;
    box.innerHTML =
      (n.task_id
        ? `<a class="wb-chip wb-chip-task" href="#/projects/${ctx.id}/tasks" title="${esc(t("proj.wb.openTasks"))}">${icon("check", 12)}<span>${esc(n.task_title || t("proj.wb.taskGone"))}</span></a>`
        : "") +
      (n.user_id ? `<span class="wb-chip wb-chip-user" title="${esc(n.user_label || "")}">${icon("users", 12)}<span>${esc(n.user_label || "?")}</span></span>` : "");
    box.hidden = !box.innerHTML;
  };

  // ─── Notizen ───────────────────────────────────────────────────────────
  const build = (n: ProjectNote): HTMLElement => {
    const el = document.createElement("div");
    el.className = `wb-note sticky-${n.color}`;
    el.dataset.id = n.id;
    el.innerHTML = `
      <div class="wb-head" ${ctx.canEdit ? `title="${t("proj.wb.dragHint")}"` : ""}>
        <span class="wb-grip">${ctx.canEdit ? icon("drag", 14) : ""}</span>
        <span class="grow"></span>
        ${
          ctx.canEdit
            ? `<button class="icon-btn wb-ltask" title="${t("proj.wb.linkTask")}" aria-label="${t("proj.wb.linkTask")}">${icon("check", 14)}</button>
               <button class="icon-btn wb-luser" title="${t("proj.wb.linkUser")}" aria-label="${t("proj.wb.linkUser")}">${icon("users", 14)}</button>
               <button class="icon-btn wb-col" title="${t("proj.wb.changeColor")}" aria-label="${t("proj.wb.changeColor")}">${icon("star", 14)}</button>
               <button class="icon-btn wb-del" title="${t("proj.wb.delete")}" aria-label="${t("proj.wb.delete")}">${icon("trash", 14)}</button>`
            : ""
        }
      </div>
      <div class="wb-refs" hidden></div>
      <textarea class="wb-text" maxlength="4000" placeholder="${t("proj.wb.textPh")}" aria-label="${t("proj.wb.text")}" ${ctx.canEdit ? "" : "readonly"}></textarea>
      ${ctx.canEdit ? `<span class="wb-conn" title="${t("proj.wb.connect")}"></span><span class="wb-resize" title="${t("proj.wb.resize")}"></span>` : ""}`;
    const ta = el.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = n.text;
    els.set(n.id, el);
    paintRefs(n);
    if (!ctx.canEdit) return el;

    ta.addEventListener("focus", () => editing++);
    ta.addEventListener("blur", () => {
      editing = Math.max(0, editing - 1);
      flush(n);
    });
    ta.addEventListener("input", () => {
      n.text = ta.value;
      window.clearTimeout(timers.get(n.id));
      timers.set(n.id, window.setTimeout(() => flush(n), 700));
    });
    // Ziehen am Kopf (Bildschirm-Differenz / Zoom = Welt-Differenz)
    const head = el.querySelector<HTMLElement>(".wb-head")!;
    head.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
      e.preventDefault();
      const p0 = toWorld(e.clientX, e.clientY);
      const x0 = n.x;
      const y0 = n.y;
      busyDrag = true;
      el.classList.add("dragging");
      world.appendChild(el); // nach oben
      dragWith(
        head,
        e,
        (ev) => {
          const p = toWorld(ev.clientX, ev.clientY);
          n.x = clamp(Math.round(x0 + p.x - p0.x), -COORD, COORD);
          n.y = clamp(Math.round(y0 + p.y - p0.y), -COORD, COORD);
          place(el, n);
          renderLinks();
        },
        async () => {
          el.classList.remove("dragging");
          await save(n, { x: n.x, y: n.y });
          busyDrag = false;
        },
      );
    });
    // Größe ändern
    const rz = el.querySelector<HTMLElement>(".wb-resize")!;
    rz.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const p0 = toWorld(e.clientX, e.clientY);
      const w0 = n.w;
      const h0 = n.h;
      busyDrag = true;
      dragWith(
        rz,
        e,
        (ev) => {
          const p = toWorld(ev.clientX, ev.clientY);
          n.w = clamp(Math.round(w0 + p.x - p0.x), MIN_W, 700);
          n.h = clamp(Math.round(h0 + p.y - p0.y), MIN_H, 700);
          place(el, n);
          renderLinks();
        },
        async () => {
          await save(n, { w: n.w, h: n.h });
          busyDrag = false;
        },
      );
    });
    // Pfeil ziehen: vom Punkt am rechten Rand auf eine andere Notiz
    const conn = el.querySelector<HTMLElement>(".wb-conn")!;
    conn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      busyDrag = true;
      const sx = n.x + n.w / 2;
      const sy = n.y + n.h / 2;
      let hover: Element | null = null;
      tmp.setAttribute("x1", String(sx));
      tmp.setAttribute("y1", String(sy));
      tmp.setAttribute("x2", String(sx));
      tmp.setAttribute("y2", String(sy));
      tmp.setAttribute("visibility", "visible");
      const target = (ev: PointerEvent): HTMLElement | null => {
        const x = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".wb-note");
        return x && x.dataset.id !== n.id ? x : null;
      };
      dragWith(
        conn,
        e,
        (ev) => {
          const p = toWorld(ev.clientX, ev.clientY);
          tmp.setAttribute("x2", String(p.x));
          tmp.setAttribute("y2", String(p.y));
          const tg = target(ev);
          if (tg !== hover) {
            hover?.classList.remove("wb-target");
            hover = tg;
            hover?.classList.add("wb-target");
          }
        },
        async (ev) => {
          const tg = target(ev);
          hover?.classList.remove("wb-target");
          tmp.setAttribute("visibility", "hidden");
          if (tg) {
            try {
              const l = await api.createNoteLink(ctx.id, n.id, tg.dataset.id!);
              links.set(l.id, l);
              renderLinks();
            } catch (err) {
              toastError(err);
            }
          }
          busyDrag = false;
        },
      );
    });
    el.querySelector(".wb-ltask")!.addEventListener("click", () => void linkTask(n));
    el.querySelector(".wb-luser")!.addEventListener("click", () => void linkUser(n));
    el.querySelector(".wb-col")!.addEventListener("click", () => {
      n.color = COLORS[(COLORS.indexOf(n.color) + 1) % COLORS.length];
      el.className = `wb-note sticky-${n.color}`;
      void save(n, { color: n.color });
    });
    el.querySelector(".wb-del")!.addEventListener("click", async () => {
      if (n.text.trim() && !(await confirmDialog(t("proj.wb.deleteConfirm"), { danger: true, trash: true }))) return;
      try {
        await api.deleteProjectNote(ctx.id, n.id);
        window.clearTimeout(timers.get(n.id));
        notes.delete(n.id);
        els.delete(n.id);
        el.remove();
        for (const [id, l] of links) if (l.from_id === n.id || l.to_id === n.id) links.delete(id);
        renderLinks();
        syncEmpty();
      } catch (e) {
        toastError(e);
      }
    });
    return el;
  };

  const flush = (n: ProjectNote) => {
    if (!timers.has(n.id)) return;
    window.clearTimeout(timers.get(n.id));
    timers.delete(n.id);
    void save(n, { text: n.text });
  };

  const syncEmpty = () => {
    let e = host.querySelector<HTMLElement>(".wb-empty");
    if (!notes.size) {
      if (!e) {
        e = document.createElement("div");
        e.className = "wb-empty";
        e.innerHTML = `${icon("textbox", 32)}<h3>${t("proj.wb.empty")}</h3><p class="muted">${ctx.canEdit ? t("proj.wb.emptyHint") : t("proj.wb.emptyHintRo")}</p>`;
        viewEl.appendChild(e);
      }
    } else e?.remove();
  };

  /** Server-Stand einarbeiten, ohne aktiv bearbeitete/gezogene Notizen zu überschreiben. */
  const apply = (list: ProjectNote[]) => {
    const seen = new Set<string>();
    for (const s of list) {
      seen.add(s.id);
      const cur = notes.get(s.id);
      if (!cur) {
        notes.set(s.id, s);
        const el = build(s);
        place(el, s);
        world.appendChild(el);
        continue;
      }
      const el = els.get(s.id)!;
      const ta = el.querySelector("textarea")!;
      const typing = document.activeElement === ta || timers.has(s.id);
      if (!typing && cur.text !== s.text) {
        cur.text = s.text;
        ta.value = s.text;
      }
      if (!el.classList.contains("dragging")) {
        Object.assign(cur, { x: s.x, y: s.y, w: s.w, h: s.h });
        place(el, cur);
      }
      if (cur.color !== s.color) {
        cur.color = s.color;
        el.className = `wb-note sticky-${s.color}`;
      }
      if (cur.task_id !== s.task_id || cur.user_id !== s.user_id || cur.task_title !== s.task_title || cur.user_label !== s.user_label) {
        applyRefs(cur, s);
      }
    }
    for (const id of [...notes.keys()]) {
      if (!seen.has(id) && !timers.has(id)) {
        notes.delete(id);
        els.get(id)?.remove();
        els.delete(id);
      }
    }
    syncEmpty();
  };

  const load = async () => {
    const [list, lk] = await Promise.all([api.projectNotes(ctx.id), api.noteLinks(ctx.id)]);
    apply(list);
    links = new Map(lk.map((l) => [l.id, l]));
    if (!links.has(selLink)) selLink = "";
    renderLinks();
  };

  host.querySelector("#wbAdd")?.addEventListener("click", async () => {
    offset = (offset + 28) % 140;
    const w = 220;
    const h = 160;
    const c = toWorld(
      viewEl.getBoundingClientRect().left + viewEl.clientWidth / 2,
      viewEl.getBoundingClientRect().top + viewEl.clientHeight / 2,
    );
    try {
      const n = await api.createProjectNote(ctx.id, {
        color,
        text: "",
        w,
        h,
        x: Math.round(c.x - w / 2 + offset),
        y: Math.round(c.y - h / 2 + offset),
      });
      apply([...notes.values(), n]);
      renderLinks();
      els.get(n.id)?.querySelector("textarea")?.focus();
    } catch (e) {
      toastError(e);
    }
  });

  load().catch((e) => {
    viewEl.insertAdjacentHTML("beforebegin", `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`);
  });
  startPolling(host, load, () => busyDrag || editing > 0 || timers.size > 0 || modalOpen());
}
