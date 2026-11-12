// Zeitstrahl / Phasen: Spieler- und Missionsbau-Spur, Ziehen/Dauer ändern, Ansicht (Spieler/Missionsbau/Zeus),
// Phase anlegen/löschen, H-Stunde (DTG-Feld), Deckkraft fremder Phasen und der Präsentationsmodus.
import { api } from "../api";
import { t } from "../i18n";
import { icon } from "../icons";
import { confirmDialog, promptDialog, toastError } from "../notify";
import type { ActAs, PhaseT, PlanCtx, Span } from "./ctx";
import { esc0, fmtInput, parseNaive } from "./geo";

export function initTimeline(ctx: PlanCtx): void {
  const { map, root, planId, snap, markers, annots, images, phases, phaseListeners, canEdit, isMB, canZeus, sig } = ctx;
  const { playerPhases, builderChildren, zeusChildren, zeusOpen, activePlayerId, isNotesPhase, hk } = ctx.model;
  const dtgInput = root.querySelector<HTMLInputElement>("#dtg")!;
  dtgInput.title = t("phase.hHour");
  {
    const raw = snap.plan.h_hour as string | null | undefined;
    if (raw) dtgInput.value = raw.slice(0, 16);
  }
  dtgInput.addEventListener("change", () => {
    opStart = dtgInput.value ? new Date(dtgInput.value) : defaultHHour();
    void api.patchPlan(planId, { h_hour: dtgInput.value || null }).catch((e) => toastError(e));
    renderTimeline();
    ctx.ui.repaintNotesTimes();
  });
  // ── Zeitstrahl / Phasen ───────────────────────────────────────────────
  const timelineEl = root.querySelector<HTMLDivElement>("#timeline")!;

  const DUR = 60; // Standard-Dauer je Phase (min)
  const defaultHHour = (): Date => {
    const raw = snap.plan.h_hour as string | null | undefined;
    if (raw) return parseNaive(raw);
    // Ohne H-Zeit: frühester expliziter Phasenbeginn (alte Missionen), sonst heute 08:00.
    const starts = phases.filter((p) => p.start_at).map((p) => parseNaive(p.start_at as string).getTime());
    if (starts.length) return new Date(Math.min(...starts));
    const d = new Date();
    d.setHours(8, 0, 0, 0);
    return d;
  };
  let opStart = defaultHHour();

  let tlPxPerMin = Number(localStorage.getItem(`sidc_tl_zoom_${planId}`)) || 3.5;
  if (!Number.isFinite(tlPxPerMin) || tlPxPerMin <= 0) tlPxPerMin = 3.5;
  const setZoom = (v: number, anchorMin?: number, anchorPx?: number) => {
    tlPxPerMin = Math.max(0.015, Math.min(24, v));
    try {
      localStorage.setItem(`sidc_tl_zoom_${planId}`, String(tlPxPerMin));
    } catch {
      /* ignore */
    }
    renderTimeline();
    const sc = timelineEl.querySelector<HTMLElement>(".tl-scroll");
    if (sc && anchorMin != null && anchorPx != null) {
      sc.scrollLeft = anchorMin * tlPxPerMin - anchorPx;
    }
  };

  const computeSpans = (): Map<string, Span> => {
    const out = new Map<string, Span>();
    const H = opStart.getTime();
    const mk = (p: PhaseT, fallbackStart: number): Span => {
      let s: number;
      let e: number;
      if (p.start_at) {
        s = parseNaive(p.start_at).getTime();
        e = p.end_at ? parseNaive(p.end_at).getTime() : s + DUR * 60000;
      } else {
        s = fallbackStart;
        e = p.end_at ? parseNaive(p.end_at).getTime() : s + DUR * 60000;
      }
      if (!(e > s)) e = s + 15 * 60000;
      return { s, e };
    };
    const players = phases
      .filter((p) => (p.plane ?? "player") === "player")
      .sort((a, b) => a.ordering - b.ordering);
    let cursor = H;
    for (const p of players) {
      const sp = mk(p, cursor);
      out.set(p.id, sp);
      cursor = sp.e;
    }
    const byParent = new Map<string, PhaseT[]>();
    for (const b of phases.filter((p) => p.plane === "builder")) {
      const k = b.parent_id ?? "";
      (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(b);
    }
    for (const [pid, subs] of byParent) {
      const parent = out.get(pid);
      subs.sort((a, b) => (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0));
      let bc = parent ? parent.s : H;
      for (const b of subs) {
        let sp: Span;
        if (!b.start_at && !b.end_at && subs.length === 1 && parent) sp = { ...parent };
        else sp = mk(b, bc);
        out.set(b.id, sp);
        bc = sp.e;
      }
    }
    return out;
  };
  const assignRows = (ids: string[], spans: Map<string, Span>): Map<string, number> => {
    const rowEnd: number[] = [];
    const rowOf = new Map<string, number>();
    for (const id of ids.slice().sort((a, b) => spans.get(a)!.s - spans.get(b)!.s)) {
      const sp = spans.get(id)!;
      let r = rowEnd.findIndex((end) => end <= sp.s);
      if (r === -1) {
        r = rowEnd.length;
        rowEnd.push(sp.e);
      } else rowEnd[r] = sp.e;
      rowOf.set(id, r);
    }
    return rowOf;
  };
  const TICKS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 20160, 40320];
  const tickMin = (): number => TICKS.find((m) => m * tlPxPerMin >= 68) ?? TICKS[TICKS.length - 1];
  const fmtTick = (d: Date, step: number): string => {
    const p = (n: number) => String(n).padStart(2, "0");
    if (step < 1440) {
      const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
      return d.getHours() === 0 && d.getMinutes() === 0 ? `${p(d.getDate())}.${p(d.getMonth() + 1)}.` : hm;
    }
    if (step < 10080) return `${p(d.getDate())}.${p(d.getMonth() + 1)}.`;
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.`;
  };
  // Phase per Server + lokal aktualisieren, dann neu zeichnen.
  const patchPhaseTimes = (id: string, s: number | null, e: number | null): void => {
    const p = phases.find((x) => x.id === id);
    if (!p) return;
    const oldS = p.start_at;
    const oldE = p.end_at;
    p.start_at = s == null ? null : fmtInput(new Date(s));
    p.end_at = e == null ? null : fmtInput(new Date(e));
    void api.patchPhase(planId, id, { start_at: p.start_at, end_at: p.end_at }).catch((err) => {
      // Rollback, sonst zeigt die UI Zeiten, die der Server nie bekommen hat
      p.start_at = oldS;
      p.end_at = oldE;
      renderTimeline();
      ctx.ui.repaintNotesTimes();
      toastError(err);
    });
    renderTimeline();
    ctx.ui.repaintNotesTimes();
  };
  function applyPhase(): void {
    renderTimeline();
    void ctx.ui.refreshMarkers();
    phaseListeners.forEach((f) => f());
    updatePresentBar();
  }
  function selectPhase(id: string): void {
    if (id === ctx.currentPhaseId || !phases.some((p) => p.id === id)) return;
    ctx.currentPhaseId = id;
    applyPhase();
  }
  function selectPlayerPhase(pid: string): void {
    ctx.currentPhaseId =
      ctx.actAs === "builder" ? builderChildren(pid)[0]?.id ?? pid : ctx.actAs === "zeus" ? zeusChildren(pid)[0]?.id ?? pid : pid;
    applyPhase();
  }
  function setActAs(next: ActAs): void {
    ctx.actAs = next;
    try {
      localStorage.setItem(`sidc_actas_${planId}`, next);
    } catch {
      /* ignore */
    }
    const pid = activePlayerId();
    ctx.currentPhaseId =
      next === "builder" ? builderChildren(pid)[0]?.id ?? pid : next === "zeus" ? zeusChildren(pid)[0]?.id ?? pid : pid;
    applyPhase();
  }

  // ── Präsentationsmodus (Vollbild, nur Karte + Phasen-Umschalter) ──────
  let presentBar: HTMLElement | null = null;
  function updatePresentBar(): void {
    if (!presentBar) return;
    const list = playerPhases();
    const idx = list.findIndex((p) => p.id === activePlayerId());
    presentBar.querySelector(".pb-name")!.textContent =
      `${list[idx]?.name ?? "—"}  (${idx + 1}/${list.length})`;
  }
  function stepPhase(dir: number): void {
    const list = playerPhases();
    const idx = list.findIndex((p) => p.id === activePlayerId());
    const next = list[(idx + dir + list.length) % list.length];
    if (next) selectPlayerPhase(next.id);
  }
  function exitPresent(): void {
    root.classList.remove("presenting");
    presentBar?.remove();
    presentBar = null;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    document.removeEventListener("keydown", onPresentKey);
    map.resize();
  }
  const onPresentKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") exitPresent();
    else if (e.key === "ArrowRight" || e.key === "PageDown") stepPhase(1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") stepPhase(-1);
  };
  // Plan verlassen, ohne den Präsentationsmodus zu beenden → Vollbild/Leiste aufräumen
  sig.addEventListener("abort", () => {
    if (presentBar) exitPresent();
  });
  function startPresent(): void {
    root.classList.add("presenting");
    presentBar = document.createElement("div");
    presentBar.className = "present-bar";
    presentBar.innerHTML =
      `<button class="icon-btn" data-pb="prev" title="${t("common.prev")}">${icon("back")}</button>` +
      `<span class="pb-name"></span>` +
      `<button class="icon-btn" data-pb="next" title="${t("common.next")}">${icon("chevron")}</button>` +
      `<button class="icon-btn" data-pb="exit" title="${t("present.exit")}">${icon("x")}</button>`;
    root.appendChild(presentBar);
    presentBar.querySelector('[data-pb="prev"]')!.addEventListener("click", () => stepPhase(-1));
    presentBar.querySelector('[data-pb="next"]')!.addEventListener("click", () => stepPhase(1));
    presentBar.querySelector('[data-pb="exit"]')!.addEventListener("click", exitPresent);
    document.addEventListener("keydown", onPresentKey, { signal: sig });
    document.documentElement.requestFullscreen?.().catch(() => {});
    updatePresentBar();
    setTimeout(() => map.resize(), 60);
  }

  function addLocalPhase(p: PhaseT): void {
    phases.push({ ...p, notes: p.notes ?? "", plane: p.plane ?? "player" });
    phases.sort((a, b) => a.ordering - b.ordering || (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0));
  }

  // Neue Spieler-Phase (Top-Level) anlegen — von Zeitstrahl-Leiste, Spieler-Lane-"+"
  // und Notiz-Fenster gemeinsam genutzt.
  async function addPlayerPhase(): Promise<void> {
    const name = await promptDialog(t("phase.namePrompt"), { value: `Phase ${playerPhases().length}` });
    if (!name) return;
    const p = await api.createPhase(planId, name);
    addLocalPhase(p as PhaseT);
    if (isMB) {
      // die server-seitig gepaarte Builder-Phase nachladen
      for (const ph of await api.planPhases(planId))
        if (!phases.some((x) => x.id === ph.id)) addLocalPhase(ph as PhaseT);
    }
    selectPlayerPhase(p.id);
  }

  // Neue Missionsbau-Zwischenphase unter parentId — von Zeitstrahl-Leiste (Builder-
  // Lane-"+") und Notiz-Fenster gemeinsam genutzt.
  async function addSubPhase(parentId: string): Promise<void> {
    if (!parentId) return;
    const name = await promptDialog(t("mb.subPhaseName"), {
      value: `${playerPhases().findIndex((p) => p.id === parentId) + 1}.${builderChildren(parentId).length}`,
    });
    if (!name) return;
    const p = await api.createPhase(planId, name, { plane: "builder", parent_id: parentId });
    addLocalPhase(p as PhaseT);
    selectPhase(p.id);
  }

  let tlFirstPaint = true;
  let tlKeepScroll = -1;
  function removePhaseLocal(delId: string): void {
    const gone = new Set([delId, ...phases.filter((p) => p.parent_id === delId).map((p) => p.id)]);
    for (let i = phases.length - 1; i >= 0; i--) if (gone.has(phases[i].id)) phases.splice(i, 1);
    for (const m of markers.values()) if (m.phase_id && gone.has(m.phase_id)) m.phase_id = null;
    for (const a of annots.values()) if (a.phase_id && gone.has(a.phase_id)) a.phase_id = null;
    for (const i of images.values()) if (i.phase_id && gone.has(i.phase_id)) i.phase_id = null;
    if (gone.has(ctx.currentPhaseId)) ctx.currentPhaseId = playerPhases()[0]?.id ?? "";
    applyPhase();
    ctx.ui.renderAnnots();
    ctx.ui.renderMapImages();
    ctx.ui.refreshImageRail();
  }
  function renderTimeline(): void {
    const apid = activePlayerId();
    const prevScroll = timelineEl.querySelector<HTMLElement>(".tl-scroll")?.scrollLeft ?? -1;
    const spans = computeSpans();
    const step = tickMin();
    const stepMs = step * 60000;
    // Zeitbereich (Domäne)
    // Nur Phasenbereich ±12 h (kein Auffüllen bis heute).
    let dom0 = Infinity;
    let dom1 = -Infinity;
    for (const sp of spans.values()) {
      dom0 = Math.min(dom0, sp.s);
      dom1 = Math.max(dom1, sp.e);
    }
    if (!Number.isFinite(dom0)) {
      dom0 = opStart.getTime();
      dom1 = dom0 + 4 * 3600e3;
    }
    const first = dom0;
    dom0 -= 12 * 3600e3;
    dom1 += 12 * 3600e3;
    const xOf = (t: number) => ((t - dom0) / 60000) * tlPxPerMin;
    const W = Math.max(200, xOf(dom1));

    const players = phases.filter((p) => (p.plane ?? "player") === "player").map((p) => p.id);
    // Missionsbau-Notizen sind ein Layer, keine Phase: nicht im Zeitstrahl
    const builders = phases
      .filter((p) => p.plane === "builder" && !isNotesPhase(p) && (ctx.actAs !== "zeus" || zeusOpen(p.id)))
      .map((p) => p.id);
    const rowP = assignRows(players, spans);
    const rowB = assignRows(builders, spans);
    const maxRow = (m: Map<string, number>) => Math.max(0, ...[...m.values()].map((r) => r + 1));
    const laneH = (n: number) => Math.max(30, n * 26 + 6);

    const ticks: string[] = [];
    for (let t = Math.ceil(dom0 / stepMs) * stepMs; t <= dom1; t += stepMs) {
      ticks.push(
        `<div class="tl-tick" style="left:${xOf(t)}px"><span>${fmtTick(new Date(t), step)}</span></div>`,
      );
    }
    const bar = (id: string, plane: "player" | "builder", row: number): string => {
      const sp = spans.get(id)!;
      const p = phases.find((x) => x.id === id)!;
      const explicit = !!(p.start_at || p.end_at);
      const fixedRole = isNotesPhase(p);
      const left = xOf(sp.s);
      const w = Math.max(26, xOf(sp.e) - left);
      const dur = Math.round((sp.e - sp.s) / 60000);
      const durTxt = dur >= 1440 ? `${(dur / 1440).toFixed(1)} d` : dur >= 60 ? `${(dur / 60).toFixed(dur % 60 ? 1 : 0)} h` : `${dur} min`;
      return (
        `<div class="tl-bar ${id === ctx.currentPhaseId ? "active" : ""} ${explicit ? "" : "tl-auto"} ${fixedRole ? "tl-notes" : ""}" ` +
        `data-pick="${id}" data-plane="${plane}" style="left:${left}px;width:${w}px;top:${row * 26}px" ` +
        `title="${esc0(p.name)} · ${fixedRole ? t("notes.layerHint") : durTxt}">` +
        (canEdit && (plane === "player" || isMB) && !fixedRole ? `<span class="tl-edge tl-edge-l" data-edge="l" data-id="${id}"></span>` : "") +
        (plane === "builder" && isMB && zeusOpen(id) ? `<span class="tl-zeus" title="${t("zeus.badge")}">Z</span>` : fixedRole && isMB ? `<span class="tl-zeus tl-zeus-off" title="${t("zeus.statusOff")}">Z</span>` : "") +
        (p.locked ? `<span class="tl-lock" title="${t("phase.lockedHint")}">${icon("lock", 10)}</span>` : "") +
        `<span class="tl-bar-name">${fixedRole ? "⚑ " : ""}${esc0(p.name)}</span>` +
        (canEdit && (plane === "player" || isMB) && !fixedRole
          ? `<span class="tl-edge tl-edge-r" data-edge="r" data-id="${id}"></span>` +
            (p.locked
              ? ""
              : `<button class="tl-del" data-del="${id}" title="${t("common.delete")}">${icon("x", 12)}</button>`)
          : "") +
        `</div>`
      );
    };

    // Handy: statt Zeitstrahl nur eine Phasen-Auswahl (Zeitstrahl per CSS ausgeblendet)
    const mobSel =
      `<select class="tl-mobsel" id="tl-mobsel" title="${t("phase.heading")}">` +
      [...players, ...builders]
        .map((id) => {
          const p = phases.find((x) => x.id === id)!;
          return `<option value="${id}" ${id === ctx.currentPhaseId ? "selected" : ""}>${p.plane === "builder" ? "⚑ " : ""}${esc0(p.name)}</option>`;
        })
        .join("") +
      `</select>`;
    const ctl =
      `<div class="tl-ctl">` +
      mobSel +
      `<button class="icon-btn" id="ph-notes" title="${t("notes.open") + hk("notes")}">${icon("notes", 16)}</button>` +
      `<span class="tl-zoom"><button id="tl-zout" title="${t("tl.zoomOut")}">${icon("minus", 14)}</button><button id="tl-zin" title="${t("tl.zoomIn")}">${icon("plus", 14)}</button></span>` +
      (isMB || canZeus
        ? `<span class="segmented mb-actas">` +
          `<button class="seg-btn ${ctx.actAs === "player" ? "active" : ""}" data-as="player">${t("mb.player")}</button>` +
          (isMB ? `<button class="seg-btn ${ctx.actAs === "builder" ? "active" : ""}" data-as="builder">${t("mb.builder")}</button>` : "") +
          (canZeus ? `<button class="seg-btn ${ctx.actAs === "zeus" ? "active" : ""}" data-as="zeus">${t("mb.zeus")}</button>` : "") +
          `</span>`
        : "") +
      (canEdit ? `<button id="ph-add" title="${t("phase.add")}">+ ${t("phase.heading")}</button>` : "") +
      `<label class="ph-op" title="${t("phase.outOpacityHint")}">${t("phase.outOpacity")}` +
      `<input type="range" id="ph-op" min="0" max="100" step="5" value="${ctx.outOpacity}"/><span id="ph-op-v">${ctx.outOpacity}%</span></label>` +
      (isMB
        ? `<label class="ph-op" title="${t("mb.crossOpacityHint")}">${t("mb.crossOpacity")}` +
          `<input type="range" id="cross-op" min="0" max="100" step="5" value="${ctx.crossOpacity}"/><span id="cross-op-v">${ctx.crossOpacity}%</span></label>`
        : "") +
      `</div>`;

    timelineEl.innerHTML =
      `<div class="tl">` +
      ctl +
      `<div class="tl-scroll"><div class="tl-canvas" style="width:${W}px">` +
      `<div class="tl-lane tl-player" style="height:${laneH(maxRow(rowP))}px">` +
      players.map((id) => bar(id, "player", rowP.get(id) ?? 0)).join("") +
      (canEdit ? `<button id="player-add" class="tl-subadd" title="${t("phase.add")}">+</button>` : "") +
      `</div>` +
      `<div class="tl-ruler">${ticks.join("")}</div>` +
      (isMB || ctx.actAs === "zeus"
        ? `<div class="tl-lane tl-builder" style="height:${laneH(maxRow(rowB))}px">` +
          builders.map((id) => bar(id, "builder", rowB.get(id) ?? 0)).join("") +
          (canEdit && isMB ? `<button id="sub-add" class="tl-subadd" title="${t("mb.subPhase")}">+</button>` : "") +
          `</div>`
        : "") +
      `</div></div></div>`;

    timelineEl.querySelector<HTMLSelectElement>("#tl-mobsel")!.addEventListener("change", (e) => selectPhase((e.target as HTMLSelectElement).value));
    const scEl = timelineEl.querySelector<HTMLElement>(".tl-scroll")!;
    if (tlFirstPaint) {
      scEl.scrollLeft = Math.max(0, xOf(first) - 48);
      tlFirstPaint = false;
    } else if (tlKeepScroll >= 0) {
      scEl.scrollLeft = tlKeepScroll;
    } else if (prevScroll >= 0) {
      scEl.scrollLeft = prevScroll;
    }
    tlKeepScroll = -1;

    scEl.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = scEl.getBoundingClientRect();
      const px = e.clientX - r.left + scEl.scrollLeft;
      setZoom(tlPxPerMin * (e.deltaY < 0 ? 1.18 : 1 / 1.18), px / tlPxPerMin, e.clientX - r.left);
    });
    timelineEl.querySelector("#tl-zin")?.addEventListener("click", () => setZoom(tlPxPerMin * 1.7));
    timelineEl.querySelector("#tl-zout")?.addEventListener("click", () => setZoom(tlPxPerMin / 1.7));

    timelineEl.querySelector("#ph-notes")?.addEventListener("click", () => ctx.ui.toggleNotesWin());
    timelineEl.querySelectorAll<HTMLButtonElement>("[data-as]").forEach((b) =>
      b.addEventListener("click", () => setActAs(b.dataset.as as ActAs)),
    );

    // Balken: klicken = wählen, ziehen = verschieben, Kanten = Dauer ändern
    const pickPhase = (id: string): void => {
      const p = phases.find((x) => x.id === id);
      if (!p) return;
      if (isMB && ctx.actAs !== "zeus") {
        const want = p.plane === "builder" ? "builder" : "player";
        if (ctx.actAs !== want) {
          ctx.actAs = want;
          try {
            localStorage.setItem(`sidc_actas_${planId}`, ctx.actAs);
          } catch {
            /* ignore */
          }
        }
      }
      ctx.currentPhaseId = id;
      applyPhase();
    };
    const snap15 = (min: number) => Math.round(min / 15) * 15;
    timelineEl.querySelectorAll<HTMLElement>(".tl-bar").forEach((el) => {
      const id = el.dataset.pick!;
      const startDrag = (ev: MouseEvent, edge: "" | "l" | "r") => {
        if (!canEdit || (el.dataset.plane === "builder" && !isMB) || isNotesPhase(phases.find((x) => x.id === id))) {
          if (!edge) pickPhase(id);
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const sp = { ...spans.get(id)! };
        const x0 = ev.clientX;
        const origLeft = parseFloat(el.style.left) || 0;
        const origW = parseFloat(el.style.width) || 26;
        let moved = false;
        const onMove = (e: MouseEvent) => {
          const dMin = snap15((e.clientX - x0) / tlPxPerMin);
          if (Math.abs(e.clientX - x0) > 3) moved = true;
          if (edge === "l") {
            el.style.left = `${origLeft + dMin * tlPxPerMin}px`;
            el.style.width = `${Math.max(15 * tlPxPerMin, origW - dMin * tlPxPerMin)}px`;
          } else if (edge === "r") {
            el.style.width = `${Math.max(15 * tlPxPerMin, origW + dMin * tlPxPerMin)}px`;
          } else {
            el.style.left = `${origLeft + dMin * tlPxPerMin}px`;
          }
        };
        const onUp = (e: MouseEvent) => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          const dMin = snap15((e.clientX - x0) / tlPxPerMin);
          if (!moved && !edge) {
            pickPhase(id);
            return;
          }
          tlKeepScroll = scEl.scrollLeft;
          if (edge === "l") patchPhaseTimes(id, Math.min(sp.s + dMin * 60000, sp.e - 15 * 60000), sp.e);
          else if (edge === "r") patchPhaseTimes(id, sp.s, Math.max(sp.e + dMin * 60000, sp.s + 15 * 60000));
          else patchPhaseTimes(id, sp.s + dMin * 60000, sp.e + dMin * 60000);
        };
        document.addEventListener("mousemove", onMove, { signal: sig });
        document.addEventListener("mouseup", onUp, { signal: sig });
      };
      el.querySelector('[data-edge="l"]')?.addEventListener("mousedown", (e) => startDrag(e as MouseEvent, "l"));
      el.querySelector('[data-edge="r"]')?.addEventListener("mousedown", (e) => startDrag(e as MouseEvent, "r"));
      el.addEventListener("mousedown", (e) => {
        if ((e.target as HTMLElement).closest(".tl-edge, .tl-del")) return;
        startDrag(e, "");
      });
      el.querySelector<HTMLButtonElement>(".tl-del")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog(t("phase.confirmDelete"), { danger: true, trash: true }))) return;
        await api.deletePhase(planId, id);
        removePhaseLocal(id);
      });
    });

    timelineEl.querySelector("#ph-add")?.addEventListener("click", () => void addPlayerPhase());
    timelineEl.querySelector("#player-add")?.addEventListener("click", () => void addPlayerPhase());
    timelineEl.querySelector("#sub-add")?.addEventListener("click", () => void addSubPhase(apid));

    const op = timelineEl.querySelector<HTMLInputElement>("#ph-op")!;
    const opv = timelineEl.querySelector<HTMLSpanElement>("#ph-op-v")!;
    op.addEventListener("input", () => {
      ctx.outOpacity = Number(op.value);
      opv.textContent = `${ctx.outOpacity}%`;
      localStorage.setItem("sidc_phaseopacity", String(ctx.outOpacity));
      void ctx.ui.refreshMarkers();
      ctx.ui.renderAnnots();
    });
    const cop = timelineEl.querySelector<HTMLInputElement>("#cross-op");
    if (cop) {
      const copv = timelineEl.querySelector<HTMLSpanElement>("#cross-op-v")!;
      cop.addEventListener("input", () => {
        ctx.crossOpacity = Number(cop.value);
        copv.textContent = `${ctx.crossOpacity}%`;
        localStorage.setItem("sidc_crossopacity", String(ctx.crossOpacity));
        void ctx.ui.refreshMarkers();
        ctx.ui.renderAnnots();
      });
    }
  }
  renderTimeline();
  // Doppelklick auf eine Phase öffnet das Phasen-Notizen-Fenster (die erste Klickhälfte hat die Phase gewählt)
  timelineEl.addEventListener("dblclick", (e) => {
    if (!(e.target as HTMLElement).closest(".tl-bar") || (e.target as HTMLElement).closest(".tl-edge, .tl-del")) return;
    if (document.querySelector(".notes-win")?.hasAttribute("hidden")) ctx.ui.toggleNotesWin();
  });
  Object.assign(ctx.ui, {
    renderTimeline,
    applyPhase,
    selectPhase,
    selectPlayerPhase,
    stepPhase,
    startPresent,
    addPlayerPhase,
    addSubPhase,
    patchPhaseTimes,
    computeSpans,
  });
}
