// Phasen-Notizen: frei verschiebbares Fenster mit Reiter je Phase (Markdown, Bilder, Zeiten,
// Missionsbau-Freigaben für Spieler/Zeus).
import { api } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { renderMarkdown } from "../md";
import { attachMdToolbar } from "../mdtoolbar";
import { toastError } from "../notify";
import { ZEUS_DEFAULT_H, type PlanCtx } from "./ctx";
import { esc0, fmtInput, parseNaive, parseUtc } from "./geo";

export function initPhaseNotes(ctx: PlanCtx): void {
  const { root, planId, phases, phaseListeners, canEdit, isMB, projectId, sig } = ctx;
  const { isNotesPhase, activePlayerId, pickPlanImage, wireNoteImageRefs, wireRefs } = ctx.model;
  // ── Phasen-Notizen: frei verschiebbares Fenster mit Reiter je Phase ────
  const notesWin = document.createElement("div");
  notesWin.className = "notes-win";
  notesWin.hidden = true;
  notesWin.innerHTML = `
    <div class="notes-head"><span>${t("notes.title")}</span><span class="grow"></span>
      ${canEdit ? `<button class="notes-img icon-btn" title="${t("notes.insertImage")}">${icon("image", 16)}</button>` : ""}
      <button class="notes-x icon-btn" title="${t("common.close")}">${icon("x", 16)}</button></div>
    <div class="notes-tabs"></div>
    <div class="notes-times"></div>
    <div class="notes-split">
      <textarea class="notes-edit" placeholder="${t("notes.hint")}" ${canEdit ? "" : "readonly"}></textarea>
      <div class="notes-view"></div>
    </div>`;
  root.appendChild(notesWin);
  const placeNotesWin = () => {
    let pos = { x: window.innerWidth - 380, y: 96 };
    try {
      const raw = localStorage.getItem("sidc_noteswin");
      if (raw) pos = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    // Immer sichtbar halten, auch wenn die gespeicherte Position von einem
    // größeren Fenster stammt.
    const x = Math.max(0, Math.min(pos.x, window.innerWidth - 120));
    const y = Math.max(0, Math.min(pos.y, window.innerHeight - 80));
    notesWin.style.left = `${x}px`;
    notesWin.style.top = `${y}px`;
  };
  placeNotesWin();
  const nTabs = notesWin.querySelector<HTMLDivElement>(".notes-tabs")!;
  const nTimes = notesWin.querySelector<HTMLDivElement>(".notes-times")!;
  const nEdit = notesWin.querySelector<HTMLTextAreaElement>(".notes-edit")!;
  if (canEdit) attachMdToolbar(nEdit, { projectId: projectId ?? undefined, isBuilder: isMB });
  const nView = notesWin.querySelector<HTMLDivElement>(".notes-view")!;
  let notesTabId = ctx.currentPhaseId;
  const saveTimers = new Map<string, number>();

  const renderNotesTimes = () => {
    const ph = phases.find((p) => p.id === notesTabId);
    if (!ph) {
      nTimes.innerHTML = "";
      return;
    }
    const sp = ctx.ui.computeSpans().get(ph.id);
    const val = (raw: string | null | undefined, fb?: number) =>
      raw ? fmtInput(parseNaive(raw)) : fb != null ? fmtInput(new Date(fb)) : "";
    nTimes.innerHTML =
      `<label class="nt-name">${t("common.name")}<input data-nname ${canEdit && !isNotesPhase(ph) ? "" : "disabled"} value="${esc0(ph.name)}"/></label>` +
      `<label>${t("phase.start")}<input type="datetime-local" data-nstart ${canEdit && !isNotesPhase(ph) ? "" : "disabled"} value="${val(ph.start_at, sp?.s)}"/></label>` +
      `<label>${t("phase.end")}<input type="datetime-local" data-nend ${canEdit && !isNotesPhase(ph) ? "" : "disabled"} value="${val(ph.end_at, sp?.e)}"/></label>` +
      (ph.start_at || ph.end_at
        ? `<button data-ntclear title="${t("common.reset")}">${icon("x", 12)}</button>`
        : `<span class="muted">(auto)</span>`) +
      (isNotesPhase(ph)
        ? `<span class="nt-notes-info">⚑ ${t("notes.layerHint")}</span>` +
          (isMB ? `<span class="nt-zbadge" role="status">${t("notes.perPin")}</span>` : "")
        : "") +
      (isMB && canEdit && ph.plane === "builder" && !isNotesPhase(ph)
        ? `<span class="nt-zeus"><label class="chk"><input type="checkbox" data-prel ${ph.player_released ? "checked" : ""}/> ${t("phase.playerRelease")}</label>` +
          `<label class="chk"><input type="checkbox" data-zrel ${ph.zeus_released ? "checked" : ""}/> ${t("zeus.release")}</label>` +
          `<label>${t("zeus.hours")}<input type="number" min="0" step="1" data-zhours style="width:4.5rem" value="${
            ph.zeus_released && ph.zeus_until
              ? Math.max(1, Math.round((parseUtc(ph.zeus_until) - Date.now()) / 3600e3))
              : ph.zeus_released
                ? ""
                : String(ZEUS_DEFAULT_H)
          }" placeholder="${t("zeus.unlimited")}" title="${t("zeus.hoursHint")}"/></label>` +
          `<button type="button" class="zq" data-zq="${ZEUS_DEFAULT_H}">${ZEUS_DEFAULT_H} h</button>` +
          `<button type="button" class="zq" data-zq="">${t("zeus.unlimited")}</button>` +
          (ph.zeus_released && ph.zeus_until
            ? `<span class="muted">${t("zeus.until")} ${fmtInput(new Date(parseUtc(ph.zeus_until)))}</span>`
            : "") +
          `</span>`
        : "");
    if (!canEdit) return;
    const sendZeus = async () => {
      const rel = nTimes.querySelector<HTMLInputElement>("[data-zrel]")!.checked;
      const hv = nTimes.querySelector<HTMLInputElement>("[data-zhours]")!.value.trim();
      try {
        const upd = await api.patchPhase(planId, ph.id, { zeus_released: rel, zeus_hours: hv === "" ? null : Number(hv) });
        ph.zeus_released = upd.zeus_released;
        ph.zeus_until = upd.zeus_until;
      } catch (e) {
        toastError(e);
      }
      ctx.ui.renderTimeline();
      renderNotesTimes();
    };
    nTimes.querySelector("[data-prel]")?.addEventListener("change", async (e) => {
      try {
        const upd = await api.patchPhase(planId, ph.id, { player_released: (e.target as HTMLInputElement).checked });
        ph.player_released = upd.player_released;
      } catch (err) {
        toastError(err);
      }
      renderNotesTimes();
      ctx.ui.applyPhase();
    });
    nTimes.querySelector("[data-zrel]")?.addEventListener("change", () => void sendZeus());
    // Schnellknöpfe: Freigabe sofort setzen (leer = unbegrenzt)
    nTimes.querySelectorAll<HTMLButtonElement>("[data-zq]").forEach((b) =>
      b.addEventListener("click", async () => {
        const h = b.dataset.zq ? Number(b.dataset.zq) : null;
        try {
          const upd = await api.patchPhase(planId, ph.id, { zeus_released: true, zeus_hours: h });
          ph.zeus_released = upd.zeus_released;
          ph.zeus_until = upd.zeus_until;
        } catch (e) {
          toastError(e);
        }
        ctx.ui.renderTimeline();
        renderNotesTimes();
      }),
    );
    nTimes.querySelector("[data-zhours]")?.addEventListener("change", () => {
      if (nTimes.querySelector<HTMLInputElement>("[data-zrel]")!.checked) void sendZeus();
    });
    const get = (s: string) => {
      const v = nTimes.querySelector<HTMLInputElement>(s)!.value;
      return v ? parseNaive(v).getTime() : null;
    };
    const commit = () => ctx.ui.patchPhaseTimes(ph.id, get("[data-nstart]"), get("[data-nend]"));
    nTimes.querySelector("[data-nstart]")?.addEventListener("change", commit);
    nTimes.querySelector("[data-nend]")?.addEventListener("change", commit);
    nTimes.querySelector("[data-ntclear]")?.addEventListener("click", () => ctx.ui.patchPhaseTimes(ph.id, null, null));
    nTimes.querySelector<HTMLInputElement>("[data-nname]")?.addEventListener("change", (e) => {
      const nm = (e.target as HTMLInputElement).value.trim();
      if (!nm || nm === ph.name) return;
      ph.name = nm;
      // gepaarte Builder-/Spieler-Phase gleich mit umbenennen (Altverhalten)
      void api.renamePhase(planId, ph.id, nm).catch((err) => toastError(err));
      ctx.ui.renderTimeline();
      paintNotes();
    });
  };
  ctx.ui.repaintNotesTimes = () => {
    if (!notesWin.hidden) renderNotesTimes();
  };

  const flushNotes = () => {
    const ph = phases.find((p) => p.id === notesTabId);
    if (!ph || !canEdit) return;
    if (ph.notes === nEdit.value) return;
    ph.notes = nEdit.value;
    // Timer je Phase: schneller Phasenwechsel darf die ausstehende Speicherung der vorigen nicht verwerfen
    window.clearTimeout(saveTimers.get(ph.id));
    saveTimers.set(
      ph.id,
      window.setTimeout(() => {
        saveTimers.delete(ph.id);
        void api.updatePhaseNotes(planId, ph.id, ph.notes).catch((err) => toastError(err));
      }, 600),
    );
  };
  const paintNotes = () => {
    const ph = phases.find((p) => p.id === notesTabId) ?? phases[0];
    if (!ph) return;
    notesTabId = ph.id;
    const tabBtn = (p: (typeof phases)[number]) =>
      `<button data-nt="${p.id}" class="${p.id === notesTabId ? "active" : ""}">${isNotesPhase(p) ? "⚑ " : ""}${esc(p.name)}</button>`;
    const playerP = phases.filter((p) => (p.plane ?? "player") !== "builder");
    const builderP = phases.filter((p) => (p.plane ?? "player") === "builder" && !isNotesPhase(p));
    const addBtn = (attr: string, title: string) =>
      canEdit ? `<button class="notes-tab-add" ${attr} title="${title}">${icon("plus", 11)}</button>` : "";
    nTabs.innerHTML =
      `<div class="notes-tab-grp"><span class="notes-grp-h">${t("mb.player")}</span>${playerP.map(tabBtn).join("")}` +
      addBtn("data-add-player", t("phase.add")) +
      `</div>` +
      (builderP.length || isMB
        ? `<div class="notes-tab-sep"></div><div class="notes-tab-grp"><span class="notes-grp-h">${t("mb.builder")}</span>${builderP.map(tabBtn).join("")}` +
          addBtn("data-add-sub", t("mb.subPhase")) +
          `</div>`
        : "");
    nTabs.querySelectorAll<HTMLButtonElement>("[data-nt]").forEach((b) =>
      b.addEventListener("click", () => {
        flushNotes();
        notesTabId = b.dataset.nt!;
        paintNotes();
      }),
    );
    nTabs.querySelector("[data-add-player]")?.addEventListener("click", () => void ctx.ui.addPlayerPhase());
    nTabs.querySelector("[data-add-sub]")?.addEventListener("click", () => void ctx.ui.addSubPhase(activePlayerId()));
    nEdit.value = ph.notes ?? "";
    nView.innerHTML = renderMarkdown(ph.notes ?? "");
    wireNoteImageRefs(nView);
    wireRefs(nView);
    renderNotesTimes();
  };
  nEdit.addEventListener("input", () => {
    flushNotes();
    nView.innerHTML = renderMarkdown(nEdit.value);
    wireNoteImageRefs(nView);
    wireRefs(nView);
  });
  notesWin.querySelector(".notes-img")?.addEventListener("click", async () => {
    const pick = await pickPlanImage();
    if (!pick) return;
    const s = nEdit.selectionStart ?? nEdit.value.length;
    nEdit.value = nEdit.value.slice(0, s) + `{{img:${pick}}}` + nEdit.value.slice(s);
    nEdit.dispatchEvent(new Event("input"));
    nEdit.focus();
  });
  nEdit.addEventListener("blur", flushNotes);
  // Phasenwechsel → Reiter dieser Phase aktiv machen
  phaseListeners.push(() => {
    flushNotes();
    notesTabId = ctx.currentPhaseId;
    paintNotes();
  });
  notesWin.querySelector(".notes-x")!.addEventListener("click", () => (notesWin.hidden = true));
  ctx.ui.toggleNotesWin = () => {
    notesWin.hidden = !notesWin.hidden;
    if (!notesWin.hidden) {
      placeNotesWin(); // gegen off-screen gespeicherte Position
      paintNotes();
    }
  };
  // Ziehen am Kopf
  {
    const head = notesWin.querySelector<HTMLDivElement>(".notes-head")!;
    let dx = 0;
    let dy = 0;
    const onMove = (e: MouseEvent) => {
      notesWin.style.left = `${e.clientX - dx}px`;
      notesWin.style.top = `${e.clientY - dy}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      localStorage.setItem(
        "sidc_noteswin",
        JSON.stringify({ x: parseInt(notesWin.style.left), y: parseInt(notesWin.style.top) }),
      );
    };
    head.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".notes-x")) return;
      dx = e.clientX - notesWin.offsetLeft;
      dy = e.clientY - notesWin.offsetTop;
      document.addEventListener("mousemove", onMove, { signal: sig });
      document.addEventListener("mouseup", onUp, { signal: sig });
    });
  }
}
