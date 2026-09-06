import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { api, ApiError, type Me } from "./api";
import { openPlanView } from "./plan";
import { renderAdmin } from "./admin";

const app = document.querySelector<HTMLDivElement>("#app")!;

let me: Me | null = null;

async function route(): Promise<void> {
  try {
    me = await api.me();
  } catch {
    me = null;
  }

  if (!me) return renderLogin();

  const planMatch = location.hash.match(/^#\/plans\/([0-9a-f]{32})$/);
  if (planMatch) return openPlanView(app, planMatch[1], me);
  if (location.hash === "#/admin" && me.role === "admin") return renderAdmin(app);
  return renderPlanList();
}

// ─── Login ────────────────────────────────────────────────────────────────

async function renderLogin(): Promise<void> {
  const { enabled: oidc } = await api.oidcEnabled().catch(() => ({ enabled: false }));
  app.innerHTML = `
    <div class="center"><div class="card stack">
      <h1>SIDC – C2 – Command &amp; Control</h1>
      <input id="u" placeholder="Benutzername" autocomplete="username" />
      <input id="p" type="password" placeholder="Passwort" autocomplete="current-password" />
      <button class="primary" id="go">Anmelden</button>
      ${oidc ? `<a href="/auth/oidc/login">Mit OIDC anmelden</a>` : ""}
      <div class="error" id="err"></div>
    </div></div>`;

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
      err.textContent = e instanceof ApiError ? e.message : "Fehler";
    }
  };
  app.querySelector("#go")!.addEventListener("click", submit);
  app.querySelector("#p")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") submit();
  });
}

// ─── Plan-Liste ───────────────────────────────────────────────────────────

async function renderPlanList(): Promise<void> {
  const [plans, maps] = await Promise.all([api.plans(), api.maps().catch(() => [])]);
  const canCreate = me!.can_create_plans_effective && maps.some((m) => m.status === "ready");

  app.innerHTML = `
    <div class="topbar">
      <strong>SIDC – C2</strong>
      <span class="grow"></span>
      ${me!.role === "admin" ? `<a href="#/admin">Administration</a>` : ""}
      <span class="muted">${me!.username} (${me!.role})</span>
      <button id="logout">Abmelden</button>
    </div>
    <div class="list stack">
      ${me!.role === "admin" ? adminMapsBlock(maps) : ""}
      <h2>Pläne</h2>
      ${
        canCreate
          ? `<div class="row">
               <input id="pn" placeholder="Planname" />
               <select id="pm">${maps
                 .filter((m) => m.status === "ready")
                 .map((m) => `<option value="${m.id}">${m.name}</option>`)
                 .join("")}</select>
               <button class="primary" id="pc">Neuer Plan</button>
             </div>`
          : `<div class="muted">${
              me!.can_create_plans_effective
                ? "Keine importierte Karte vorhanden."
                : "Keine Berechtigung, Pläne zu erstellen."
            }</div>`
      }
      <table><tbody>
        ${plans
          .map(
            (p) => `<tr>
              <td><a href="#/plans/${p.id}">${p.name}</a></td>
              <td><span class="badge">${p.level}</span></td>
              <td>${
                p.level === "owner" ? `<button data-del="${p.id}">Löschen</button>` : ""
              }</td>
            </tr>`,
          )
          .join("")}
      </tbody></table>
    </div>`;

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
  app.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (confirm("Plan wirklich löschen?")) {
        await api.deletePlan(b.dataset.del!);
        route();
      }
    }),
  );
  app.querySelector("#mi")?.addEventListener("click", async () => {
    const id = app.querySelector<HTMLInputElement>("#mid")!.value.trim();
    const name = app.querySelector<HTMLInputElement>("#mname")!.value.trim();
    const url = app.querySelector<HTMLInputElement>("#murl")!.value.trim();
    if (!id || !name || !url) return;
    try {
      await api.importMap(id, name, url);
      setTimeout(route, 500);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : "Fehler");
    }
  });
  app.querySelectorAll<HTMLButtonElement>("[data-reimport]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api.reimportMap(b.dataset.reimport!);
      setTimeout(route, 800);
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-delmap]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`Karte "${b.dataset.delmap}" löschen?`)) return;
      try {
        await api.deleteMap(b.dataset.delmap!);
        route();
      } catch (e) {
        alert(e instanceof ApiError ? e.message : "Fehler");
      }
    }),
  );
  app.querySelector("#restart")?.addEventListener("click", async () => {
    if (!confirm("Backend neu starten? Kurzer Ausfall (~5 s).")) return;
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
      <h2 style="margin:0">Karten (Admin)</h2>
      <span class="grow"></span>
      <button id="restart">Backend neu starten</button>
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
                 <button data-reimport="${m.id}">Neu laden</button>
                 <button data-delmap="${m.id}">Löschen</button>
               </td>
             </tr>`,
        )
        .join("")}
    </tbody></table>
    <div class="row">
      <input id="mid" placeholder="karten-id" />
      <input id="mname" placeholder="Anzeigename" />
      <input id="murl" placeholder="Download-URL (.zip)" style="flex:1" />
      <button id="mi">Importieren</button>
    </div>`;
}

window.addEventListener("hashchange", route);
route();
