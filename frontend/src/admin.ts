// Admin-Bereich: SIDC-Katalog-Upload, lokale User, Gruppen.
import { api, ApiError, type AdminGroup, type AdminUser } from "./api";
import { langSelect, t, wireLangSelect } from "./i18n";
import { icon } from "./icons";
import { sidebar, themeSwitch, wireSidebar, wireThemeSwitch } from "./ui";

const CATALOGS: { key: string; label: string; file: string }[] = [
  { key: "all-markers", label: "Alle Marker", file: "SIDC_AllMarkersCatalog.json" },
  { key: "quick-menu", label: "QuickMenü", file: "SIDC_QuickMarkerMenuCatalog.json" },
  { key: "phaseline-style", label: "Phase-Line-Stil", file: "SIDC_PhaseLineStyleCatalog.json" },
  { key: "channels", label: "Channels", file: "SIDC_ChannelSettings.json" },
  { key: "modifiers", label: "Modifikatoren", file: "SIDC_ModifierCatalog.json" },
];

export async function renderAdmin(app: HTMLElement): Promise<void> {
  const [status, users, groups] = await Promise.all([
    api.catalogStatus().catch(() => ({}) as Record<string, boolean>),
    api.adminUsers(),
    api.adminGroups(),
  ]);

  app.innerHTML = `
   <div class="shell">
    ${sidebar("admin", { isAdmin: true, username: "" })}
    <div class="shell-main">
    <div class="topbar"><strong>${t("admin.heading")}</strong><span class="grow"></span>${themeSwitch()}${langSelect()}</div>
    <div class="list stack">
      <h2>${t("admin.catalog")}</h2>
      <p class="muted">${t("admin.catalogHint")}</p>
      <table><tbody>${CATALOGS.map(
        (c) => `<tr>
          <td>${c.label} <span class="muted">${c.file}</span></td>
          <td><span class="badge">${status[c.key] ? t("admin.loaded") : t("admin.missing")}</span></td>
          <td>
            <input type="file" accept="application/json,.json" data-cat="${c.key}" />
            ${status[c.key] ? `<button data-delcat="${c.key}">${t("common.delete")}</button>` : ""}
          </td>
        </tr>`,
      ).join("")}</tbody></table>

      <h2>${t("admin.users")}</h2>
      <table><tbody>${users.map(userRow).join("")}</tbody></table>
      <div class="row">
        <input id="nu-name" placeholder="${t('auth.username')}" />
        <input id="nu-pw" type="password" placeholder="${t('auth.password')} (min. 12)" />
        <select id="nu-role"><option value="user">user</option><option value="admin">admin</option></select>
        <label><input type="checkbox" id="nu-ccp" /> ${t("admin.canCreatePlans")}</label>
        <button class="primary" id="nu-add">${t("common.create")}</button>
      </div>

      <h2>${t("admin.groups")}</h2>
      <table><tbody>${groups.map((g) => groupRow(g, users)).join("")}</tbody></table>
      <div class="row">
        <input id="ng-name" placeholder="${t('admin.groupName')}" />
        <label><input type="checkbox" id="ng-ccp" /> ${t("admin.canCreatePlans")}</label>
        <button class="primary" id="ng-add">${t("common.create")}</button>
      </div>

      <h2>${t("admin.log")}</h2>
      <div class="row">
        <input id="lg-action" placeholder="action (login, plan, map, …)" />
        <input id="lg-user" placeholder="${t('auth.username')}" />
        <button id="lg-load">${t("admin.logFilter")}</button>
        <button id="lg-more">${t("admin.logMore")}</button>
      </div>
      <div id="lg-out"><table class="acl-tbl"><tbody></tbody></table></div>
    </div>
    </div>
   </div>`;

  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);
  const reload = () => renderAdmin(app);
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : t("common.error"));
    }
  };

  app.querySelectorAll<HTMLInputElement>("[data-cat]").forEach((inp) =>
    inp.addEventListener("change", () =>
      guard(async () => {
        if (inp.files?.[0]) await api.uploadCatalog(inp.dataset.cat!, inp.files[0]);
      }),
    ),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-delcat]").forEach((b) =>
    b.addEventListener("click", () => guard(() => api.deleteCatalog(b.dataset.delcat!))),
  );

  app.querySelector("#nu-add")!.addEventListener("click", () =>
    guard(() =>
      api.createUser({
        username: (app.querySelector("#nu-name") as HTMLInputElement).value.trim(),
        password: (app.querySelector("#nu-pw") as HTMLInputElement).value,
        role: (app.querySelector("#nu-role") as HTMLSelectElement).value,
        can_create_plans: (app.querySelector("#nu-ccp") as HTMLInputElement).checked,
      }),
    ),
  );
  app.querySelectorAll<HTMLElement>("[data-u]").forEach((el) => {
    const id = el.dataset.u!;
    el.querySelector("[data-toggle-active]")?.addEventListener("click", () =>
      guard(() => api.patchUser(id, { is_active: el.dataset.active !== "true" })),
    );
    el.querySelector("[data-toggle-ccp]")?.addEventListener("click", () =>
      guard(() => api.patchUser(id, { can_create_plans: el.dataset.ccp !== "true" })),
    );
    el.querySelector("[data-reset]")?.addEventListener("click", () => {
      const pw = prompt(t("admin.newPassword"));
      if (pw) guard(() => api.patchUser(id, { password: pw }));
    });
    el.querySelector("[data-del]")?.addEventListener("click", () => {
      if (confirm(t("admin.confirmDeleteUser"))) guard(() => api.deleteUser(id));
    });
  });

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
            <td style="text-align:left;color:var(--muted)">${
              Object.entries(x.detail)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")
            }</td>
          </tr>`,
        )
        .join(""),
    );
    logOffset += r.items.length;
  };
  app.querySelector("#lg-load")!.addEventListener("click", () => guard(() => loadLog(true)));
  app.querySelector("#lg-more")!.addEventListener("click", () => guard(() => loadLog(false)));
  void loadLog(true, 20); // beim Öffnen: die letzten 20 Ereignisse

  app.querySelector("#ng-add")!.addEventListener("click", () =>
    guard(() =>
      api.createGroup({
        name: (app.querySelector("#ng-name") as HTMLInputElement).value.trim(),
        can_create_plans: (app.querySelector("#ng-ccp") as HTMLInputElement).checked,
      }),
    ),
  );
  app.querySelectorAll<HTMLElement>("[data-g]").forEach((el) => {
    const id = el.dataset.g!;
    el.querySelector("[data-delg]")?.addEventListener("click", () => {
      if (confirm(t("admin.confirmDeleteGroup"))) guard(() => api.deleteGroup(id));
    });
    el.querySelectorAll<HTMLInputElement>("[data-member]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const ids = [...el.querySelectorAll<HTMLInputElement>("[data-member]:checked")].map((x) => x.dataset.member!);
        guard(() => api.setGroupMembers(id, ids));
      }),
    );
  });
}

function userRow(u: AdminUser): string {
  return `<tr data-u="${u.id}" data-active="${u.is_active}" data-ccp="${u.can_create_plans}">
    <td>${u.username} ${u.is_local ? "" : '<span class="badge">OIDC</span>'}</td>
    <td><span class="badge">${u.role}</span></td>
    <td><button data-toggle-active>${u.is_active ? "aktiv" : "deaktiviert"}</button></td>
    <td><button data-toggle-ccp>Pläne: ${u.can_create_plans ? "ja" : "nein"}</button></td>
    <td>${u.is_local ? "<button data-reset>PW</button>" : ""} <button class="icon-btn" data-del>${icon("x", 16)}</button></td>
  </tr>`;
}

function groupRow(g: AdminGroup, users: AdminUser[]): string {
  return `<tr data-g="${g.id}">
    <td>${g.name} ${g.can_create_plans ? '<span class="badge">Pläne</span>' : ""}</td>
    <td>${users
      .map(
        (u) =>
          `<label style="margin-right:.6rem"><input type="checkbox" data-member="${u.id}" ${
            g.member_ids.includes(u.id) ? "checked" : ""
          }/> ${u.username}</label>`,
      )
      .join("")}</td>
    <td><button class="icon-btn" data-delg>${icon("x", 16)}</button></td>
  </tr>`;
}
