// Chat: Direktnachrichten, Gruppen (frei, aus Admin-Gruppen oder Projekten) und der System-Feed
// (Erwähnungen, Zuweisungen). Zustellung per Polling.
import {
  type ChatConversation,
  type ChatMessage,
  type ChatNotification,
  type Mentionable,
  type Me,
  api,
} from "./api";
import { esc } from "./esc";
import { icon } from "./icons";
import { langSelect, t, wireLangSelect } from "./i18n";
import { attachMentions, renderMentionText } from "./mentionInput";
import { a11yModal, confirmDialog, promptDialog, toastError } from "./notify";
import { relTime, startPolling } from "./projectUtil";
import { openSettings } from "./settings";
import { sidebar, themeSwitch, wireSidebar, wireThemeSwitch } from "./ui";

const SYSTEM = "system";

export async function renderChat(app: HTMLElement, me: Me, selIn?: string): Promise<void> {
  app.innerHTML = `
   <div class="shell">
    ${sidebar("chat", { isAdmin: me.role === "admin", username: me.display_name || me.username, isMissionBuilder: me.is_mission_builder_effective })}
    <div class="shell-main">
     <div class="topbar"><strong>${t("nav.chat")}</strong><span class="grow"></span>${themeSwitch()}${langSelect()}
       <button class="icon-btn" id="settingsBtn" title="${t("settings.open")}" aria-label="${t("settings.open")}">${icon("settings")}</button></div>
     <div class="chat" id="chat">
      <aside class="chat-side">
        <div class="chat-side-h"><strong>${t("chat.conversations")}</strong>
          <button class="icon-btn" id="chNew" title="${t("chat.new")}" aria-label="${t("chat.new")}">${icon("plus", 16)}</button></div>
        <div id="chList" class="chat-list"></div>
      </aside>
      <section class="chat-main" id="chMain"></section>
     </div>
    </div>
   </div>`;
  wireLangSelect(app);
  wireThemeSwitch(app);
  wireSidebar(app);
  app.querySelector("#settingsBtn")?.addEventListener("click", openSettings);

  const root = app.querySelector<HTMLElement>("#chat")!;
  const listEl = app.querySelector<HTMLElement>("#chList")!;
  const mainEl = app.querySelector<HTMLElement>("#chMain")!;
  let convs: ChatConversation[] = [];
  let sysUnread = 0;
  let sel: string | null = selIn ?? null;
  let stopMain: (() => void) | null = null;

  const bump = () => window.dispatchEvent(new Event("chat-unread-changed"));

  // ── Seitenliste ──
  const paintList = () => {
    const row = (id: string, ic: string, name: string, sub: string, unread: number, time = "") =>
      `<button class="chat-row${sel === id ? " sel" : ""}" data-id="${esc(id)}">
        <span class="chat-ic">${ic}</span>
        <span class="chat-meta"><strong>${esc(name)}</strong><span class="muted">${esc(sub)}</span></span>
        <span class="chat-side-r"><span class="muted chat-time">${esc(time)}</span>${unread ? `<span class="ubadge">${unread > 99 ? "99+" : unread}</span>` : ""}</span></button>`;
    listEl.innerHTML =
      row(SYSTEM, icon("audit", 18), t("chat.system"), t("chat.systemSub"), sysUnread) +
      convs
        .map((c) =>
          row(
            c.id,
            c.kind === "dm" ? icon("users", 18) : icon("groups", 18),
            c.name || "?",
            c.last ? `${c.last.user_label ? c.last.user_label + ": " : ""}${c.last.text}` : t("chat.noMessages"),
            c.unread,
            c.last ? relTime(c.last.created_at) : "",
          ),
        )
        .join("");
  };
  listEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (b) void select(b.dataset.id!);
  });

  const loadList = async () => {
    const [c, u] = await Promise.all([api.chatConversations(), api.chatUnread()]);
    convs = c;
    sysUnread = u.notifications;
    paintList();
  };

  async function select(id: string | null): Promise<void> {
    stopMain?.();
    stopMain = null;
    sel = id;
    try {
      history.replaceState(null, "", id ? `#/chat/${id}` : "#/chat");
    } catch {
      /* ignore */
    }
    root.classList.toggle("chat-open", !!id); // schmale Bildschirme: Liste oder Verlauf
    paintList();
    if (!id) {
      mainEl.innerHTML = `<div class="chat-empty muted">${t("chat.pick")}</div>`;
    } else if (id === SYSTEM) {
      stopMain = mountSystem(mainEl, () => void loadList().then(bump), () => void select(null));
    } else {
      const c = convs.find((x) => x.id === id);
      if (!c) {
        mainEl.innerHTML = `<div class="chat-empty muted">${t("chat.pick")}</div>`;
        return;
      }
      stopMain = mountConversation(mainEl, c, () => void loadList().then(bump), () => void select(null), async () => {
        await loadList();
        await select(null);
      });
    }
  }

  // ── Neue Unterhaltung ──
  app.querySelector("#chNew")!.addEventListener("click", () => {
    void openNewDialog(async (cid) => {
      await loadList();
      await select(cid);
    });
  });

  mainEl.innerHTML = `<div class="chat-empty muted">${t("common.loading")}</div>`;
  try {
    await loadList();
  } catch (e) {
    mainEl.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
    return;
  }
  await select(sel && (sel === SYSTEM || convs.some((c) => c.id === sel)) ? sel : null);
  startPolling(root, loadList, () => !!document.querySelector(".edit-modal"), 6000);
}

// ─── Unterhaltung ──────────────────────────────────────────────────────────

function mountConversation(
  host: HTMLElement,
  conv: ChatConversation,
  changed: () => void,
  back: () => void,
  left: () => Promise<void>,
): () => void {
  let msgs: ChatMessage[] = [];
  let cands: Mentionable[] = [];
  let editing: string | null = null;
  let sig = "";
  let alive = true;

  host.innerHTML = `
    <header class="chat-head"><button class="icon-btn chat-back" title="${t("nav.back")}" aria-label="${t("nav.back")}">${icon("back", 18)}</button>
      <strong class="grow">${esc(conv.name)}</strong>
      ${conv.kind === "group" ? `<button class="icon-btn" data-members title="${t("chat.members")}" aria-label="${t("chat.members")}">${icon("users", 16)} <span class="muted">${conv.member_count}</span></button>` : ""}
    </header>
    <div class="chat-msgs" aria-live="polite"></div>
    <div class="chat-compose"><textarea rows="2" maxlength="5000" placeholder="${esc(t("chat.ph"))}" aria-label="${esc(t("chat.ph"))}"></textarea>
      <button class="primary" data-send>${t("thread.send")}</button></div>`;
  const list = host.querySelector<HTMLElement>(".chat-msgs")!;
  const ta = host.querySelector<HTMLTextAreaElement>(".chat-compose textarea")!;
  attachMentions(ta, () => cands);
  host.querySelector(".chat-back")!.addEventListener("click", back);

  const paint = (force = false) => {
    const s = JSON.stringify(msgs.map((m) => [m.id, m.text, m.edited_at])) + (editing ?? "");
    if (!force && s === sig) return;
    sig = s;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    let lastUser: string | null = null;
    let lastDay = "";
    list.innerHTML = msgs.length
      ? msgs
          .map((m) => {
            const day = new Date(m.created_at).toLocaleDateString();
            const sep = day !== lastDay ? `<div class="chat-day">${esc(day)}</div>` : "";
            const head = m.user_id !== lastUser || sep;
            lastDay = day;
            lastUser = m.user_id;
            const body =
              editing === m.id
                ? `<textarea class="chat-edit" rows="2" maxlength="5000">${esc(m.text)}</textarea>
                   <div class="row"><button data-save>${t("common.save")}</button><button data-cancel>${t("common.cancel")}</button></div>`
                : `<div class="th-tx">${renderMentionText(m.text, m.mentions)}</div>`;
            return `${sep}<div class="chat-msg${m.mine ? " mine" : ""}" data-id="${esc(m.id)}">
              ${head ? `<div class="th-h"><strong>${esc(m.user_label || t("act.unknown"))}</strong>
                 <span class="muted" title="${esc(new Date(m.created_at).toLocaleString())}">${esc(new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}${m.edited_at ? " · " + esc(t("thread.edited")) : ""}</span></div>` : ""}
              ${body}
              ${m.mine && editing !== m.id ? `<span class="chat-acts"><button class="icon-btn" data-edit title="${esc(t("thread.edit"))}" aria-label="${esc(t("thread.edit"))}">${icon("edit", 13)}</button><button class="icon-btn" data-del title="${esc(t("common.delete"))}" aria-label="${esc(t("common.delete"))}">${icon("trash", 13)}</button></span>` : ""}
            </div>`;
          })
          .join("")
      : `<p class="muted chat-empty">${t("chat.noMessages")}</p>`;
    if (nearBottom || force) list.scrollTop = list.scrollHeight;
    if (editing) {
      const inp = list.querySelector<HTMLTextAreaElement>(".chat-edit");
      if (inp) {
        attachMentions(inp, () => cands);
        inp.focus();
      }
    }
  };

  const load = async () => {
    if (!alive) return;
    const fresh = await api.chatMessages(conv.id);
    if (!alive) return;
    const hadNew = fresh.length && (!msgs.length || fresh[fresh.length - 1].id !== msgs[msgs.length - 1]?.id);
    if (editing) {
      msgs = msgs.length ? msgs : fresh; // beim Bearbeiten nichts umschreiben
      return;
    }
    msgs = fresh;
    paint(!sig);
    if (hadNew || conv.unread) {
      conv.unread = 0;
      void api.chatRead(conv.id).then(changed).catch(() => {});
    }
  };

  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.disabled = true;
    try {
      await api.postChatMessage(conv.id, text);
      ta.value = "";
      editing = null;
      msgs = await api.chatMessages(conv.id);
      paint(true);
      changed();
    } catch (e) {
      toastError(e);
    } finally {
      ta.disabled = false;
      ta.focus();
    }
  };
  host.querySelector("[data-send]")!.addEventListener("click", () => void send());
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });

  list.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const row = el.closest<HTMLElement>(".chat-msg");
    if (!row) return;
    const id = row.dataset.id!;
    try {
      if (el.closest("[data-edit]")) {
        editing = id;
        paint(true);
      } else if (el.closest("[data-cancel]")) {
        editing = null;
        paint(true);
      } else if (el.closest("[data-save]")) {
        const text = row.querySelector<HTMLTextAreaElement>(".chat-edit")!.value.trim();
        if (!text) return;
        await api.patchChatMessage(conv.id, id, text);
        editing = null;
        msgs = await api.chatMessages(conv.id);
        paint(true);
      } else if (el.closest("[data-del]")) {
        if (!(await confirmDialog(t("chat.deleteConfirm"), { danger: true, trash: true }))) return;
        await api.deleteChatMessage(conv.id, id);
        msgs = await api.chatMessages(conv.id);
        paint(true);
        changed();
      }
    } catch (err) {
      toastError(err);
    }
  });

  host.querySelector("[data-members]")?.addEventListener("click", () => void openMembersDialog(conv, left, changed));

  void api.chatMentionables(conv.id).then((c) => (cands = c)).catch(() => {});
  load().catch((e) => {
    list.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
  const stopPoll = startPolling(host, load, () => !!editing, 3000);
  return () => {
    alive = false;
    stopPoll();
  };
}

// ─── System-Feed ───────────────────────────────────────────────────────────

function mountSystem(host: HTMLElement, changed: () => void, back: () => void): () => void {
  let rows: ChatNotification[] = [];
  let alive = true;
  host.innerHTML = `
    <header class="chat-head"><button class="icon-btn chat-back" title="${t("nav.back")}" aria-label="${t("nav.back")}">${icon("back", 18)}</button>
      <strong class="grow">${t("chat.system")}</strong>
      <button data-all>${t("chat.markAll")}</button><button data-clear>${t("chat.clearRead")}</button></header>
    <div class="chat-msgs sys"></div>`;
  const list = host.querySelector<HTMLElement>(".chat-msgs")!;
  host.querySelector(".chat-back")!.addEventListener("click", back);

  const href = (n: ChatNotification): string =>
    n.conversation_id ? `#/chat/${n.conversation_id}` : n.project_id ? `#/projects/${n.project_id}/tasks` : "#/chat";
  const text = (n: ChatNotification): string => {
    const who = `<strong>${esc(n.actor_label || t("act.unknown"))}</strong>`;
    const where = `<em>${esc(n.title)}</em>${n.project_name ? ` <span class="muted">· ${esc(n.project_name)}</span>` : ""}`;
    if (n.kind === "assigned") return t("sys.assigned").replace("{u}", who).replace("{t}", where);
    if (n.kind === "chat_mention") return t("sys.chatMention").replace("{u}", who).replace("{t}", where || "");
    return t("sys.taskMention").replace("{u}", who).replace("{t}", where);
  };
  const open = new Set<string>(); // Einträge mit geöffnetem Antwortfeld
  const drafts = new Map<string, string>();
  const paint = () => {
    list.innerHTML = rows.length
      ? rows
          .map(
            (n) => `<div class="sys-w">
              <a class="sys-i${n.read ? "" : " unread"}" href="${esc(href(n))}" data-id="${esc(n.id)}">
              <span class="chat-ic">${icon(n.kind === "assigned" ? "check" : "audit", 16)}</span>
              <span class="sys-b"><span>${text(n)}</span>${n.text ? `<span class="sys-q muted">${esc(n.text)}</span>` : ""}</span>
              <span class="muted chat-time">${esc(relTime(n.created_at))}</span></a>
              ${
                n.conversation_id || n.task_id
                  ? `<div class="sys-r" data-rid="${esc(n.id)}">${
                      open.has(n.id)
                        ? `<input maxlength="5000" placeholder="${esc(t("sys.replyPh"))}" value="${esc(drafts.get(n.id) ?? "")}" /><button class="primary" data-rs>${t("thread.send")}</button>`
                        : `<button class="link" data-rt>${t("sys.reply")}</button>`
                    }</div>`
                  : ""
              }</div>`,
          )
          .join("")
      : `<p class="muted chat-empty">${t("chat.sysEmpty")}</p>`;
  };
  const load = async () => {
    if (!alive) return;
    rows = await api.chatNotifications();
    if (list.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return; // nicht beim Tippen überschreiben
    paint();
  };
  const sendReply = async (rid: string, input: HTMLInputElement) => {
    const txt = input.value.trim();
    if (!txt) return;
    input.disabled = true;
    try {
      await api.replyNotification(rid, txt);
      open.delete(rid);
      drafts.delete(rid);
      await load();
      changed();
    } catch (err) {
      input.disabled = false;
      toastError(err);
    }
  };
  list.addEventListener("input", (e) => {
    const inp = e.target as HTMLInputElement;
    const rid = inp.closest<HTMLElement>("[data-rid]")?.dataset.rid;
    if (rid) drafts.set(rid, inp.value);
  });
  list.addEventListener("keydown", (e) => {
    const inp = e.target as HTMLInputElement;
    const rid = inp.closest<HTMLElement>("[data-rid]")?.dataset.rid;
    if (rid && e.key === "Enter" && inp.tagName === "INPUT") {
      e.preventDefault();
      void sendReply(rid, inp);
    }
  });
  list.addEventListener("click", (e) => {
    const tgt = e.target as HTMLElement;
    const rid = tgt.closest<HTMLElement>("[data-rid]")?.dataset.rid;
    if (rid && tgt.closest("[data-rt]")) {
      open.add(rid);
      paint();
      list.querySelector<HTMLInputElement>(`[data-rid="${CSS.escape(rid)}"] input`)?.focus();
      return;
    }
    if (rid && tgt.closest("[data-rs]")) {
      void sendReply(rid, list.querySelector<HTMLInputElement>(`[data-rid="${CSS.escape(rid)}"] input`)!);
      return;
    }
    const a = tgt.closest<HTMLElement>("[data-id]");
    if (a) void api.chatReadNotifications({ ids: [a.dataset.id!] }).then(changed).catch(() => {}); // Navigation läuft über den Link
  });
  host.querySelector("[data-all]")!.addEventListener("click", async () => {
    await api.chatReadNotifications({ all: true }).catch(toastError);
    await load();
    changed();
  });
  host.querySelector("[data-clear]")!.addEventListener("click", async () => {
    await api.chatClearNotifications().catch(toastError);
    await load();
    changed();
  });
  load().catch((e) => {
    list.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  });
  const stopPoll = startPolling(host, load, () => false, 6000);
  return () => {
    alive = false;
    stopPoll();
  };
}

// ─── Dialoge ───────────────────────────────────────────────────────────────

async function openNewDialog(done: (cid: string) => Promise<void>): Promise<void> {
  const data = await api.chatUsers().catch(() => ({ users: [], groups: [], projects: [] }));
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card stack" style="width:min(30rem,94vw);max-height:90vh;overflow:auto">
    <h1 style="margin:0;font-size:1.05rem">${t("chat.new")}</h1>
    <div class="segmented" role="tablist">
      <button data-tab="dm" class="seg-btn active">${t("chat.tab.dm")}</button><button data-tab="group" class="seg-btn">${t("chat.tab.group")}</button>
      <button data-tab="src" class="seg-btn">${t("chat.tab.src")}</button></div>
    <div data-pane="dm"><input id="nq" placeholder="${esc(t("chat.search"))}" /><div class="chat-pick" id="nList"></div></div>
    <div data-pane="group" hidden><input id="gn" maxlength="80" placeholder="${esc(t("chat.groupName"))}" />
      <div class="chat-pick" id="gList">${data.users.map((u) => `<label><input type="checkbox" value="${esc(u.id)}" /> ${esc(u.label)} <span class="muted">@${esc(u.username)}</span></label>`).join("")}</div></div>
    <div data-pane="src" hidden>
      <p class="muted" style="font-size:.8rem">${t("chat.srcHint")}</p>
      <div class="chat-pick">${data.groups.map((g) => `<button data-src="group:${esc(g.id)}">${icon("groups", 14)} ${esc(g.name)} <span class="muted">${t("chat.srcGroup")}</span></button>`).join("")}
        ${data.projects.map((p) => `<button data-src="project:${esc(p.id)}">${icon("folder", 14)} ${esc(p.name)} <span class="muted">${t("chat.srcProject")}</span></button>`).join("")}
        ${data.groups.length + data.projects.length ? "" : `<p class="muted">${t("chat.srcNone")}</p>`}</div></div>
    <div class="row" style="justify-content:flex-end"><button data-c>${t("common.cancel")}</button><button class="primary" data-ok hidden>${t("chat.create")}</button></div></div>`;
  document.body.appendChild(back);
  a11yModal(back, t("chat.new"));
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  back.querySelector("[data-c]")!.addEventListener("click", close);
  const ok = back.querySelector<HTMLButtonElement>("[data-ok]")!;
  const go = async (fn: () => Promise<{ id: string }>) => {
    try {
      const c = await fn();
      close();
      await done(c.id);
    } catch (e) {
      toastError(e);
    }
  };

  back.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      back.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
      back.querySelectorAll<HTMLElement>("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
      ok.hidden = b.dataset.tab !== "group";
    }),
  );
  const nList = back.querySelector<HTMLElement>("#nList")!;
  const paintDm = (q: string) => {
    const ql = q.toLowerCase();
    nList.innerHTML = data.users
      .filter((u) => !ql || u.label.toLowerCase().includes(ql) || u.username.toLowerCase().includes(ql))
      .map((u) => `<button data-u="${esc(u.id)}">${icon("users", 14)} ${esc(u.label)} <span class="muted">@${esc(u.username)}</span></button>`)
      .join("");
  };
  paintDm("");
  back.querySelector<HTMLInputElement>("#nq")!.addEventListener("input", (e) => paintDm((e.target as HTMLInputElement).value));
  nList.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-u]");
    if (b) void go(() => api.createChat({ kind: "dm", user_id: b.dataset.u! }));
  });
  ok.addEventListener("click", () => {
    const name = back.querySelector<HTMLInputElement>("#gn")!.value.trim();
    if (!name) {
      back.querySelector("#gn")!.classList.add("invalid");
      return;
    }
    const ids = [...back.querySelectorAll<HTMLInputElement>("#gList input:checked")].map((i) => i.value);
    void go(() => api.createChat({ kind: "group", name, member_ids: ids }));
  });
  back.querySelectorAll<HTMLElement>("[data-src]").forEach((b) =>
    b.addEventListener("click", () => {
      const [type, id] = b.dataset.src!.split(":");
      void go(() => api.createChat({ kind: "group", source_type: type as "group" | "project", source_id: id }));
    }),
  );
}

async function openMembersDialog(conv: ChatConversation, left: () => Promise<void>, changed: () => void): Promise<void> {
  const [members, data] = await Promise.all([
    api.chatMembers(conv.id).catch(() => []),
    conv.is_owner && !conv.source_type ? api.chatUsers().catch(() => null) : Promise.resolve(null),
  ]);
  const back = document.createElement("div");
  back.className = "edit-modal";
  const own = conv.is_owner && !conv.source_type;
  const have = new Set(members.map((m) => m.user_id));
  back.innerHTML = `<div class="card stack" style="width:min(26rem,94vw);max-height:90vh;overflow:auto">
    <h1 style="margin:0;font-size:1.05rem">${esc(conv.name)}</h1>
    ${conv.source_type ? `<p class="muted" style="font-size:.8rem">${t(conv.source_type === "group" ? "chat.boundGroup" : "chat.boundProject")}</p>` : ""}
    <ul class="chat-members">${members
      .map((m) => `<li>${esc(m.label)}${m.is_owner ? ` <span class="muted">(${t("chat.owner")})</span>` : ""}${own && !m.is_owner ? ` <button class="icon-btn" data-rm="${esc(m.user_id)}" title="${t("common.delete")}">${icon("x", 12)}</button>` : ""}</li>`)
      .join("")}</ul>
    ${own && data ? `<label class="muted">${t("chat.addMember")}</label><select id="mAdd"><option value="">–</option>${data.users.filter((u) => !have.has(u.id)).map((u) => `<option value="${esc(u.id)}">${esc(u.label)}</option>`).join("")}</select>` : ""}
    <div class="row" style="justify-content:space-between">
      ${conv.kind === "group" && !conv.source_type ? `<button class="danger" data-leave>${t("chat.leave")}</button>` : "<span></span>"}
      <span class="row">${own ? `<button data-rename>${t("chat.rename")}</button>` : ""}<button data-c>${t("common.close")}</button></span></div></div>`;
  document.body.appendChild(back);
  a11yModal(back, conv.name);
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  back.querySelector("[data-c]")!.addEventListener("click", close);
  const reopen = () => {
    close();
    changed();
  };
  back.querySelectorAll<HTMLElement>("[data-rm]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api.chatPutMembers(conv.id, { remove: [b.dataset.rm!] });
        reopen();
      } catch (e) {
        toastError(e);
      }
    }),
  );
  back.querySelector<HTMLSelectElement>("#mAdd")?.addEventListener("change", async (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (!v) return;
    try {
      await api.chatPutMembers(conv.id, { add: [v] });
      reopen();
    } catch (err) {
      toastError(err);
    }
  });
  back.querySelector("[data-rename]")?.addEventListener("click", async () => {
    const n = await promptDialog(t("chat.groupName"), { value: conv.name });
    if (!n?.trim()) return;
    try {
      await api.chatRename(conv.id, n.trim());
      reopen();
    } catch (e) {
      toastError(e);
    }
  });
  back.querySelector("[data-leave]")?.addEventListener("click", async () => {
    if (!(await confirmDialog(t("chat.leaveConfirm"), { danger: true }))) return;
    try {
      await api.chatLeave(conv.id);
      close();
      await left();
    } catch (e) {
      toastError(e);
    }
  });
}
