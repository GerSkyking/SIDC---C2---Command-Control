// Export: Screenshot (nur Karteninhalt + DTG), Briefing-PDF je Phase (inkl. Kräfteübersicht),
// Plan-Vorschaubild und Versions-Panel.
import { api } from "../api";
import { t } from "../i18n";
import { toast } from "../notify";
import { mimeExt, renderMapCanvas, wireShotOpts } from "../screenshot";
import { openVersionPanel } from "../versions";
import type { PlanCtx } from "./ctx";
import { imgToJpeg } from "./geo";

export function initExport(ctx: PlanCtx): void {
  const { map, root, planId, snap, markers, images, phases, isMB, canEdit, myPlan, sig, baseLayerVisible } = ctx;
  const { isNotesPhase } = ctx.model;
  // ── Datum/Zeit (DTG = H-Stunde) ──────────────────────────────────────
  const dtgInput = root.querySelector<HTMLInputElement>("#dtg")!;
  const DTG_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const p2 = (n: number) => String(n).padStart(2, "0");
  const shotDate = () => (dtgInput.value ? new Date(dtgInput.value) : new Date());
  // Militärisches Format "DDHHMMZ MMM YY" (eingegebene Zeit als Zulu gelesen).
  const militaryDtg = (d: Date) =>
    `${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}Z ${DTG_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;

  // ── Screenshot: nur Karteninhalt (Sat/Grid + Orte + Marker + Zeichnungen
  //    + Richtungspfeile), keine Bedienelemente. Unten links der DTG.
  const gridCanvas = root.querySelector<HTMLCanvasElement>("#gridCanvas")!;
  const shotBtn = root.querySelector<HTMLButtonElement>("#shot")!;
  const getShotOpts = wireShotOpts(root);
  shotBtn.addEventListener("click", async () => {
    shotBtn.disabled = true;
    try {
      const opts = getShotOpts();
      const out = await renderMapCanvas(map, opts);
      const g2d = out.getContext("2d")!;
      if (baseLayerVisible.grid !== false) g2d.drawImage(gridCanvas, 0, 0, out.width, out.height);

      const d = shotDate();
      const s = out.height / 1080; // Label-Skalierung, auflösungsunabhängig
      g2d.font = `bold ${Math.round(15 * s)}px monospace`;
      g2d.textBaseline = "bottom";
      g2d.lineWidth = 3 * s;
      g2d.strokeStyle = "rgba(0,0,0,0.85)";
      g2d.fillStyle = "#fff";
      const label = militaryDtg(d);
      const x = 12 * s;
      const y = out.height - 12 * s;
      g2d.strokeText(label, x, y);
      g2d.fillText(label, x, y);

      const phaseName = phases.find((p) => p.id === ctx.currentPhaseId)?.name ?? "global";
      const safe = (str: string) => str.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "map";
      const fileStamp =
        `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}-` +
        `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const { mime, ext, quality } = mimeExt(opts.fmt);
      const a = document.createElement("a");
      a.href = out.toDataURL(mime, quality);
      a.download = `${safe(snap.plan.name)}_${safe(phaseName)}_${fileStamp}.${ext}`;
      a.click();
    } finally {
      shotBtn.disabled = false;
    }
  });

  // ── Briefing-PDF: je Phase eine Seite (Karte auf Phasen-Marker gerahmt) ──
  const briefingPlaneChoice = (): Promise<"player" | "builder" | null> =>
    new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "edit-modal";
      back.innerHTML = `<div class="card stack" style="width:min(22rem,94vw)">
        <h1 style="margin:0;font-size:1.05rem">${t("briefing.planeTitle")}</h1>
        <div class="row" style="gap:.5rem">
          <button class="primary" data-pl="player" style="flex:1" title="${t("tip.brief.player")}">${t("mb.player")}</button>
          <button data-pl="builder" style="flex:1" title="${t("tip.brief.builder")}">${t("mb.builder")}</button>
        </div>
        <button data-pl="" class="muted">${t("common.cancel")}</button>
      </div>`;
      const done = (v: "player" | "builder" | null) => {
        back.remove();
        resolve(v);
      };
      back.addEventListener("mousedown", (e) => e.target === back && done(null));
      back.querySelectorAll<HTMLButtonElement>("[data-pl]").forEach((b) =>
        b.addEventListener("click", () => done((b.dataset.pl as "player" | "builder") || null)),
      );
      document.body.appendChild(back);
    });
  const briefingBtn = root.querySelector<HTMLButtonElement>("#briefing")!;
  briefingBtn.addEventListener("click", async () => {
    briefingBtn.disabled = true;
    const origPhase = ctx.currentPhaseId;
    const origCenter = map.getCenter();
    const origZoom = map.getZoom();
    const origBearing = map.getBearing();
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "plan";
    const stripMd = (s: string) =>
      s
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/[*_`>#]/g, "")
        .replace(/^\s*[-*]\s+/gm, "• ")
        .trim();
    const idle = () =>
      new Promise<void>((res) => {
        if (map.loaded() && !map.isMoving()) return res();
        map.once("idle", () => res());
      });
    // Missionsbauer wählt, für welche Ebene das Briefing gilt.
    let plane: "player" | "builder" = "player";
    if (isMB) {
      const choice = await briefingPlaneChoice();
      if (choice === null) {
        briefingBtn.disabled = false;
        return;
      }
      plane = choice;
    }
    const briefPhases = phases.filter((p) => (p.plane ?? "player") === plane && !isNotesPhase(p));

    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      const d = shotDate();

      for (let pi = 0; pi < briefPhases.length; pi++) {
        const phase = briefPhases[pi];
        if (pi > 0) doc.addPage();
        ctx.currentPhaseId = phase.id;
        // Marker dieser Phase (+ globale) für den Bildausschnitt
        const pts = [...markers.values()]
          .filter((m) => m.phase_id === phase.id || m.phase_id == null || (m.extra_phase_ids ?? []).includes(phase.id))
          .map((m) => [m.world_x, m.world_y] as [number, number]);
        if (pts.length) {
          let m0 = pts[0].slice() as [number, number];
          let m1 = pts[0].slice() as [number, number];
          for (const p of pts) {
            m0 = [Math.min(m0[0], p[0]), Math.min(m0[1], p[1])];
            m1 = [Math.max(m1[0], p[0]), Math.max(m1[1], p[1])];
          }
          const padX = (m1[0] - m0[0]) * 0.1 || 0.0005;
          const padY = (m1[1] - m0[1]) * 0.1 || 0.0005;
          map.fitBounds(
            [
              [m0[0] - padX, m0[1] - padY],
              [m1[0] + padX, m1[1] + padY],
            ],
            { padding: 40, duration: 0, bearing: 0 },
          );
        }
        await ctx.ui.refreshMarkers();
        await idle();
        map.redraw();
        const mc = map.getCanvas();
        const cvs = document.createElement("canvas");
        cvs.width = mc.width;
        cvs.height = mc.height;
        const cx = cvs.getContext("2d")!;
        cx.drawImage(mc, 0, 0);
        if (baseLayerVisible.grid !== false) cx.drawImage(gridCanvas, 0, 0, cvs.width, cvs.height);
        const img = cvs.toDataURL("image/jpeg", 0.9);

        // Layout: Titel oben, Karte links, Notizen rechts
        doc.setFontSize(16);
        doc.text(`${snap.plan.name} — ${phase.name}  (${pi + 1}/${briefPhases.length})`, 12, 14);
        doc.setFontSize(9);
        doc.text(militaryDtg(d), pw - 12, 14, { align: "right" });
        const imgW = pw * 0.62 - 12;
        const imgH = (imgW * cvs.height) / cvs.width;
        doc.addImage(img, "JPEG", 12, 20, imgW, Math.min(imgH, ph - 28));
        const nx = 12 + imgW + 8;
        const colW = pw - nx - 10;
        const notes = stripMd((phase.notes || "").replace(/\{\{img:[0-9a-f]{32}\}\}/g, "").trim());
        let ny = 26;
        if (notes) {
          doc.setFontSize(10);
          const lines = doc.splitTextToSize(notes, colW) as string[];
          doc.text(lines, nx, ny);
          ny += lines.length * 4.6 + 4;
        }
        // Bild-Verweise der Phase als echte Bilder unter den Notiztext
        const refs = [...(phase.notes || "").matchAll(/\{\{img:([0-9a-f]{32})\}\}/g)].map((m) => m[1]);
        for (const rid of refs) {
          const meta = images.get(rid);
          if (!meta) continue;
          try {
            const dataUrl = await imgToJpeg(api.planImageUrl(planId, rid));
            const ratio = meta.natural_w > 0 ? meta.natural_h / meta.natural_w : 0.6;
            let iw = colW;
            let ih = iw * ratio;
            if (ny + ih > ph - 12) {
              doc.addPage();
              ny = 20;
              if (ih > ph - 30) {
                ih = ph - 30;
                iw = ih / ratio;
              }
            }
            doc.addImage(dataUrl, "JPEG", nx, ny, iw, ih);
            ny += ih + 2;
            if (meta.caption) {
              doc.setFontSize(8);
              doc.text(doc.splitTextToSize(meta.caption, colW) as string[], nx, ny + 3);
              ny += 6;
            }
          } catch {
            /* Bild nicht ladbar -> überspringen */
          }
        }
      }
      // ── Kräfteübersicht: ORBAT-Knoten, die auf der Karte stehen ──
      await ctx.ui.ensureOrbatCache();
      const nodesOnMap = new Set(
        [...markers.values()].map((m) => m.orbat_node_id).filter(Boolean) as string[],
      );
      const forceItems = ctx.planOrbatCache.flatMap((o) =>
        (o.nodes ?? [])
          .filter((n) => o.released || nodesOnMap.has(n.id))
          .map((n) => ({ orbat: o.name, aff: o.affiliation, n })),
      );
      if (forceItems.length) {
        doc.addPage();
        doc.setFontSize(16);
        doc.text(`${snap.plan.name} — ${t("orbat.forcesTitle")}`, 12, 14);
        let y = 26;
        let curOrbat = "";
        for (const it of forceItems) {
          if (y > ph - 14) {
            doc.addPage();
            y = 20;
          }
          if (it.orbat !== curOrbat) {
            curOrbat = it.orbat;
            doc.setFontSize(12);
            doc.text(`${curOrbat}  (${t("orbat.aff." + it.aff)})`, 12, y);
            y += 7;
          }
          doc.setFontSize(10);
          const strength =
            it.n.qty_planned == null ? "?" : `${it.n.qty_current ?? "?"}/${it.n.qty_planned}`;
          doc.text(`• ${it.n.name}    ${strength}    ${t("orbat.status." + it.n.status)}`, 16, y);
          y += 6;
        }
      }
      const fileStamp =
        `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}-` +
        `${p2(d.getHours())}${p2(d.getMinutes())}`;
      doc.save(`${safe(snap.plan.name)}_Briefing_${fileStamp}.pdf`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "PDF-Export fehlgeschlagen", { kind: "error" });
    } finally {
      ctx.currentPhaseId = origPhase;
      map.jumpTo({ center: origCenter, zoom: origZoom, bearing: origBearing });
      await ctx.ui.refreshMarkers();
      ctx.ui.renderTimeline();
      briefingBtn.disabled = false;
    }
  });
  // Plan-Vorschaubild (Thumbnail) — bei Versions-Speichern + einmal kurz nach dem Laden.
  async function captureThumb(): Promise<void> {
    if (!canEdit || sig.aborted) return;
    try {
      await new Promise<void>((res, rej) => {
        if (map.loaded() && !map.isMoving()) return res();
        const to = window.setTimeout(() => rej(new Error("idle-timeout")), 8000);
        map.once("idle", () => {
          window.clearTimeout(to);
          res();
        });
      });
      if (sig.aborted) return;
      map.redraw();
      const mc = map.getCanvas();
      const w = 400;
      const h = Math.round((w * mc.height) / mc.width);
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      out.getContext("2d")!.drawImage(mc, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
      if (blob) await api.uploadThumbnail(planId, blob);
    } catch {
      /* Thumbnail ist optional */
    }
  }
  if (canEdit) setTimeout(() => void captureThumb(), 5000);

  root
    .querySelector("#versions")!
    .addEventListener("click", () =>
      openVersionPanel(planId, canEdit, myPlan?.level === "owner", () => void captureThumb()),
    );
}
