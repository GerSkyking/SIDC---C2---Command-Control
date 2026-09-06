// Freigabe-Editor für einen Plan (nur Owner): Subjekte (User/Gruppe) → Rolle +
// feingranulare Rechte (setzen / bewegen / löschen / malen).
import { api, ApiError, type AclEntry } from "./api";
import { t } from "./i18n";

type Row = Omit<AclEntry, "id">;

export async function openAclEditor(planId: string, planName: string, onClose?: () => void): Promise<void> {
  const [entries, candidates] = await Promise.all([
    api.planAcl(planId),
    api.planAclCandidates(planId),
  ]);
  const nameOf = (t: string, id: string) =>
    candidates.find((c) => c.subject_type === t && c.subject_id === id)?.name ?? id.slice(0, 8);

  let rows: Row[] = entries.map((e) => ({ ...e }));

  const backdrop = document.createElement("div");
  backdrop.className = "wiz-backdrop";
  document.body.appendChild(backdrop);
  const close = () => {
    backdrop.remove();
    onClose?.();
  };
  backdrop.addEventListener("click", (e) => e.target === backdrop && close());

  const draw = () => {
    backdrop.innerHTML = `
      <div class="wiz" style="width:min(44rem,95vw)">
        <div class="wiz-head"><strong>${t("acl.heading")} — ${planName}</strong><span class="grow"></span><button data-x>✕</button></div>
        <div class="wiz-body">
          <table class="acl-tbl"><thead><tr>
            <th>${t("acl.who")}</th><th>${t("acl.role")}</th><th>${t("acl.place")}</th><th>${t("acl.move")}</th><th>${t("acl.deletePerm")}</th><th>${t("acl.draw")}</th><th></th>
          </tr></thead><tbody>
          ${rows
            .map(
              (r, i) => `<tr>
                <td>${nameOf(r.subject_type, r.subject_id)}</td>
                <td><select data-i="${i}" data-f="level">
                  ${["viewer", "editor", "owner"].map((l) => `<option ${l === r.level ? "selected" : ""}>${l}</option>`).join("")}
                </select></td>
                ${(["can_place", "can_move", "can_delete", "can_draw"] as const)
                  .map(
                    (f) =>
                      `<td><input type="checkbox" data-i="${i}" data-f="${f}" ${r[f] ? "checked" : ""} ${
                        r.level === "editor" ? "" : "disabled"
                      }/></td>`,
                  )
                  .join("")}
                <td><button data-del="${i}">✕</button></td>
              </tr>`,
            )
            .join("")}
          </tbody></table>
          <div class="row" style="margin-top:.6rem">
            <select data-add>
              <option value="">${t("acl.addSubject")}</option>
              ${candidates
                .filter((c) => !rows.some((r) => r.subject_type === c.subject_type && r.subject_id === c.subject_id))
                .map((c) => `<option value="${c.subject_type}:${c.subject_id}">${c.name}</option>`)
                .join("")}
            </select>
          </div>
          <p class="muted">Feingranulare Häkchen gelten nur für Rolle „editor". „owner" darf alles + Freigaben verwalten, „viewer" nur sehen.</p>
          <hr style="border-color:var(--border)"/>
          <h3 style="margin:.4rem 0">${t("acl.publicLink")}</h3>
          <div id="shares"></div>
          <div class="row">
            <input id="sh-label" placeholder="${t('acl.linkLabel')}" />
            <input id="sh-days" type="number" min="0" placeholder="${t('acl.linkDays')}" style="width:9rem" />
            <button id="sh-add">${t("acl.createLink")}</button>
          </div>
        </div>
        <div class="wiz-config" style="max-height:none">
          <span class="error" data-err></span>
          <button class="primary" data-save>${t("common.save")}</button>
        </div>
      </div>`;

    backdrop.querySelector("[data-x]")!.addEventListener("click", close);
    backdrop.querySelectorAll<HTMLElement>("[data-f]").forEach((el) =>
      el.addEventListener("change", () => {
        const i = Number(el.dataset.i);
        const f = el.dataset.f as keyof Row;
        if (f === "level") rows[i].level = (el as HTMLSelectElement).value as Row["level"];
        else (rows[i][f] as boolean) = (el as HTMLInputElement).checked;
        draw();
      }),
    );
    backdrop.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) =>
      b.addEventListener("click", () => {
        rows.splice(Number(b.dataset.del), 1);
        draw();
      }),
    );
    backdrop.querySelector<HTMLSelectElement>("[data-add]")!.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (!v) return;
      const [t, id] = v.split(":");
      rows.push({
        subject_type: t as "user" | "group",
        subject_id: id,
        level: "editor",
        can_place: true,
        can_move: true,
        can_delete: true,
        can_draw: true,
      });
      draw();
    });
    backdrop.querySelector("#sh-add")?.addEventListener("click", async () => {
      const label = (backdrop.querySelector("#sh-label") as HTMLInputElement).value.trim();
      const days = Number((backdrop.querySelector("#sh-days") as HTMLInputElement).value) || 0;
      await api.createShare(planId, label, days || undefined);
      void renderShares();
    });
    void renderShares();

    backdrop.querySelector("[data-save]")!.addEventListener("click", async () => {
      try {
        await api.putPlanAcl(planId, rows);
        close();
      } catch (err) {
        backdrop.querySelector<HTMLElement>("[data-err]")!.textContent =
          err instanceof ApiError ? err.message : t("common.error");
      }
    });
  };

  async function renderShares(): Promise<void> {
    const box = backdrop.querySelector<HTMLDivElement>("#shares");
    if (!box) return;
    const shares = (await api.planShares(planId)).filter((s) => !s.revoked);
    box.innerHTML = shares.length
      ? shares
          .map((s) => {
            const url = `${location.origin}/#/p/${s.token}`;
            return `<div class="row" style="margin:.2rem 0">
              <input readonly value="${url}" style="flex:1" onclick="this.select()" />
              <button data-copy="${url}">${t("acl.copy")}</button>
              <button data-revoke="${s.token}">${t("acl.revoke")}</button>
            </div>`;
          })
          .join("")
      : `<p class="muted">${t("acl.noLink")}</p>`;
    box.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) =>
      b.addEventListener("click", () => navigator.clipboard?.writeText(b.dataset.copy!)),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.revokeShare(planId, b.dataset.revoke!);
        renderShares();
      }),
    );
  }

  draw();
}
