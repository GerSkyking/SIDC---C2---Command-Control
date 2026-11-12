// Stern-Pin „Ort markieren": Dialog „Was ist hier / was soll hier passieren?" — legt wahlweise einen
// Verzeichnis-Eintrag, eine Aufgabe, eine Haftnotiz, einen Verweis oder reinen Text an; der Pin selbst
// ist eine Annotation, deren erste Zeile nur aus Verknüpfungs-Codes besteht.
import * as maplibregl from "maplibre-gl";
import { api, type ProjectTask } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { attachMdToolbar } from "../mdtoolbar";
import { renderMarkdown } from "../md";
import { toast, toastError } from "../notify";
import { DOC_TYPE_ICON, type DocType, templateContent } from "../projectTemplates";
import { openRefPicker } from "../refPicker";
import { cid } from "../ws";
import { STAR_SVG, type PlanCtx } from "./ctx";

export function initStarDialog(ctx: PlanCtx): void {
  const { map, socket, planId, projectId, isMB, caps, pendingStarZeus, pendingStarArea } = ctx;
  const { wireRefs } = ctx.model;
  /** Referenz-Pin: Annotation, deren Text nur den Verknüpfungs-Code enthält (Ebene = aktive Phase). */
  // ── Stern-Pin: „Ort markieren" → Was ist hier / was soll hier passieren? ──
  // Der Stern steht sofort auf der Karte (Entwurf), danach legt der Dialog wahlweise eine Aufgabe,
  // eine Haftnotiz oder einen Verweis auf Bestehendes an. Der Pin selbst ist eine Annotation, deren
  // erste Zeile nur aus Verknüpfungs-Codes besteht (Rest = Beschreibung).
  async function openStarDialog(pos: [number, number]): Promise<void> {
    if (!projectId) return;
    const pid = projectId;
    const mbDefault = isMB;
    const draftEl = document.createElement("div");
    draftEl.className = `star-pin star-draft ${mbDefault ? "star-mb" : ""}`;
    draftEl.innerHTML = STAR_SVG;
    const draft = new maplibregl.Marker({ element: draftEl }).setLngLat(pos).addTo(map);
    const [proj, assignees] = await Promise.all([
      api.project(pid).catch(() => null),
      api.projectAssignees(pid).catch((): { user_id: string; label: string }[] => []),
    ]);
    const canProj = !!proj && !proj.archived && (proj.role === "editor" || proj.role === "owner");
    // Warum nichts Neues angelegt werden kann: kein Projekt-Mitglied (Plan nur per Plan-Freigabe), nur Betrachter, archiviert
    const whyNot = canProj ? "" : !proj ? t("star.notMember") : proj.archived ? t("star.archived") : t("star.noProjectRole");
    const docSpace: "builder" | "public" = proj?.is_builder ? "builder" : "public";
    type Kind = "task" | "note" | "doc" | "link" | "text";
    // Neu im Verzeichnis: dieselben Kategorien wie im Projekt-Reiter „Verzeichnis“ (Ort vorausgewählt)
    const DIR_KINDS: DocType[] = ["place", "character", "faction", "scene", "mission", "opord", "briefing", ""];
    let docType: DocType = "place";
    // Ohne Projekt-Mitgliedschaft liefert auch die Projektsuche nichts: dann bleibt nur die Kartennotiz
    let kind: Kind = canProj ? "doc" : proj ? "link" : "text";
    let linkCode = "";
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    const lockAttr = (ok: boolean): string => (ok ? "" : `disabled title="${esc(whyNot)}"`);
    const kindBtn = (k: Kind, ic: string, ok: boolean): string =>
      `<button type="button" class="seg-btn" data-k="${k}" ${lockAttr(ok)}>${icon(ic, 14)} ${t("star.kind." + k)}</button>`;
    const dirBtn = (ty: DocType): string =>
      `<button type="button" class="seg-btn" data-k="doc" data-dt="${ty}" ${lockAttr(canProj)}>${icon(ty ? DOC_TYPE_ICON[ty] : "notes", 14)} ${
        ty ? t("dt." + ty) : t("star.dt.other")
      }</button>`;
    back.innerHTML = `<div class="card star-dlg" style="width:min(38rem,96vw)">
      <div class="row"><h1 style="flex:1;margin:0">${t("star.title")}</h1><button class="icon-btn" data-x title="${t("common.close")}">${icon("x")}</button></div>
      <p class="muted" style="margin:.2rem 0 .5rem">${t("star.intro")}</p>
      <div class="star-sec">${t("star.secDir")}</div>
      <div class="segmented star-kinds">${DIR_KINDS.map(dirBtn).join("")}</div>
      <div class="star-sec">${t("star.secMore")}</div>
      <div class="segmented star-kinds">${kindBtn("task", "check", canProj)}${kindBtn("note", "textbox", canProj)}${kindBtn("link", "link", !!proj)}${kindBtn("text", "edit", true)}</div>
      ${canProj ? "" : `<p class="star-why">${icon("lock", 13)} ${esc(whyNot)}</p>`}
      <p data-kdoc hidden class="muted" style="margin:.4rem 0 0;font-size:.78rem">${t(docSpace === "builder" ? "star.docBuilder" : "star.docPublic")}</p>
      <div data-klink hidden>
        <div class="row" style="margin-top:.5rem;gap:.4rem"><button type="button" data-pick>${icon("link", 14)} ${t("star.pickTarget")}</button><span data-picked class="muted">${t("star.nothingPicked")}</span></div>
      </div>
      <label style="margin-top:.5rem" data-ltitle>${t("star.what")}</label>
      <input data-stitle maxlength="200" placeholder="${t("star.whatPh")}"/>
      <label style="margin-top:.5rem" data-ldesc>${t("star.happens")}</label>
      <textarea data-sdesc rows="4" placeholder="${t("star.happensPh")}"></textarea>
      <div data-ktask class="row" style="gap:.5rem;margin-top:.5rem;flex-wrap:wrap">
        <label style="flex:1 1 10rem">${t("star.assignee")}<select data-sas><option value="">—</option>${assignees
          .map((u) => `<option value="${esc(u.user_id)}">${esc(u.label)}</option>`)
          .join("")}</select></label>
        <label style="flex:0 1 9rem">${t("star.due")}<input type="date" data-sdue/></label>
        <label style="flex:0 1 8rem">${t("star.prio")}<select data-sprio><option value="low">${t("star.prio.low")}</option><option value="normal" selected>${t("star.prio.normal")}</option><option value="high">${t("star.prio.high")}</option></select></label>
      </div>
      <label class="chk star-area-chk"><input type="checkbox" data-sarea/> ${t("area.afterCreate")}</label>
      ${ctx.ui.annotVisHtml({ phase_id: ctx.currentPhaseId || null, extra_phase_ids: [], zeus_released: false, zeus_until: null, mb: mbDefault })}
      <div class="row" style="margin-top:.8rem">
        <button class="primary" data-save style="flex:1">${t("star.create")}</button>
        <button data-cancel>${t("common.cancel")}</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    const titleIn = back.querySelector<HTMLInputElement>("[data-stitle]")!;
    const descIn = back.querySelector<HTMLTextAreaElement>("[data-sdesc]")!;
    attachMdToolbar(descIn, { projectId: pid, isBuilder: isMB });
    ctx.ui.wireAnnotVis(back);
    // Entwurfs-Stern färbt sich mit der gewählten Sichtbarkeit
    back.querySelectorAll<HTMLButtonElement>("[data-avis] [data-v]").forEach((b) =>
      b.addEventListener("click", () => draftEl.classList.toggle("star-mb", b.dataset.v === "mb")),
    );
    const showKind = (): void => {
      back
        .querySelectorAll<HTMLButtonElement>("[data-k]")
        .forEach((b) => b.classList.toggle("active", b.dataset.k === kind && (kind !== "doc" || b.dataset.dt === docType)));
      back.querySelector<HTMLElement>("[data-ktask]")!.hidden = kind !== "task";
      back.querySelector<HTMLElement>("[data-klink]")!.hidden = kind !== "link";
      back.querySelector<HTMLElement>("[data-kdoc]")!.hidden = kind !== "doc";
      back.querySelector<HTMLElement>("[data-ltitle]")!.textContent = t(
        kind === "link" ? "star.whatOptional" : kind === "doc" ? "star.name" : "star.what",
      );
      // Bei Verzeichnis-Einträgen (Person, Ort …) ist es eine Beschreibung, bei Aufgaben/Notizen der Auftrag
      back.querySelector<HTMLElement>("[data-ldesc]")!.textContent = t(kind === "doc" ? "star.describe" : "star.happens");
    };
    back.querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) =>
      b.addEventListener("click", () => {
        kind = b.dataset.k as Kind;
        if (kind === "doc") docType = (b.dataset.dt ?? "") as DocType;
        showKind();
      }),
    );
    const pick = async (): Promise<void> => {
      const code = await openRefPicker({ projectId: pid, mode: "insert", isBuilder: isMB });
      if (!code) return;
      linkCode = code;
      const sp = back.querySelector<HTMLElement>("[data-picked]")!;
      sp.classList.remove("muted");
      sp.innerHTML = renderMarkdown(code);
      wireRefs(sp);
    };
    back.querySelector("[data-pick]")!.addEventListener("click", () => void pick());
    showKind();
    setTimeout(() => titleIn.focus(), 0);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || document.querySelector(".rp-back")) return;
      e.stopPropagation();
      close();
    };
    const close = (): void => {
      draft.remove();
      back.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("mousedown", (e) => e.target === back && close());
    back.querySelector("[data-x]")!.addEventListener("click", close);
    back.querySelector("[data-cancel]")!.addEventListener("click", close);
    const saveBtn = back.querySelector<HTMLButtonElement>("[data-save]")!;
    saveBtn.addEventListener("click", async () => {
      const title = titleIn.value.trim();
      const desc = descIn.value.trim();
      if (kind !== "link" && !title) {
        titleIn.focus();
        toast(t("star.needTitle"), { kind: "error" });
        return;
      }
      if (kind === "link" && !linkCode) {
        toast(t("star.needTarget"), { kind: "error" });
        return;
      }
      const vis = ctx.ui.readAnnotVis(back, null);
      const mb = vis.mb_layer === true;
      saveBtn.disabled = true;
      let text = "";
      try {
        if (kind === "task") {
          const tk = await api.createProjectTask(pid, {
            title,
            description: desc,
            priority: back.querySelector<HTMLSelectElement>("[data-sprio]")!.value as ProjectTask["priority"],
            assignee_id: back.querySelector<HTMLSelectElement>("[data-sas]")!.value || null,
            due_date: back.querySelector<HTMLInputElement>("[data-sdue]")!.value || null,
            plan_id: planId,
          });
          text = `{{task:${tk.id}}}`;
        } else if (kind === "note") {
          const n = await api.createProjectNote(pid, {
            text: desc ? `${title}\n\n${desc}` : title,
            color: mb ? "pink" : "yellow",
            x: 40 + Math.round(Math.random() * 400),
            y: 40 + Math.round(Math.random() * 300),
          });
          text = `{{note:${n.id}}}`;
        } else if (kind === "doc") {
          // Neue Datei aus Vorlage; die Beschreibung landet unter der Vorlage, der Plan als Verweis darunter
          const ty = docType;
          const content =
            templateContent(ty, title).trimEnd() + (desc ? `\n\n${desc}` : "") + `\n\n---\n${t("star.docOnMap")} {{plan:${planId}}}\n`;
          const d = await api.createProjectDoc(pid, { space: docSpace, kind: "doc", name: title, content, doc_type: ty });
          text = `{{doc:${d.id}}}`;
        } else if (kind === "link") {
          text = [linkCode, title ? `**${title}**` : "", desc].filter(Boolean).join("\n\n");
        } else {
          text = [`## ${title}`, desc].filter(Boolean).join("\n\n");
        }
      } catch (e) {
        saveBtn.disabled = false;
        toastError(e);
        return;
      }
      const ac = cid();
      const { zeus_released: zRel, zeus_hours: zH, ...visCreate } = vis;
      socket.send({
        type: "annotation.create",
        cid: ac,
        data: {
          world_x: pos[0],
          world_y: pos[1],
          text,
          width: kind === "text" ? 240 : 160,
          ref_zoom: map.getZoom(),
          ...visCreate,
        },
      });
      // Zeus-Freigabe ist ein Feld von annotation.modify: nach dem Anlegen nachreichen
      if (mb && zRel) pendingStarZeus.set(ac, { zeus_released: true, zeus_hours: zH });
      // „Danach Bereich zeichnen": sobald der Server den Pin bestätigt, startet das Zeichnen um ihn herum
      if (back.querySelector<HTMLInputElement>("[data-sarea]")?.checked) pendingStarArea.add(ac);
      close();
      if (kind === "task" || kind === "note" || kind === "doc")
        toast(t(kind === "task" ? "star.taskDone" : kind === "note" ? "star.noteDone" : "star.docDone"), { kind: "success" });
    });
  }
  ctx.tools.ref = {
    click: (e) => {
      ctx.ui.setMode("move");
      if (caps.place && projectId) void openStarDialog([e.lngLat.lng, e.lngLat.lat]);
    },
  };
}
