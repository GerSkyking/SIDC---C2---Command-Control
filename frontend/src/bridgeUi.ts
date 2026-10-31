// Brücke zu Discord & Co.: Konto verknüpfen (Einstellungen) und Gruppen-Chat mit einem Kanal verbinden (Chat).
import { api } from "./api";
import { esc } from "./esc";
import { t } from "./i18n";
import { a11yModal, toast, toastError } from "./notify";

function codeBox(code: string, mins: number): string {
  return `<div class="brg-code"><div class="row" style="gap:.5rem"><code>${esc(code)}</code><button data-copy="${esc(code)}">${t("brg.copy")}</button></div>
    <span class="muted" style="font-size:.78rem">${t("brg.codeHint").replace("{m}", String(mins))}</span></div>`;
}

/** Kopieren-Knöpfe in `root` verdrahten (nach dem Einfügen von codeBox aufrufen). */
function wireCopy(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy!);
        toast(t("brg.copied"), { kind: "success", timeout: 1500 });
      } catch (e) {
        toastError(e);
      }
    }),
  );
}

/** Einstellungen: „Discord-Konto verknüpfen“ inkl. Code-Anzeige. */
export function mountAccountLinks(host: HTMLElement): void {
  const paint = async () => {
    const me = await api.bridgeMe().catch(() => null);
    if (!me || !me.enabled) {
      host.innerHTML = "";
      return;
    }
    const linked = me.identities.some((i) => i.provider === "discord");
    host.innerHTML = `<div class="ntf-i"><strong>Discord</strong>
      <span class="muted" style="font-size:.8rem">${linked ? t("brg.linked") : t("brg.notLinked")}</span>
      <div class="row" style="gap:.4rem"><button data-code>${t("brg.linkAccount")}</button>
        ${linked ? `<button class="danger" data-unlink>${t("brg.unlink")}</button>` : ""}</div>
      <div data-out></div></div>`;
    host.querySelector("[data-code]")!.addEventListener("click", async () => {
      try {
        const r = await api.bridgeCode({ kind: "user" });
        host.querySelector<HTMLElement>("[data-out]")!.innerHTML = codeBox(r.code, Math.round(r.expires_in / 60));
        wireCopy(host);
      } catch (e) {
        toastError(e);
      }
    });
    host.querySelector("[data-unlink]")?.addEventListener("click", async () => {
      await api.bridgeUnlinkIdentity("discord").catch(toastError);
      await paint();
    });
  };
  void paint();
}

/** Chat-Kopf: Gruppen-Chat mit Discord-Kanälen verbinden / Verbindungen lösen. */
export async function openBridgeDialog(conversationId: string, name: string): Promise<void> {
  const me = await api.bridgeMe().catch(() => null);
  const back = document.createElement("div");
  back.className = "edit-modal";
  back.innerHTML = `<div class="card stack" style="width:min(30rem,94vw)">
    <h1 style="margin:0;font-size:1.05rem">${t("brg.title")} – ${esc(name)}</h1>
    ${me?.enabled ? "" : `<p class="error">${t("brg.off")}</p>`}
    <div data-links></div>
    <p class="muted" style="font-size:.8rem;margin:0">${t("brg.chanHint")}</p>
    <div data-out></div>
    <div class="row" style="justify-content:flex-end;gap:.4rem"><button data-code ${me?.enabled ? "" : "disabled"}>${t("brg.newCode")}</button><button data-c>${t("common.close")}</button></div></div>`;
  document.body.appendChild(back);
  a11yModal(back, t("brg.title"));
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  back.querySelector("[data-c]")!.addEventListener("click", close);
  const links = back.querySelector<HTMLElement>("[data-links]")!;
  const load = async () => {
    const rows = await api.bridgeLinks(conversationId).catch(() => []);
    links.innerHTML = rows.length
      ? rows
          .map((r) => `<div class="row" style="gap:.4rem"><span class="grow">${esc(r.provider)} · ${r.channel_name ? `${esc(r.group_name)} #${esc(r.channel_name)}` : `<span class="muted">${esc(r.external_id)}</span>`}</span><button class="icon-btn" data-rm="${esc(r.id)}" title="${t("brg.remove")}">×</button></div>`)
          .join("")
      : `<p class="muted" style="font-size:.82rem">${t("brg.none")}</p>`;
    links.querySelectorAll<HTMLElement>("[data-rm]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.bridgeDeleteLink(b.dataset.rm!).catch(toastError);
        await load();
      }),
    );
  };
  void load();
  back.querySelector("[data-code]")!.addEventListener("click", async () => {
    try {
      const r = await api.bridgeCode({ kind: "conv", conversation_id: conversationId });
      back.querySelector<HTMLElement>("[data-out]")!.innerHTML = codeBox(r.code, Math.round(r.expires_in / 60));
      wireCopy(back);
    } catch (e) {
      toastError(e);
    }
  });
  // nach dem Einlösen des Codes zeigt sich die neue Verbindung hier
  const poll = setInterval(() => (back.isConnected ? void load() : clearInterval(poll)), 4000);
}

/** Admin-Bereich: Gruppen-Chats mit Kanälen verbinden, die der Bot sieht (alle Server). */
export function mountBridgeAdmin(host: HTMLElement): void {
  const paint = async () => {
    const ov = await api.bridgeAdminOverview().catch(() => null);
    if (!ov) {
      host.innerHTML = "";
      return;
    }
    const groups = [...new Set(ov.channels.map((c) => c.group_name))];
    host.innerHTML = `<h2>${t("brg.adminTitle")}</h2>
      <p class="muted" style="font-size:.82rem;margin:0">${t("brg.adminHint")}</p>
      ${ov.enabled ? "" : `<p class="error">${t("brg.off")}</p>`}
      <table><tbody>${
        ov.links.length
          ? ov.links
              .map(
                (l) => `<tr><td>${esc(l.conversation_name)}</td><td>${l.channel_name ? `${esc(l.group_name)} #${esc(l.channel_name)}` : esc(l.external_id)}</td>
                  <td style="text-align:right"><button class="danger" data-rm="${esc(l.id)}">${t("brg.remove")}</button></td></tr>`,
              )
              .join("")
          : `<tr><td class="muted">${t("brg.none")}</td></tr>`
      }</tbody></table>
      <div class="row" style="gap:.4rem;flex-wrap:wrap">
        <select id="bga-conv">${ov.conversations.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select>
        <select id="bga-chan">${
          ov.channels.length
            ? groups
                .map(
                  (g) => `<optgroup label="${esc(g)}">${ov.channels
                    .filter((c) => c.group_name === g)
                    .map((c) => `<option value="${esc(c.provider + "|" + c.external_id)}">#${esc(c.name)}</option>`)
                    .join("")}</optgroup>`,
                )
                .join("")
            : `<option value="">${t("brg.noChannels")}</option>`
        }</select>
        <button class="primary" data-link ${ov.channels.length && ov.conversations.length ? "" : "disabled"}>${t("brg.link")}</button></div>`;
    host.querySelectorAll<HTMLElement>("[data-rm]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.bridgeAdminUnlink(b.dataset.rm!).catch(toastError);
        await paint();
      }),
    );
    host.querySelector("[data-link]")?.addEventListener("click", async () => {
      const [provider, external_id] = host.querySelector<HTMLSelectElement>("#bga-chan")!.value.split("|");
      try {
        await api.bridgeAdminLink({
          conversation_id: host.querySelector<HTMLSelectElement>("#bga-conv")!.value,
          provider,
          external_id,
        });
        await paint();
      } catch (e) {
        toastError(e);
      }
    });
  };
  void paint();
}

