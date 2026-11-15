// Admin-Bereich, kategorisiert: Benutzer & Gruppen / Log / Config (Karten + Kataloge).
import { api, type AdminGroup, type AdminUser } from "./api";
import { configHtml, wireConfig } from "./adminConfig";
import { mountBridgeAdmin } from "./bridgeUi";
import { langSelect, t, wireLangSelect } from "./i18n";
import { icon } from "./icons";
import { confirmDialog, promptDialog, toastError } from "./notify";
import { navAdmin, sidebar, themeSwitch, wireSidebar, wireThemeSwitch, type NavSection } from "./ui";
import { esc } from "./esc";

export type AdminSection = "users" | "log" | "config" | "storage";

export async function renderAdmin(app: HTMLElement, section: AdminSection = "users"): Promise<void> {
  const me = await api.me().catch(() => null);
  const staff = !!me && navAdmin(me).isStaff;
  const fullAdmin = me?.role === "admin";
  const canGrant = !!me?.can_grant_rights;
  // Ansichten je Rolle: Benutzer/Speicher = Staff, Log = Admin, Konfiguration (Karten) = Kartenverwalter
  if ((section === "users" || section === "storage") && !staff) section = "config";
  if (section === "log" && !fullAdmin) section = staff ? "users" : "config";
  const shell = (body: string, title: string) => `
   <div class="shell">
    ${sidebar(section as NavSection, { ...navAdmin(me ?? { role: "user" }), username: me?.display_name || me?.username || "", isMissionBuilder: !!me?.is_mission_builder_effective })}
    <div class="shell-main">
    <div class="topbar"><strong>${title}</strong><span class="grow"></span>${themeSwitch()}${langSelect()}</div>
    <div class="list stack">${body}</div>
    </div>
   </div>`;

  const reload = () => renderAdmin(app, section);
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      toastError(e);
    }
  };

  if (section === "config") {
    const [maps, sources, catStatus, imprint, privacy] = await Promise.all([
      api.maps().catch(() => []),
      api.mapSources().catch(() => []),
      api.catalogStatus().catch(() => ({}) as Record<string, boolean>),
      api.legal("imprint").catch(() => ({ content: null })),
      api.legal("privacy").catch(() => ({ content: null })),
    ]);
    const legalStatus = { imprint: !!imprint.content, privacy: !!privacy.content };
    app.innerHTML = shell(configHtml(maps, sources, catStatus, legalStatus, staff), t("admin.config"));
    postShell(app);
    wireConfig(app.querySelector<HTMLElement>(".list")!, reload);
    const brg = document.createElement("div");
    brg.className = "stack";
    app.querySelector<HTMLElement>(".list")!.appendChild(brg);
    mountBridgeAdmin(brg);
    return;
  }

  if (section === "log") {
    app.innerHTML = shell(
      `<h2>${t("admin.log")}</h2>
       <div class="row">
         <input id="lg-action" placeholder="action (login, plan, map, …)" />
         <input id="lg-user" placeholder="${t("auth.username")}" />
         <button id="lg-load">${t("admin.logFilter")}</button>
         <button id="lg-more">${t("admin.logMore")}</button>
       </div>
       <div id="lg-out"><table class="acl-tbl"><tbody></tbody></table></div>`,
      t("admin.log"),
    );
    postShell(app);
    let logOffset = 0;
    const loadLog = async (reset: boolean, count = 30) => {
      if (reset) logOffset = 0;
      const r = await api.adminAudit({
        limit: count,
        offset: logOffset,
        action: (app.querySelector("#lg-action") as HTMLInputElement).value.trim(),
        user: (app.querySelector("#lg-user") as HTMLInputElement).value.trim(),
      });
      const tb = app.querySelector("#lg-out tbody")!;
      if (reset) tb.innerHTML = "";
      tb.insertAdjacentHTML(
        "beforeend",
        r.items
          .map(
            (x) => `<tr>
              <td style="text-align:left">${new Date(x.ts).toLocaleString()}</td>
              <td>${esc(x.user)}</td><td><code>${esc(x.action)}</code></td><td>${esc(x.target)}</td>
              <td style="text-align:left;color:var(--muted)">${Object.entries(x.detail)
                .map(([k, v]) => `${esc(k)}=${esc(String(v))}`)
                .join(" ")}</td>
            </tr>`,
          )
          .join(""),
      );
      logOffset += r.items.length;
    };
    app.querySelector("#lg-load")!.addEventListener("click", () => void loadLog(true).catch(() => {}));
    app.querySelector("#lg-more")!.addEventListener("click", () => void loadLog(false).catch(() => {}));
    void loadLog(true, 20);
    return;
  }

  if (section === "storage") {
    const [rows, mapRows] = await Promise.all([
      api.adminProjectStorage().catch(() => []),
      api.adminMapStorage().catch(() => []),
    ]);
    const mapsTotal = mapRows.reduce((a, m) => a + m.bytes, 0);
    const projTotal = rows.reduce((a, r) => a + r.total_bytes, 0);
    const fb = (n: number) =>
      n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
    const max = Math.max(1, ...rows.map((r) => r.total_bytes));
    app.innerHTML = shell(
      `<h2>${t("admin.storage")}</h2>
       <p class="muted">${t("admin.storage.hint")}</p>
       <p><strong>${t("admin.storage.grand")}: ${fb(projTotal + mapsTotal)}</strong>
          <span class="muted"> (${t("admin.storage.projects")}: ${fb(projTotal)} · ${t("admin.storage.maps")}: ${fb(mapsTotal)})</span></p>
       ${
         rows.length
           ? `<table class="acl-tbl"><thead><tr>
                <th>${t("proj.name")}</th><th>${t("admin.storage.images")}</th><th>${t("admin.storage.docs")}</th>
                <th>${t("admin.storage.plans")}</th><th>${t("admin.storage.total")}</th><th></th>
              </tr></thead><tbody>${rows
                .map(
                  (r) => `<tr>
                    <td style="text-align:left"><a href="#/projects/${esc(r.project_id)}">${esc(r.name)}</a></td>
                    <td>${fb(r.images_bytes)}</td><td>${fb(r.docs_bytes)}</td><td>${r.plans_count}</td>
                    <td><strong>${fb(r.total_bytes)}</strong></td>
                    <td style="width:30%"><div class="stor-bar"><i style="width:${Math.max(2, Math.round((r.total_bytes / max) * 100))}%"></i></div></td>
                  </tr>`,
                )
                .join("")}</tbody></table>`
           : `<p class="muted">${t("admin.storage.empty")}</p>`
       }
       <h3>${t("admin.storage.maps")}</h3>
       ${
         mapRows.length
           ? `<table class="acl-tbl"><thead><tr><th>${t("proj.name")}</th><th>${t("admin.storage.total")}</th><th></th></tr></thead><tbody>${mapRows
               .map(
                 (m) => `<tr><td style="text-align:left">${esc(m.name)}</td><td><strong>${fb(m.bytes)}</strong></td>
                   <td style="width:30%"><div class="stor-bar"><i style="width:${Math.max(2, Math.round((m.bytes / Math.max(1, mapRows[0].bytes)) * 100))}%"></i></div></td></tr>`,
               )
               .join("")}</tbody></table>`
           : `<p class="muted">${t("admin.storage.mapsEmpty")}</p>`
       }`,
      t("admin.storage"),
    );
    postShell(app);
    return;
  }

  // section === "users"
  const [users, groups, discordIds] = await Promise.all([
    api.adminUsers(),
    api.adminGroups(),
    api.bridgeAdminIdentities().catch(() => ({}) as Record<string, string>),
  ]);
  app.innerHTML = shell(
    `<h2>${t("admin.users")}</h2>
     <table><tbody>${users.map((u) => userRow(u, canGrant, discordIds[u.id])).join("")}</tbody></table>
     <div class="row">
       <input id="nu-name" placeholder="${t("auth.username")}" />
       <input id="nu-pw" type="password" placeholder="${t("auth.password")} (min. 12)" />
       <select id="nu-role" title="${t("tip.admin.role")}" ${canGrant ? "" : "disabled"}><option value="user">user</option><option value="admin">admin</option></select>
       <label title="${t("tip.admin.ccp")}"><input type="checkbox" id="nu-ccp" ${canGrant ? "" : "disabled"} /> ${t("admin.canCreatePlans")}</label>
       <label title="${t("tip.admin.mb")}"><input type="checkbox" id="nu-mb" ${canGrant ? "" : "disabled"} /> ${t("admin.missionBuilder")}</label>
       <label title="${t("tip.admin.zeus")}"><input type="checkbox" id="nu-zeus" ${canGrant ? "" : "disabled"} /> ${t("admin.zeus")}</label>
       <label title="${t("tip.admin.technician")}"><input type="checkbox" id="nu-tech" ${canGrant ? "" : "disabled"} /> ${t("admin.technician")}</label>
       <label title="${t("tip.admin.mapManager")}"><input type="checkbox" id="nu-maps" ${canGrant ? "" : "disabled"} /> ${t("admin.mapManager")}</label>
       <button class="primary" id="nu-add" ${canGrant ? "" : "disabled"}>${t("common.create")}</button>
     </div>

     <h2>${t("admin.groups")}</h2>
     <p class="muted">${t("admin.groupsHint")}</p>
     <table><tbody>${groups.map((g) => groupRow(g, users, canGrant, staff)).join("")}</tbody></table>
     <div class="row">
       <input id="ng-name" placeholder="${t("admin.groupName")}" />
       <label title="${t("tip.admin.ccp")}"><input type="checkbox" id="ng-ccp" ${canGrant ? "" : "disabled"} /> ${t("admin.canCreatePlans")}</label>
       <label title="${t("tip.admin.mb")}"><input type="checkbox" id="ng-mb" ${canGrant ? "" : "disabled"} /> ${t("admin.missionBuilder")}</label>
       <label title="${t("tip.admin.zeus")}"><input type="checkbox" id="ng-zeus" ${canGrant ? "" : "disabled"} /> ${t("admin.zeus")}</label>
       <label title="${t("tip.admin.technician")}"><input type="checkbox" id="ng-tech" ${canGrant ? "" : "disabled"} /> ${t("admin.technician")}</label>
       <label title="${t("tip.admin.mapManager")}"><input type="checkbox" id="ng-maps" ${canGrant ? "" : "disabled"} /> ${t("admin.mapManager")}</label>
       <button class="primary" id="ng-add">${t("common.create")}</button>
     </div>`,
    t("admin.usersGroups"),
  );
  postShell(app);

  app.querySelector("#nu-add")!.addEventListener("click", () =>
    guard(() =>
      api.createUser({
        username: (app.querySelector("#nu-name") as HTMLInputElement).value.trim(),
        password: (app.querySelector("#nu-pw") as HTMLInputElement).value,
        role: (app.querySelector("#nu-role") as HTMLSelectElement).value,
        can_create_plans: (app.querySelector("#nu-ccp") as HTMLInputElement).checked,
        is_mission_builder: (app.querySelector("#nu-mb") as HTMLInputElement).checked,
        is_zeus: (app.querySelector("#nu-zeus") as HTMLInputElement).checked,
        is_technician: (app.querySelector("#nu-tech") as HTMLInputElement).checked,
        can_manage_maps: (app.querySelector("#nu-maps") as HTMLInputElement).checked,
      }),
    ),
  );
  app.querySelectorAll<HTMLElement>("[data-u]").forEach((el) => {
    const id = el.dataset.u!;
    const field: Record<string, "is_active" | "can_create_plans" | "is_mission_builder" | "is_zeus" | "is_technician" | "can_manage_maps"> = {
      active: "is_active",
      ccp: "can_create_plans",
      mb: "is_mission_builder",
      zeus: "is_zeus",
      technician: "is_technician",
      maps: "can_manage_maps",
    };
    el.querySelectorAll<HTMLInputElement>("[data-ur]").forEach((cb) =>
      cb.addEventListener("change", async () => {
        try {
          await api.patchUser(id, { [field[cb.dataset.ur!]]: cb.checked });
        } catch (e) {
          cb.checked = !cb.checked;
          toastError(e);
        }
      }),
    );
    el.querySelector<HTMLInputElement>("[data-uname]")?.addEventListener("change", (e) => {
      guard(() => api.patchUser(id, { display_name: (e.target as HTMLInputElement).value.trim() }));
    });
    el.querySelector("[data-dc]")?.addEventListener("click", async () => {
      const cur = discordIds[id] ?? "";
      const v = await promptDialog(t("admin.discordId"), { value: cur });
      if (v === null) return;
      const clean = v.trim();
      if (!clean && cur) guard(() => api.bridgeAdminClearIdentity(id));
      else if (clean) guard(() => api.bridgeAdminSetIdentity(id, clean));
    });
    el.querySelector("[data-reset]")?.addEventListener("click", async () => {
      const pw = await promptDialog(t("admin.newPassword"));
      if (pw) guard(() => api.patchUser(id, { password: pw }));
    });
    el.querySelector("[data-del]")?.addEventListener("click", async () => {
      if (await confirmDialog(t("admin.confirmDeleteUser"), { danger: true, trash: true })) guard(() => api.deleteUser(id));
    });
  });

  app.querySelector("#ng-add")!.addEventListener("click", () =>
    guard(() =>
      api.createGroup({
        name: (app.querySelector("#ng-name") as HTMLInputElement).value.trim(),
        can_create_plans: (app.querySelector("#ng-ccp") as HTMLInputElement).checked,
        is_mission_builder: (app.querySelector("#ng-mb") as HTMLInputElement).checked,
        is_zeus: (app.querySelector("#ng-zeus") as HTMLInputElement).checked,
        is_technician: (app.querySelector("#ng-tech") as HTMLInputElement).checked,
        can_manage_maps: (app.querySelector("#ng-maps") as HTMLInputElement).checked,
      }),
    ),
  );
  app.querySelectorAll<HTMLElement>("[data-g]").forEach((el) => {
    const id = el.dataset.g!;
    const g = groups.find((x) => x.id === id)!;
    el.querySelector("[data-delg]")?.addEventListener("click", async () => {
      if (await confirmDialog(t("admin.confirmDeleteGroup"), { danger: true, trash: true })) guard(() => api.deleteGroup(id));
    });
    // Rechte: Checkboxen im Dropdown → PATCH (kein Reload, Dropdown bleibt offen)
    el.querySelectorAll<HTMLInputElement>("[data-gr]").forEach((cb) =>
      cb.addEventListener("change", async () => {
        const body = {
          name: g.name,
          can_create_plans: el.querySelector<HTMLInputElement>('[data-gr="ccp"]')!.checked,
          is_mission_builder: el.querySelector<HTMLInputElement>('[data-gr="mb"]')!.checked,
          is_zeus: el.querySelector<HTMLInputElement>('[data-gr="zeus"]')!.checked,
          is_technician: el.querySelector<HTMLInputElement>('[data-gr="technician"]')!.checked,
          can_manage_maps: el.querySelector<HTMLInputElement>('[data-gr="maps"]')!.checked,
        };
        try {
          await api.patchGroup(id, body);
        } catch (e) {
          cb.checked = !cb.checked;
          toastError(e);
        }
      }),
    );
    el.querySelectorAll<HTMLInputElement>("[data-member]").forEach((cb) =>
      cb.addEventListener("change", async () => {
        const ids = [...el.querySelectorAll<HTMLInputElement>("[data-member]:checked")].map((x) => x.dataset.member!);
        try {
          const upd = await api.setGroupMembers(id, ids);
          const sum = el.querySelector(".mem-drop summary");
          if (sum) sum.textContent = `${t("admin.members")} (${upd.member_ids.length})`;
        } catch (e) {
          cb.checked = !cb.checked;
          toastError(e);
        }
      }),
    );
  });
}

function postShell(app: HTMLElement): void {
  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);
}

function userRow(u: AdminUser, canGrant: boolean, discordId?: string): string {
  const lock = u.protected ? "disabled" : "";
  const rlock = u.protected || !canGrant ? "disabled" : ""; // Rechte vergibt nur ein lokaler Admin
  return `<tr data-u="${u.id}">
    <td><strong>${esc(u.username)}</strong>
        ${u.display_name ? `<div class="muted" style="font-size:.8rem">${esc(u.display_name)}</div>` : ""}</td>
    <td style="width:5.5rem"><span class="badge" title="${t("tip.admin.role")}">${esc(u.role)}</span></td>
    <td style="width:11rem">${u.is_local ? "" : `<span class="badge" title="${t("tip.admin.oidc")}">OIDC</span> `}${u.protected ? `<span class="badge" title="${t("admin.protectedHint")}">${icon("lock", 11)} ${t("admin.protected")}</span> ` : ""}${u.is_active ? "" : `<span class="badge">${t("admin.inactive")}</span>`}</td>
    <td>
      <details class="admin-drop">
        <summary title="${t("tip.admin.rights")}">${t("admin.rights")}</summary>
        <div class="drop-body">
          <label class="chk" title="${t("tip.admin.active")}"><input type="checkbox" data-ur="active" ${canGrant ? lock : "disabled"} ${u.is_active ? "checked" : ""}/> ${t("admin.active")}</label>
          <label class="chk" title="${t("tip.admin.ccp")}"><input type="checkbox" data-ur="ccp" ${rlock} ${u.can_create_plans ? "checked" : ""}/> ${t("admin.canCreatePlans")}</label>
          <label class="chk" title="${t("tip.admin.mb")}"><input type="checkbox" data-ur="mb" ${rlock} ${u.is_mission_builder ? "checked" : ""}/> ${t("admin.missionBuilder")}</label>
          <label class="chk" title="${t("tip.admin.zeus")}"><input type="checkbox" data-ur="zeus" ${rlock} ${u.is_zeus ? "checked" : ""}/> ${t("admin.zeus")}</label>
          <label class="chk" title="${t("tip.admin.technician")}"><input type="checkbox" data-ur="technician" ${rlock} ${u.is_technician ? "checked" : ""}/> ${t("admin.technician")}</label>
          <label class="chk" title="${t("tip.admin.mapManager")}"><input type="checkbox" data-ur="maps" ${rlock} ${u.can_manage_maps ? "checked" : ""}/> ${t("admin.mapManager")}</label>
          <label class="chk-lbl">${t("settings.displayName")}
            <input data-uname maxlength="64" value="${esc(u.display_name ?? "")}" ${canGrant && !u.protected ? "" : "disabled"} /></label>
        </div>
      </details>
    </td>
    <td><button data-dc title="${discordId ? esc(t("tip.admin.discordOn").replace("{id}", discordId)) : t("tip.admin.discordOff")}">Discord${discordId ? " ✓" : ""}</button>
        ${u.is_local && !u.protected ? `<button data-reset title="${t("tip.admin.pwReset")}">${t("admin.passwordShort")}</button>` : ""}
        ${u.protected ? "" : `<button class="icon-btn" data-del title="${t("common.delete")}">${icon("x", 16)}</button>`}</td>
  </tr>`;
}

function groupRow(g: AdminGroup, users: AdminUser[], canGrant: boolean, staff: boolean): string {
  const sys = !!g.is_system;
  const rlock = sys || !canGrant ? "disabled" : "";
  const hasRights = g.can_create_plans || g.is_mission_builder || g.is_zeus || !!g.is_technician || !!g.can_manage_maps;
  const mlock = sys || !staff || (hasRights && !canGrant) ? "disabled" : ""; // Mitglieder von Rechte-Gruppen: nur lokaler Admin
  return `<tr data-g="${g.id}">
    <td><strong>${esc(g.name)}</strong></td>
    <td>
      <details class="admin-drop">
        <summary title="${t("tip.admin.rights")}">${t("admin.rights")}</summary>
        <div class="drop-body">
          <label class="chk" title="${t("tip.admin.ccp")}"><input type="checkbox" data-gr="ccp" ${rlock} ${g.can_create_plans ? "checked" : ""}/> ${t("admin.canCreatePlans")}</label>
          <label class="chk" title="${t("tip.admin.mb")}"><input type="checkbox" data-gr="mb" ${rlock} ${g.is_mission_builder ? "checked" : ""}/> ${t("admin.missionBuilder")}</label>
          <label class="chk" title="${t("tip.admin.zeus")}"><input type="checkbox" data-gr="zeus" ${rlock} ${g.is_zeus ? "checked" : ""}/> ${t("admin.zeus")}</label>
          <label class="chk" title="${t("tip.admin.technician")}"><input type="checkbox" data-gr="technician" ${rlock} ${g.is_technician ? "checked" : ""}/> ${t("admin.technician")}</label>
          <label class="chk" title="${t("tip.admin.mapManager")}"><input type="checkbox" data-gr="maps" ${rlock} ${g.can_manage_maps ? "checked" : ""}/> ${t("admin.mapManager")}</label>
        </div>
      </details>
    </td>
    <td>
      <details class="admin-drop mem-drop">
        <summary title="${t("tip.admin.members")}">${t("admin.members")} (${g.member_ids.length})</summary>
        <div class="drop-body drop-grid">
          ${users
            .map(
              (u) =>
                `<label class="chk"><input type="checkbox" data-member="${u.id}" ${mlock} ${
                  g.member_ids.includes(u.id) ? "checked" : ""
                }/> ${esc(u.username)}</label>`,
            )
            .join("")}
        </div>
      </details>
    </td>
    <td>${sys ? `<span class="badge" title="${t("admin.publicHint")}">${icon("lock", 11)} ${t("admin.system")}</span>` : !staff || (hasRights && !canGrant) ? "" : `<button class="icon-btn" data-delg title="${t("common.delete")}">${icon("x", 16)}</button>`}</td>
  </tr>`;
}
