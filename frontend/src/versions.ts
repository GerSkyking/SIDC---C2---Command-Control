// Versionsverlauf eines Plans: Stände sichern + auf einen alten Stand zurück.
import { api, ApiError } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";

export function openVersionPanel(
  planId: string,
  canSave: boolean,
  canRestore: boolean,
  onSaved?: () => void,
): void {
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card ver-card">
      <div class="row"><h1 style="flex:1;margin:0">${t("versions.title")}</h1><button class="ver-x icon-btn">${icon("x")}</button></div>
      ${
        canSave
          ? `<div class="row">
        <input class="ver-name" placeholder="${t("versions.saveName")}" style="flex:1" />
        <button class="primary ver-save">${t("versions.save")}</button>
      </div>`
          : ""
      }
      <div class="ver-list"><div class="muted">…</div></div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.querySelector(".ver-x")!.addEventListener("click", close);

  const listEl = back.querySelector<HTMLDivElement>(".ver-list")!;
  const load = async () => {
    try {
      const rows = await api.planVersions(planId);
      if (!rows.length) {
        listEl.innerHTML = `<div class="muted">${t("versions.empty")}</div>`;
        return;
      }
      listEl.innerHTML = rows
        .map(
          (v) => `<div class="ver-row">
            <div class="ver-meta">
              <strong>${v.label || "—"}</strong>
              <span class="muted">${new Date(v.created_at).toLocaleString()} · ${v.author}
                · ${v.marker_count} ${t("versions.markers")}, ${v.stroke_count} ${t("versions.strokes")}</span>
            </div>
            ${canRestore ? `<button data-restore="${v.id}">${t("versions.restore")}</button>` : ""}
          </div>`,
        )
        .join("");
      listEl.querySelectorAll<HTMLButtonElement>("[data-restore]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm(t("versions.confirmRestore"))) return;
          try {
            await api.restoreVersion(planId, b.dataset.restore!);
            location.reload();
          } catch (e) {
            alert(e instanceof ApiError ? e.message : t("common.error"));
          }
        }),
      );
    } catch (e) {
      listEl.innerHTML = `<div class="error">${e instanceof ApiError ? e.message : t("common.error")}</div>`;
    }
  };

  back.querySelector(".ver-save")?.addEventListener("click", async () => {
    const name = back.querySelector<HTMLInputElement>(".ver-name")!.value.trim();
    try {
      await api.saveVersion(planId, name);
      back.querySelector<HTMLInputElement>(".ver-name")!.value = "";
      onSaved?.();
      void load();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : t("common.error"));
    }
  });

  void load();
}
