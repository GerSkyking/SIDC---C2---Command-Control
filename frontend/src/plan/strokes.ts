// Linien und Lineal: Phasenlinien zeichnen (Linien-Stil-Panel, ✓/Zahnrad/Papierkorb am Endpunkt),
// Linien-Einstellungen, Stützpunkte ziehen, Messlinien (Schrägentfernung) mit eigenem Phasen-/Layer-Menü.
import type { GeoJSONSource } from "maplibre-gl";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { confirmDialog } from "../notify";
import { layerSelectHtml, phaseMultiHtml, readPhaseMulti } from "../sidc/layerui";
import { lngLatToWorld } from "../sidc/sidc";
import { cid } from "../ws";
import { AREA_CLOSE_PX, type LngLat2, type PlanCtx, type Stroke } from "./ctx";
import { areaFieldsHtml, openAreaNameDialog, wireAreaFields } from "./strokeArea";
import { fmtDist, lineDraftFC } from "./geo";

export function initStrokes(ctx: PlanCtx): void {
  const { map, socket, root, strokes, canEdit, caps, cal, sig, lineColors, lineWidths, phaseListeners, layerListeners } = ctx;
  const { bindXPhases, zeusBlocked, selectablePhases, samePlanePhases, measureVisible } = ctx.model;
  ctx.measurePhaseId = ctx.currentPhaseId || null;
  let measureLayerId: string | null = null;
  let measureExtra: string[] = [];
  let lineExtraPhases: string[] = [];
  let renderMeasureX: () => void = () => {};
  let renderLineX: () => void = () => {};
  {
    const mp = root.querySelector<HTMLSelectElement>("#mPhase")!;
    const ml = root.querySelector<HTMLSelectElement>("#mLayer")!;
    const fill = () => {
      ml.innerHTML =
        `<option value="">${t("tac.autoOpt")}</option>` +
        ctx.tacLayers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
      if (measureLayerId && !ctx.tacLayers.some((l) => l.id === measureLayerId)) measureLayerId = null;
      ml.value = measureLayerId ?? "";
    };
    fill();
    layerListeners.push(fill);
    mp.value = ctx.measurePhaseId ?? "";
    renderMeasureX = bindXPhases(root.querySelector<HTMLElement>("#mXph")!, () => ctx.measurePhaseId, () => measureExtra, (v) => (measureExtra = v));
    mp.addEventListener("change", () => {
      ctx.measurePhaseId = mp.value || ctx.currentPhaseId || null;
      renderMeasureX();
    });
    ml.addEventListener("change", () => (measureLayerId = ml.value || null));
    phaseListeners.push(() => {
      ctx.measurePhaseId = ctx.currentPhaseId || null;
      mp.value = ctx.measurePhaseId ?? "";
      renderMeasureX();
      redrawMeasure();
    });
  }
  ctx.linePhaseId = ctx.currentPhaseId || null;
  let lineLayerId: string | null = null;

  const lineDoneBtn = root.querySelector<HTMLButtonElement>("#lineDone")!;
  const strokeGearBtn = root.querySelector<HTMLButtonElement>("#strokeGear")!;
  const strokeDelBtn = root.querySelector<HTMLButtonElement>("#strokeDel")!;
  // Anker für den grünen Haken (und das Zahnrad): letzter Punkt der laufenden
  // Linie bzw. der gerade bearbeiteten Linie/Messlinie.
  const doneAnchor = (): [number, number] | null => {
    if (ctx.mode === "line" && ctx.linePts.length >= 2) return ctx.linePts[ctx.linePts.length - 1];
    if (ctx.mode === "measure" && ctx.measureActive.length >= 2) return ctx.measureActive[ctx.measureActive.length - 1];
    if (ctx.editStrokeId) {
      const p = strokes.get(ctx.editStrokeId)?.points;
      if (p && p.length) return p[p.length - 1] as [number, number];
    }
    if (ctx.editMeasureId) {
      const p = ctx.measureLines.find((x) => x.id === ctx.editMeasureId)?.pts;
      if (p && p.length) return p[p.length - 1];
    }
    return null;
  };
  const positionLineDone = () => {
    const a = doneAnchor();
    // Zahnrad nur beim Bearbeiten einer bestehenden Phasenlinie, Papierkorb auch bei Messlinien
    const running = (ctx.mode === "line" && ctx.linePts.length >= 2) || (ctx.mode === "measure" && ctx.measureActive.length >= 2);
    const showGear = !!ctx.editStrokeId && !running;
    const showDel = !!ctx.editStrokeId || !!ctx.editMeasureId || running; // laufend: Löschen = verwerfen
    if (!a) {
      lineDoneBtn.hidden = true;
      strokeGearBtn.hidden = true;
      strokeDelBtn.hidden = true;
      return;
    }
    const p = map.project(a);
    // #map ist um die Topbar-Höhe nach unten versetzt — die Buttons liegen in
    // #app, also den Versatz addieren (fester Bildschirm-Abstand, skaliert nicht).
    const mr = map.getContainer().getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const bx = mr.left - rr.left + p.x;
    const by = mr.top - rr.top + p.y;
    lineDoneBtn.hidden = false;
    lineDoneBtn.style.left = `${Math.round(bx - 16)}px`;
    lineDoneBtn.style.top = `${Math.round(by - 46)}px`;
    strokeGearBtn.hidden = !showGear;
    if (showGear) {
      strokeGearBtn.style.left = `${Math.round(bx + 22)}px`;
      strokeGearBtn.style.top = `${Math.round(by - 46)}px`;
    }
    strokeDelBtn.hidden = !showDel;
    if (showDel) {
      strokeDelBtn.style.left = `${Math.round(bx + (showGear ? 60 : 22))}px`;
      strokeDelBtn.style.top = `${Math.round(by - 46)}px`;
    }
  };
  lineDoneBtn.addEventListener("click", () => {
    if (ctx.mode === "line" && ctx.linePts.length >= 2) finishLine();
    else if (ctx.mode === "measure" && ctx.measureActive.length >= 2) commitMeasure();
    else if (ctx.editStrokeId) ctx.ui.setEditStroke(null);
    else if (ctx.editMeasureId) ctx.ui.setEditMeasure(null);
  });
  strokeGearBtn.addEventListener("click", () => {
    if (ctx.editStrokeId) openStrokeSettings(ctx.editStrokeId);
  });
  strokeDelBtn.addEventListener("click", async () => {
    const saved = !(ctx.mode === "line" && ctx.linePts.length >= 2) && !(ctx.mode === "measure" && ctx.measureActive.length >= 2);
    if (saved && (ctx.editStrokeId || ctx.editMeasureId) && !(await confirmDialog(t("line.confirmDelete"), { danger: true, trash: true }))) return;
    if (ctx.mode === "line" && ctx.linePts.length >= 2) {
      cancelLine(); // laufende Linie verwerfen
    } else if (ctx.mode === "measure" && ctx.measureActive.length >= 2) {
      ctx.measureActive = [];
      ctx.measureCursor = null;
      redrawMeasure();
    } else if (ctx.editStrokeId) {
      if (caps.draw) deleteStroke(ctx.editStrokeId);
      ctx.ui.setEditStroke(null);
    } else if (ctx.editMeasureId) {
      const mid = ctx.editMeasureId;
      ctx.measureLines = ctx.measureLines.filter((x) => x.id !== mid);
      ctx.ui.setEditMeasure(null);
      redrawMeasure();
    }
  });
  // ── Fläche schließen: Klick nahe am Startpunkt (ab 3 Punkten) schließt die Linie zur Fläche ──
  const nearStart = (p: LngLat2 | null): boolean => {
    if (!p || ctx.linePts.length < 3) return false;
    const a = map.project(ctx.linePts[0]);
    const b = map.project(p);
    return Math.hypot(a.x - b.x, a.y - b.y) <= AREA_CLOSE_PX;
  };
  // Geschlossener Entwurf, solange der Benennen-Dialog offen ist
  let closingPts: LngLat2[] | null = null;
  const refreshLineDraft = () => {
    const src = map.getSource("linedraft") as GeoJSONSource | undefined;
    if (closingPts) src?.setData(lineDraftFC(closingPts, null, false, true));
    else src?.setData(lineDraftFC(ctx.linePts, ctx.lineCursor, nearStart(ctx.lineCursor)));
    positionLineDone();
  };

  // ── Undo/Redo für Linien: Anlegen, Löschen, Einstellungen, Stützpunkte ──
  // Wird eine gelöschte Linie per Undo/Redo neu angelegt, bekommt sie eine neue ID — ``alias`` führt die
  // ursprüngliche ID auf die aktuelle, damit ältere Befehle (z. B. Einstellungen) weiter greifen.
  const alias = new Map<string, string>();
  const resolve = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 50 && alias.has(cur); i++) cur = alias.get(cur)!;
    return cur;
  };
  const pendingCommits = new Map<string, (id: string) => void>();
  const sendCommit = (data: Record<string, unknown>, onId: (id: string) => void): void => {
    const c = cid();
    pendingCommits.set(c, onId);
    socket.send({ type: "stroke.commit", cid: c, data });
  };
  const strokeCommitted = (c: string, id: string): void => {
    const f = pendingCommits.get(c);
    if (!f) return;
    pendingCommits.delete(c);
    f(id);
  };
  /** Linie anlegen (mit Undo = löschen, Redo = neu anlegen). */
  const commitStroke = (data: Record<string, unknown>): void => {
    let origId: string | null = null;
    const onId = (id: string) => {
      if (!origId) origId = id;
      else if (id !== origId) alias.set(resolve(origId), id);
    };
    sendCommit(data, onId);
    ctx.ui.pushCmd({
      undo: () => {
        if (!origId) return;
        const id = resolve(origId);
        if (ctx.editStrokeId === id) ctx.ui.setEditStroke(null);
        socket.send({ type: "stroke.delete", id });
      },
      redo: () => sendCommit(data, onId),
    });
  };
  /** Daten einer bestehenden Linie zum Neu-Anlegen (Undo des Löschens). */
  const strokeData = (s: Stroke): Record<string, unknown> => ({
    kind: "phaseline",
    points: s.points.map((p) => [p[0], p[1]]),
    color: s.color,
    width: s.width,
    phase_id: s.phase_id ?? null,
    extra_phase_ids: [...(s.extra_phase_ids ?? [])],
    layer_id: s.layer_id ?? null,
    closed: s.closed === true,
    name: s.name ?? "",
    sidc: s.sidc ?? "",
    fill: s.fill !== false,
  });
  const deleteStroke = (id: string): void => {
    const s = strokes.get(id);
    socket.send({ type: "stroke.delete", id });
    if (!s) return;
    const data = strokeData(s);
    ctx.ui.pushCmd({
      undo: () => sendCommit(data, (nid) => alias.set(resolve(id), nid)),
      redo: () => socket.send({ type: "stroke.delete", id: resolve(id) }),
    });
  };
  /** Felder einer Linie ändern (mit Undo auf den vorherigen Stand der geänderten Felder). */
  const modifyStroke = (id: string, data: Record<string, unknown>): void => {
    const s = strokes.get(id) as unknown as Record<string, unknown> | undefined;
    const norm = (v: unknown): string => JSON.stringify(v === undefined ? null : v);
    const changed: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(data)) {
      const prev = k === "fill" ? s?.[k] !== false : k === "closed" ? s?.[k] === true : s?.[k];
      if (s && norm(data[k]) === norm(prev)) continue;
      changed[k] = data[k];
      before[k] = prev === undefined ? (k === "name" || k === "sidc" ? "" : null) : JSON.parse(norm(prev));
    }
    if (!Object.keys(changed).length) return;
    socket.send({ type: "stroke.modify", id, data: changed });
    ctx.ui.pushCmd({
      undo: () => socket.send({ type: "stroke.modify", id: resolve(id), data: before }),
      redo: () => socket.send({ type: "stroke.modify", id: resolve(id), data: changed }),
    });
  };

  // Höhe an einem Punkt — dieselbe Quelle wie im HUD (2D: DEM-Kacheln, 3D: Terrain-Mesh).
  const elevationAt = (lng: number, lat: number): number => {
    try {
      const el = ctx.is3D
        ? (map.queryTerrainElevation({ lng, lat }) ?? 0) / 1.5
        : ctx.ui.sampleElevation(lng, lat);
      return el ?? 0;
    } catch {
      return 0;
    }
  };
  // Lineal misst die tatsächliche Schrägentfernung (Horizontaldistanz + Höhenunterschied),
  // nicht nur die 2D-Kartendistanz.
  const pathLen = (pts: [number, number][]): number => {
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = lngLatToWorld(cal, pts[i - 1][0], pts[i - 1][1]);
      const [bx, by] = lngLatToWorld(cal, pts[i][0], pts[i][1]);
      const horiz = Math.hypot(bx - ax, by - ay);
      const dz = elevationAt(pts[i][0], pts[i][1]) - elevationAt(pts[i - 1][0], pts[i - 1][1]);
      s += Math.hypot(horiz, dz);
    }
    return s;
  };
  const redrawMeasure = () => {
    const src = map.getSource("measure") as GeoJSONSource | undefined;
    if (!src) return;
    const feats: GeoJSON.Feature[] = [];
    // Alle Messlinien gestrichelt (wie die Vorschau). Zwischen je zwei Punkten die
    // Teilstrecke, am Ende zusätzlich die Gesamtstrecke.
    const addLine = (id: string, pts: [number, number][]) => {
      if (pts.length >= 2)
        feats.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: pts },
          properties: { kind: "line", mid: id, dashed: true },
        });
      for (const p of pts)
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { kind: "pt", mid: id } });
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        feats.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
          properties: { kind: "label", label: fmtDist(pathLen([a, b])) },
        });
      }
      if (pts.length >= 3)
        feats.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: pts[pts.length - 1] },
          properties: { kind: "label", label: `Σ ${fmtDist(pathLen(pts))}` },
        });
    };
    for (const ml of ctx.measureLines) if (measureVisible(ml)) addLine(ml.id, ml.pts);
    if (ctx.measureActive.length) {
      const live = ctx.measureCursor ? [...ctx.measureActive, ctx.measureCursor] : ctx.measureActive;
      addLine("__active", live);
    }
    src.setData({ type: "FeatureCollection", features: feats });
    positionLineDone();
  };
  const commitMeasure = () => {
    // Doppelklick setzt den letzten Punkt doppelt — Duplikat entfernen
    const n = ctx.measureActive.length;
    if (n >= 2 && ctx.measureActive[n - 1][0] === ctx.measureActive[n - 2][0] && ctx.measureActive[n - 1][1] === ctx.measureActive[n - 2][1])
      ctx.measureActive.pop();
    if (ctx.measureActive.length >= 2)
      ctx.measureLines.push({
        id: `m${Date.now()}`,
        pts: [...ctx.measureActive],
        phase_id: ctx.measurePhaseId ?? ctx.currentPhaseId ?? null,
        extra_phase_ids: [...measureExtra],
        layer_id: measureLayerId,
      });
    ctx.measureActive = [];
    ctx.measureCursor = null;
    redrawMeasure();
  };
  // Linien-Stil-Panel
  const lcBox = root.querySelector<HTMLDivElement>("#lc")!;
  const drawColors = () =>
    (lcBox.innerHTML = lineColors
      .map(
        (c) =>
          `<button data-pc="${c.packedColor}" title="${esc(c.name)}" style="background:rgb(${c.red},${c.green},${c.blue})" class="${
            c.packedColor === ctx.lineColor ? "active" : ""
          }"></button>`,
      )
      .join(""));
  drawColors();
  lcBox.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-pc]") as HTMLElement | null;
    if (!b) return;
    ctx.lineColor = Number(b.dataset.pc);
    drawColors();
  });
  root.querySelector<HTMLSelectElement>("#lw")!.addEventListener("change", (e) => {
    ctx.lineWidth = Number((e.target as HTMLSelectElement).value);
  });
  {
    const lp = root.querySelector<HTMLSelectElement>("#lPhase")!;
    const ll = root.querySelector<HTMLSelectElement>("#lLayer")!;
    lp.value = ctx.linePhaseId ?? "";
    const fillLayers = () => {
      ll.innerHTML =
        `<option value="">${t("tac.autoOpt")}</option>` +
        ctx.tacLayers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
      if (lineLayerId && !ctx.tacLayers.some((l) => l.id === lineLayerId)) lineLayerId = null;
      ll.value = lineLayerId ?? "";
    };
    fillLayers();
    layerListeners.push(fillLayers);
    renderLineX = bindXPhases(root.querySelector<HTMLElement>("#lXph")!, () => ctx.linePhaseId, () => lineExtraPhases, (v) => (lineExtraPhases = v));
    lp.addEventListener("change", () => {
      ctx.linePhaseId = lp.value || ctx.currentPhaseId || null;
      renderLineX();
    });
    phaseListeners.push(() => {
      ctx.linePhaseId = ctx.currentPhaseId || null;
      lp.value = ctx.linePhaseId ?? "";
      renderLineX();
    });
    ll.addEventListener("change", () => (lineLayerId = ll.value || null));
  }
  const finishLine = () => {
    if (ctx.linePts.length >= 2 && zeusBlocked()) return;
    if (ctx.linePts.length >= 2) commitStroke(lineData(ctx.linePts));
    ctx.linePts = [];
    refreshLineDraft();
  };
  function lineData(pts: LngLat2[]): Record<string, unknown> {
    return {
      kind: "phaseline",
      points: pts,
      color: ctx.lineColor,
      width: ctx.lineWidth,
      phase_id: ctx.linePhaseId ?? ctx.currentPhaseId ?? null,
      extra_phase_ids: [...lineExtraPhases],
      layer_id: lineLayerId,
    };
  }
  // Linie zur Fläche geschlossen → Benennen-Dialog (Name, Symbol, Füllung), dann mit closed:true speichern
  const closeLine = () => {
    if (ctx.linePts.length < 3 || zeusBlocked()) return;
    const base = lineData([...ctx.linePts]);
    closingPts = base.points as LngLat2[];
    ctx.linePts = [];
    ctx.lineCursor = null;
    refreshLineDraft();
    openAreaNameDialog(root, sig, (f) => {
      closingPts = null;
      refreshLineDraft();
      commitStroke({ ...base, closed: true, name: f.name, sidc: f.sidc, fill: f.fill });
    });
  };
  root.querySelector("#lineFinish")!.addEventListener("click", finishLine);
  // Laufende Linie verwerfen (Rechtsklick / Escape) — ohne sie zu setzen.
  const cancelLine = () => {
    ctx.linePts = [];
    refreshLineDraft();
  };
  // Zahnrad an einer bestehenden Phasenlinie: Phase/Ebene, Channel, Farbe, Breite
  function openStrokeSettings(strokeId: string): void {
    const s = strokes.get(strokeId);
    if (!s) return;
    const isClosed = s.closed === true && s.points.length >= 3;
    const back = document.createElement("div");
    back.className = "edit-modal area-name-dlg";
    back.innerHTML = `<div class="card" style="width:min(24rem,96vw)">
      <div class="row"><h1 style="flex:1;margin:0">${t("line.edit")}</h1><button class="icon-btn" data-x title="${t("common.close")}">${icon("x")}</button></div>
      <label class="chk-lbl">${t("phase.assign")}
        <select data-sphase>
          ${selectablePhases()
            .map(
              (ph) =>
                `<option value="${esc(ph.id)}" ${ph.id === s.phase_id ? "selected" : ""}>${ph.plane === "builder" ? "⚑ " : ""}${esc(ph.name)}</option>`,
            )
            .join("")}
        </select></label>
      <label class="chk-lbl">${t("phase.extra")}<div data-sx>${phaseMultiHtml("data-xphases", samePlanePhases(s.phase_id), s.extra_phase_ids ?? [], s.phase_id)}</div></label>
      ${
        `<label class="chk-lbl">${t("wiz.layer")}${layerSelectHtml("data-slayer", ctx.tacLayers, s.layer_id)}</label>`
      }
      <label class="chk-lbl">${t("line.color")}
        <select data-scolor>${lineColors
          .map((c) => `<option value="${c.packedColor}" ${c.packedColor === s.color ? "selected" : ""}>${esc(c.name)}</option>`)
          .join("")}</select></label>
      <label class="chk-lbl">${t("line.width")}
        <select data-swidth>${lineWidths
          .map((w) => `<option value="${w.width}" ${w.width === s.width ? "selected" : ""}>${w.width}</option>`)
          .join("")}</select></label>
      <label class="chk" style="margin-top:.5rem" title="${t("areaName.closedHint")}"><input type="checkbox" data-sclosed ${isClosed ? "checked" : ""} ${
        s.points.length < 3 ? "disabled" : ""
      }/> <span>${t("areaName.closed")}</span></label>
      <div data-area-block ${isClosed ? "" : "hidden"}>${areaFieldsHtml({ name: s.name ?? "", sidc: s.sidc ?? "", fill: s.fill !== false })}</div>
      <div class="row" style="margin-top:.6rem"><button class="primary" data-save style="flex:1">${t("common.save")}</button></div>
    </div>`;
    document.body.appendChild(back);
    const readArea = wireAreaFields(back, { name: s.name ?? "", sidc: s.sidc ?? "", fill: s.fill !== false }, root, back);
    const closedIn = back.querySelector<HTMLInputElement>("[data-sclosed]")!;
    closedIn.addEventListener("change", () => (back.querySelector<HTMLElement>("[data-area-block]")!.hidden = !closedIn.checked));
    const close = () => back.remove();
    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.querySelector("[data-x]")!.addEventListener("click", close);
    {
      const sp = back.querySelector<HTMLSelectElement>("[data-sphase]")!;
      sp.addEventListener("change", () => {
        const host = back.querySelector<HTMLElement>("[data-sx]")!;
        host.innerHTML = phaseMultiHtml("data-xphases", samePlanePhases(sp.value), readPhaseMulti(back, "data-xphases"), sp.value);
      });
    }
    back.querySelector("[data-save]")!.addEventListener("click", () => {
      const data: Record<string, unknown> = {
        phase_id: back.querySelector<HTMLSelectElement>("[data-sphase]")!.value || ctx.currentPhaseId || null,
        extra_phase_ids: readPhaseMulti(back, "data-xphases"),
        layer_id: back.querySelector<HTMLSelectElement>("[data-slayer]")
          ? back.querySelector<HTMLSelectElement>("[data-slayer]")!.value || null
          : (s.layer_id ?? null),
        color: Number(back.querySelector<HTMLSelectElement>("[data-scolor]")!.value),
        width: Number(back.querySelector<HTMLSelectElement>("[data-swidth]")!.value),
        closed: closedIn.checked && s.points.length >= 3,
      };
      // Name/Symbol/Füllung nur bei geschlossener Fläche (bei offener Linie bleiben sie gespeichert)
      if (data.closed) Object.assign(data, readArea());
      modifyStroke(strokeId, data);
      close();
    });
  }
  // Linie zum Bearbeiten wählen (Verschieben-Modus), Stützpunkte ziehen
  // (im Zeichnen-Werkzeug nur, wenn gerade keine neue Linie läuft — sonst setzt der Klick einen Punkt)
  map.on("click", "strokes", (e) => {
    if (!canEdit) return;
    if (ctx.mode !== "move" && ctx.mode !== "markermove" && !(ctx.mode === "line" && !ctx.linePts.length)) return;
    e.preventDefault();
    ctx.ui.setEditStroke((e.features?.[0]?.properties?.id as string) ?? null);
  });
  map.on("click", "measure-line", (e) => {
    if (ctx.mode !== "move" && ctx.mode !== "markermove" && !(ctx.mode === "measure" && !ctx.measureActive.length)) return;
    e.preventDefault();
    const mid = e.features?.[0]?.properties?.mid as string | undefined;
    ctx.ui.setEditMeasure(mid && mid !== "__active" ? mid : null);
  });
  // Stützpunkte gespeichert → Undo auf die Punkte vor dem Ziehen (Fläche/Schraffur folgt über refreshStrokes)
  const saveVerts = (id: string, before: LngLat2[], pts: LngLat2[]): void => {
    const after = pts.map((p) => [p[0], p[1]] as LngLat2);
    socket.send({ type: "stroke.modify", id, data: { points: after } });
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    ctx.ui.pushCmd({
      undo: () => socket.send({ type: "stroke.modify", id: resolve(id), data: { points: before } }),
      redo: () => socket.send({ type: "stroke.modify", id: resolve(id), data: { points: after } }),
    });
  };
  map.on("mouseenter", "strokeverts-hit", () => (map.getCanvas().style.cursor = "grab"));
  map.on("mouseleave", "strokeverts-hit", () => (map.getCanvas().style.cursor = ctx.ui.modeCursor()));
  map.on("mousedown", "strokeverts-hit", (e) => {
    const idx = e.features?.[0]?.properties?.i as number;
    const pts = ctx.ui.editPts();
    if (!pts || idx == null) return;
    e.preventDefault();
    map.dragPan.disable();
    map.getCanvas().style.cursor = "grabbing";
    const before = pts.map((p) => [p[0], p[1]] as LngLat2);
    const onMove = (ev: maplibregl.MapMouseEvent) => {
      pts[idx] = [ev.lngLat.lng, ev.lngLat.lat];
      if (ctx.editStrokeId) ctx.ui.refreshStrokes();
      else redrawMeasure();
      ctx.ui.refreshStrokeVerts();
    };
    const onUp = () => {
      map.off("mousemove", onMove);
      map.dragPan.enable();
      map.getCanvas().style.cursor = ctx.ui.modeCursor();
      if (ctx.editStrokeId) saveVerts(ctx.editStrokeId, before, pts);
    };
    map.on("mousemove", onMove);
    // document statt map: Loslassen außerhalb der Karte darf den Drag nicht hängen lassen
    document.addEventListener("mouseup", onUp, { once: true, signal: sig });
  });

  // Touch: Stützpunkt mit einem Finger ziehen (zweiter Finger = Karte navigieren)
  map.on("touchstart", "strokeverts-hit", (e) => {
    if (e.points.length !== 1) return;
    const idx = e.features?.[0]?.properties?.i as number;
    const pts = ctx.ui.editPts();
    if (!pts || idx == null) return;
    e.preventDefault();
    ctx.vertTouchDrag = true;
    map.dragPan.disable();
    const before = pts.map((p) => [p[0], p[1]] as LngLat2);
    const onMove = (ev: maplibregl.MapTouchEvent) => {
      if (ev.points.length !== 1) return;
      pts[idx] = [ev.lngLat.lng, ev.lngLat.lat];
      if (ctx.editStrokeId) ctx.ui.refreshStrokes();
      else redrawMeasure();
      ctx.ui.refreshStrokeVerts();
    };
    map.on("touchmove", onMove);
    const end = () => {
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
      map.off("touchmove", onMove);
      ctx.vertTouchDrag = false;
      ctx.ui.syncDragPan();
      // bei touchcancel (Systemgeste/Anruf) trotzdem speichern — lokal ist der Punkt schon verschoben
      if (ctx.editStrokeId) saveVerts(ctx.editStrokeId, before, pts);
    };
    document.addEventListener("touchend", end, { signal: sig });
    document.addEventListener("touchcancel", end, { signal: sig });
  });
  map.on("dblclick", (e) => {
    if (ctx.mode === "line") {
      e.preventDefault();
      finishLine();
    } else if (ctx.mode === "measure") {
      e.preventDefault();
      commitMeasure();
    }
  });
  ctx.tools.line = {
    click: (e) => {
      const p: LngLat2 = [e.lngLat.lng, e.lngLat.lat];
      if (nearStart(p)) {
        closeLine(); // Klick auf den Startpunkt → Fläche
        return;
      }
      ctx.linePts.push(p);
      refreshLineDraft();
    },
  };
  ctx.tools.measure = {
    click: (e) => {
      ctx.measureActive.push([e.lngLat.lng, e.lngLat.lat]); // Linksklick verlängert
      redrawMeasure();
    },
  };
  Object.assign(ctx.ui, {
    positionLineDone,
    redrawMeasure,
    commitMeasure,
    finishLine,
    cancelLine,
    refreshLineDraft,
    strokeCommitted,
    renderMeasureX: () => renderMeasureX(),
    renderLineX: () => renderLineX(),
  });
}
