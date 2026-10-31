// Missionsbau-Projekte: Projektliste (#/projects) und Projektrahmen mit Tabs (#/projects/<id>/<tab>).
import { api, type Me, type PlanFolder, type PlanItem, type ProjectDetail, type ProjectFolder, type ProjectItem, type ProjectStorageRow } from "./api";
import { openAclEditor } from "./acl";
import { esc } from "./esc";
import { icon } from "./icons";
import { langSelect, t, wireLangSelect } from "./i18n";
import { a11yModal, confirmDialog, toast, toastError } from "./notify";
import { renderPlanTree } from "./planTree";
import { projectFolderPath, renderProjectTree, selectedProjectFolder } from "./projectTree";
import { type ProjCtx, fmtBytes } from "./projectUtil";
import { openSettings } from "./settings";
import { getLastProject, setLastProject, sidebar, themeSwitch, wireSidebar, wireThemeSwitch } from "./ui";

type Tab = "overview" | "public" | "builder" | "plans" | "tasks" | "whiteboard" | "members";
const TABS: { id: Tab; ic: string; key: string }[] = [
  { id: "overview", ic: "compass", key: "proj.tab.overview" },
  { id: "public", ic: "notes", key: "proj.tab.public" },
  { id: "builder", ic: "lock", key: "proj.tab.builder" },
  { id: "plans", ic: "map", key: "proj.tab.plans" },
  { id: "tasks", ic: "check", key: "proj.tab.tasks" },
  { id: "whiteboard", ic: "textbox", key: "proj.tab.whiteboard" },
  { id: "members", ic: "users", key: "proj.tab.members" },
];

function shell(me: Me, title: string, body: string, crumbs = ""): string {
  return `
   <div class="shell">
    ${sidebar("projects", { isAdmin: me.role === "admin", username: me.display_name || me.username, isMissionBuilder: me.is_mission_builder_effective })}
    <div class="shell-main">
    <div class="topbar">
      ${crumbs || `<strong>${esc(title)}</strong>`}
      <span class="grow"></span>
      ${themeSwitch()}${langSelect()}
      <button class="icon-btn" id="settingsBtn" title="${t("settings.open")}" aria-label="${t("settings.open")}">${icon("settings")}</button>
    </div>
    ${body}
    </div>
   </div>`;
}

function wireShell(app: HTMLElement): void {
  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);
  app.querySelector("#settingsBtn")?.addEventListener("click", openSettings);
}

/** Zuletzt geöffnetes Projekt beim Nutzer merken (Sidebar-Link „Missionsbau" öffnet es direkt). */
function rememberProject(id: string): void {
  if (getLastProject() === id) return;
  setLastProject(id);
  void api.saveSettings({ last_project: id || null }).catch(() => {});
}

export async function renderProjects(app: HTMLElement, me: Me, id?: string, tab?: string): Promise<void> {
  if (!id) return renderList(app, me);
  return renderProject(app, me, id, tab);
}

// ─── Projektliste ─────────────────────────────────────────────────────────

async function renderList(app: HTMLElement, me: Me): Promise<void> {
  const isAdmin = me.role === "admin";
  const canCreate = isAdmin || me.is_mission_builder_effective;
  let list: ProjectItem[] = [];
  let folders: ProjectFolder[] = [];
  let loadErr = "";
  folders = await api.projectFolderList().catch((): ProjectFolder[] => []);
  try {
    list = await api.projects();
  } catch (e) {
    loadErr = e instanceof Error ? e.message : String(e);
  }
  const storage: ProjectStorageRow[] = isAdmin ? await api.adminProjectStorage().catch(() => []) : [];
  let showArchived = false;
  try {
    showArchived = localStorage.getItem("sidc_proj_archived") === "1";
  } catch {
    /* ignore */
  }

  /** Zielordner für „Projekt anlegen" anzeigen (= im Baum gewählter Ordner) */
  const showTarget = () => {
    const el = app.querySelector<HTMLElement>("#pj-target");
    if (!el) return;
    const sel = selectedProjectFolder();
    el.textContent = `${t("pt.target")}: ${sel ? projectFolderPath(folders, sel) : t("pt.targetRoot")}`;
    el.title = t("pt.targetHint");
  };
  const reloadTree = async () => {
    try {
      [list, folders] = await Promise.all([api.projects(), api.projectFolderList().catch((): ProjectFolder[] => [])]);
    } catch (e) {
      toastError(e);
    }
    if (app.querySelector("#projTree")) paint();
  };

  const paint = () => {
    const vis = list.filter((p) => showArchived || !p.archived);
    const nArch = list.filter((p) => p.archived).length;
    const host = app.querySelector<HTMLElement>("#projTree")!;
    if (!vis.length && !folders.length) {
      host.innerHTML = `<div class="proj-empty">${icon("folder", 36)}<h3>${t("proj.empty")}</h3><p class="muted">${
        canCreate ? t("proj.emptyCreate") : t("proj.emptyMember")
      }</p></div>`;
    } else {
      renderProjectTree(host, vis, folders, {
        canCreateFolders: canCreate,
        user: { id: me.id, isAdmin },
        onChanged: () => void reloadTree(),
        onSelectFolder: () => showTarget(),
      });
    }
    showTarget();
    const tg = app.querySelector<HTMLElement>("#projArch");
    if (tg) {
      tg.hidden = nArch === 0;
      tg.querySelector("input")!.checked = showArchived;
      tg.querySelector("span")!.textContent = `${t("proj.showArchived")} (${nArch})`;
    }
  };

  app.innerHTML = shell(
    me,
    t("proj.heading"),
    `<div class="list stack proj-list">
      ${loadErr ? `<p class="error">${esc(loadErr)}</p>` : ""}
      <p class="muted">${t("proj.intro")}</p>
      ${
        canCreate
          ? `<section class="create-card">
               <h2>${t("proj.newTitle")}</h2>
               <p class="muted">${t("proj.newHint")}</p>
               <div class="create-grid">
                 <div class="field"><label for="pj-name">${t("proj.name")}</label>
                   <input id="pj-name" maxlength="120" placeholder="${t("proj.namePh")}" autocomplete="off" /></div>
                 <div class="field"><label for="pj-desc">${t("proj.desc")}</label>
                   <input id="pj-desc" placeholder="${t("proj.descPh")}" autocomplete="off" /></div>
               </div>
               <div class="create-actions">
                 <button class="primary" id="pj-go" title="${t("proj.create")}">${icon("plus", 14)} ${t("proj.create")}</button>
                 <span class="create-target" id="pj-target"></span>
                 <span class="create-msg" id="pj-msg" role="status"></span>
               </div>
             </section>`
          : ""
      }
      <label class="proj-arch" id="projArch" hidden><input type="checkbox" /> <span></span></label>
      <div class="plan-tree proj-tree" id="projTree" role="tree" aria-label="${t("pt.treeLabel")}"></div>
      ${
        isAdmin
          ? `<section class="proj-storage"><h2>${icon("download", 16)} ${t("admin.storage")}</h2>
              ${
                storage.length
                  ? `<table class="acl-tbl"><tbody>${storage
                      .slice(0, 6)
                      .map(
                        (r) =>
                          `<tr><td style="text-align:left"><a href="#/projects/${esc(r.project_id)}">${esc(r.name)}</a></td><td>${fmtBytes(r.total_bytes)}</td></tr>`,
                      )
                      .join("")}</tbody></table>
                    <a href="#/admin/storage">${t("proj.storageAll")}</a>`
                  : `<p class="muted">${t("admin.storage.empty")}</p>`
              }</section>`
          : ""
      }
    </div>`,
  );
  wireShell(app);
  paint();
  app.querySelector("#projArch input")?.addEventListener("change", (e) => {
    showArchived = (e.target as HTMLInputElement).checked;
    try {
      localStorage.setItem("sidc_proj_archived", showArchived ? "1" : "0");
    } catch {
      /* ignore */
    }
    paint();
  });
  const go = async () => {
    const name = app.querySelector<HTMLInputElement>("#pj-name")!.value.trim();
    const msg = app.querySelector<HTMLElement>("#pj-msg")!;
    if (!name) {
      msg.textContent = t("proj.needName");
      app.querySelector("#pj-name")!.classList.add("invalid");
      return;
    }
    try {
      const sel = selectedProjectFolder();
      const p = await api.createProject(
        name,
        app.querySelector<HTMLInputElement>("#pj-desc")!.value.trim(),
        sel && folders.some((f) => f.id === sel) ? sel : null,
      );
      location.hash = `#/projects/${p.id}`;
    } catch (e) {
      toastError(e);
    }
  };
  app.querySelector("#pj-go")?.addEventListener("click", go);
  app.querySelector("#pj-name")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void go();
  });
}

// ─── Projektrahmen ────────────────────────────────────────────────────────

async function renderProject(app: HTMLElement, me: Me, id: string, tabIn?: string): Promise<void> {
  let project: ProjectDetail;
  try {
    project = await api.project(id);
  } catch (e) {
    if (getLastProject() === id) rememberProject(""); // Projekt nicht mehr erreichbar: nicht wieder dorthin springen
    app.innerHTML = shell(
      me,
      t("proj.heading"),
      `<div class="list stack"><div class="card stack" style="width:auto"><h1>${t("proj.loadFailed")}</h1>
        <p class="error">${esc(e instanceof Error ? e.message : String(e))}</p><a href="#/projects">${t("proj.backToList")}</a></div></div>`,
    );
    wireShell(app);
    return;
  }
  rememberProject(id);
  const isAdmin = me.role === "admin";
  const ctx: ProjCtx = {
    id,
    project,
    me,
    role: project.role,
    canEdit: isAdmin || project.role === "editor" || project.role === "owner",
    isOwner: isAdmin || project.role === "owner",
    isBuilder: !!project.is_builder || isAdmin,
  };
  const tabs = TABS.filter((x) => x.id !== "builder" || ctx.isBuilder);
  let tab: Tab = (tabs.find((x) => x.id === tabIn)?.id ?? "overview") as Tab;
  if (tabIn && !tabs.some((x) => x.id === tabIn)) tab = "overview";

  const crumbs = `<a class="proj-back icon-btn" href="#/projects" title="${t("proj.backToList")}" aria-label="${t("proj.backToList")}">${icon("back", 18)}</a>
    <strong class="proj-title" title="${esc(project.name)}">${esc(project.name)}</strong>
    <span class="badge">${esc(t("proj.role." + project.role))}</span>
    ${project.archived ? `<span class="badge">${t("proj.archived")}</span>` : ""}`;

  app.innerHTML = shell(
    me,
    project.name,
    `<div class="proj-frame">
       ${project.archived ? `<div class="proj-banner">${icon("lock", 14)} ${t("proj.archivedBanner")}</div>` : ""}
       <div class="proj-head">
         <p class="proj-desc">${project.description ? esc(project.description) : `<span class="muted">${t("proj.noDesc")}</span>`}</p>
         ${
           ctx.isOwner
             ? `<span class="proj-head-actions">
                 <button class="icon-btn" id="pjEdit" title="${t("proj.edit")}" aria-label="${t("proj.edit")}">${icon("edit", 16)}</button>
                 <button id="pjArch" title="${project.archived ? t("proj.unarchiveHint") : t("proj.archiveHint")}">${project.archived ? t("proj.unarchive") : t("proj.archive")}</button>
                 <button class="icon-btn" id="pjDel" title="${t("proj.delete")}" aria-label="${t("proj.delete")}">${icon("trash", 16)}</button>
               </span>`
             : ""
         }
       </div>
       <nav class="proj-tabs" role="tablist" aria-label="${esc(project.name)}">${tabs
         .map(
           (x) =>
             `<a role="tab" class="proj-tab ${x.id === tab ? "active" : ""}" aria-selected="${x.id === tab}" href="#/projects/${id}/${x.id}" title="${t(x.key + "Hint")}">${icon(x.ic, 15)}<span>${t(x.key)}</span></a>`,
         )
         .join("")}</nav>
       <div class="proj-body" id="projBody"></div>
     </div>`,
    crumbs,
  );
  wireShell(app);
  const body = app.querySelector<HTMLElement>("#projBody")!;
  body.dataset.tab = tab;
  // aktiven Reiter in der Leiste sichtbar halten (schmale Bildschirme scrollen seitlich)
  app.querySelector(".proj-tab.active")?.scrollIntoView?.({ block: "nearest", inline: "center" });

  if (ctx.isOwner) {
    app.querySelector("#pjEdit")?.addEventListener("click", () => editProjectDialog(ctx, () => void renderProject(app, me, id, tab)));
    app.querySelector("#pjArch")?.addEventListener("click", async () => {
      try {
        await api.patchProject(id, { archived: !project.archived });
        void renderProject(app, me, id, tab);
      } catch (e) {
        toastError(e);
      }
    });
    app.querySelector("#pjDel")?.addEventListener("click", async () => {
      if (!(await confirmDialog(t("proj.deleteConfirm"), { danger: true, trash: true }))) return;
      try {
        await api.deleteProject(id);
        location.hash = "#/projects";
      } catch (e) {
        toastError(e);
      }
    });
  }

  try {
    if (tab === "overview") (await import("./projectOverview")).mountOverview(body, ctx);
    else if (tab === "public" || tab === "builder") (await import("./projectDocs")).mountDocs(body, ctx, tab);
    else if (tab === "plans") await mountPlans(body, ctx);
    else if (tab === "tasks") (await import("./projectBoard")).mountBoard(body, ctx);
    else if (tab === "whiteboard") (await import("./projectWhiteboard")).mountWhiteboard(body, ctx);
    else if (tab === "members") (await import("./projectMembers")).mountMembers(body, ctx);
  } catch (e) {
    body.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
    console.error(e);
  }
}

function editProjectDialog(ctx: ProjCtx, done: () => void): void {
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card stack" style="width:min(28rem,94vw)">
    <h1 style="margin:0;font-size:1.05rem">${t("proj.edit")}</h1>
    <label class="muted" for="pe-n">${t("proj.name")}</label>
    <input id="pe-n" maxlength="120" value="${esc(ctx.project.name)}" placeholder="${t("proj.namePh")}" />
    <label class="muted" for="pe-d">${t("proj.desc")}</label>
    <textarea id="pe-d" rows="4" placeholder="${t("proj.descPh")}">${esc(ctx.project.description)}</textarea>
    <div class="row" style="justify-content:flex-end">
      <button data-c>${t("common.cancel")}</button>
      <button class="primary" data-ok>${t("common.save")}</button>
    </div></div>`;
  document.body.appendChild(back);
  a11yModal(back, t("proj.edit"));
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.querySelector("[data-c]")!.addEventListener("click", close);
  back.querySelector("[data-ok]")!.addEventListener("click", async () => {
    const name = back.querySelector<HTMLInputElement>("#pe-n")!.value.trim();
    if (!name) return;
    try {
      await api.patchProject(ctx.id, { name, description: back.querySelector<HTMLTextAreaElement>("#pe-d")!.value.trim() });
      close();
      done();
    } catch (e) {
      toastError(e);
    }
  });
}

// ─── Tab „Pläne" ──────────────────────────────────────────────────────────

async function mountPlans(host: HTMLElement, ctx: ProjCtx): Promise<void> {
  const [plans, folders, maps] = await Promise.all([
    api.projectPlans(ctx.id),
    api.projectFolders(ctx.id).catch((): PlanFolder[] => []),
    api.maps().catch(() => []),
  ]);
  const ready = maps.filter((m) => m.status === "ready");
  const canCreate = ctx.canEdit && ready.length > 0;
  const folderPath = (f: PlanFolder): string => {
    const byId = new Map(folders.map((x) => [x.id, x]));
    const parts = [f.name];
    for (let c = f.parent_id ? byId.get(f.parent_id) : undefined, n = 0; c && n < 20; n++) {
      parts.unshift(c.name);
      c = c.parent_id ? byId.get(c.parent_id) : undefined;
    }
    return parts.join(" / ");
  };
  host.innerHTML = `
    <div class="proj-plans stack">
      <p class="proj-hint" role="note">${icon("lock", 14)} ${t("proj.plans.intro")}</p>
      ${
        canCreate
          ? `<section class="create-card">
              <h2>${t("proj.plans.newTitle")}</h2>
              <div class="create-grid">
                <div class="field"><label for="pp-n">${t("plans.nameLabel")}</label>
                  <input id="pp-n" placeholder="${t("plans.planName")}" autocomplete="off" /></div>
                <div class="field"><label for="pp-m">${t("plans.mapLabel")}</label>
                  <select id="pp-m"><option value="">${t("plans.mapPh")}</option>${ready.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select></div>
                <div class="field"><label for="pp-f">${t("plans.folderLabel")}</label>
                  <select id="pp-f"><option value="">${t("folder.root")}</option>${[...folders]
                    .map((f) => ({ f, p: folderPath(f) }))
                    .sort((a, b) => a.p.localeCompare(b.p))
                    .map(({ f, p }) => `<option value="${esc(f.id)}">${esc(p)}</option>`)
                    .join("")}</select></div>
              </div>
              <div class="create-actions">
                <button class="primary" id="pp-go" title="${t("plans.createHint2")}">${icon("plus", 14)} ${t("plans.create")}</button>
                <button id="pp-move" title="${t("proj.plans.moveHint")}">${icon("move", 14)} ${t("proj.plans.move")}</button>
                <span class="create-msg" id="pp-msg" role="status"></span>
              </div>
            </section>`
          : ctx.canEdit
            ? `<div class="create-actions"><button id="pp-move" title="${t("proj.plans.moveHint")}">${icon("move", 14)} ${t("proj.plans.move")}</button><span class="muted">${t("plans.noMap")}</span></div>`
            : ""
      }
      <div class="plan-tree" id="ppTree"></div>
    </div>`;
  const reload = () => {
    if (host.isConnected) void mountPlans(host, ctx).catch(toastError);
  };
  renderPlanTree(host.querySelector<HTMLElement>("#ppTree")!, plans, folders, ctx.canEdit, {
    projectId: ctx.id,
    user: { id: ctx.me.id, isAdmin: ctx.me.role === "admin" },
    mapName: (mid) => maps.find((m) => m.id === mid)?.name ?? mid,
    onChanged: reload,
    onSelectFolder: (fid) => {
      const pf = host.querySelector<HTMLSelectElement>("#pp-f");
      if (pf) pf.value = fid ?? "";
    },
    onDeletePlan: async (p) => {
      if (await confirmDialog(t("plans.confirmDelete"), { danger: true, trash: true })) {
        try {
          await api.deletePlan(p.id);
          reload();
        } catch (e) {
          toastError(e);
        }
      }
    },
    onOpenShares: (p) => openAclEditor(p.id, p.name),
    onDetachPlan: ctx.canEdit
      ? async (p) => {
          if (!(await confirmDialog(t("proj.plans.detachConfirm"), { okLabel: t("proj.plans.detach") }))) return;
          try {
            await api.setPlanProject(p.id, null);
            reload();
          } catch (e) {
            toastError(e);
          }
        }
      : undefined,
  });
  if (!plans.length) {
    const tree = host.querySelector<HTMLElement>("#ppTree")!;
    tree.insertAdjacentHTML("afterend", `<p class="muted proj-hint">${t("proj.plans.empty")}</p>`);
  }

  const msg = host.querySelector<HTMLElement>("#pp-msg");
  host.querySelector("#pp-go")?.addEventListener("click", async () => {
    const name = host.querySelector<HTMLInputElement>("#pp-n")!.value.trim();
    const mapId = host.querySelector<HTMLSelectElement>("#pp-m")!.value;
    if (!name || !mapId) {
      if (msg) msg.textContent = !name ? t("plans.needName") : t("plans.needMap");
      return;
    }
    try {
      const p = await api.createPlanIn(name, mapId, host.querySelector<HTMLSelectElement>("#pp-f")!.value || null, ctx.id);
      location.hash = `#/plans/${p.id}`;
    } catch (e) {
      toastError(e);
    }
  });
  host.querySelector("#pp-move")?.addEventListener("click", () => movePlanDialog(ctx, reload));
}

/** „Bestehenden Plan hierher verschieben": eigene Pläne ohne Projekt zur Auswahl. */
async function movePlanDialog(ctx: ProjCtx, done: () => void): Promise<void> {
  let own: PlanItem[] = [];
  try {
    own = (await api.plans()).filter((p) => p.level === "owner" && !p.project_id);
  } catch (e) {
    toastError(e);
    return;
  }
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card stack" style="width:min(28rem,94vw)">
    <h1 style="margin:0;font-size:1.05rem">${t("proj.plans.move")}</h1>
    <p class="muted" style="margin:0">${t("proj.plans.moveText")}</p>
    ${
      own.length
        ? `<select id="mv-p" size="8">${own.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>`
        : `<p class="muted">${t("proj.plans.moveNone")}</p>`
    }
    <div class="row" style="justify-content:flex-end">
      <button data-c>${t("common.cancel")}</button>
      <button class="primary" data-ok ${own.length ? "" : "disabled"}>${t("proj.plans.moveGo")}</button>
    </div></div>`;
  document.body.appendChild(back);
  a11yModal(back, t("proj.plans.move"));
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.querySelector("[data-c]")!.addEventListener("click", close);
  back.querySelector("[data-ok]")!.addEventListener("click", async () => {
    const pid = back.querySelector<HTMLSelectElement>("#mv-p")?.value;
    if (!pid) return;
    try {
      await api.setPlanProject(pid, ctx.id);
      toast(t("proj.plans.moved"), { kind: "success" });
      close();
      done();
    } catch (e) {
      toastError(e);
    }
  });
}
