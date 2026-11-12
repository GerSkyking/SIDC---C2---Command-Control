// Marker: setzen (Position → Wizard, Favoriten/Vorlagen, Mehrpunkt-Ketten), Hover-Info mit Aktions-Icons,
// Ziehen (Werkzeug „Marker verschieben“ / mittlere Maustaste) und das Marker-Bearbeiten-Panel.
import * as maplibregl from "maplibre-gl";
import { api } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { confirmDialog, promptDialog, toastError } from "../notify";
import { layerSelectHtml, phaseMultiHtml, readPhaseMulti } from "../sidc/layerui";
import { isTextMarker, withModifiers, type SidcModifiers } from "../sidc/sidc";
import { iconSrc } from "../sidc/symbol";
import { openWizard, type MarkerTemplate } from "../sidc/wizard";
import { cid } from "../ws";
import type { Marker, PlanCtx } from "./ctx";

export function initMarkers(ctx: PlanCtx): void {
  const { map, socket, root, markers, caps, isMB, sig, modCat, subCatBySidc } = ctx;
  const { zeusBlocked, tplCtx, phaseOpacity, markerLabel, markerInfoText, phaseNameOf, selectablePhases, samePlanePhases } = ctx.model;
  function placeMarker(pos: [number, number], tpl: MarkerTemplate): void {
    if (zeusBlocked()) return;
    const data: Record<string, unknown> = {
      sidc: tpl.sidc,
      world_x: pos[0],
      world_y: pos[1],
      unit_text: tpl.unit_text,
      ai_text: tpl.ai_text,
      locked: tpl.locked,
      timestamp_visible: tpl.timestamp_visible,
      rotation_degrees: tpl.rotation_degrees,
      phase_id: ctx.currentPhaseId || null,
    };
    if (tpl.layer_id) data.layer_id = tpl.layer_id;
    if (tpl.extra_phase_ids?.length) data.extra_phase_ids = tpl.extra_phase_ids;
    if (tpl.tint) data.tint = tpl.tint;
    if (tpl.orbat_node_id) {
      data.orbat_node_id = tpl.orbat_node_id;
      data.orbat_strength = tpl.orbat_strength ?? 1;
    }
    if (ctx.chainGroup != null) {
      data.linked_group_id = ctx.chainGroup;
      data.point_index = ctx.chainIndex;
      if (ctx.chainIndex === 0) {
        data.line_color = ctx.lineColor;
        data.line_width = ctx.lineWidth;
      }
      ctx.chainIndex++;
    }
    socket.send({ type: "marker.create", cid: cid(), data });
  }
  root.querySelector("#tool-marker")!.addEventListener("click", () => {
    ctx.pending = null;
    ctx.pendingPos = null;
    ctx.ui.setMode("place"); // Karte fixiert, Fadenkreuz — jetzt Position klicken
    ctx.awaitingPos = true;
  });
  // ── Karten-Interaktion ────────────────────────────────────────────────
  let suppressClick = false;
  // Touch: ein Tipp auf einen Marker zeigt nur die Hover-Info (mit den Aktions-Icons), öffnet nicht das Bearbeiten
  let lastTouchAt = 0;
  map.getCanvas().addEventListener("touchstart", () => (lastTouchAt = Date.now()), { passive: true });
  const isTouchTap = () => Date.now() - lastTouchAt < 1000;
  const onMarkerClick = (e: maplibregl.MapLayerMouseEvent) => {
    if (ctx.dragId || suppressClick) return; // gerade verschoben
    e.preventDefault();
    const id = e.features?.[0]?.properties?.id as string;
    const m = markers.get(id);
    if (!m) return;
    if (isTouchTap()) {
      showHover(e);
      return;
    }
    if (m.released) return; // freigegebene Feind-Marker sind nur Anzeige
    if (ctx.mode === "move" || ctx.mode === "markermove") {
      openEditPanel(m);
    }
  };
  map.on("click", "marker-icon", onMarkerClick);
  map.on("click", "marker-dot", onMarkerClick); // Marker ohne PNG-Icon klickbar halten
  map.on("click", "marker-textmark", onMarkerClick); // Nur-Text-Marker

  // Marker ziehen (siehe unten) — früh deklariert, weil der Hover-Handler prüft.
  map.on("click", (e) => {
    if (!isTouchTap()) return;
    if (!map.queryRenderedFeatures(e.point, { layers: ["marker-icon", "marker-dot", "marker-textmark"] }).length) hideHoverNow();
  });

  // Hover: Channel / Ersteller / Phase des Markers
  const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
  let hoverHideTimer = 0;
  // Marker per Aktions-Icon verschieben: folgt der Maus (Dokument-Listener, weil das Popup
  // mit dem Marker wandert und unter dem Zeiger liegt), loslassen setzt ihn ab.
  const startIconDrag = (id: string, ev: MouseEvent) => {
    const m = markers.get(id);
    if (!m || m.locked || !caps.move) return;
    ev.preventDefault();
    const fromX = m.world_x;
    const fromY = m.world_y;
    ctx.dragId = id;
    map.dragPan.disable();
    hoverPopup.remove();
    map.getCanvas().style.cursor = "grabbing";
    const toLL = (e: MouseEvent) => {
      const r = map.getCanvas().getBoundingClientRect();
      return map.unproject([e.clientX - r.left, e.clientY - r.top]);
    };
    const onMove = (e: MouseEvent) => {
      const ll = toLL(e);
      m.world_x = ll.lng;
      m.world_y = ll.lat;
      ctx.ui.redrawMarkersOnly();
    };
    // Erst der nächste Klick setzt den Marker ab (Escape bricht ab); dieser Klick selbst gehört nicht der Karte.
    const finish = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      ctx.dragId = null;
      if (ctx.mode === "move") map.dragPan.enable();
      map.getCanvas().style.cursor = ctx.ui.modeCursor();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      finish();
      m.world_x = fromX;
      m.world_y = fromY;
      ctx.ui.redrawMarkersOnly();
    };
    const onClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      finish();
      const ll = toLL(e);
      socket.send({ type: "marker.move", id, world_x: ll.lng, world_y: ll.lat });
      ctx.ui.pushCmd({
        undo: () => socket.send({ type: "marker.move", id, world_x: fromX, world_y: fromY }),
        redo: () => socket.send({ type: "marker.move", id, world_x: ll.lng, world_y: ll.lat }),
      });
    };
    document.addEventListener("mousemove", onMove, { signal: sig });
    document.addEventListener("keydown", onKey, { capture: true, signal: sig });
    setTimeout(() => document.addEventListener("click", onClick, { capture: true, signal: sig }), 0);
  };
  const showHover = (e: maplibregl.MapLayerMouseEvent) => {
    if (ctx.dragId) return;
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const m = id ? markers.get(id) : undefined;
    // Komplett ausgeblendete Marker (Opacity 0 — fremde Phase/Ebene/Channel) zeigen
    // keine Hover-Info, auch wenn ihre Trefferfläche noch da ist.
    if (!m || phaseOpacity(m) <= 0) return;
    window.clearTimeout(hoverHideTimer);
    ctx.hoverMarkerId = m.id;
    map.getCanvas().style.cursor = "pointer";
    const info = ctx.showMarkerInfo ? markerInfoText(m.sidc) : "";
    // setDOMContent statt setHTML: keine HTML-Zeichenkette -> kein Sanitizer-Pfad,
    // Werte landen ausschließlich als textContent.
    const tip = document.createElement("div");
    tip.className = "mk-tip";
    const b = document.createElement("b");
    b.textContent = markerLabel(m) || "—";
    tip.append(b, document.createElement("br"));
    const lyName = ctx.tacLayers.find((l) => l.id === m.layer_id)?.name;
    for (const [k, v] of [
      ...(lyName ? [[t("wiz.layer"), lyName]] : []),
      [t("marker.author"), m.author || "—"],
      [t("phase.assign"), phaseNameOf(m.phase_id)],
    ] as [string, string][]) {
      tip.append(`${k}: ${v}`, document.createElement("br"));
    }
    if (info) {
      const d = document.createElement("div");
      d.className = "mk-tip-info";
      d.textContent = info;
      tip.append(d);
    }
    // Aktions-Icons: Löschen · Verschieben · Bearbeiten
    if (!m.released) {
      const acts = document.createElement("div");
      acts.className = "mk-acts";
      const mkBtn = (ic: string, title: string, ok: boolean, cls = ""): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `icon-btn ${cls}`.trim();
        b.title = title;
        b.disabled = !ok;
        b.innerHTML = icon(ic, 16);
        return b;
      };
      const del = mkBtn("trash", t("common.delete"), caps.delete && !m.locked, "mk-act-del");
      const mv = mkBtn("markerMove", t("tool.markermove"), caps.move && !m.locked);
      const ed = mkBtn("edit", t("common.rename"), caps.move);
      del.addEventListener("click", async () => {
        hideHoverNow();
        if (!(await confirmDialog(t("marker.confirmDelete"), { danger: true, trash: true }))) return;
        socket.send({ type: "marker.delete", id: m.id });
      });
      mv.addEventListener("click", (ev) => startIconDrag(m.id, ev));
      ed.addEventListener("click", () => {
        hideHoverNow();
        void openEditPanel(m);
      });
      acts.append(del, mv, ed);
      tip.append(acts);
    }
    tip.addEventListener("mouseenter", () => window.clearTimeout(hoverHideTimer));
    tip.addEventListener("mouseleave", () => hideHover());
    window.clearTimeout(hoverHideTimer);
    hoverPopup.setLngLat([m.world_x, m.world_y]).setDOMContent(tip).addTo(map);
  };
  const hideHoverNow = () => {
    window.clearTimeout(hoverHideTimer);
    ctx.hoverMarkerId = null;
    map.getCanvas().style.cursor = ctx.ui.modeCursor(); // nicht hart auf Default zurück
    hoverPopup.remove();
  };
  // verzögert, damit der Zeiger vom Marker aufs Popup (mit den Icons) wandern kann
  const hideHover = () => {
    window.clearTimeout(hoverHideTimer);
    hoverHideTimer = window.setTimeout(hideHoverNow, 350);
  };
  for (const ly of ["marker-icon", "marker-dot", "marker-textmark"]) {
    map.on("mouseenter", ly, showHover);
    map.on("mouseleave", ly, hideHover);
  }

  // Marker ziehen: im Modus "markermove" (linke Taste) ODER im Karten-Modus mit
  // gehaltener mittlerer Maustaste.
  const onMarkerMouseDown = (e: maplibregl.MapLayerMouseEvent) => {
    const midBtn = e.originalEvent.button === 1;
    const wantDrag = caps.move && (ctx.mode === "markermove" || (ctx.mode === "move" && midBtn));
    if (!wantDrag) return;
    const id = e.features?.[0]?.properties?.id as string;
    const m = id ? markers.get(id) : undefined;
    if (!m || m.locked) return;
    e.preventDefault();
    e.originalEvent.preventDefault(); // Mittelklick-Autoscroll unterdrücken
    const dragFromX = m.world_x;
    const dragFromY = m.world_y;
    ctx.dragId = id;
    map.dragPan.disable();
    map.getCanvas().style.cursor = "grabbing";
    const onMove = (ev: maplibregl.MapMouseEvent) => {
      const mm = markers.get(ctx.dragId!);
      if (!mm) return;
      mm.world_x = ev.lngLat.lng;
      mm.world_y = ev.lngLat.lat;
      ctx.ui.redrawMarkersOnly();
    };
    const onUp = (ev: MouseEvent) => {
      map.off("mousemove", onMove);
      const finished = ctx.dragId;
      ctx.dragId = null;
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      if (ctx.mode === "move") map.dragPan.enable();
      map.getCanvas().style.cursor = ctx.ui.modeCursor();
      if (finished) {
        const cr = map.getCanvas().getBoundingClientRect();
        const ll = map.unproject([ev.clientX - cr.left, ev.clientY - cr.top]);
        const ax = ll.lng;
        const ay = ll.lat;
        socket.send({ type: "marker.move", id: finished, world_x: ax, world_y: ay });
        ctx.ui.pushCmd({
          undo: () => socket.send({ type: "marker.move", id: finished, world_x: dragFromX, world_y: dragFromY }),
          redo: () => socket.send({ type: "marker.move", id: finished, world_x: ax, world_y: ay }),
        });
      }
    };
    map.on("mousemove", onMove);
    // document statt map: Loslassen außerhalb der Karte darf dragId nicht hängen lassen
    document.addEventListener("mouseup", onUp, { once: true, signal: sig });
  };
  map.on("mousedown", "marker-icon", onMarkerMouseDown);
  map.on("mousedown", "marker-dot", onMarkerMouseDown);
  map.on("mousedown", "marker-textmark", onMarkerMouseDown);
  // Mittelklick auf dem Canvas nie als Browser-Autoscroll interpretieren
  map.getCanvas().addEventListener("mousedown", (ev) => {
    if (ev.button === 1) ev.preventDefault();
  });
  // Mittlere Maustaste ziehen = Karte schieben, auch wenn das Werkzeug die Karte fixiert
  // (Zeigen, Linie, Lineal, Radierer …). Im Karten-Werkzeug wird so ein Marker gezogen — dort nicht.
  map.getCanvas().addEventListener("mousedown", (ev) => {
    if (ev.button !== 1 || ctx.mode === "move" || ctx.dragId) return;
    let lx = ev.clientX;
    let ly = ev.clientY;
    const onMove = (e: MouseEvent) => {
      map.panBy([lx - e.clientX, ly - e.clientY], { animate: false });
      lx = e.clientX;
      ly = e.clientY;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove, { signal: sig });
    document.addEventListener("mouseup", onUp, { signal: sig });
  });
  // Marker-Wizard an einer bereits gewählten Position öffnen (Klick im Platzier-Modus / Rechtsklick-Menü)
  function startPlaceAt(pos: [number, number]): void {
    ctx.awaitingPos = false;
    ctx.pendingPos = pos;
    let picked = false;
    openWizard(root, (tpl) => {
      picked = true;
      ctx.pending = tpl;
      ctx.chainGroup = tpl.is_multipoint ? Math.floor(Math.random() * 1e9) : null;
      ctx.chainIndex = 0;
      placeMarker(ctx.pendingPos ?? pos, tpl); // sofort an der geklickten Position
      if (!tpl.is_multipoint) ctx.ui.setMode("move");
    }, {
      ...tplCtx(),
      onClose: () => {
        if (!picked && ctx.mode === "place") ctx.awaitingPos = true; // Abbruch: gleich wieder Position wählen
      },
    });
  }
  // ── Marker-Edit-Panel (zentriertes Fenster, Klick außerhalb schließt) ──
  async function openEditPanel(m: Marker): Promise<void> {
    root.querySelector("#editModal")?.remove();
    if (isMB) await ctx.ui.ensureOrbatCache();
    root.querySelector("#editModal")?.remove(); // Doppelklick: zweiter Aufruf ist während des await dazugekommen
    const m0 = { ...m }; // Stand beim Öffnen des Formulars
    const orbatNodeOpts = isMB
      ? ctx.planOrbatCache
          .flatMap((o) => (o.nodes ?? []).map((n) => ({ id: n.id, label: `${o.name} · ${n.name}` })))
      : [];
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.id = "editModal";
    const p = document.createElement("div");
    p.className = "edit-panel";

    // Advanced: Modifikatoren des Markers aus dem SIDC lesen + bearbeiten
    const subCat = subCatBySidc.get(m.sidc.slice(4, 6) + m.sidc.slice(10, 16));
    const modDefs = subCat && modCat ? modCat[subCat] : null;
    const MOD_KEY: Record<string, keyof SidcModifiers> = { modifier1: "m1", modifier2: "m2", modifier3: "m3", modifier4: "m4" };
    const MOD_LBL: Record<string, string> = {
      modifier1: t("wiz.modifier1"), modifier2: t("wiz.modifier2"), modifier3: t("wiz.modifier3"), modifier4: t("wiz.modifier4"),
    };
    const curMods: SidcModifiers = {
      m4: Number(m.sidc[6]) || 0,
      m3: Number(m.sidc[7]) || 0,
      m1: Number(m.sidc.slice(16, 18)) || 0,
      m2: Number(m.sidc.slice(18, 20)) || 0,
    };
    const advHtml =
      modDefs && ["modifier1", "modifier2", "modifier3", "modifier4"].some((g) => (modDefs[g] ?? []).length)
        ? `<details class="edit-adv"><summary>${t("wiz.advanced")}</summary>` +
          ["modifier1", "modifier2", "modifier3", "modifier4"]
            .filter((g) => (modDefs[g] ?? []).length)
            .map((g) => {
              const key = MOD_KEY[g];
              const cur = curMods[key] ?? 0;
              return `<label>${MOD_LBL[g]}</label><select data-mod="${key}"><option value="0">—</option>${modDefs[g]
                .map((o) => `<option value="${o.code}" ${o.code === cur ? "selected" : ""}>${esc(o.description)}</option>`)
                .join("")}</select>`;
            })
            .join("") +
          `</details>`
        : "";

    p.innerHTML = `
      <div class="fav-head"><img class="edit-ico" src="${esc(iconSrc(m.sidc))}" width="26" height="26" data-hide-on-error/> ${t("marker.heading")}</div>
      <label>${t("marker.unitText")}</label><input data-unit value="${esc(m.unit_text)}" />
      <label>${t("marker.aiText")}</label><input data-ai value="${esc(m.ai_text)}" />
      <label>${t("marker.iconRot")}</label><input data-rot type="number" value="${m.icon_rotation || 0}" />
      <label>${isTextMarker(m.sidc) ? t("marker.textColor") : t("marker.color")}</label>
      <div class="row"><input type="color" data-tint value="${esc(m.tint || (isTextMarker(m.sidc) ? "#e6e9ee" : "#000000"))}" />
        <button type="button" data-tint-reset>${t("marker.colorReset")}</button></div>
      <label class="ph-op">${t("marker.scale")}
        <input type="range" min="25" max="300" step="5" data-mscale value="${Math.round((m.scale ?? 1) * 100)}" />
        <span data-mscalev>${Math.round((m.scale ?? 1) * 100)}%</span></label>
      <label>${t("phase.assign")}</label>
      <select data-phase>
        ${selectablePhases()
          .map(
            (ph) =>
              `<option value="${esc(ph.id)}" ${ph.id === m.phase_id ? "selected" : ""}>${ph.plane === "builder" ? "⚑ " : ""}${esc(ph.name)}</option>`,
          )
          .join("")}
      </select>
      <label>${t("phase.extra")}</label>
      ${phaseMultiHtml("data-xphases", samePlanePhases(m.phase_id), m.extra_phase_ids ?? [], m.phase_id)}
      <label>${t("wiz.layer")}</label>${layerSelectHtml("data-layer", ctx.tacLayers, m.layer_id)}
      <label class="chk"><input type="checkbox" data-lock ${m.locked ? "checked" : ""}/> <span>${t("marker.locked")}</span></label>
      ${
        isMB
          ? `<label>${t("orbat.nodeLink")}</label>
             <select data-onode>
               <option value="">${t("orbat.nodeNone")}</option>
               ${orbatNodeOpts
                 .map((o) => `<option value="${esc(o.id)}" ${o.id === m.orbat_node_id ? "selected" : ""}>${esc(o.label)}</option>`)
                 .join("")}
             </select>
             <label>${t("orbat.markerStrength")}</label>
             <input data-ostr type="number" min="1" value="${m.orbat_strength ?? 1}" />`
          : ""
      }
      ${advHtml}
      <div class="row">
        <button class="primary" data-apply>${t("common.apply")}</button>
        <button data-fav>${t("fav.add")}</button>
        <button data-clone>${t("marker.clone")}</button>
        <button class="danger" data-del>${icon("trash", 14)} ${t("common.delete")}</button>
      </div>`;
    back.appendChild(p);

    const readModSel = (): SidcModifiers => {
      const s: SidcModifiers = {};
      p.querySelectorAll<HTMLSelectElement>("[data-mod]").forEach((sel) => {
        // 0 = "kein Modifikator" muss die SIDC-Stelle aktiv zurücksetzen, nicht ignorieren
        s[sel.dataset.mod as keyof SidcModifiers] = Number(sel.value) || 0;
      });
      return s;
    };
    const nextSidc = () => withModifiers(m.sidc, readModSel());
    let tint = m.tint || "";
    const tintIn = p.querySelector<HTMLInputElement>("[data-tint]")!;
    const refreshIco = () => {
      p.querySelector<HTMLImageElement>(".edit-ico")!.src = iconSrc(nextSidc(), 28, tint || undefined);
    };
    tintIn.addEventListener("input", () => {
      tint = tintIn.value;
      refreshIco();
    });
    p.querySelector("[data-tint-reset]")!.addEventListener("click", () => {
      tint = "";
      tintIn.value = isTextMarker(m.sidc) ? "#e6e9ee" : "#000000";
      refreshIco();
    });
    p.querySelectorAll<HTMLSelectElement>("[data-mod]").forEach((sel) =>
      sel.addEventListener("change", refreshIco),
    );
    if (tint) refreshIco();
    root.appendChild(back);
    {
      const phSel = p.querySelector<HTMLSelectElement>("[data-phase]")!;
      phSel.addEventListener("change", () => {
        const host = p.querySelector<HTMLElement>("[data-xphases]");
        if (!host) return;
        const cur = readPhaseMulti(p, "data-xphases");
        host.outerHTML = phaseMultiHtml("data-xphases", samePlanePhases(phSel.value || null), cur, phSel.value || null);
      });
    }
    {
      const ms = p.querySelector<HTMLInputElement>("[data-mscale]")!;
      const mv = p.querySelector<HTMLSpanElement>("[data-mscalev]")!;
      ms.addEventListener("input", () => (mv.textContent = `${ms.value}%`));
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const close = () => {
      back.remove();
      document.removeEventListener("keydown", onEsc); // auch beim Schließen per Übernehmen/Löschen/Klick daneben
    };
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) close();
    });
    document.addEventListener("keydown", onEsc, { signal: sig });
    p.querySelector("[data-apply]")!.addEventListener("click", () => {
      const data: Record<string, unknown> = {
        unit_text: p.querySelector<HTMLInputElement>("[data-unit]")!.value,
        ai_text: p.querySelector<HTMLInputElement>("[data-ai]")!.value,
        icon_rotation: Number(p.querySelector<HTMLInputElement>("[data-rot]")!.value) || 0,
        phase_id: p.querySelector<HTMLSelectElement>("[data-phase]")!.value || ctx.currentPhaseId || null,
        layer_id: p.querySelector<HTMLSelectElement>("[data-layer]")
          ? p.querySelector<HTMLSelectElement>("[data-layer]")!.value || null
          : (m.layer_id ?? null),
        extra_phase_ids: readPhaseMulti(p, "data-xphases"),
        scale: Math.max(0.25, Math.min(3, Number(p.querySelector<HTMLInputElement>("[data-mscale]")!.value) / 100 || 1)),
        tint,
        ...(modDefs ? { sidc: nextSidc() } : {}),
        ...(isMB
          ? {
              orbat_node_id: p.querySelector<HTMLSelectElement>("[data-onode]")!.value || null,
              orbat_strength: Math.max(1, Number(p.querySelector<HTMLInputElement>("[data-ostr]")!.value) || 1),
            }
          : {}),
      };
      const wantLock = p.querySelector<HTMLInputElement>("[data-lock]")!.checked;
      const mid = m.id;
      // Nur Felder senden, die im Formular tatsächlich geändert wurden (m0 = Stand beim Öffnen) —
      // sonst überschreibt "Übernehmen" zwischenzeitliche Änderungen anderer Spieler mit dem alten Stand.
      const norm = (v: unknown): string => JSON.stringify(v === "" || v === undefined ? null : v);
      const m0r = m0 as unknown as Record<string, unknown>;
      for (const k of Object.keys(data)) if (norm(data[k]) === norm(m0r[k])) delete data[k];
      const lockChanged = wantLock !== !!m0.locked;
      if (!Object.keys(data).length && !lockChanged) {
        close();
        return;
      }
      // Undo-Basis = aktueller Stand (nicht der beim Öffnen gemerkte)
      const curM = (markers.get(mid) ?? m) as unknown as Record<string, unknown>;
      const beforeData: Record<string, unknown> = {};
      for (const k of Object.keys(data)) beforeData[k] = curM[k];
      const beforeLock = !!curM.locked;
      if (Object.keys(data).length) socket.send({ type: "marker.modify", id: mid, data });
      if (lockChanged) socket.send({ type: "marker.lock", id: mid, locked: wantLock });
      ctx.ui.pushCmd({
        undo: () => {
          if (Object.keys(beforeData).length) socket.send({ type: "marker.modify", id: mid, data: beforeData });
          if (lockChanged) socket.send({ type: "marker.lock", id: mid, locked: beforeLock });
        },
        redo: () => {
          if (Object.keys(data).length) socket.send({ type: "marker.modify", id: mid, data });
          if (lockChanged) socket.send({ type: "marker.lock", id: mid, locked: wantLock });
        },
      });
      close();
    });
    p.querySelector("[data-del]")!.addEventListener("click", () => {
      socket.send({ type: "marker.delete", id: m.id });
      close();
    });
    p.querySelector("[data-clone]")!.addEventListener("click", () => {
      ctx.chainGroup = null;
      ctx.ui.setMode("place");
      ctx.awaitingPos = false;
      ctx.pending = {
        sidc: m.sidc,
        unit_text: m.unit_text,
        ai_text: m.ai_text,
        layer_id: m.layer_id,
        extra_phase_ids: m.extra_phase_ids ?? [],
        locked: m.locked,
        timestamp_visible: true,
        rotation_degrees: m.rotation_degrees,
        tint: m.tint || "",
        is_multipoint: false,
        max_line_points: 0,
      };
      close();
    });
    p.querySelector("[data-fav]")!.addEventListener("click", async () => {
      const label = await promptDialog(t("fav.labelPrompt"), { value: m.unit_text || m.sidc.slice(0, 8) });
      if (!label) return;
      try {
        await api.addFavorite({
          label,
          sidc: m.sidc,
          rotation_degrees: m.rotation_degrees,
          unit_text: m.unit_text,
          ai_text: m.ai_text,
          channel: m.channel,
          tint: m.tint || "",
          is_multipoint: m.linked_group_id != null && m.linked_group_id >= 0,
          max_line_points: 0,
        });
        await ctx.ui.reloadFavs();
      } catch (err) {
        toastError(err);
      }
    });
  }
  ctx.tools.place = {
    click: (e) => {
      const pos: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (ctx.awaitingPos) {
        startPlaceAt(pos);
        return;
      }
      if (ctx.pending) {
        placeMarker(pos, ctx.pending);
        const done =
          !ctx.pending.is_multipoint || (ctx.pending.max_line_points > 0 && ctx.chainIndex >= ctx.pending.max_line_points);
        if (done) ctx.ui.setMode("move");
      }
    },
  };
  Object.assign(ctx.ui, { placeMarker, startPlaceAt, openEditPanel });
}
