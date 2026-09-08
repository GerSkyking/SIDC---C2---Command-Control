// Admin-Bereich, kategorisiert: Benutzer & Gruppen / Log / Config (Karten + Kataloge).
import { api, ApiError, type AdminGroup, type AdminUser } from "./api";
import { configHtml, wireConfig } from "./adminConfig";
import { langSelect, t, wireLangSelect } from "./i18n";
import { icon } from "./icons";
import { sidebar, themeSwitch, wireSidebar, wireThemeSwitch, type NavSection } from "./ui";

export type AdminSection = "users" | "log" | "config";

export async function renderAdmin(app: HTMLElement, section: AdminSection = "users"): Promise<void> {
  const me = await api.me().catch(() => null);
  const shell = (body: string, title: string) => `
   <div class="shell">
    ${sidebar(section as NavSection, { isAdmin: true, username: me?.username ?? "", isMissionBuilder: !!me?.is_mission_builder_effective })}
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
      alert(e instanceof ApiError ? e.message : t("common.error"));
    }
  };

  if (section === "config") {
    const [maps, sources, catStatus] = await Promise.all([
      api.maps().catch(() => []),
      api.mapSources().catch(() => []),
      api.catalogStatus().catch(() => ({}) as Record<string, boolean>),
    ]);
    app.innerHTML = shell(configHtml(maps, sources, catStatus), t("admin.config"));
    postShell(app);
    wireConfig(app.querySelector<HTMLElement>(".list")!, reload);
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
              <td>${x.user}</td><td><code>${x.action}</code></td><td>${x.target}</td>
              <td style="text-align:left;color:var(--muted)">${Object.entries(x.detail)
                .map(([k, v]) => `${k}=${v}`)
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

  // section === "users"
  const [users, groups] = await Promise.all([api.adminUsers(), api.adminGroups()]);
  app.innerHTML = shell(
    `<h2>${t("admin.users")}</h2>
     <table><tbody>${users.map(userRow).join("")}</tbody></table>
     <div class="row">
       <input id="nu-name" placeholder="${t("auth.username")}" />
       <input id="nu-pw" type="password" placeholder="${t("auth.password")} (min. 12)" />
       <select id="nu-role"><option value="user">user</option><option value="admin">admin</option></select>
       <label><input type="checkbox" id="nu-ccp" /> ${t("admin.canCreatePlans")}</label>
       <label><input type="checkbox" id="nu-mb" /> ${t("admin.missionBuilder")}</label>
       <button class="primary" id="nu-add">${t("common.create")}</button>
     </div>

     <h2>${t("admin.groups")}</h2>
     <p class="muted">${t("admin.groupsHint")}</p>
     <table><tbody>${groups.map((g) => groupRow(g, users)).join("")}</tbody></table>
     <div class="row">
       <input id="ng-name" placeholder="${t("admin.groupName")}" />
       <label><input type="checkbox" id="ng-ccp" /> ${t("admin.canCreatePlans")}</label>
       <label><input type="checkbox" id="ng-mb" /> ${t("admin.missionBuilder")}</label>
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
      }),
    ),
  );
  app.querySelectorAll<HTMLElement>("[data-u]").forEach((el) => {
    const id = el.dataset.u!;
    const field: Record<string, "is_active" | "can_create_plans" | "is_mission_builder"> = {
      active: "is_active",
      ccp: "can_create_plans",
      mb: "is_mission_builder",
    };
    el.querySelectorAll<HTMLInputElement>("[data-ur]").forEach((cb) =>
      cb.addEventListener("change", async () => {
        try {
          await api.patchUser(id, { [field[cb.dataset.ur!]]: cb.checked });
        } catch (e) {
          cb.checked = !cb.checked;
          alert(e instanceof ApiError ? e.message : t("common.error"));
        }
      }),
    );
    el.querySelector("[data-reset]")?.addEventListener("click", () => {
      const pw = prompt(t("admin.newPassword"));
      if (pw) guard(() => api.patchUser(id, { password: pw }));
    });
    el.querySelector("[data-del]")?.addEventListener("click", () => {
      if (confirm(t("admin.confirmDeleteUser"))) guard(() => api.deleteUser(id));
    });
  });

  app.querySelector("#ng-add")!.addEventListener("click", () =>
    guard(() =>
      api.createGroup({
        name: (app.querySelector("#ng-name") as HTMLInputElement).value.trim(),
        can_create_plans: (app.querySelector("#ng-ccp") as HTMLInputElement).checked,
        is_mission_builder: (app.querySelector("#ng-mb") as HTMLInputElement).checked,
      }),
    ),
  );
  app.querySelectorAll<HTMLElement>("[data-g]").forEach((el) => {
    const id = el.dataset.g!;
    const g = groups.find((x) => x.id === id)!;
    el.querySelector("[data-delg]")?.addEventListener("click", () => {
      if (confirm(t("admin.confirmDeleteGroup"))) guard(() => api.deleteGroup(id));
    });
    // Rechte: Checkboxen im Dropdown → PATCH (kein Reload, Dropdown bleibt offen)
    el.querySelectorAll<HTMLInputElement>("[data-gr]").forEach((cb) =>
      cb.addEventListener("change", async () => {
        const body = {
          name: g.name,
          can_create_plans: el.querySelector<HTMLInputElement>('[data-gr="ccp"]')!.checked,
          is_mission_builder: el.querySelector<HTMLInputElement>('[data-gr="mb"]')!.checked,
        };
        try {
          await api.patchGroup(id, body);
        } catch (e) {
          cb.checked = !cb.checked;
          alert(e instanceof ApiError ? e.message : t("common.error"));
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
          alert(e instanceof ApiError ? e.message : t("common.error"));
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

function userRow(u: AdminUser): string {
  return `<tr data-u="${u.id}">
    <td><strong>${u.username}</strong> ${u.is_local ? "" : '<span class="badge">OIDC</span>'}
        <span class="badge">${u.role}</span> ${u.is_active ? "" : `<span class="badge">${t("admin.inactive")}</span>`}</td>
    <td>
      <details class="admin-drop">
        <summary>${t("admin.rights")}</summary>
        <div class="drop-body">
          <label class="chk"><input type="checkbox" data-ur="active" ${u.is_active ? "checked" : ""}/> ${t("admin.active")}</label>
          <label class="chk"><input type="checkbox" data-ur="ccp" ${u.can_create_plans ? "checked" : ""}/> ${t("admin.canCreatePlans")}</label>
          <label class="chk"><input type="checkbox" data-ur="mb" ${u.is_mission_builder ? "checked" : ""}/> ${t("admin.missionBuilder")}</label>
        </div>
      </details>
    </td>
    <td>${u.is_local ? `<button data-reset>${t("admin.passwordShort")}</button>` : ""}
        <button class="icon-btn" data-del>${icon("x", 16)}</button></td>
  </tr>`;
}

function groupRow(g: AdminGroup, users: AdminUser[]): string {
  return `<tr data-g="${g.id}">
    <td><strong>${g.name}</strong></td>
    <td>
      <details class="admin-drop">
        <summary>${t("admin.rights")}</summary>
        <div class="drop-body">
          <label class="chk"><input type="checkbox" data-gr="ccp" ${g.can_create_plans ? "checked" : ""}/> ${t("admin.canCreatePlans")}</label>
          <label class="chk"><input type="checkbox" data-gr="mb" ${g.is_mission_builder ? "checked" : ""}/> ${t("admin.missionBuilder")}</label>
        </div>
      </details>
    </td>
    <td>
      <details class="admin-drop mem-drop">
        <summary>${t("admin.members")} (${g.member_ids.length})</summary>
        <div class="drop-body drop-grid">
          ${users
            .map(
              (u) =>
                `<label class="chk"><input type="checkbox" data-member="${u.id}" ${
                  g.member_ids.includes(u.id) ? "checked" : ""
                }/> ${u.username}</label>`,
            )
            .join("")}
        </div>
      </details>
    </td>
    <td><button class="icon-btn" data-delg>${icon("x", 16)}</button></td>
  </tr>`;
}
