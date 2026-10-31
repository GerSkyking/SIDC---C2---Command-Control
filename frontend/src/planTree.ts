// Baumansicht der Pläne: Ordner + Unterordner, Drag & Drop zum Verschieben,
// Klonen (mit Zielordner). Reines Vanilla-DOM.
import { api, type PlanFolder, type PlanItem, type ProjectPlanItem } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { confirmDialog, promptDialog, toastError } from "./notify";
import { esc } from "./esc";

interface TreeOpts {
  onChanged: () => void; // Daten neu laden (nach Änderungen am Server)
  onDeletePlan: (p: PlanItem) => void;
  onOpenShares: (p: PlanItem) => void;
  onSelectFolder?: (id: string | null) => void; // gewählter Ordner = Ziel für „Neuer Plan"
  /** Projekt-Pläne, auf die der Nutzer per Plan-Freigabe Zugriff hat (schreibgeschützt unter „Projekte") */
  projectPlans?: ProjectPlanItem[];
  mapName?: (id: string) => string;
  /** Projekt-Ansicht: neue Ordner entstehen im Projekt, die Auswahl wird getrennt gemerkt */
  projectId?: string;
  /** Projekt-Ansicht: Plan aus dem Projekt lösen */
  onDetachPlan?: (p: PlanItem) => void;
  /** Aktueller Nutzer: Ordner-Aktionen (umbenennen/löschen/Unterordner) nur für Admin oder Ersteller (Server entscheidet endgültig) */
  user?: { id: string; isAdmin: boolean };
}

const OPEN_KEY = "sidc_folders_open";
const ROOT_KEY = "sidc_root_open";
const SEL_KEY = "sidc_folder_selected";
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
    /* egal */
  }
}
function rootOpen(): boolean {
  try {
    return localStorage.getItem(ROOT_KEY) !== "0";
  } catch {
    return true;
  }
}
function setRootOpen(v: boolean): void {
  try {
    localStorage.setItem(ROOT_KEY, v ? "1" : "0");
  } catch {
    /* egal */
  }
}
const PGRP_KEY = "sidc_pgroups_open"; // aufgeklappte Knoten unter „Projekte" („" = Projekte-Knoten, sonst Projekt-ID)
function pgroupOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PGRP_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function savePgroupOpen(s: Set<string>): void {
  try {
    localStorage.setItem(PGRP_KEY, JSON.stringify([...s]));
  } catch {
    /* egal */
  }
}
const selKey = (projectId?: string): string => (projectId ? `${SEL_KEY}:${projectId}` : SEL_KEY);
/** Zuletzt gewählter Ordner (null = „Alle Pläne"). */
export function selectedFolder(projectId?: string): string | null {
  try {
    return localStorage.getItem(selKey(projectId)) || null;
  } catch {
    return null;
  }
}
function setSelectedFolder(id: string | null, projectId?: string): void {
  try {
    if (id) localStorage.setItem(selKey(projectId), id);
    else localStorage.removeItem(selKey(projectId));
  } catch {
    /* egal */
  }
}

export function renderPlanTree(
  host: HTMLElement,
  plans: PlanItem[],
  folders: PlanFolder[],
  canCreateFolders: boolean,
  opts: TreeOpts,
): void {
  const open = openSet();
  const subFolders = new Map<string, PlanFolder[]>();
  for (const f of folders) {
    const k = f.parent_id ?? "";
    (subFolders.get(k) ?? subFolders.set(k, []).get(k)!).push(f);
  }
  const folderPlans = new Map<string, PlanItem[]>();
  for (const p of plans) {
    const k = p.folder_id ?? "";
    (folderPlans.get(k) ?? folderPlans.set(k, []).get(k)!).push(p);
  }
  for (const list of subFolders.values()) list.sort((a, b) => a.ordering - b.ordering || a.name.localeCompare(b.name));
  for (const list of folderPlans.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const byId = new Map(folders.map((f) => [f.id, f]));
  const pid = opts.projectId;
  const mkFolder = (name: string, parent: string | null) =>
    pid ? api.createFolderIn(name, parent, pid) : api.createFolder(name, parent);
  const sel0 = selectedFolder(pid);
  if (sel0 && !byId.has(sel0)) setSelectedFolder(null, pid); // gewählter Ordner existiert nicht mehr

  const depthOf = (id: string | null): number => {
    let d = 0;
    let cur = id ? byId.get(id) : undefined;
    while (cur?.parent_id) {
      d++;
      cur = byId.get(cur.parent_id);
    }
    return d;
  };
  /** Ist `maybeAncestor` gleich `id` oder ein Vorfahre davon? (Ordner nicht in sich selbst schieben) */
  const isSelfOrAncestor = (maybeAncestor: string, id: string | null): boolean => {
    let cur = id ? byId.get(id) : undefined;
    while (cur) {
      if (cur.id === maybeAncestor) return true;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return false;
  };
  const folderOptions = (selected: string | null): string =>
    `<option value="">${t("folder.root")}</option>` +
    [...folders]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (f) =>
          `<option value="${f.id}" ${f.id === selected ? "selected" : ""}>${"  ".repeat(depthOf(f.id))}${esc(f.name)}</option>`,
      )
      .join("");

  // Anzahl Pläne inkl. aller Unterordner
  const deepCount = (id: string): number =>
    (folderPlans.get(id) ?? []).length + (subFolders.get(id) ?? []).reduce((n, f) => n + deepCount(f.id), 0);

  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      opts.onChanged();
    } catch (e) {
      toastError(e);
    }
  };

  /** Admin oder Ersteller; Alt-Ordner ohne Ersteller: jeder, der Ordner anlegen darf */
  const canManageFolder = (f: PlanFolder): boolean =>
    canCreateFolders && (!opts.user || opts.user.isAdmin || !f.created_by || f.created_by === opts.user.id);

  const clearHi = () => host.querySelectorAll(".drop-hi").forEach((x) => x.classList.remove("drop-hi"));

  const applyDrop = (payload: string, targetFolderId: string | null) => {
    const [kind, id] = payload.split(":");
    if (kind === "plan") {
      const cur = plans.find((p) => p.id === id);
      if (cur && (cur.folder_id ?? null) === targetFolderId) return; // schon dort
      void guard(() => api.movePlan(id, targetFolderId));
    } else if (kind === "folder") {
      if (isSelfOrAncestor(id, targetFolderId)) return; // nicht in sich selbst / einen Unterordner
      if ((byId.get(id)?.parent_id ?? null) === targetFolderId) return;
      void guard(() => api.moveFolder(id, targetFolderId));
    }
  };

  let dragPayload = "";
  let hoverTimer: number | undefined;

  const wireDropzone = (el: HTMLElement, targetFolderId: string | null, autoOpen?: () => void) => {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (!el.classList.contains("drop-hi")) {
        clearHi();
        el.classList.add("drop-hi");
        window.clearTimeout(hoverTimer);
        if (autoOpen) hoverTimer = window.setTimeout(autoOpen, 700); // Ordner klappt beim Drüberhalten auf
      }
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove("drop-hi");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.clearTimeout(hoverTimer);
      clearHi();
      const payload = e.dataTransfer?.getData("text/plain") || dragPayload;
      if (payload) applyDrop(payload, targetFolderId);
    });
  };

  const startDrag = (el: HTMLElement, payload: string) => {
    el.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      dragPayload = payload;
      e.dataTransfer?.setData("text/plain", payload);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
      host.classList.add("is-dragging");
    });
    el.addEventListener("dragend", () => {
      dragPayload = "";
      window.clearTimeout(hoverTimer);
      el.classList.remove("dragging");
      host.classList.remove("is-dragging");
      clearHi();
    });
  };

  const planRow = (p: PlanItem): HTMLElement => {
    const row = document.createElement("div");
    row.className = "tree-row tree-plan";
    row.draggable = true;
    const canManage = p.level === "owner" || p.level === "editor";
    row.innerHTML =
      `<span class="tree-grip" title="${t("folder.dragHandle")}">${icon("drag", 14)}</span>` +
      `<img class="tree-thumb" src="/plans/${p.id}/thumbnail" alt="" data-hide-on-error="none" />` +
      `<a href="#/plans/${p.id}" class="tree-name" title="${t("plans.open")}">${esc(p.name)}</a>` +
      `<span class="badge">${p.level}</span>` +
      (opts.mapName ? `<span class="tree-map" title="${t("plans.map")}">${icon("map", 12)} ${esc(opts.mapName(p.map_id))}</span>` : "") +
      `<span class="tree-actions">` +
      (canManage
        ? `<select class="tree-move" title="${t("plans.moveTo")}" aria-label="${t("plans.moveTo")}">${folderOptions(p.folder_id)}</select>`
        : "") +
      (canManage
        ? `<button class="icon-btn" data-ren title="${t("common.rename")}" aria-label="${t("common.rename")}">${icon("edit", 16)}</button>`
        : "") +
      `<button data-clone title="${t("plans.cloneHint")}">${t("plans.clone")}</button>` +
      (opts.onDetachPlan && canManage
        ? `<button data-detach title="${t("proj.plans.detachHint")}">${t("proj.plans.detach")}</button>`
        : "") +
      (p.level === "owner"
        ? `<button data-shares title="${t("plans.sharesHint")}">${t("plans.shares")}</button>` +
          `<button class="icon-btn" data-del title="${t("common.delete")}" aria-label="${t("common.delete")}">${icon("trash", 16)}</button>`
        : "") +
      `</span>`;
    startDrag(row, `plan:${p.id}`);
    // Auf einen Plan fallen lassen = in dessen Ordner einsortieren
    wireDropzone(row, p.folder_id ?? null);
    row.querySelector<HTMLSelectElement>(".tree-move")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      void guard(() => api.movePlan(p.id, v || null));
    });
    row.querySelector("[data-ren]")?.addEventListener("click", async () => {
      const name = await promptDialog(t("plans.renamePrompt"), { value: p.name });
      if (name && name.trim() && name.trim() !== p.name) void guard(() => api.renamePlan(p.id, name.trim()));
    });
    row.querySelector("[data-clone]")!.addEventListener("click", () => cloneDialog(p, folders, guard));
    row.querySelector("[data-detach]")?.addEventListener("click", () => opts.onDetachPlan?.(p));
    row.querySelector("[data-shares]")?.addEventListener("click", () => opts.onOpenShares(p));
    row.querySelector("[data-del]")?.addEventListener("click", () => opts.onDeletePlan(p));
    return row;
  };

  /** Virtueller Ordner „Projekte → Projektname → Pläne": nur Lesen/Öffnen, Rechte regelt die Plan-Freigabe. */
  const renderProjectPlans = (box: HTMLElement) => {
    const pp = opts.projectPlans ?? [];
    if (!pp.length || pid) return;
    const po = pgroupOpen();
    const groups = new Map<string, { name: string; plans: ProjectPlanItem[] }>();
    for (const p of pp) {
      const g = groups.get(p.project_id ?? "") ?? { name: p.project_name, plans: [] };
      g.plans.push(p);
      groups.set(p.project_id ?? "", g);
    }
    const sorted = [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
    const folderRow = (key: string, label: string, count: number, depth: number, isOpen: boolean): HTMLElement => {
      const r = document.createElement("div");
      r.className = "tree-row tree-folder";
      r.style.paddingLeft = `${0.6 + depth * 1.4}rem`;
      const tw = isOpen ? t("common.collapse") : t("common.expand");
      r.innerHTML =
        `<span class="tree-grip tree-grip-off"></span>` +
        `<button class="tree-tw icon-btn" title="${tw}" aria-label="${tw}">${icon(isOpen ? "chevronDown" : "chevron", 16)}</button>` +
        `<span class="tree-ico">${icon(isOpen ? "folderOpen" : "folder", 16)}</span><span class="tree-name">${esc(label)}</span>` +
        `<span class="tree-count" title="${t("folder.count")}">${count}</span>`;
      r.addEventListener("click", () => {
        if (isOpen) po.delete(key);
        else po.add(key);
        savePgroupOpen(po);
        paint();
      });
      return r;
    };
    const readRow = (p: ProjectPlanItem, depth: number): HTMLElement => {
      const row = document.createElement("div");
      row.className = "tree-row tree-plan";
      row.style.paddingLeft = `${0.6 + depth * 1.4}rem`;
      row.innerHTML =
        `<span class="tree-grip tree-grip-off"></span>` +
        `<img class="tree-thumb" src="/plans/${p.id}/thumbnail" alt="" data-hide-on-error="none" />` +
        `<a href="#/plans/${p.id}" class="tree-name" title="${t("plans.open")}">${esc(p.name)}</a>` +
        `<span class="badge">${p.level}</span>` +
        (opts.mapName ? `<span class="tree-map" title="${t("plans.map")}">${icon("map", 12)} ${esc(opts.mapName(p.map_id))}</span>` : "") +
        `<span class="tree-actions">` +
        (p.level === "owner"
          ? `<button data-shares title="${t("plans.sharesHint")}">${t("plans.shares")}</button>`
          : "") +
        `</span>`;
      row.querySelector("[data-shares]")?.addEventListener("click", () => opts.onOpenShares(p));
      return row;
    };
    const topOpen = po.has("");
    box.appendChild(folderRow("", t("folder.projects"), pp.length, 1, topOpen));
    if (!topOpen) return;
    const kids = document.createElement("div");
    kids.className = "tree-kids";
    for (const [projId, g] of sorted) {
      const o = po.has(projId);
      kids.appendChild(folderRow(projId, g.name, g.plans.length, 2, o));
      if (o) {
        const inner = document.createElement("div");
        inner.className = "tree-kids";
        for (const p of g.plans.sort((a, b) => a.name.localeCompare(b.name))) inner.appendChild(readRow(p, 3));
        kids.appendChild(inner);
      }
    }
    box.appendChild(kids);
  };

  const select = (id: string | null) => {
    setSelectedFolder(id, pid);
    opts.onSelectFolder?.(id);
  };

  const renderChildren = (parentId: string, box: HTMLElement, depth: number) => {
    for (const f of subFolders.get(parentId) ?? []) {
      const isOpen = open.has(f.id);
      const fRow = document.createElement("div");
      fRow.className = "tree-row tree-folder" + (selectedFolder(pid) === f.id ? " selected" : "");
      fRow.style.paddingLeft = `${0.6 + depth * 1.4}rem`;
      fRow.draggable = true;
      const toggleTitle = isOpen ? t("common.collapse") : t("common.expand");
      fRow.innerHTML =
        `<span class="tree-grip" title="${t("folder.dragHandle")}">${icon("drag", 14)}</span>` +
        `<button class="tree-tw icon-btn" title="${toggleTitle}" aria-label="${toggleTitle}">${icon(isOpen ? "chevronDown" : "chevron", 16)}</button>` +
        `<span class="tree-ico">${icon(isOpen ? "folderOpen" : "folder", 16)}</span><span class="tree-name">${esc(f.name)}</span>` +
        `<span class="tree-count" title="${t("folder.count")}">${deepCount(f.id)}</span>` +
        (canManageFolder(f)
          ? `<span class="tree-actions">` +
            `<button class="icon-btn" data-newsub title="${t("folder.newSub")}" aria-label="${t("folder.newSub")}">${icon("plus", 16)}</button>` +
            `<button class="icon-btn" data-ren title="${t("common.rename")}" aria-label="${t("common.rename")}">${icon("edit", 16)}</button>` +
            `<button class="icon-btn" data-delf title="${t("common.delete")}" aria-label="${t("common.delete")}">${icon("x", 16)}</button></span>`
          : "");
      const setOpen = (v: boolean) => {
        if (v) open.add(f.id);
        else open.delete(f.id);
        saveOpen(open);
        paint();
      };
      startDrag(fRow, `folder:${f.id}`);
      wireDropzone(fRow, f.id, () => {
        if (!open.has(f.id)) setOpen(true);
      });
      // Klick auf die Zeile: Ordner wählen (Ziel für „Neuer Plan") und auf-/zuklappen
      fRow.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".tree-actions")) return;
        select(f.id);
        setOpen(!isOpen);
      });
      fRow.querySelector("[data-newsub]")?.addEventListener("click", async () => {
        const name = await promptDialog(t("folder.namePrompt"));
        if (name && name.trim()) {
          open.add(f.id);
          saveOpen(open);
          void guard(() => mkFolder(name.trim(), f.id));
        }
      });
      fRow.querySelector("[data-ren]")?.addEventListener("click", async () => {
        const name = await promptDialog(t("folder.renamePrompt"), { value: f.name });
        if (name && name.trim() && name !== f.name) void guard(() => api.renameFolder(f.id, name.trim()));
      });
      fRow.querySelector("[data-delf]")?.addEventListener("click", async () => {
        if (await confirmDialog(t("folder.confirmDelete"), { danger: true, trash: true })) {
          if (selectedFolder(pid) === f.id) select(null);
          void guard(() => api.deleteFolder(f.id));
        }
      });
      box.appendChild(fRow);

      if (isOpen) {
        const kids = document.createElement("div");
        kids.className = "tree-kids";
        renderChildren(f.id, kids, depth + 1);
        for (const p of folderPlans.get(f.id) ?? []) {
          const pr = planRow(p);
          pr.style.paddingLeft = `${0.6 + (depth + 1) * 1.4}rem`;
          kids.appendChild(pr);
        }
        if (!kids.childElementCount) {
          kids.innerHTML = `<div class="tree-empty" style="padding-left:${0.6 + (depth + 1) * 1.4}rem">${t("folder.empty")}</div>`;
        }
        box.appendChild(kids);
      }
    }
  };

  const paint = () => {
    window.clearTimeout(hoverTimer);
    host.innerHTML = "";
    const isRootOpen = rootOpen();
    const rootHead = document.createElement("div");
    rootHead.className = "tree-row tree-root" + (selectedFolder(pid) === null ? " selected" : "");
    const rootToggle = isRootOpen ? t("common.collapse") : t("common.expand");
    rootHead.innerHTML =
      `<button class="tree-tw icon-btn" title="${rootToggle}" aria-label="${rootToggle}">${icon(isRootOpen ? "chevronDown" : "chevron", 16)}</button>` +
      `<span class="tree-ico">${icon(isRootOpen ? "folderOpen" : "folder", 16)}</span><span class="tree-name">${t("folder.root")}</span>` +
      `<span class="tree-count" title="${t("folder.count")}">${plans.length}</span>` +
      (canCreateFolders
        ? `<span class="tree-actions"><button id="tree-newfolder" title="${t("folder.newHint")}">${icon("plus", 14)} ${t("folder.new")}</button></span>`
        : "");
    wireDropzone(rootHead, null, () => {
      if (!rootOpen()) {
        setRootOpen(true);
        paint();
      }
    });
    rootHead.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".tree-actions")) return;
      select(null);
      setRootOpen(!isRootOpen);
      paint();
    });
    host.appendChild(rootHead);
    rootHead.querySelector("#tree-newfolder")?.addEventListener("click", async () => {
      const name = await promptDialog(t("folder.namePrompt"));
      if (name && name.trim()) void guard(() => mkFolder(name.trim(), null));
    });

    if (!isRootOpen) return;
    const body = document.createElement("div");
    body.className = "tree-body";
    // Freie Fläche im Baum = oberste Ebene
    wireDropzone(body, null);
    renderChildren("", body, 1);
    for (const p of folderPlans.get("") ?? []) {
      const pr = planRow(p);
      pr.style.paddingLeft = `${0.6 + 1.4}rem`;
      body.appendChild(pr);
    }
    const hadOwn = body.childElementCount > 0;
    renderProjectPlans(body);
    if (!body.childElementCount) {
      body.innerHTML = `<div class="tree-empty">${t("folder.emptyRoot")}</div>`;
    } else if (hadOwn) {
      const hint = document.createElement("div");
      hint.className = "tree-hint";
      hint.textContent = t("folder.dropHint");
      body.appendChild(hint);
    }
    host.appendChild(body);
  };

  paint();
}

function cloneDialog(
  p: PlanItem,
  folders: PlanFolder[],
  guard: (fn: () => Promise<unknown>) => Promise<void>,
): void {
  const path = (f: PlanFolder): string => {
    const parts: string[] = [f.name];
    let cur = f.parent_id;
    const byId = new Map(folders.map((x) => [x.id, x]));
    while (cur) {
      const pf = byId.get(cur);
      if (!pf) break;
      parts.unshift(pf.name);
      cur = pf.parent_id;
    }
    return parts.join(" / ");
  };
  const back = document.createElement("div");
  back.className = "wiz-backdrop";
  back.innerHTML = `
    <div class="card stack" style="width:min(24rem,92vw)">
      <h1 style="margin:0">${t("plans.cloneTitle")}</h1>
      <label class="muted">${t("plans.cloneName")}</label>
      <input id="cl-name" value="${esc(p.name)} (Kopie)" />
      <label class="muted">${t("plans.cloneFolder")}</label>
      <select id="cl-folder">
        <option value="">${t("folder.root")}</option>
        ${folders.map((f) => `<option value="${f.id}" ${f.id === p.folder_id ? "selected" : ""}>${esc(path(f))}</option>`).join("")}
      </select>
      <label><input type="checkbox" id="cl-acl" /> ${t("plans.cloneAcl")}</label>
      <div class="row">
        <button class="primary" id="cl-go">${t("plans.clone")}</button>
        <button id="cl-x">${t("common.cancel")}</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("click", (e) => e.target === back && close());
  back.querySelector("#cl-x")!.addEventListener("click", close);
  back.querySelector("#cl-go")!.addEventListener("click", () => {
    const name = (back.querySelector("#cl-name") as HTMLInputElement).value.trim();
    if (!name) return;
    const folder = (back.querySelector("#cl-folder") as HTMLSelectElement).value || null;
    const acl = (back.querySelector("#cl-acl") as HTMLInputElement).checked;
    void guard(() => api.clonePlan(p.id, name, acl, folder));
    close();
  });
}
