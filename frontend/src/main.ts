import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { api, ApiError, type Me } from "./api";
import { openPlanView } from "./plan";
import { renderAdmin } from "./admin";
import { openAclEditor } from "./acl";
import { renderPlanTree } from "./planTree";
import { renderPublicView } from "./publicview";
import { langSelect, t, wireLangSelect } from "./i18n";

const app = document.querySelector<HTMLDivElement>("#app")!;

let me: Me | null = null;

async function route(): Promise<void> {
  const pub = location.hash.match(/^#\/p\/([A-Za-z0-9_-]{10,})$/);
  if (pub) return renderPublicView(app, pub[1]);

  try {
    me = await api.me();
  } catch {
    me = null;
  }

  if (!me) return renderLogin();

  const planMatch = location.hash.match(/^#\/plans\/([0-9a-f]{32})$/);
  if (planMatch) {
    try {
      return await openPlanView(app, planMatch[1], me);
    } catch (e) {
      app.innerHTML = `<div class="center"><div class="card stack">
        <h1>${t("plan.loadFailed")}</h1>
        <p class="error">${e instanceof Error ? e.message : String(e)}</p>
        <a href="#/">← ${t("nav.back")}</a></div></div>`;
      console.error(e);
      return;
    }
  }
  if (location.hash === "#/admin" && me.role === "admin") return renderAdmin(app);
  return renderPlanList();
}

// ─── Login ────────────────────────────────────────────────────────────────

async function renderLogin(): Promise<void> {
  const { enabled: oidc } = await api.oidcEnabled().catch(() => ({ enabled: false }));
  app.innerHTML = `
    <div class="center"><div class="card stack">
      <div class="row"><h1 style="flex:1">${t("app.title")}</h1>${langSelect()}</div>
      <input id="u" placeholder="${t("auth.username")}" autocomplete="username" />
      <input id="p" type="password" placeholder="${t("auth.password")}" autocomplete="current-password" />
      <button class="primary" id="go">${t("auth.login")}</button>
      ${oidc ? `<a href="/auth/oidc/login">${t("auth.oidc")}</a>` : ""}
      <div class="error" id="err"></div>
    </div></div>`;
  wireLangSelect(app);

  const err = app.querySelector<HTMLDivElement>("#err")!;
  const submit = async () => {
    err.textContent = "";
    try {
      await api.login(
        app.querySelector<HTMLInputElement>("#u")!.value,
        app.querySelector<HTMLInputElement>("#p")!.value,
      );
      location.hash = "#/";
      route();
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : t("auth.error");
    }
  };
  app.querySelector("#go")!.addEventListener("click", submit);
  app.querySelector("#p")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") submit();
  });
}

// ─── Plan-Liste ───────────────────────────────────────────────────────────

async function renderPlanList(): Promise<void> {
  const [plans, maps, folders] = await Promise.all([
    api.plans(),
    api.maps().catch(() => []),
    api.folders().catch(() => []),
  ]);
  const canCreate = me!.can_create_plans_effective && maps.some((m) => m.status === "ready");

  app.innerHTML = `
    <div class="topbar">
      <strong>SIDC – C2</strong>
      <span class="grow"></span>
      ${langSelect()}
      ${me!.role === "admin" ? `<a href="#/admin">${t("nav.admin")}</a>` : ""}
      <span class="muted">${me!.username} (${me!.role})</span>
      <button id="logout">${t("auth.logout")}</button>
    </div>
    <div class="list stack">
      ${me!.role === "admin" ? adminMapsBlock(maps) : ""}
      <h2>${t("plans.heading")}</h2>
      ${
        canCreate
          ? `<div class="row">
               <input id="pn" placeholder="${t("plans.planName")}" />
               <select id="pm">${maps
                 .filter((m) => m.status === "ready")
                 .map((m) => `<option value="${m.id}">${m.name}</option>`)
                 .join("")}</select>
               <button class="primary" id="pc">${t("plans.new")}</button>
             </div>`
          : `<div class="muted">${
              me!.can_create_plans_effective ? t("plans.noMap") : t("plans.noPerm")
            }</div>`
      }
      <div class="plan-tree" id="planTree"></div>
    </div>`;
  wireLangSelect(app);

  renderPlanTree(app.querySelector<HTMLDivElement>("#planTree")!, plans, folders, me!.can_create_plans_effective, {
    onChanged: () => renderPlanList(),
    onDeletePlan: async (p) => {
      if (confirm(t("plans.confirmDelete"))) {
        await api.deletePlan(p.id);
        renderPlanList();
      }
    },
    onOpenShares: (p) => openAclEditor(p.id, p.name),
  });

  app.querySelector("#logout")!.addEventListener("click", async () => {
    await api.logout();
    location.hash = "#/";
    route();
  });
  app.querySelector("#pc")?.addEventListener("click", async () => {
    const name = app.querySelector<HTMLInputElement>("#pn")!.value.trim();
    const mapId = app.querySelector<HTMLSelectElement>("#pm")!.value;
    if (!name) return;
    const p = await api.createPlan(name, mapId);
    location.hash = `#/plans/${p.id}`;
    route();
  });
  const mapId = () => app.querySelector<HTMLInputElement>("#mid")!.value.trim();
  const mapName = () => app.querySelector<HTMLInputElement>("#mname")!.value.trim();
  app.querySelector("#mi")?.addEventListener("click", async () => {
    const url = app.querySelector<HTMLInputElement>("#murl")!.value.trim();
    if (!mapId() || !mapName() || !url) return;
    try {
      await api.importMap(mapId(), mapName(), url);
      setTimeout(route, 500);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : "Fehler");
    }
  });
  app.querySelector("#mu")?.addEventListener("click", async () => {
    const f = app.querySelector<HTMLInputElement>("#mfile")!.files?.[0];
    const prog = app.querySelector<HTMLDivElement>("#mprogress")!;
    if (!mapId() || !mapName() || !f) return;
    try {
      await api.uploadMapFile(mapId(), mapName(), f, (p) => (prog.textContent = `Upload ${p.toFixed(0)} %`));
      prog.textContent = "Upload fertig – Verarbeitung läuft…";
      setTimeout(route, 1500);
    } catch (e) {
      prog.textContent = "";
      alert(e instanceof ApiError ? e.message : "Fehler");
    }
  });
  app.querySelectorAll<HTMLButtonElement>("[data-reimport]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api.reimportMap(b.dataset.reimport!);
        setTimeout(route, 800);
      } catch (e) {
        alert(e instanceof ApiError ? e.message : "Fehler");
      }
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-updbtn]").forEach((b) =>
    b.addEventListener("click", () =>
      app.querySelector<HTMLInputElement>(`[data-upd="${b.dataset.updbtn}"]`)!.click(),
    ),
  );
  app.querySelectorAll<HTMLInputElement>("[data-upd]").forEach((inp) =>
    inp.addEventListener("change", async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const prog = app.querySelector<HTMLDivElement>("#mprogress")!;
      try {
        await api.uploadMapFile(inp.dataset.upd!, "", f, (p) => (prog.textContent = `Update ${p.toFixed(0)} %`));
        prog.textContent = "Upload fertig – Verarbeitung läuft…";
        setTimeout(route, 1500);
      } catch (e) {
        prog.textContent = "";
        alert(e instanceof ApiError ? e.message : "Fehler");
      }
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-delmap]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`${t("common.delete")}: ${b.dataset.delmap}?`)) return;
      try {
        await api.deleteMap(b.dataset.delmap!);
        route();
      } catch (e) {
        alert(e instanceof ApiError ? e.message : t("common.error"));
      }
    }),
  );
  app.querySelector("#restart")?.addEventListener("click", async () => {
    if (!confirm(t("admin.restartConfirm"))) return;
    try {
      await api.restartBackend();
    } catch {
      /* Verbindung bricht beim Neustart erwartungsgemäß ab */
    }
    setTimeout(() => location.reload(), 6000);
  });
}

function adminMapsBlock(maps: { id: string; name: string; status: string; error: string | null }[]): string {
  return `
    <div class="row">
      <h2 style="margin:0">${t("admin.maps")}</h2>
      <span class="grow"></span>
      <button id="restart">${t("admin.restart")}</button>
    </div>
    <table><tbody>
      ${maps
        .map(
          (m) =>
            `<tr>
               <td>${m.name} <span class="muted">${m.id}</span></td>
               <td><span class="badge">${m.status}</span></td>
               <td class="muted">${m.error ?? ""}</td>
               <td>
                 <input type="file" accept=".zip" data-upd="${m.id}" style="display:none" />
                 <button data-updbtn="${m.id}">${t("admin.update")}</button>
                 <button data-reimport="${m.id}">${t("admin.fromLink")}</button>
                 <button data-delmap="${m.id}">${t("common.delete")}</button>
               </td>
             </tr>`,
        )
        .join("")}
    </tbody></table>
    <div class="row">
      <input id="mid" placeholder="${t("admin.mapId")}" />
      <input id="mname" placeholder="${t("admin.displayName")}" />
    </div>
    <div class="row">
      <input id="murl" placeholder="${t("admin.downloadUrl")}" style="flex:1" />
      <button id="mi">${t("admin.viaLink")}</button>
    </div>
    <div class="row">
      <input type="file" id="mfile" accept=".zip,application/zip" style="flex:1" />
      <button id="mu">${t("admin.upload")}</button>
    </div>
    <div id="mprogress" class="muted"></div>`;
}

window.addEventListener("hashchange", route);
route();
