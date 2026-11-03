// Öffentliches Feedback-Formular (#/feedback/<token>): ohne Login, schlichtes Layout ohne Navigation, einbettbar per <iframe>.
import { ApiError } from "./api";
import { esc } from "./esc";
import { langSelect, t, wireLangSelect } from "./i18n";
import { publicFeedbackApi } from "./projectFeedbackApi";

export async function renderFeedbackPublic(root: HTMLElement, token: string): Promise<void> {
  const shell = (inner: string) =>
    `<div class="fbp-page"><main class="fbp-card" aria-labelledby="fbpH">
       <div class="fbp-top"><span class="grow"></span>${langSelect()}</div>${inner}</main></div>`;
  const fail = (msg: string) => {
    root.innerHTML = shell(`<h1 id="fbpH">${esc(t("fbp.title"))}</h1><p class="error" role="alert">${esc(msg)}</p>`);
    wireLangSelect(root);
  };
  /** Fehlertext je HTTP-Status */
  const explain = (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.status === 404) return t("fbp.invalid");
      if (e.status === 410) return t("fbp.archived");
      if (e.status === 429) return t("fbp.rate");
      if (e.status === 400 && e.message.length < 160 && !e.message.includes("[object")) return e.message;
      if (e.status === 400 || e.status === 413 || e.status === 422) return t("fbp.needFields");
    }
    return t("fbp.fail");
  };

  root.innerHTML = shell(`<p class="muted">${t("common.loading")}</p>`);
  let info: { project: string; kinds: string[] };
  try {
    info = await publicFeedbackApi.info(token);
  } catch (e) {
    return fail(e instanceof ApiError && (e.status === 404 || e.status === 410) ? explain(e) : t("fbp.fail"));
  }

  const form = () => {
    root.innerHTML = shell(`
      <h1 id="fbpH">${esc(info.project || t("fbp.title"))}</h1>
      <p class="muted">${t("fbp.intro")}</p>
      <form id="fbpForm" class="stack" novalidate>
        <div class="field"><label for="fbp-k">${t("fbp.kind")}</label>
          <select id="fbp-k" name="kind">${info.kinds.map((k) => `<option value="${esc(k)}">${esc(t("fb.kind." + k))}</option>`).join("")}</select></div>
        <div class="field"><label for="fbp-t">${t("fbp.titleLbl")}</label>
          <input id="fbp-t" name="title" maxlength="200" required aria-required="true" autocomplete="off" /></div>
        <div class="field"><label for="fbp-x">${t("fbp.text")}</label>
          <textarea id="fbp-x" name="text" rows="6" maxlength="5000" aria-describedby="fbp-cnt"></textarea>
          <small class="muted" id="fbp-cnt">0 / 5000</small></div>
        <div class="field"><label for="fbp-n">${t("fbp.name")}</label>
          <input id="fbp-n" name="name" maxlength="80" autocomplete="name" placeholder="${esc(t("fbp.namePh"))}" /></div>
        <div class="fbp-hp" aria-hidden="true"><label>Website<input name="website" id="fbp-w" tabindex="-1" autocomplete="off" /></label></div>
        <p class="error" id="fbp-err" role="alert"></p>
        <div class="row"><button class="primary" type="submit" id="fbp-go">${t("fbp.send")}</button></div>
      </form>`);
    wireLangSelect(root);
    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const err = $("#fbp-err");
    const text = $<HTMLTextAreaElement>("#fbp-x");
    text.addEventListener("input", () => ($("#fbp-cnt").textContent = `${text.value.length} / 5000`));
    $("#fbpForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const title = $<HTMLInputElement>("#fbp-t").value.trim();
      err.textContent = "";
      $("#fbp-t").classList.toggle("invalid", !title);
      if (!title) {
        err.textContent = t("fbp.needTitle");
        $("#fbp-t").focus();
        return;
      }
      const go = $<HTMLButtonElement>("#fbp-go");
      go.disabled = true;
      try {
        await publicFeedbackApi.submit(token, {
          title,
          text: text.value.trim(),
          kind: $<HTMLSelectElement>("#fbp-k").value,
          name: $<HTMLInputElement>("#fbp-n").value.trim(),
          website: $<HTMLInputElement>("#fbp-w").value,
        });
        thanks();
      } catch (e) {
        err.textContent = explain(e);
        go.disabled = false;
      }
    });
  };

  const thanks = () => {
    root.innerHTML = shell(`
      <h1 id="fbpH">${esc(t("fbp.thanks"))}</h1>
      <p role="status">${t("fbp.thanksText")}</p>
      <div class="row"><button id="fbp-again">${t("fbp.again")}</button></div>`);
    wireLangSelect(root);
    root.querySelector("#fbp-again")!.addEventListener("click", form);
    root.querySelector<HTMLElement>("#fbpH")!.setAttribute("tabindex", "-1");
    root.querySelector<HTMLElement>("#fbpH")!.focus();
  };

  form();
}
