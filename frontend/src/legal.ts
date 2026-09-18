// Impressum/Datenschutz — müssen jederzeit ohne Login erreichbar sein. Der Text
// kommt vom Admin (Konfiguration → Rechtliches, .md/.txt-Upload) und wird als
// Markdown angezeigt; ohne Upload steht dort ein Platzhalter.
import { api } from "./api";
import { t } from "./i18n";
import { renderMarkdown } from "./md";
import { themeSwitch, wireThemeSwitch } from "./ui";

export async function renderLegal(app: HTMLElement, page: "imprint" | "privacy"): Promise<void> {
  const title = page === "imprint" ? t("legal.imprint") : t("legal.privacy");
  const pending = page === "imprint" ? t("legal.imprintPending") : t("legal.privacyPending");
  const { content } = await api.legal(page).catch(() => ({ content: null }));
  app.innerHTML = `
    <div class="center"><div class="card stack" style="max-width:40rem">
      <div class="row"><h1 style="flex:1">${title}</h1>${themeSwitch()}</div>
      ${content ? renderMarkdown(content) : `<p class="muted">${pending}</p>`}
      <a href="#/">${t("nav.back")}</a>
    </div></div>`;
  wireThemeSwitch(app);
}
