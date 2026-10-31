// Brücke zu Discord & Co.: Konto verknüpfen (Einstellungen) und Gruppen-Chat mit einem Kanal verbinden (Chat).
import { api } from "./api";
import { esc } from "./esc";
import { t } from "./i18n";
import { a11yModal, toastError } from "./notify";

function codeBox(code: string, mins: number): string {
  return `<div class="brg-code"><code>/c2 link ${esc(code)}</code>
    <span class="muted" style="font-size:.78rem">${t("brg.codeHint").replace("{m}", String(mins))}</span></div>`;
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
          .map((r) => `<div class="row" style="gap:.4rem"><span class="grow">${esc(r.provider)} · <span class="muted">${esc(r.external_id)}</span></span><button class="icon-btn" data-rm="${esc(r.id)}" title="${t("brg.remove")}">×</button></div>`)
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
    } catch (e) {
      toastError(e);
    }
  });
  // nach dem Einlösen des Codes zeigt sich die neue Verbindung hier
  const poll = setInterval(() => (back.isConnected ? void load() : clearInterval(poll)), 4000);
}
