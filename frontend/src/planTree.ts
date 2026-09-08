// Baumansicht der Pläne: Ordner + Unterordner, Drag & Drop zum Verschieben,
// Klonen (mit Zielordner). Reines Vanilla-DOM.
import { api, ApiError, type PlanFolder, type PlanItem } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";

interface TreeOpts {
  onChanged: () => void; // neu laden
  onDeletePlan: (p: PlanItem) => void;
  onOpenShares: (p: PlanItem) => void;
}

const OPEN_KEY = "sidc_folders_open";
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

  // Flache, eingerückte Ordnerliste für die „Verschieben nach"-Auswahl
  const byId = new Map(folders.map((f) => [f.id, f]));
  const depthOf = (id: string | null): number => {
    let d = 0;
    let cur = id ? byId.get(id) : undefined;
    while (cur?.parent_id) {
      d++;
      cur = byId.get(cur.parent_id);
    }
    return d;
  };
  const folderOptions = (selected: string | null): string =>
    `<option value="">${t("folder.root")}</option>` +
    [...folders]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (f) =>
          `<option value="${f.id}" ${f.id === selected ? "selected" : ""}>${"  ".repeat(depthOf(f.id))}${f.name}</option>`,
      )
      .join("");

  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      opts.onChanged();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : t("common.error"));
    }
  };

  const applyDrop = (payload: string, targetFolderId: string | null) => {
    const [kind, id] = payload.split(":");
    if (kind === "plan") void guard(() => api.movePlan(id, targetFolderId));
    else if (kind === "folder" && id !== targetFolderId)
      void guard(() => api.moveFolder(id, targetFolderId));
  };

  const wireDropzone = (el: HTMLElement, targetFolderId: string | null) => {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("drop-hi");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-hi"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drop-hi");
      const payload = e.dataTransfer?.getData("text/plain");
      if (payload) applyDrop(payload, targetFolderId);
    });
  };

  const planRow = (p: PlanItem): HTMLElement => {
    const row = document.createElement("div");
    row.className = "tree-row tree-plan";
    row.draggable = true;
    const canManage = p.level === "owner" || p.level === "editor";
    row.innerHTML =
      `<img class="tree-thumb" src="/plans/${p.id}/thumbnail" alt="" onerror="this.style.display='none'" />` +
      `<a href="#/plans/${p.id}" class="tree-name">${p.name}</a>` +
      `<span class="badge">${p.level}</span>` +
      `<span class="tree-actions">` +
      (canManage
        ? `<select class="tree-move" title="${t("plans.moveTo")}">${folderOptions(p.folder_id)}</select>`
        : "") +
      (canManage
        ? `<button class="icon-btn" data-ren title="${t("common.rename")}">${icon("edit", 16)}</button>`
        : "") +
      `<button data-clone>${t("plans.clone")}</button>` +
      (p.level === "owner"
        ? `<button data-shares>${t("plans.shares")}</button>` +
          `<button class="icon-btn" data-del title="${t("common.delete")}">${icon("trash", 16)}</button>`
        : "") +
      `</span>`;
    row.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/plain", `plan:${p.id}`));
    row.querySelector<HTMLSelectElement>(".tree-move")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      void guard(() => api.movePlan(p.id, v || null));
    });
    row.querySelector("[data-ren]")?.addEventListener("click", () => {
      const name = prompt(t("plans.renamePrompt"), p.name);
      if (name && name.trim() && name.trim() !== p.name) void guard(() => api.renamePlan(p.id, name.trim()));
    });
    row.querySelector("[data-clone]")!.addEventListener("click", () => cloneDialog(p, folders, guard));
    row.querySelector("[data-shares]")?.addEventListener("click", () => opts.onOpenShares(p));
    row.querySelector("[data-del]")?.addEventListener("click", () => opts.onDeletePlan(p));
    return row;
  };

  const renderChildren = (parentId: string, box: HTMLElement, depth: number) => {
    for (const f of subFolders.get(parentId) ?? []) {
      const isOpen = open.has(f.id);
      const fRow = document.createElement("div");
      fRow.className = "tree-row tree-folder";
      fRow.style.paddingLeft = `${depth * 1.1}rem`;
      fRow.draggable = true;
      fRow.innerHTML =
        `<button class="tree-tw icon-btn">${icon(isOpen ? "chevronDown" : "chevron", 16)}</button>` +
        `<span class="tree-ico">${icon(isOpen ? "folderOpen" : "folder", 16)}</span><span class="tree-name">${f.name}</span>` +
        `<span class="tree-count">${(folderPlans.get(f.id) ?? []).length}</span>` +
        (canCreateFolders
          ? `<span class="tree-actions">` +
            `<button class="icon-btn" data-newsub title="${t("folder.newSub")}">${icon("plus", 16)}</button>` +
            `<button class="icon-btn" data-ren title="${t("common.rename")}">${icon("edit", 16)}</button>` +
            `<button class="icon-btn" data-delf title="${t("common.delete")}">${icon("x", 16)}</button></span>`
          : "");
      fRow.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        e.dataTransfer?.setData("text/plain", `folder:${f.id}`);
      });
      wireDropzone(fRow, f.id);
      fRow.querySelector(".tree-tw")!.addEventListener("click", () => {
        if (isOpen) open.delete(f.id);
        else open.add(f.id);
        saveOpen(open);
        opts.onChanged();
      });
      fRow.querySelector("[data-newsub]")?.addEventListener("click", () => {
        const name = prompt(t("folder.namePrompt"));
        if (name) void guard(() => api.createFolder(name, f.id));
      });
      fRow.querySelector("[data-ren]")?.addEventListener("click", () => {
        const name = prompt(t("folder.renamePrompt"), f.name);
        if (name && name !== f.name) void guard(() => api.renameFolder(f.id, name));
      });
      fRow.querySelector("[data-delf]")?.addEventListener("click", () => {
        if (confirm(t("folder.confirmDelete"))) void guard(() => api.deleteFolder(f.id));
      });
      box.appendChild(fRow);

      if (isOpen) {
        const kids = document.createElement("div");
        kids.className = "tree-kids";
        renderChildren(f.id, kids, depth + 1);
        for (const p of folderPlans.get(f.id) ?? []) {
          const pr = planRow(p);
          pr.style.paddingLeft = `${(depth + 1) * 1.1}rem`;
          kids.appendChild(pr);
        }
        box.appendChild(kids);
      }
    }
  };

  host.innerHTML = "";
  const rootHead = document.createElement("div");
  rootHead.className = "tree-row tree-root";
  rootHead.innerHTML =
    `<span class="tree-ico">${icon("map", 16)}</span><span class="tree-name">${t("folder.root")}</span>` +
    (canCreateFolders ? `<span class="tree-actions"><button id="tree-newfolder">${t("folder.new")}</button></span>` : "");
  wireDropzone(rootHead, null);
  host.appendChild(rootHead);
  rootHead.querySelector("#tree-newfolder")?.addEventListener("click", () => {
    const name = prompt(t("folder.namePrompt"));
    if (name) void guard(() => api.createFolder(name, null));
  });

  const body = document.createElement("div");
  body.className = "tree-body";
  renderChildren("", body, 0);
  for (const p of folderPlans.get("") ?? []) body.appendChild(planRow(p));
  if (!body.childElementCount) {
    body.innerHTML = `<div class="muted" style="padding:.5rem">${t("folder.dropHint")}</div>`;
  }
  host.appendChild(body);
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
      <input id="cl-name" value="${p.name} (Kopie)" />
      <label class="muted">${t("plans.cloneFolder")}</label>
      <select id="cl-folder">
        <option value="">${t("folder.root")}</option>
        ${folders.map((f) => `<option value="${f.id}" ${f.id === p.folder_id ? "selected" : ""}>${path(f)}</option>`).join("")}
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
