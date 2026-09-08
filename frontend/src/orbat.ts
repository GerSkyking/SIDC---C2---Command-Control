// ORBAT-Bibliothek (Missionsbau): globale Kräfteübersichten mit Baumstruktur.
import { api, type Me, type Orbat, type OrbatNode } from "./api";
import { langSelect, t, wireLangSelect } from "./i18n";
import { confirmDialog, toastError } from "./notify";
import { icon } from "./icons";
import { iconSrc } from "./sidc/symbol";
import { sidebar, themeSwitch, wireSidebar, wireThemeSwitch } from "./ui";

const AFFIL = ["friend", "hostile", "neutral", "unknown"] as const;
const OPEN_KEY = "sidc_orbat_open";

function openSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveOpen(s: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

export async function renderOrbatLibrary(app: HTMLElement, me: Me, selectedId?: string): Promise<void> {
  const list = await api.orbats().catch(() => [] as Orbat[]);
  const sel = selectedId && list.some((o) => o.id === selectedId) ? selectedId : list[0]?.id;
  const detail = sel ? await api.orbat(sel).catch(() => null) : null;

  app.innerHTML = `
   <div class="shell">
    ${sidebar("orbat", { isAdmin: me.role === "admin", username: me.username, isMissionBuilder: true })}
    <div class="shell-main">
    <div class="topbar"><strong>${t("nav.orbat")}</strong><span class="grow"></span>${themeSwitch()}${langSelect()}</div>
    <div class="orbat-wrap">
      <aside class="orbat-list">
        ${list
          .map(
            (o) =>
              `<a class="orbat-li ${o.id === sel ? "active" : ""}" href="#/orbat/${o.id}">
                 <span class="badge aff-${o.affiliation}">${t("orbat.aff." + o.affiliation)}</span>
                 <span class="grow">${o.name}</span>
               </a>`,
          )
          .join("") || `<p class="muted">${t("orbat.none")}</p>`}
        <div class="orbat-new">
          <input id="o-name" placeholder="${t("orbat.namePlaceholder")}" />
          <select id="o-aff">${AFFIL.map((a) => `<option value="${a}">${t("orbat.aff." + a)}</option>`).join("")}</select>
          <button class="primary" id="o-add">${t("common.create")}</button>
        </div>
      </aside>
      <section class="orbat-main">${detail ? "" : `<p class="muted">${t("orbat.pickOne")}</p>`}</section>
    </div>
    </div>
   </div>`;
  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);

  app.querySelector("#o-add")!.addEventListener("click", async () => {
    const name = (app.querySelector("#o-name") as HTMLInputElement).value.trim();
    if (!name) return;
    try {
      const o = await api.createOrbat({
        name,
        affiliation: (app.querySelector("#o-aff") as HTMLSelectElement).value,
      });
      location.hash = `#/orbat/${o.id}`;
    } catch (e) {
      toastError(e);
    }
  });

  if (detail) renderDetail(app.querySelector<HTMLElement>(".orbat-main")!, detail);
}

function renderDetail(host: HTMLElement, o: Orbat): void {
  const canEdit = o.level === "editor";
  const open = openSet();
  const nodes = o.nodes ?? [];
  const byParent = new Map<string, OrbatNode[]>();
  for (const n of nodes) {
    const k = n.parent_id ?? "";
    (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(n);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.ordering - b.ordering);

  // Summe der Ist-Stärke aller Nachfahren eines Knotens (für die "+N"-Anzeige)
  const descSum = (id: string): number =>
    (byParent.get(id) ?? []).reduce((a, n) => a + (n.qty_current ?? 0) + descSum(n.id), 0);

  const reload = async () => {
    const fresh = await api.orbat(o.id).catch(() => null);
    if (fresh) renderDetail(host, fresh);
  };
  const fail = (e: unknown) => toastError(e);

  const statusPill = (s: string) =>
    `<span class="st-pill st-${s}">${t("orbat.status." + s)}</span>`;
  const relSummary = (n: OrbatNode) => {
    if (!n.rel_visible) return `<span class="muted">${t("orbat.rel.hidden")}</span>`;
    const parts = [n.rel_show_type ? t("orbat.rel.type") : t("orbat.rel.exists")];
    if ((n.rel_strength ?? -1) >= 0) parts.push(`~${n.rel_strength}%`);
    return `<span class="rel-sum">${parts.join(" · ")}</span>`;
  };

  const nodeHtml = (n: OrbatNode, depth: number): string => {
    const kids = byParent.get(n.id) ?? [];
    const isOpen = open.has(n.id);
    return `
      <div class="orb-node" data-n="${n.id}" draggable="${canEdit}" style="margin-left:${depth * 1.2}rem">
        <div class="orb-row">
          ${kids.length ? `<button class="orb-tw" data-tw="${n.id}">${icon(isOpen ? "chevronDown" : "chevron", 14)}</button>` : `<span class="orb-tw"></span>`}
          <img class="orb-ico" src="${n.sidc ? iconSrc(n.sidc) : ""}" alt="" onerror="this.style.visibility='hidden'" />
          <span class="orb-name">${n.name}</span>
          <span class="orb-qty" title="${t("orbat.qtyCurrent")} / ${t("orbat.maxStrength")}${kids.length ? " (+ Untergliederungen)" : ""}">${n.qty_current ?? "?"}/${n.qty_planned ?? "?"}${kids.length ? ` <span class="orb-sub-sum">+${descSum(n.id)}</span>` : ""}</span>
          ${statusPill(n.status)}
          <span class="orb-rel">${relSummary(n)}</span>
          ${
            canEdit
              ? `<span class="orb-actions">
                   <button class="icon-btn" data-add="${n.id}" title="${t("orbat.addChild")}">${icon("plus", 14)}</button>
                   <button class="icon-btn" data-edit="${n.id}" title="${t("common.rename")}">${icon("edit", 14)}</button>
                   <button class="icon-btn" data-del="${n.id}" title="${t("common.delete")}">${icon("x", 14)}</button>
                 </span>`
              : ""
          }
        </div>
      </div>
      ${isOpen ? kids.map((k) => nodeHtml(k, depth + 1)).join("") : ""}`;
  };

  const roots = byParent.get("") ?? [];
  const leaves = nodes.filter((n) => !(byParent.get(n.id) ?? []).length);
  const sumCur = leaves.reduce((a, n) => a + (n.qty_current ?? 0), 0);
  const sumMax = leaves.reduce((a, n) => a + (n.qty_planned ?? 0), 0);
  host.innerHTML = `
    <div class="orb-head">
      <input class="orb-title" value="${o.name}" ${canEdit ? "" : "disabled"} />
      <select class="orb-aff" ${canEdit ? "" : "disabled"}>
        ${AFFIL.map((a) => `<option value="${a}" ${a === o.affiliation ? "selected" : ""}>${t("orbat.aff." + a)}</option>`).join("")}
      </select>
      ${o.is_owner ? `<button data-acl>${t("plans.shares")}</button>` : ""}
      ${o.is_owner ? `<button class="danger" data-delo>${t("common.delete")}</button>` : ""}
    </div>
    <textarea class="orb-notes" placeholder="${t("orbat.notes")}" ${canEdit ? "" : "readonly"}>${o.notes ?? ""}</textarea>
    <div class="orb-total">${t("orbat.totalStrength")}: <strong>${sumCur} / ${sumMax}</strong></div>
    <div class="orb-tree" data-drop-root>
      ${roots.map((r) => nodeHtml(r, 0)).join("") || `<p class="muted">${t("orbat.noNodes")}</p>`}
    </div>
    ${canEdit ? `<button id="orb-add-root">${t("orbat.addRoot")}</button>` : ""}`;

  // Kopf
  const title = host.querySelector<HTMLInputElement>(".orb-title")!;
  const aff = host.querySelector<HTMLSelectElement>(".orb-aff")!;
  const notes = host.querySelector<HTMLTextAreaElement>(".orb-notes")!;
  const saveHead = () =>
    api.patchOrbat(o.id, { name: title.value.trim() || o.name, affiliation: aff.value, notes: notes.value }).catch(fail);
  title.addEventListener("change", saveHead);
  aff.addEventListener("change", () => void reload().then(saveHead));
  notes.addEventListener("change", saveHead);
  host.querySelector("[data-delo]")?.addEventListener("click", async () => {
    if (!(await confirmDialog(t("orbat.confirmDelete"), { danger: true }))) return;
    await api.deleteOrbat(o.id).catch(fail);
    location.hash = "#/orbat";
  });
  host.querySelector("[data-acl]")?.addEventListener("click", () => openOrbatAcl(o.id));

  // Baum
  host.querySelectorAll<HTMLButtonElement>("[data-tw]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.tw!;
      open.has(id) ? open.delete(id) : open.add(id);
      saveOpen(open);
      renderDetail(host, o);
    }),
  );
  host.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((b) =>
    b.addEventListener("click", () => editNode(o.id, null, b.dataset.add!, reload)),
  );
  host.querySelector("#orb-add-root")?.addEventListener("click", () =>
    editNode(o.id, null, null, reload),
  );
  host.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => editNode(o.id, nodes.find((n) => n.id === b.dataset.edit)!, undefined, reload)),
  );
  host.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!(await confirmDialog(t("orbat.confirmDeleteNode"), { danger: true }))) return;
      await api.deleteNode(o.id, b.dataset.del!).catch(fail);
      void reload();
    }),
  );

  // Drag & Drop zum Umhängen
  if (canEdit) {
    host.querySelectorAll<HTMLElement>(".orb-node").forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        e.dataTransfer?.setData("text/plain", el.dataset.n!);
      });
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        el.classList.add("drop-hi");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-hi"));
      el.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("drop-hi");
        const src = e.dataTransfer?.getData("text/plain");
        if (src && src !== el.dataset.n) {
          await api.patchNode(o.id, src, { parent_id: el.dataset.n }).catch(fail);
          void reload();
        }
      });
    });
    const rootZone = host.querySelector<HTMLElement>("[data-drop-root]")!;
    rootZone.addEventListener("dragover", (e) => e.preventDefault());
    rootZone.addEventListener("drop", async (e) => {
      if ((e.target as HTMLElement).closest(".orb-node")) return;
      e.preventDefault();
      const src = e.dataTransfer?.getData("text/plain");
      if (src) {
        await api.patchNode(o.id, src, { parent_id: null }).catch(fail);
        void reload();
      }
    });
  }
}

function editNode(
  orbatId: string,
  existing: OrbatNode | null,
  parentId: string | null | undefined,
  onDone: () => void,
): void {
  const isNew = !existing;
  const n: Partial<OrbatNode> = existing
    ? { ...existing }
    : { name: "Einheit", sidc: "", qty_planned: 1, qty_current: 1, status: "active", rel_strength: 50 };
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card" style="width:min(30rem,96vw)">
    <div class="row"><h1 style="flex:1;margin:0">${isNew ? t("orbat.newNode") : t("orbat.editNode")}</h1>
      <button class="icon-btn" data-x>${icon("x")}</button></div>
    <label class="chk-lbl">${t("common.name")}<input data-f="name" value="${n.name ?? ""}" /></label>
    <label class="chk-lbl">${t("marker.heading")}
      <span class="orb-sym-pick">
        <img data-sym-prev width="30" height="30" src="${n.sidc ? iconSrc(n.sidc) : ""}" onerror="this.style.visibility='hidden'"/>
        <button type="button" data-sym-btn>${t("orbat.pickSymbol")}</button>
        <code data-sym-code>${n.sidc ?? ""}</code>
      </span>
    </label>
    <div class="row">
      <label class="chk-lbl" style="flex:1">${t("orbat.maxStrength")}<input type="number" min="0" data-f="qty_planned" value="${n.qty_planned ?? 1}" /></label>
      <label class="chk-lbl" style="flex:1">${t("orbat.qtyCurrent")}<input type="number" min="0" data-f="qty_current" value="${n.qty_current ?? 1}" /></label>
    </div>
    <label class="chk-lbl">${t("orbat.statusLabel")}
      <select data-f="status">${["active", "damaged", "destroyed"].map((s) => `<option value="${s}" ${s === n.status ? "selected" : ""}>${t("orbat.status." + s)}</option>`).join("")}</select>
    </label>
    <hr style="border-color:var(--border)"/>
    <div class="orb-rel-edit">
      <label class="chk"><input type="checkbox" data-f="rel_visible" ${existing?.rel_visible ? "checked" : ""}/> ${t("orbat.relVisible")}</label>
      <label class="chk"><input type="checkbox" data-f="rel_show_type" ${existing?.rel_show_type ? "checked" : ""}/> ${t("orbat.relShowType")}</label>
      <label class="chk-lbl">${t("orbat.relStrength")}
        <input type="range" min="-1" max="100" step="5" data-f="rel_strength" value="${n.rel_strength ?? 50}" />
        <span data-relv>${(n.rel_strength ?? 50) < 0 ? t("orbat.rel.hidden") : (n.rel_strength ?? 50) + "%"}</span>
      </label>
    </div>
    <label class="chk-lbl">${t("orbat.notes")}<textarea data-f="notes" rows="2">${n.notes ?? ""}</textarea></label>
    <div class="row" style="margin-top:.6rem"><button class="primary" data-save style="flex:1">${t("common.save")}</button></div>
  </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.querySelector("[data-x]")!.addEventListener("click", close);
  let symSidc = n.sidc ?? "";
  back.querySelector<HTMLButtonElement>("[data-sym-btn]")!.addEventListener("click", () => {
    void import("./sidc/builder").then(({ openMarkerBuilderModal }) =>
      openMarkerBuilderModal(symSidc, (s) => {
        symSidc = s;
        back.querySelector<HTMLImageElement>("[data-sym-prev]")!.src = iconSrc(s);
        back.querySelector<HTMLElement>("[data-sym-code]")!.textContent = s;
      }),
    );
  });
  const rel = back.querySelector<HTMLInputElement>('[data-f="rel_strength"]')!;
  const relv = back.querySelector<HTMLSpanElement>("[data-relv]")!;
  rel.addEventListener("input", () => {
    relv.textContent = Number(rel.value) < 0 ? t("orbat.rel.hidden") : rel.value + "%";
  });
  back.querySelector("[data-save]")!.addEventListener("click", async () => {
    const g = <T extends HTMLElement>(s: string) => back.querySelector<T>(`[data-f="${s}"]`)!;
    const body: Record<string, unknown> = {
      name: (g("name") as HTMLInputElement).value.trim() || "Einheit",
      sidc: symSidc,
      qty_planned: Number((g("qty_planned") as HTMLInputElement).value) || 0,
      qty_current: Number((g("qty_current") as HTMLInputElement).value) || 0,
      status: (g("status") as HTMLSelectElement).value,
      notes: (g("notes") as HTMLTextAreaElement).value,
      rel_visible: (g("rel_visible") as HTMLInputElement).checked,
      rel_show_type: (g("rel_show_type") as HTMLInputElement).checked,
      rel_strength: Number(rel.value),
    };
    try {
      if (isNew) await api.createNode(orbatId, { ...body, parent_id: parentId ?? null });
      else await api.patchNode(orbatId, existing!.id, body);
      close();
      onDone();
    } catch (e) {
      toastError(e);
    }
  });
}

function openOrbatAcl(orbatId: string): void {
  void api.orbatAcl(orbatId).then(({ entries, candidates }) => {
    const back = document.createElement("div");
    back.className = "edit-modal";
    let rows: any[] = entries.map((e) => ({ ...e }));
    const draw = () => {
      back.innerHTML = `<div class="card" style="width:min(38rem,96vw)">
        <div class="row"><h1 style="flex:1;margin:0">${t("orbat.aclTitle")}</h1><button class="icon-btn" data-x>${icon("x")}</button></div>
        <table class="acl-tbl"><thead><tr><th>${t("acl.who")}</th><th>${t("acl.role")}</th><th>${t("orbat.canPlace")}</th><th>${t("orbat.canMove")}</th><th></th></tr></thead><tbody>
        ${rows
          .map((r, i) => {
            const name = candidates.find((c: any) => c.subject_type === r.subject_type && c.subject_id === r.subject_id)?.name ?? r.subject_id.slice(0, 8);
            return `<tr>
              <td>${name}</td>
              <td><select data-i="${i}" data-f="level"><option value="viewer" ${r.level === "viewer" ? "selected" : ""}>${t("acl.role.viewer")}</option><option value="editor" ${r.level === "editor" ? "selected" : ""}>${t("acl.role.editor")}</option></select></td>
              <td><input type="checkbox" data-i="${i}" data-f="can_place" ${r.can_place ? "checked" : ""}/></td>
              <td><input type="checkbox" data-i="${i}" data-f="can_move" ${r.can_move ? "checked" : ""}/></td>
              <td><button class="icon-btn" data-del="${i}">${icon("x", 14)}</button></td>
            </tr>`;
          })
          .join("")}
        </tbody></table>
        <div class="row" style="margin-top:.5rem"><select data-add><option value="">${t("acl.addSubject")}</option>
          ${candidates.filter((c: any) => !rows.some((r) => r.subject_type === c.subject_type && r.subject_id === c.subject_id)).map((c: any) => `<option value="${c.subject_type}:${c.subject_id}">${c.name}</option>`).join("")}
        </select></div>
        <p class="muted">${t("orbat.aclHint")}</p>
        <div class="row" style="margin-top:.6rem"><button class="primary" data-save style="flex:1">${t("common.save")}</button></div>
      </div>`;
      back.querySelector("[data-x]")!.addEventListener("click", () => back.remove());
      back.querySelectorAll<HTMLElement>("[data-f]").forEach((el) =>
        el.addEventListener("change", () => {
          const i = Number(el.dataset.i);
          const f = el.dataset.f!;
          if (f === "level") rows[i].level = (el as HTMLSelectElement).value;
          else rows[i][f] = (el as HTMLInputElement).checked;
          draw();
        }),
      );
      back.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) =>
        b.addEventListener("click", () => {
          rows.splice(Number(b.dataset.del), 1);
          draw();
        }),
      );
      back.querySelector<HTMLSelectElement>("[data-add]")!.addEventListener("change", (e) => {
        const v = (e.target as HTMLSelectElement).value;
        if (!v) return;
        const [ty, id] = v.split(":");
        rows.push({ subject_type: ty, subject_id: id, level: "viewer", can_place: true, can_move: true });
        draw();
      });
      back.querySelector("[data-save]")!.addEventListener("click", async () => {
        try {
          await api.putOrbatAcl(orbatId, rows);
          back.remove();
        } catch (e) {
          toastError(e);
        }
      });
    };
    document.body.appendChild(back);
    back.addEventListener("mousedown", (e) => e.target === back && back.remove());
    draw();
  });
}
