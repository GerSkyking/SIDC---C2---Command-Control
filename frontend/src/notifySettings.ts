// Einstellungen → Benachrichtigungen: externe Kanäle (Discord, ntfy, Matrix, Web-Push …).
// Das Formular wird aus der Typ-Beschreibung des Servers gebaut – neue Kanal-Typen brauchen hier keine Änderung.
import { type NotifyChannel, type NotifyKind, type NotifyType, api } from "./api";
import { esc } from "./esc";
import { t } from "./i18n";
import { confirmDialog, toast, toastError } from "./notify";

const KINDS: NotifyKind[] = ["task_mention", "chat_mention", "assigned"];

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function bytesToB64url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  let s = "";
  new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const pushSupported = (): boolean => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Fragt Berechtigung ab, meldet den Browser an und legt serverseitig einen Web-Push-Kanal an. */
async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error(t("ntf.pushUnsupported"));
  if ((await Notification.requestPermission()) !== "granted") throw new Error(t("ntf.pushDenied"));
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { key } = await api.webpushKey();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) as BufferSource });
  const p256dh = bytesToB64url(sub.getKey("p256dh"));
  const auth = bytesToB64url(sub.getKey("auth"));
  await api.webpushSubscribe({ endpoint: sub.endpoint, keys: { p256dh, auth }, name: navigator.platform || "Browser" });
}

export function mountNotifySettings(host: HTMLElement): void {
  let types: NotifyType[] = [];
  let rows: NotifyChannel[] = [];

  const typeLabel = (ty: string) => types.find((x) => x.type === ty)?.label ?? ty;
  const kindBoxes = (sel: NotifyKind[], name: string) =>
    KINDS.map(
      (k) => `<label class="ntf-k"><input type="checkbox" data-k="${name}" value="${k}" ${!sel.length || sel.includes(k) ? "checked" : ""} /> ${t("ntf.kind." + k)}</label>`,
    ).join("");
  const pickKinds = (root: ParentNode, name: string): NotifyKind[] => {
    const on = [...root.querySelectorAll<HTMLInputElement>(`input[data-k="${name}"]:checked`)].map((i) => i.value as NotifyKind);
    return on.length === KINDS.length ? [] : on; // alles gewählt = keine Einschränkung
  };

  const paint = () => {
    const formTypes = types.filter((x) => x.form);
    host.innerHTML = `
      <p class="muted" style="font-size:.78rem;margin:.2rem 0">${t("ntf.hint")}</p>
      <div class="ntf-list">${
        rows.length
          ? rows
              .map(
                (c) => `<div class="ntf-i" data-id="${esc(c.id)}">
                  <div class="ntf-h"><strong>${esc(c.name)}</strong> <span class="muted">${esc(typeLabel(c.type))}</span>
                    <span class="grow"></span>
                    <label class="ntf-k"><input type="checkbox" data-en ${c.enabled ? "checked" : ""} /> ${t("ntf.enabled")}</label></div>
                  <div class="ntf-kinds">${kindBoxes(c.kinds, "k" + c.id)}</div>
                  ${c.last_error ? `<div class="error" style="font-size:.78rem">${esc(c.last_error)}</div>` : c.last_ok_at ? `<div class="muted" style="font-size:.75rem">${t("ntf.lastOk")}</div>` : ""}
                  <div class="row" style="gap:.4rem"><button data-test>${t("ntf.test")}</button><button data-save>${t("common.save")}</button><button class="danger" data-del>${t("common.delete")}</button></div>
                </div>`,
              )
              .join("")
          : `<p class="muted" style="font-size:.82rem">${t("ntf.none")}</p>`
      }</div>
      <div class="row" style="gap:.4rem;margin-top:.5rem;flex-wrap:wrap">
        ${pushSupported() ? `<button data-push>${t("ntf.addPush")}</button>` : `<span class="muted" style="font-size:.78rem">${t("ntf.pushUnsupported")}</span>`}
        <select id="ntf-type">${formTypes.map((x) => `<option value="${esc(x.type)}" ${x.available ? "" : "disabled"}>${esc(x.label)}${x.available ? "" : " – " + t("ntf.unavailable")}</option>`).join("")}</select>
        <button data-add>${t("ntf.add")}</button>
      </div>
      <div id="ntf-form"></div>`;
    wire();
  };

  const reload = async () => {
    rows = await api.notifyChannels();
    paint();
  };

  const openForm = (ty: NotifyType) => {
    const box = host.querySelector<HTMLElement>("#ntf-form")!;
    box.innerHTML = `<div class="ntf-i">
      <strong>${esc(ty.label)}</strong><p class="muted" style="font-size:.78rem;margin:.2rem 0">${esc(ty.help)}</p>
      <input id="nf-name" maxlength="80" placeholder="${esc(t("ntf.name"))}" />
      ${ty.fields.map((f) => `<input data-f="${esc(f.key)}" type="${f.secret ? "password" : "text"}" autocomplete="off" placeholder="${esc(f.label + (f.placeholder ? " – " + f.placeholder : ""))}" />`).join("")}
      <div class="ntf-kinds">${kindBoxes([], "new")}</div>
      <div class="row" style="gap:.4rem;justify-content:flex-end"><button data-c>${t("common.cancel")}</button><button class="primary" data-ok>${t("common.save")}</button></div></div>`;
    box.querySelector("[data-c]")!.addEventListener("click", () => (box.innerHTML = ""));
    box.querySelector("[data-ok]")!.addEventListener("click", async () => {
      const config: Record<string, string> = {};
      box.querySelectorAll<HTMLInputElement>("[data-f]").forEach((i) => (config[i.dataset.f!] = i.value));
      try {
        await api.createNotifyChannel({
          type: ty.type,
          name: box.querySelector<HTMLInputElement>("#nf-name")!.value,
          config,
          kinds: pickKinds(box, "new"),
        });
        await reload();
      } catch (e) {
        toastError(e);
      }
    });
  };

  const wire = () => {
    host.querySelector("[data-add]")?.addEventListener("click", () => {
      const ty = types.find((x) => x.type === host.querySelector<HTMLSelectElement>("#ntf-type")!.value);
      if (ty) openForm(ty);
    });
    host.querySelector("[data-push]")?.addEventListener("click", async () => {
      try {
        await enablePush();
        toast(t("ntf.pushOn"), { kind: "success" });
        await reload();
      } catch (e) {
        toastError(e);
      }
    });
    host.querySelectorAll<HTMLElement>(".ntf-list .ntf-i").forEach((el) => {
      const id = el.dataset.id!;
      el.querySelector("[data-test]")!.addEventListener("click", async () => {
        try {
          await api.testNotifyChannel(id);
          toast(t("ntf.testOk"), { kind: "success" });
        } catch (e) {
          toastError(e);
        }
        await reload();
      });
      el.querySelector("[data-save]")!.addEventListener("click", async () => {
        try {
          await api.patchNotifyChannel(id, {
            enabled: el.querySelector<HTMLInputElement>("[data-en]")!.checked,
            kinds: pickKinds(el, "k" + id),
          });
          toast(t("ntf.saved"), { kind: "success" });
          await reload();
        } catch (e) {
          toastError(e);
        }
      });
      el.querySelector("[data-del]")!.addEventListener("click", async () => {
        if (!(await confirmDialog(t("ntf.confirmDel"), { danger: true }))) return;
        await api.deleteNotifyChannel(id).catch(toastError);
        await reload();
      });
    });
  };

  host.innerHTML = `<p class="muted">…</p>`;
  Promise.all([api.notifyTypes(), api.notifyChannels()])
    .then(([ty, ch]) => {
      types = ty.types;
      rows = ch;
      paint();
    })
    .catch((e) => {
      host.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
    });
}
