// Whiteboard mit Haftnotizen (Vorbild: KabelMaster BoardPage): farbig, am Kopf ziehen, Text direkt tippen,
// Farbe wechseln, löschen. Große scrollbare Fläche, Pointer-Events (Maus + Touch), Polling alle 5 s.
import { api, type NoteColor, type ProjectNote } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { confirmDialog, toastError } from "./notify";
import { type ProjCtx, dragWith, modalOpen, startPolling } from "./projectUtil";

const COLORS: NoteColor[] = ["yellow", "green", "blue", "pink", "orange", "gray"];
const AREA_W = 3200;
const AREA_H = 2200;
const MIN_W = 140;
const MIN_H = 100;

export function mountWhiteboard(host: HTMLElement, ctx: ProjCtx): void {
  let color: NoteColor = "yellow";
  try {
    const c = localStorage.getItem("sidc_proj_notecolor") as NoteColor | null;
    if (c && COLORS.includes(c)) color = c;
  } catch {
    /* ignore */
  }
  const notes = new Map<string, ProjectNote>();
  const els = new Map<string, HTMLElement>();
  const timers = new Map<string, number>();
  let busyDrag = false;
  let editing = 0; // Anzahl fokussierter Textfelder
  let offset = 0;

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
        <span class="muted wb-hint">${ctx.canEdit ? t("proj.wb.hint") : t("proj.wb.hintRo")}</span>
      </div>
      <div class="wb-scroll" id="wbScroll"><div class="wb-area" id="wbArea" style="width:${AREA_W}px;height:${AREA_H}px"></div></div>
    </div>`;
  const scroll = host.querySelector<HTMLElement>("#wbScroll")!;
  const area = host.querySelector<HTMLElement>("#wbArea")!;

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
            ? `<button class="icon-btn wb-col" title="${t("proj.wb.changeColor")}" aria-label="${t("proj.wb.changeColor")}">${icon("star", 14)}</button>
               <button class="icon-btn wb-del" title="${t("proj.wb.delete")}" aria-label="${t("proj.wb.delete")}">${icon("trash", 14)}</button>`
            : ""
        }
      </div>
      <textarea class="wb-text" maxlength="4000" placeholder="${t("proj.wb.textPh")}" aria-label="${t("proj.wb.text")}" ${ctx.canEdit ? "" : "readonly"}></textarea>
      ${ctx.canEdit ? `<span class="wb-resize" title="${t("proj.wb.resize")}"></span>` : ""}`;
    const ta = el.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = n.text;
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
    // Ziehen am Kopf
    const head = el.querySelector<HTMLElement>(".wb-head")!;
    head.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
      e.preventDefault();
      const dx = e.clientX - n.x;
      const dy = e.clientY - n.y;
      const sx = scroll.scrollLeft;
      const sy = scroll.scrollTop;
      busyDrag = true;
      el.classList.add("dragging");
      area.appendChild(el); // nach oben
      dragWith(
        head,
        e,
        (ev) => {
          // Scrollen während des Ziehens mitnehmen
          n.x = clamp(Math.round(ev.clientX - dx + (scroll.scrollLeft - sx)), 0, AREA_W - n.w);
          n.y = clamp(Math.round(ev.clientY - dy + (scroll.scrollTop - sy)), 0, AREA_H - n.h);
          place(el, n);
          const r = scroll.getBoundingClientRect();
          if (ev.clientX > r.right - 30) scroll.scrollLeft += 16;
          else if (ev.clientX < r.left + 30) scroll.scrollLeft -= 16;
          if (ev.clientY > r.bottom - 30) scroll.scrollTop += 16;
          else if (ev.clientY < r.top + 30) scroll.scrollTop -= 16;
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
      const w0 = n.w;
      const h0 = n.h;
      const x0 = e.clientX;
      const y0 = e.clientY;
      busyDrag = true;
      dragWith(
        rz,
        e,
        (ev) => {
          n.w = clamp(Math.round(w0 + ev.clientX - x0), MIN_W, Math.min(700, AREA_W - n.x));
          n.h = clamp(Math.round(h0 + ev.clientY - y0), MIN_H, Math.min(700, AREA_H - n.y));
          place(el, n);
        },
        async () => {
          await save(n, { w: n.w, h: n.h });
          busyDrag = false;
        },
      );
    });
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
        scroll.parentElement!.appendChild(e);
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
        els.set(s.id, el);
        place(el, s);
        area.appendChild(el);
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

  const load = async () => apply(await api.projectNotes(ctx.id));

  host.querySelector("#wbAdd")?.addEventListener("click", async () => {
    offset = (offset + 28) % 140;
    const w = 220;
    const h = 160;
    try {
      const n = await api.createProjectNote(ctx.id, {
        color,
        text: "",
        w,
        h,
        x: clamp(scroll.scrollLeft + 24 + offset, 0, AREA_W - w),
        y: clamp(scroll.scrollTop + 24 + offset, 0, AREA_H - h),
      });
      apply([...notes.values(), n]);
      els.get(n.id)?.querySelector("textarea")?.focus();
    } catch (e) {
      toastError(e);
    }
  });

  load().catch((e) => {
    scroll.insertAdjacentHTML("beforebegin", `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`);
  });
  startPolling(host, load, () => busyDrag || editing > 0 || timers.size > 0 || modalOpen());
}
