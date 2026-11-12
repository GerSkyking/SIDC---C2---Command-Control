// Taktische Layer: Auto-Layer nach Identität (Blufor/Redfor/…) + eigene Layer pro Plan, Panel mit
// Sichtbarkeit/Deckkraft; reagiert auf Layer- und Phasen-Änderungen vom Server.
import { api } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { makeMovable } from "../movable";
import { confirmDialog, toastError } from "../notify";
import type { WsMessage } from "../ws";
import { TAC_AUTO, type PlanCtx, type TacAuto, type TacLayer } from "./ctx";

export function initTactical(ctx: PlanCtx): void {
  const { socket, root, planId, markers, strokes, canEdit, isMB, projectId, tacKey, tacState, layerListeners } = ctx;
  // ── Taktische Layer (Auto-Layer nach Identität + eigene Layer) ────────
  const tacPanel = root.querySelector<HTMLDivElement>("#tacPanel")!;
  const tacBtn = root.querySelector<HTMLButtonElement>("#tacBtn")!;
  const mvTac = makeMovable(tacPanel, { plan: planId, key: "tactical", pinnable: true });
  const applyTac = (): void => {
    void ctx.ui.refreshMarkers();
    ctx.ui.refreshStrokes();
    ctx.ui.redrawMeasure();
    ctx.ui.renderAnnots();
  };
  const saveTac = (): void => {
    try {
      localStorage.setItem(tacKey, JSON.stringify(tacState));
    } catch {
      /* ignore */
    }
  };
  function buildTacPanel(): void {
    const row = (key: string, label: string, del: boolean): string => {
      const st = tacState[key] ?? {};
      return (
        `<div class="layer-row"><label><input type="checkbox" data-tk="${esc(key)}" ${st.on === false ? "" : "checked"}/> ${esc(label)}</label>` +
        `<input type="range" min="0" max="100" step="5" value="${st.op ?? 100}" data-to="${esc(key)}" title="${t("layers.opacityHint")}"/>` +
        (del
          ? `<button class="icon-btn" style="color:var(--danger)" data-tdel="${esc(key)}" title="${t("common.delete")}">${icon("trash", 14)}</button>`
          : "") +
        `</div>`
      );
    };
    const auto: Record<TacAuto, string> = {
      bluefor: t("tac.blufor"),
      redfor: t("tac.redfor"),
      civgreen: t("tac.civgreen"),
      unknown: t("tac.unknown"),
    };
    tacPanel.innerHTML =
      `<div class="fav-head">${t("tac.heading")}</div>` +
      `<div class="tac-sep">${t("tac.auto")}</div>` +
      TAC_AUTO.map((k) => row("auto:" + k, auto[k], false)).join("") +
      (ctx.tacLayers.length || canEdit ? `<div class="tac-sep">${t("tac.custom")}</div>` : "") +
      ctx.tacLayers.map((l) => row(l.id, l.name, canEdit)).join("") +
      (isMB && projectId ? `<div class="tac-sep">${t("mb.builder")}</div>` + row("mbnotes", t("tac.mbNotes"), false) : "") +
      (canEdit
        ? `<div class="tac-new"><input id="tacNewName" maxlength="40" placeholder="${t("tac.new")}"/><button id="tacNewBtn">${t("tac.add")}</button></div>`
        : "") +
      `<div class="muted" style="font-size:.72rem;margin-top:.4rem">${t("tac.hint")}</div>`;
    tacPanel.querySelectorAll<HTMLInputElement>("[data-tk]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const k = cb.dataset.tk!;
        tacState[k] = { ...tacState[k], on: cb.checked };
        saveTac();
        applyTac();
      }),
    );
    tacPanel.querySelectorAll<HTMLInputElement>("[data-to]").forEach((sl) =>
      sl.addEventListener("input", () => {
        const k = sl.dataset.to!;
        tacState[k] = { ...tacState[k], op: +sl.value };
        saveTac();
        applyTac();
      }),
    );
    tacPanel.querySelectorAll<HTMLButtonElement>("[data-tdel]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmDialog(t("tac.confirmDelete"), { danger: true, trash: true }))) return;
        await api.deleteLayer(planId, b.dataset.tdel!).catch(toastError);
      }),
    );
    const nameIn = tacPanel.querySelector<HTMLInputElement>("#tacNewName");
    const create = async () => {
      const name = nameIn?.value.trim();
      if (!name) return;
      await api.createLayer(planId, name).catch(toastError);
      if (nameIn) nameIn.value = "";
    };
    tacPanel.querySelector("#tacNewBtn")?.addEventListener("click", () => void create());
    nameIn?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void create();
    });
  }
  // Suche: Treffer in einem ausgeblendeten Layer → Layer wieder einblenden (Deckkraft 0 → 100 %)
  ctx.ui.showTacLayer = (key: string): void => {
    const st = tacState[key] ?? {};
    tacState[key] = { ...st, on: true, op: st.op ? st.op : 100 };
    saveTac();
    if (!tacPanel.hidden) buildTacPanel();
    applyTac();
  };
  tacBtn.addEventListener("click", () => {
    tacPanel.hidden = !tacPanel.hidden;
    if (!tacPanel.hidden) {
      if (!mvTac.hasPos()) ctx.ui.placeNextToTool(tacPanel, tacBtn);
      buildTacPanel();
      mvTac.bringIntoView();
    }
  });
  if (mvTac.isPinned()) {
    tacPanel.hidden = false;
    buildTacPanel();
  }
  // Layer-Liste vom Server (anderer Nutzer legt an/löscht)
  const onLayersChanged = (list: TacLayer[], removed?: string): void => {
    ctx.tacLayers = list.filter((l) => !l.is_default);
    if (removed) {
      for (const m of markers.values()) if (m.layer_id === removed) m.layer_id = null;
      for (const st of strokes.values()) if (st.layer_id === removed) st.layer_id = null;
      delete tacState[removed];
      saveTac();
    }
    layerListeners.forEach((f) => f());
    if (!tacPanel.hidden) buildTacPanel();
    applyTac();
  };
  socket.on((msg: WsMessage) => {
    if (msg.type === "layers.changed") onLayersChanged(msg.layers as TacLayer[], msg.removed as string | undefined);
    else if (msg.type === "phases.changed") void ctx.ui.resync().catch(() => {});
    // Reconnect (ws.ts: reconnect=true ab der 2. Verbindung): verpasste Änderungen per Snapshot nachladen
    else if (msg.type === "_open" && msg.reconnect) void ctx.ui.resync().catch(() => {});
  });
}
