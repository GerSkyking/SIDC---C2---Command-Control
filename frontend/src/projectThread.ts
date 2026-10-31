// Diskussions-Thread einer Aufgabe: Fragen stellen, Leute per @name / @gruppe / @projekt ansprechen.
import { type Mentionable, type TaskComment, api } from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { attachMentions, renderMentionText } from "./mentionInput";
import { confirmDialog, toastError } from "./notify";
import { type ProjCtx, relTime } from "./projectUtil";

export async function mountThread(host: HTMLElement, ctx: ProjCtx, taskId: string): Promise<void> {
  let comments: TaskComment[] = [];
  let cands: Mentionable[] = [];
  let editing: string | null = null;
  const canPost = !ctx.project.archived;

  host.innerHTML = `<div class="th-list" aria-live="polite"></div>
    ${
      canPost
        ? `<div class="th-new"><textarea rows="2" maxlength="5000" placeholder="${esc(t("thread.ph"))}" aria-label="${esc(t("thread.ph"))}"></textarea>
           <button class="primary" data-send>${esc(t("thread.send"))}</button></div>
           <p class="muted th-hint">${esc(t("thread.hint"))}</p>`
        : ""
    }`;
  const list = host.querySelector<HTMLElement>(".th-list")!;
  const ta = host.querySelector<HTMLTextAreaElement>(".th-new textarea");
  if (ta) attachMentions(ta, () => cands);

  const paint = () => {
    list.innerHTML = comments.length
      ? comments
          .map((c) =>
            editing === c.id
              ? `<div class="th-c" data-id="${esc(c.id)}"><textarea rows="3" maxlength="5000" class="th-edit">${esc(c.text)}</textarea>
                  <div class="row"><button data-save>${esc(t("common.save"))}</button><button data-cancel>${esc(t("common.cancel"))}</button></div></div>`
              : `<div class="th-c" data-id="${esc(c.id)}">
                  <div class="th-h"><strong>${esc(c.user_label || t("act.unknown"))}</strong>
                    <span class="muted" title="${esc(new Date(c.created_at).toLocaleString())}">${esc(relTime(c.created_at))}${c.edited_at ? " · " + esc(t("thread.edited")) : ""}</span>
                    <span class="grow"></span>
                    ${c.can_edit ? `<button class="icon-btn" data-edit title="${esc(t("thread.edit"))}" aria-label="${esc(t("thread.edit"))}">${icon("edit", 14)}</button>` : ""}
                    ${c.can_delete ? `<button class="icon-btn" data-del title="${esc(t("common.delete"))}" aria-label="${esc(t("common.delete"))}">${icon("trash", 14)}</button>` : ""}</div>
                  <div class="th-tx">${renderMentionText(c.text, c.mentions)}</div></div>`,
          )
          .join("")
      : `<p class="muted">${esc(t("thread.empty"))}</p>`;
  };

  const load = async () => {
    comments = await api.taskComments(ctx.id, taskId);
    paint();
  };

  list.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const row = el.closest<HTMLElement>(".th-c");
    if (!row) return;
    const id = row.dataset.id!;
    try {
      if (el.closest("[data-edit]")) {
        editing = id;
        paint();
        const inp = list.querySelector<HTMLTextAreaElement>(".th-edit");
        if (inp) {
          attachMentions(inp, () => cands);
          inp.focus();
        }
      } else if (el.closest("[data-cancel]")) {
        editing = null;
        paint();
      } else if (el.closest("[data-save]")) {
        const text = row.querySelector<HTMLTextAreaElement>(".th-edit")!.value.trim();
        if (!text) return;
        await api.patchTaskComment(ctx.id, taskId, id, text);
        editing = null;
        await load();
      } else if (el.closest("[data-del]")) {
        if (!(await confirmDialog(t("thread.deleteConfirm"), { danger: true, trash: true }))) return;
        await api.deleteTaskComment(ctx.id, taskId, id);
        await load();
      }
    } catch (err) {
      toastError(err);
    }
  });

  const send = async () => {
    const text = ta?.value.trim();
    if (!ta || !text) return;
    try {
      await api.createTaskComment(ctx.id, taskId, text);
      ta.value = "";
      await load();
      list.scrollTop = list.scrollHeight;
    } catch (err) {
      toastError(err);
    }
  };
  host.querySelector("[data-send]")?.addEventListener("click", () => void send());
  ta?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  });

  try {
    [comments, cands] = await Promise.all([
      api.taskComments(ctx.id, taskId),
      api.projectMentionables(ctx.id).catch((): Mentionable[] => []),
    ]);
    paint();
  } catch (err) {
    list.innerHTML = `<p class="error">${esc(err instanceof Error ? err.message : String(err))}</p>`;
  }
}
