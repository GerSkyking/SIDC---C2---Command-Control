// Baumansicht der Projekte: Ordner + Unterordner, Drag & Drop (Projekte UND Ordner),
// Zyklus-Schutz, Auto-Aufklappen. Optik/Verhalten wie planTree.ts. Reines Vanilla-DOM.
import { api, type ProjectFolder, type ProjectItem } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { confirmDialog, promptDialog, toastError } from "./notify";
import { esc } from "./esc";
import { relTime } from "./projectUtil";

interface TreeOpts {
  onChanged: () => void; // Daten neu laden (nach Änderungen am Server)
  onSelectFolder?: (id: string | null) => void; // gewählter Ordner = Ziel für „Neues Projekt"
  /** Admin oder Missionsbauer: darf Ordner anlegen */
  canCreateFolders: boolean;
  user: { id: string; isAdmin: boolean };
}

const OPEN_KEY = "sidc_pfolders_open";
const ROOT_KEY = "sidc_proot_open";
const SEL_KEY = "sidc_pfolder_selected";
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
/** Zuletzt gewählter Projekt-Ordner (null = „Alle Projekte"). */
export function selectedProjectFolder(): string | null {
  try {
    return localStorage.getItem(SEL_KEY) || null;
  } catch {
    return null;
  }
}
function setSelected(id: string | null): void {
  try {
    if (id) localStorage.setItem(SEL_KEY, id);
    else localStorage.removeItem(SEL_KEY);
  } catch {
    /* egal */
  }
}

/** Pfad „A / B / C" eines Ordners (für Anzeige des Ziels). */
export function projectFolderPath(folders: ProjectFolder[], id: string | null): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (let c = id ? byId.get(id) : undefined, n = 0; c && n < 30; n++) {
    parts.unshift(c.name);
    c = c.parent_id ? byId.get(c.parent_id) : undefined;
  }
  return parts.join(" / ");
}

export function renderProjectTree(
  host: HTMLElement,
  projects: ProjectItem[],
  folders: ProjectFolder[],
  opts: TreeOpts,
): void {
  const open = openSet();
  const byId = new Map(folders.map((f) => [f.id, f]));
  const subFolders = new Map<string, ProjectFolder[]>();
  for (const f of folders) {
    // Eltern, die nicht sichtbar sind, behandeln wir als oberste Ebene
    const k = f.parent_id && byId.has(f.parent_id) ? f.parent_id : "";
    (subFolders.get(k) ?? subFolders.set(k, []).get(k)!).push(f);
  }
  const folderProjects = new Map<string, ProjectItem[]>();
  for (const p of projects) {
    const k = p.folder_id && byId.has(p.folder_id) ? p.folder_id : "";
    (folderProjects.get(k) ?? folderProjects.set(k, []).get(k)!).push(p);
  }
  for (const list of subFolders.values()) list.sort((a, b) => (a.ordering ?? 0) - (b.ordering ?? 0) || a.name.localeCompare(b.name));
  for (const list of folderProjects.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  if (selectedProjectFolder() && !byId.has(selectedProjectFolder()!)) setSelected(null); // gewählter Ordner existiert nicht mehr

  const deepCount = (id: string): number =>
    (folderProjects.get(id) ?? []).length + (subFolders.get(id) ?? []).reduce((n, f) => n + deepCount(f.id), 0);
  /** Ist `maybeAncestor` gleich `id` oder ein Vorfahre davon? (Zyklus-Schutz) */
  const isSelfOrAncestor = (maybeAncestor: string, id: string | null): boolean => {
    let cur = id ? byId.get(id) : undefined;
    for (let n = 0; cur && n < 50; n++) {
      if (cur.id === maybeAncestor) return true;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return false;
  };
  /** Admin oder Ersteller; Alt-Ordner ohne Ersteller: jeder, der Ordner anlegen darf. Server entscheidet endgültig. */
  const canManageFolder = (f: ProjectFolder): boolean =>
    opts.user.isAdmin || (opts.canCreateFolders && (!f.created_by || f.created_by === opts.user.id));
  const canMoveProject = (p: ProjectItem): boolean => opts.user.isAdmin || p.role === "owner";

  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      opts.onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  const clearHi = () => host.querySelectorAll(".drop-hi").forEach((x) => x.classList.remove("drop-hi"));

  const applyDrop = (payload: string, targetFolderId: string | null) => {
    const idx = payload.indexOf(":");
    const kind = payload.slice(0, idx);
    const id = payload.slice(idx + 1);
    if (kind === "project") {
      const cur = projects.find((p) => p.id === id);
      if (!cur || (cur.folder_id ?? null) === targetFolderId) return; // schon dort
      void guard(() => api.moveProject(id, targetFolderId));
    } else if (kind === "folder") {
      if (isSelfOrAncestor(id, targetFolderId)) return; // nicht in sich selbst / einen Unterordner
      if ((byId.get(id)?.parent_id ?? null) === targetFolderId) return;
      void guard(() => api.moveProjectFolder(id, targetFolderId));
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

  const projectRow = (p: ProjectItem): HTMLElement => {
    const row = document.createElement("div");
    const movable = canMoveProject(p);
    row.className = "tree-row tree-project" + (p.archived ? " is-archived" : "");
    row.draggable = movable;
    row.innerHTML =
      (movable
        ? `<span class="tree-grip" title="${t("folder.dragHandle")}">${icon("drag", 14)}</span>`
        : `<span class="tree-grip tree-grip-off"></span>`) +
      `<span class="tree-ico">${icon("compass", 16)}</span>` +
      `<a href="#/projects/${esc(p.id)}" class="tree-name" title="${esc(t("proj.open"))}: ${esc(p.name)}">${esc(p.name)}</a>` +
      `<span class="badge">${esc(t("proj.role." + p.role))}</span>` +
      (p.archived ? `<span class="badge">${t("proj.archived")}</span>` : "") +
      `<span class="tree-desc muted" title="${esc(p.description)}">${esc(p.description)}</span>` +
      `<span class="tree-stats">` +
      `<span title="${t("proj.stat.plans")}">${icon("map", 13)} ${p.plan_count}</span>` +
      `<span title="${t("proj.stat.open")}">${icon("check", 13)} ${p.open_tasks}</span>` +
      `<span class="${p.my_open_tasks ? "proj-mine" : ""}" title="${t("proj.stat.mine")}">${icon("users", 13)} ${p.my_open_tasks}</span>` +
      `<span class="muted tree-when">${esc(relTime(p.updated_at))}</span>` +
      `</span>`;
    if (movable) {
      startDrag(row, `project:${p.id}`);
      // Auf ein Projekt fallen lassen = in dessen Ordner einsortieren
      wireDropzone(row, p.folder_id && byId.has(p.folder_id) ? p.folder_id : null);
    }
    return row;
  };

  const select = (id: string | null) => {
    setSelected(id);
    opts.onSelectFolder?.(id);
  };

  const renderChildren = (parentId: string, box: HTMLElement, depth: number) => {
    for (const f of subFolders.get(parentId) ?? []) {
      const isOpen = open.has(f.id);
      const manage = canManageFolder(f);
      const fRow = document.createElement("div");
      fRow.className = "tree-row tree-folder" + (selectedProjectFolder() === f.id ? " selected" : "");
      fRow.style.paddingLeft = `${0.6 + depth * 1.4}rem`;
      fRow.draggable = manage;
      const toggleTitle = isOpen ? t("common.collapse") : t("common.expand");
      fRow.innerHTML =
        (manage
          ? `<span class="tree-grip" title="${t("folder.dragHandle")}">${icon("drag", 14)}</span>`
          : `<span class="tree-grip tree-grip-off"></span>`) +
        `<button class="tree-tw icon-btn" title="${toggleTitle}" aria-label="${toggleTitle}">${icon(isOpen ? "chevronDown" : "chevron", 16)}</button>` +
        `<span class="tree-ico">${icon(isOpen ? "folderOpen" : "folder", 16)}</span><span class="tree-name">${esc(f.name)}</span>` +
        `<span class="tree-count" title="${t("pt.count")}">${deepCount(f.id)}</span>` +
        (manage
          ? `<span class="tree-actions">` +
            `<button class="icon-btn" data-newsub title="${t("pt.newSub")}" aria-label="${t("pt.newSub")}">${icon("plus", 16)}</button>` +
            `<button class="icon-btn" data-ren title="${t("common.rename")}" aria-label="${t("common.rename")}">${icon("edit", 16)}</button>` +
            `<button class="icon-btn" data-delf title="${t("common.delete")}" aria-label="${t("common.delete")}">${icon("x", 16)}</button></span>`
          : "");
      const setOpen = (v: boolean) => {
        if (v) open.add(f.id);
        else open.delete(f.id);
        saveOpen(open);
        paint();
      };
      if (manage) startDrag(fRow, `folder:${f.id}`);
      wireDropzone(fRow, f.id, () => {
        if (!open.has(f.id)) setOpen(true);
      });
      // Klick auf die Zeile: Ordner wählen (Ziel für „Neues Projekt") und auf-/zuklappen
      fRow.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".tree-actions")) return;
        select(f.id);
        setOpen(!isOpen);
      });
      fRow.querySelector("[data-newsub]")?.addEventListener("click", async () => {
        const name = await promptDialog(t("pt.namePrompt"));
        if (name && name.trim()) {
          open.add(f.id);
          saveOpen(open);
          void guard(() => api.createProjectFolder(name.trim(), f.id));
        }
      });
      fRow.querySelector("[data-ren]")?.addEventListener("click", async () => {
        const name = await promptDialog(t("pt.renamePrompt"), { value: f.name });
        if (name && name.trim() && name.trim() !== f.name) void guard(() => api.renameProjectFolder(f.id, name.trim()));
      });
      fRow.querySelector("[data-delf]")?.addEventListener("click", async () => {
        if (await confirmDialog(t("pt.confirmDelete"), { danger: true, trash: true })) {
          if (selectedProjectFolder() === f.id) select(null);
          void guard(() => api.deleteProjectFolder(f.id));
        }
      });
      box.appendChild(fRow);

      if (isOpen) {
        const kids = document.createElement("div");
        kids.className = "tree-kids";
        renderChildren(f.id, kids, depth + 1);
        for (const p of folderProjects.get(f.id) ?? []) {
          const pr = projectRow(p);
          pr.style.paddingLeft = `${0.6 + (depth + 1) * 1.4}rem`;
          kids.appendChild(pr);
        }
        if (!kids.childElementCount) {
          kids.innerHTML = `<div class="tree-empty" style="padding-left:${0.6 + (depth + 1) * 1.4}rem">${t("pt.empty")}</div>`;
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
    rootHead.className = "tree-row tree-root" + (selectedProjectFolder() === null ? " selected" : "");
    const rootToggle = isRootOpen ? t("common.collapse") : t("common.expand");
    rootHead.innerHTML =
      `<button class="tree-tw icon-btn" title="${rootToggle}" aria-label="${rootToggle}">${icon(isRootOpen ? "chevronDown" : "chevron", 16)}</button>` +
      `<span class="tree-ico">${icon(isRootOpen ? "folderOpen" : "folder", 16)}</span><span class="tree-name">${t("pt.root")}</span>` +
      `<span class="tree-count" title="${t("pt.count")}">${projects.length}</span>` +
      (opts.canCreateFolders || opts.user.isAdmin
        ? `<span class="tree-actions"><button id="ptree-newfolder" title="${t("pt.newHint")}">${icon("plus", 14)} ${t("pt.new")}</button></span>`
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
    rootHead.querySelector("#ptree-newfolder")?.addEventListener("click", async () => {
      const name = await promptDialog(t("pt.namePrompt"));
      if (name && name.trim()) void guard(() => api.createProjectFolder(name.trim(), null));
    });

    if (!isRootOpen) return;
    const body = document.createElement("div");
    body.className = "tree-body";
    wireDropzone(body, null); // freie Fläche im Baum = oberste Ebene
    renderChildren("", body, 1);
    for (const p of folderProjects.get("") ?? []) {
      const pr = projectRow(p);
      pr.style.paddingLeft = `${0.6 + 1.4}rem`;
      body.appendChild(pr);
    }
    if (!body.childElementCount) {
      body.innerHTML = `<div class="tree-empty">${t("pt.emptyRoot")}</div>`;
    } else if (folders.length || projects.length > 1) {
      const hint = document.createElement("div");
      hint.className = "tree-hint";
      hint.textContent = t("pt.dropHint");
      body.appendChild(hint);
    }
    host.appendChild(body);
  };

  paint();
}
