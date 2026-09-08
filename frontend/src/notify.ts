// Eigenes Benachrichtigungs-/Dialog-System — ersetzt native alert/confirm/prompt.
import { t } from "./i18n";
import { icon } from "./icons";

export type ToastKind = "info" | "success" | "error" | "warn";

let host: HTMLElement | null = null;
function toastHost(): HTMLElement {
  if (!host || !document.body.contains(host)) {
    host = document.createElement("div");
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message: string, opts: { kind?: ToastKind; timeout?: number } = {}): void {
  const kind = opts.kind ?? "info";
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span class="toast-msg"></span><button class="toast-x icon-btn" aria-label="${t("common.close")}">${icon("x", 13)}</button>`;
  el.querySelector(".toast-msg")!.textContent = message;
  toastHost().appendChild(el);
  const remove = () => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector(".toast-x")!.addEventListener("click", remove);
  const ms = opts.timeout ?? (kind === "error" ? 7000 : 4000);
  if (ms > 0) setTimeout(remove, ms);
}

/** Bequemer Fehler-Toast aus einem catch-Wert. */
export function toastError(e: unknown, fallback?: string): void {
  const msg =
    e instanceof Error ? e.message : typeof e === "string" && e ? e : fallback || t("common.error");
  toast(msg, { kind: "error" });
}

interface ConfirmOpts {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function confirmDialog(message: string, opts: ConfirmOpts = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.innerHTML = `<div class="card stack" style="width:min(24rem,94vw)">
      ${opts.title ? `<h1 style="margin:0;font-size:1.05rem">${opts.title}</h1>` : ""}
      <p class="nd-msg" style="margin:0;white-space:pre-line"></p>
      <div class="row" style="justify-content:flex-end;gap:.5rem">
        <button data-c>${opts.cancelLabel ?? t("common.cancel")}</button>
        <button class="${opts.danger ? "danger" : "primary"}" data-ok>${opts.okLabel ?? t("common.ok")}</button>
      </div></div>`;
    back.querySelector(".nd-msg")!.textContent = message;
    document.body.appendChild(back);
    const done = (v: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Enter") done(true);
    };
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("mousedown", (e) => e.target === back && done(false));
    back.querySelector("[data-c]")!.addEventListener("click", () => done(false));
    back.querySelector("[data-ok]")!.addEventListener("click", () => done(true));
    setTimeout(() => (back.querySelector("[data-ok]") as HTMLButtonElement).focus(), 0);
  });
}

interface PromptOpts {
  title?: string;
  value?: string;
  okLabel?: string;
  placeholder?: string;
}

export function promptDialog(message: string, opts: PromptOpts = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "edit-modal";
    back.innerHTML = `<div class="card stack" style="width:min(26rem,94vw)">
      ${opts.title ? `<h1 style="margin:0;font-size:1.05rem">${opts.title}</h1>` : ""}
      <p class="nd-msg" style="margin:0;white-space:pre-line"></p>
      <input data-in />
      <div class="row" style="justify-content:flex-end;gap:.5rem">
        <button data-c>${t("common.cancel")}</button>
        <button class="primary" data-ok>${opts.okLabel ?? t("common.ok")}</button>
      </div></div>`;
    back.querySelector(".nd-msg")!.textContent = message;
    document.body.appendChild(back);
    const inp = back.querySelector<HTMLInputElement>("[data-in]")!;
    inp.value = opts.value ?? "";
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    const done = (v: string | null) => {
      back.remove();
      resolve(v);
    };
    back.addEventListener("mousedown", (e) => e.target === back && done(null));
    back.querySelector("[data-c]")!.addEventListener("click", () => done(null));
    back.querySelector("[data-ok]")!.addEventListener("click", () => done(inp.value));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(inp.value);
      if (e.key === "Escape") done(null);
    });
    setTimeout(() => {
      inp.focus();
      inp.select();
    }, 0);
  });
}
