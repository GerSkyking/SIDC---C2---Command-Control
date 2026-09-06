// Freigabe-Editor für einen Plan (nur Owner): Subjekte (User/Gruppe) → Rolle +
// feingranulare Rechte (setzen / bewegen / löschen / malen).
import { api, ApiError, type AclEntry } from "./api";

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
        <div class="wiz-head"><strong>Freigaben — ${planName}</strong><span class="grow"></span><button data-x>✕</button></div>
        <div class="wiz-body">
          <table class="acl-tbl"><thead><tr>
            <th>Wer</th><th>Rolle</th><th>setzen</th><th>bewegen</th><th>löschen</th><th>malen</th><th></th>
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
              <option value="">+ Subjekt hinzufügen…</option>
              ${candidates
                .filter((c) => !rows.some((r) => r.subject_type === c.subject_type && r.subject_id === c.subject_id))
                .map((c) => `<option value="${c.subject_type}:${c.subject_id}">${c.name}</option>`)
                .join("")}
            </select>
          </div>
          <p class="muted">Feingranulare Häkchen gelten nur für Rolle „editor". „owner" darf alles + Freigaben verwalten, „viewer" nur sehen.</p>
        </div>
        <div class="wiz-config" style="max-height:none">
          <span class="error" data-err></span>
          <button class="primary" data-save>Speichern</button>
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
    backdrop.querySelector("[data-save]")!.addEventListener("click", async () => {
      try {
        await api.putPlanAcl(planId, rows);
        close();
      } catch (err) {
        backdrop.querySelector<HTMLElement>("[data-err]")!.textContent =
          err instanceof ApiError ? err.message : "Fehler";
      }
    });
  };
  draw();
}
