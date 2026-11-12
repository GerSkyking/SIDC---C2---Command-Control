// Live-Verbindung: WebSocket-Nachrichten verteilen (Marker/Linien/Notizen/Bilder/Präsenz),
// verlorene Änderungen melden und nach Reconnect/Phasen-Änderung per Snapshot neu laden (resync).
import { api, type ImagePlacement, type PlanImage } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { toast } from "../notify";
import type { WsMessage } from "../ws";
import type { Annot, Marker, PhaseT, PlanCtx, Stroke } from "./ctx";

export function initLive(ctx: PlanCtx): void {
  const { root, me, planId, markers, strokes, annots, images, placements, phases, caps, canZeus, peers } = ctx;
  const { upsertPeer, playerPhases } = ctx.model;
  // ── WebSocket ──────────────────────────────────────────────────────────
  const socket = ctx.socket;
  let lastDropToast = 0;
  socket.onDropped = () => {
    // Nicht still verlieren: Nutzer sieht, dass die Änderung NICHT angekommen ist.
    if (Date.now() - lastDropToast < 3000) return;
    lastDropToast = Date.now();
    toast(t("ws.dropped"), { kind: "error" });
  };

  const presenceEl = root.querySelector<HTMLSpanElement>("#presence")!;
  const names = new Map<string, string>();
  const renderPresence = () =>
    (presenceEl.innerHTML = [...names.values()].map((n) => `<span class="badge" title="${t("tip.live.presence")}">${esc(n)}</span>`).join(""));

  socket.on((msg: WsMessage) => {
    switch (msg.type) {
      case "hello":
        Object.assign(caps, msg.caps);
        ctx.ui.applyCaps();
        break;
      case "reject":
        if (msg.reason) console.warn("abgelehnt:", msg.reason);
        break;
      case "presence.join":
        if (msg.uid !== me.id) names.set(msg.uid, msg.user);
        renderPresence();
        break;
      case "presence.leave":
        names.delete(msg.uid);
        peers.delete(msg.uid);
        renderPresence();
        ctx.ui.refreshPeers();
        break;
      case "presence.cursor":
        if (msg.uid !== me.id) {
          upsertPeer(msg.uid, names.get(msg.uid) ?? "?", msg.lng, msg.lat, !!msg.hl, (msg.arrow as [number, number] | null) ?? null);
          ctx.ui.refreshPeers();
        }
        break;
      case "marker.upsert":
        markers.set(msg.marker.id, msg.marker);
        void ctx.ui.refreshMarkers();
        break;
      case "marker.delete":
        markers.delete(msg.id);
        void ctx.ui.refreshMarkers();
        break;
      case "stroke.upsert":
        strokes.set(msg.stroke.id, msg.stroke);
        ctx.ui.refreshStrokes();
        if (ctx.editStrokeId === msg.stroke.id) ctx.ui.refreshStrokeVerts();
        if (msg.cid) ctx.ui.strokeCommitted(msg.cid as string, msg.stroke.id);
        break;
      case "stroke.delete":
        strokes.delete(msg.id);
        ctx.ui.refreshStrokes();
        if (ctx.editStrokeId === msg.id) ctx.ui.setEditStroke(null);
        break;
      case "annotation.upsert": {
        const wasResizing = ctx.annotResizingId === msg.annotation.id;
        annots.set(msg.annotation.id, msg.annotation);
        if (!ctx.annotResizingId) ctx.ui.renderAnnots(); // während eines Resize nicht neu aufbauen
        else if (!wasResizing) ctx.ui.positionAnnots();
        if (msg.cid && msg.cid === ctx.pendingAnnotCid) {
          ctx.pendingAnnotCid = null;
          ctx.ui.openAnnotEditor(msg.annotation.id, true);
        }
        if (msg.cid && ctx.pendingStarArea.has(msg.cid)) {
          ctx.pendingStarArea.delete(msg.cid);
          ctx.ui.startAreaDraw(msg.annotation.id);
        }
        if (msg.cid && ctx.pendingStarZeus.has(msg.cid)) {
          const z = ctx.pendingStarZeus.get(msg.cid)!;
          ctx.pendingStarZeus.delete(msg.cid);
          socket.send({ type: "annotation.modify", id: msg.annotation.id, data: z });
        }
        break;
      }
      case "annotation.delete":
        annots.delete(msg.id);
        ctx.ui.renderAnnots();
        break;
      case "image.upsert":
        images.set(msg.image.id, msg.image);
        if (!ctx.imgResizingId) ctx.ui.renderMapImages(); // Beschriftung/Notiz können in Hover/Popover sichtbar sein
        ctx.ui.refreshImageRail();
        break;
      case "image.delete":
        images.delete(msg.id);
        // Alle Platzierungen dieses Bilds lokal mit entfernen (Server-CASCADE
        // sendet dafür keine einzelnen placement.delete-Nachrichten).
        for (const p of [...placements.values()]) if (p.image_id === msg.id) placements.delete(p.id);
        ctx.ui.renderMapImages();
        ctx.ui.refreshImageRail();
        break;
      case "placement.upsert":
        placements.set(msg.placement.id, msg.placement);
        if (!ctx.imgResizingId) ctx.ui.renderMapImages();
        else ctx.ui.positionImages();
        ctx.ui.refreshImageRail();
        break;
      case "placement.delete":
        placements.delete(msg.id);
        ctx.ui.renderMapImages();
        ctx.ui.refreshImageRail();
        break;
    }
  });
  socket.connect();
  window.addEventListener("hashchange", () => socket.close(), { once: true });
  // Phasen-Freigaben (Zeus) oder Phasen/Inhalte haben sich geändert → alles neu holen
  let resyncSeq = 0;
  const resync = async (): Promise<void> => {
    const seq = ++resyncSeq;
    const sn = await api.snapshot(planId);
    if (seq !== resyncSeq) return; // neuere Anfrage läuft/ist durch → diese (ältere) Antwort verwerfen
    const sorted = [...(sn.phases ?? [])].sort(
      (a: PhaseT, b: PhaseT) => a.ordering - b.ordering || (a.sub_ordering ?? 0) - (b.sub_ordering ?? 0),
    );
    phases.splice(0, phases.length, ...sorted);
    markers.clear();
    for (const m of sn.markers as Marker[]) markers.set(m.id, m);
    strokes.clear();
    for (const st of sn.strokes as Stroke[]) strokes.set(st.id, st);
    annots.clear();
    for (const a of (sn.annotations ?? []) as Annot[]) annots.set(a.id, a);
    images.clear();
    for (const i of (sn.images ?? []) as PlanImage[]) images.set(i.id, i);
    placements.clear();
    for (const p of (sn.image_placements ?? []) as ImagePlacement[]) placements.set(p.id, p);
    if (!phases.some((x) => x.id === ctx.currentPhaseId)) ctx.currentPhaseId = playerPhases()[0]?.id ?? "";
    if (ctx.actAs === "zeus" && !canZeus) ctx.actAs = "player";
    ctx.ui.applyPhase();
    ctx.ui.refreshStrokes();
    ctx.ui.renderAnnots();
    if (!ctx.imgResizingId) ctx.ui.renderMapImages();
    ctx.ui.refreshImageRail();
  };
  ctx.ui.resync = resync;
}
