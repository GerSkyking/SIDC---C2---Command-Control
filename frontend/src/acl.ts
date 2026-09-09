// Freigabe-Editor für einen Plan (nur Owner): Subjekte (User/Gruppe) → Rolle +
// feingranulare Rechte (setzen / bewegen / löschen / malen).
import { api, ApiError, type AclEntry, type Phase, type PublicShareRow, type ShareOpts } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";

type Row = Omit<AclEntry, "id">;

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
export const shareUrl = (token: string, label?: string): string => {
  const sl = label ? slugify(label) : "";
  return `${location.origin}/#/p/${token}${sl ? "~" + sl : ""}`;
};

export async function openAclEditor(
  planId: string,
  planName: string,
  onClose?: () => void,
  isMB = false,
): Promise<void> {
  const [entries, candidates, phases] = await Promise.all([
    api.planAcl(planId),
    api.planAclCandidates(planId),
    api.planPhases(planId).catch(() => [] as Phase[]),
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
        <div class="wiz-head"><strong>${t("acl.heading")} — ${planName}</strong><span class="grow"></span><button class="icon-btn" data-x>${icon("x")}</button></div>
        <div class="wiz-body">
          <table class="acl-tbl"><thead><tr>
            <th>${t("acl.who")}</th><th>${t("acl.role")}</th><th>${t("acl.place")}</th><th>${t("acl.move")}</th><th>${t("acl.deletePerm")}</th><th>${t("acl.draw")}</th><th></th>
          </tr></thead><tbody>
          ${rows
            .map(
              (r, i) => `<tr>
                <td>${nameOf(r.subject_type, r.subject_id)}</td>
                <td><select data-i="${i}" data-f="level">
                  ${(["viewer", "editor", "owner"] as const)
                    .map((l) => `<option value="${l}" ${l === r.level ? "selected" : ""}>${t("acl.role." + l)}</option>`)
                    .join("")}
                </select></td>
                ${(["can_place", "can_move", "can_delete", "can_draw"] as const)
                  .map(
                    (f) =>
                      `<td><input type="checkbox" data-i="${i}" data-f="${f}" ${r[f] ? "checked" : ""} ${
                        r.level === "editor" ? "" : "disabled"
                      }/></td>`,
                  )
                  .join("")}
                <td><button class="icon-btn" data-del="${i}">${icon("x", 16)}</button></td>
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
          <p class="muted">${t("acl.legend")}</p>
          <hr style="border-color:var(--border)"/>
          <h3 style="margin:.4rem 0">${t("acl.publicLink")}</h3>
          <div id="shares"></div>
          <button id="sh-new">+ ${t("acl.createLink")}</button>
          <div id="sh-form"></div>
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
        level: "viewer",
        can_place: true,
        can_move: true,
        can_delete: true,
        can_draw: true,
      });
      draw();
    });
    backdrop.querySelector("#sh-new")?.addEventListener("click", () => openShareForm(null));
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

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  async function renderShares(): Promise<void> {
    const box = backdrop.querySelector<HTMLDivElement>("#shares");
    if (!box) return;
    const shares = (await api.planShares(planId)).filter((s) => !s.revoked);
    const badge = (on: boolean | undefined, txt: string) =>
      on ? `<span class="badge" style="background:var(--accent-weak)">${txt}</span>` : "";
    box.innerHTML = shares.length
      ? shares
          .map((s) => {
            const url = shareUrl(s.token, s.label);
            const scope = s.phase_ids?.length
              ? `${s.phase_ids.length} ${t("phase.heading")}`
              : s.date_from || s.date_to
                ? `${(s.date_from || "").slice(0, 10)}…${(s.date_to || "").slice(0, 10)}`
                : t("acl.allPhases");
            return `<div class="sh-item">
              <div class="row">
                <strong class="grow">${esc(s.label || t("acl.linkUnnamed"))}</strong>
                ${badge(s.can_point, t("tool.point"))}${badge(s.can_move, t("tool.markermove"))}${badge(s.can_edit, t("common.rename"))}${badge(s.include_builder, "⚑")}
                <span class="muted">${scope}</span>
                <button class="icon-btn" data-edit="${s.token}" title="${t("common.rename")}">${icon("edit", 14)}</button>
                <button class="icon-btn" data-revoke="${s.token}" title="${t("acl.revoke")}">${icon("x", 14)}</button>
              </div>
              <div class="row"><input readonly value="${url}" style="flex:1" onclick="this.select()" />
                <button data-copy="${url}">${t("acl.copy")}</button></div>
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
    box.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) =>
      b.addEventListener("click", () =>
        openShareForm(shares.find((x) => x.token === b.dataset.edit) ?? null),
      ),
    );
  }

  function openShareForm(s: PublicShareRow | null): void {
    const host = backdrop.querySelector<HTMLDivElement>("#sh-form")!;
    const g = (v: unknown, d = "") => (v == null ? d : String(v));
    const phaseChecks = (withBuilder: boolean): string => {
      const checked = new Set(
        [...host.querySelectorAll<HTMLInputElement>("[data-ph]:checked")].map((c) => c.dataset.ph!),
      );
      const src = checked.size ? checked : new Set(s?.phase_ids ?? []);
      return phases
        .filter((p) => withBuilder || (p.plane ?? "player") !== "builder")
        .map(
          (p) =>
            `<label class="chk"><input type="checkbox" data-ph="${p.id}" ${src.has(p.id) ? "checked" : ""}/> ${
              p.plane === "builder" ? "⚑ " : ""
            }${esc(p.name)}</label>`,
        )
        .join("");
    };
    host.innerHTML = `<div class="sh-form">
      <label class="chk-lbl">${t("acl.linkLabel")}<input data-f="label" value="${esc(g(s?.label))}"/></label>
      <div class="row">
        <label class="chk"><input type="checkbox" data-f="can_point" ${s ? (s.can_point ? "checked" : "") : "checked"}/> ${t("tool.point")}</label>
        <label class="chk"><input type="checkbox" data-f="can_move" ${s?.can_move ? "checked" : ""}/> ${t("tool.markermove")}</label>
        <label class="chk"><input type="checkbox" data-f="can_edit" ${s?.can_edit ? "checked" : ""}/> ${t("common.rename")}</label>
        ${isMB ? `<label class="chk"><input type="checkbox" data-f="include_builder" ${s?.include_builder ? "checked" : ""}/> ${t("mb.builder")}</label>` : ""}
      </div>
      <label class="chk-lbl">${t("acl.linkDays")}<input type="number" min="0" data-f="expires_days" placeholder="∞"/></label>
      <fieldset class="sh-scope">
        <legend>${t("acl.scope")}</legend>
        <label class="chk"><input type="radio" name="shsc" value="all" ${!s?.phase_ids?.length && !s?.date_from && !s?.date_to ? "checked" : ""}/> ${t("acl.allPhases")}</label>
        <label class="chk"><input type="radio" name="shsc" value="phases" ${s?.phase_ids?.length ? "checked" : ""}/> ${t("acl.pickPhases")}</label>
        <div data-scope="phases" class="sh-phases">${phaseChecks(!!s?.include_builder)}</div>
        <label class="chk"><input type="radio" name="shsc" value="date" ${s?.date_from || s?.date_to ? "checked" : ""}/> ${t("acl.dateRange")}</label>
        <div data-scope="date" class="row">
          <input type="datetime-local" data-f="date_from" value="${g(s?.date_from).slice(0, 16)}"/>
          <input type="datetime-local" data-f="date_to" value="${g(s?.date_to).slice(0, 16)}"/>
        </div>
      </fieldset>
      <div class="row"><button class="primary" data-shsave>${t("common.save")}</button>
        <button data-shcancel>${t("common.cancel")}</button></div>
    </div>`;
    const syncScope = () => {
      const v = host.querySelector<HTMLInputElement>('input[name="shsc"]:checked')?.value;
      host.querySelector<HTMLElement>('[data-scope="phases"]')!.hidden = v !== "phases";
      host.querySelector<HTMLElement>('[data-scope="date"]')!.hidden = v !== "date";
    };
    host.querySelectorAll('input[name="shsc"]').forEach((r) => r.addEventListener("change", syncScope));
    syncScope();
    // Missionsbau an/aus → Phasenliste neu aufbauen (mit/ohne ⚑-Phasen)
    host.querySelector<HTMLInputElement>('[data-f="include_builder"]')?.addEventListener("change", (e) => {
      host.querySelector<HTMLElement>('[data-scope="phases"]')!.innerHTML = phaseChecks(
        (e.target as HTMLInputElement).checked,
      );
    });
    host.querySelector("[data-shcancel]")!.addEventListener("click", () => (host.innerHTML = ""));
    host.querySelector("[data-shsave]")!.addEventListener("click", async () => {
      const f = <T extends HTMLInputElement>(n: string) => host.querySelector<T>(`[data-f="${n}"]`);
      const scope = host.querySelector<HTMLInputElement>('input[name="shsc"]:checked')?.value;
      const opts: ShareOpts = {
        label: f("label")!.value.trim(),
        can_point: f("can_point")!.checked,
        can_move: f("can_move")!.checked,
        can_edit: f("can_edit")!.checked,
        include_builder: !!f("include_builder")?.checked,
        expires_days: Number(f("expires_days")!.value) || 0,
        phase_ids:
          scope === "phases"
            ? [...host.querySelectorAll<HTMLInputElement>("[data-ph]:checked")].map((c) => c.dataset.ph!)
            : [],
        date_from: scope === "date" && f("date_from")!.value ? f("date_from")!.value : null,
        date_to: scope === "date" && f("date_to")!.value ? f("date_to")!.value : null,
      };
      try {
        if (s) await api.patchShare(planId, s.token, opts);
        else await api.createShare(planId, opts);
        host.innerHTML = "";
        void renderShares();
      } catch (err) {
        backdrop.querySelector<HTMLElement>("[data-err]")!.textContent =
          err instanceof ApiError ? err.message : t("common.error");
      }
    });
  }

  draw();
}
