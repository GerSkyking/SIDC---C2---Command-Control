// Kleine UI-Helfer, damit die innerHTML-Templates nicht dupliziert werden.
import { icon } from "./icons";
import { getTheme, setTheme, type ThemeChoice } from "./theme";
import { t } from "./i18n";

export function iconBtn(
  name: string,
  opts: { title?: string; id?: string; active?: boolean; data?: Record<string, string>; cls?: string } = {},
): string {
  const attrs = [
    opts.id ? `id="${opts.id}"` : "",
    `class="icon-btn ${opts.active ? "active" : ""} ${opts.cls ?? ""}"`,
    opts.title ? `title="${opts.title}" aria-label="${opts.title}"` : "",
    ...Object.entries(opts.data ?? {}).map(([k, v]) => `data-${k}="${v}"`),
  ]
    .filter(Boolean)
    .join(" ");
  return `<button type="button" ${attrs}>${icon(name)}</button>`;
}

/** 3-Wege-Theme-Schalter. Wird via wireThemeSwitch(root) verdrahtet. */
export function themeSwitch(): string {
  const cur = getTheme();
  const opt = (v: ThemeChoice, ic: string, label: string) =>
    `<button type="button" class="seg-btn ${cur === v ? "active" : ""}" data-theme-set="${v}" title="${label}" aria-label="${label}">${icon(ic, 16)}</button>`;
  return `<div class="segmented theme-switch" role="group" aria-label="${t("theme.label")}">
    ${opt("dark", "moon", t("theme.dark"))}
    ${opt("light", "sun", t("theme.light"))}
    ${opt("system", "monitor", t("theme.system"))}
  </div>`;
}

export function wireThemeSwitch(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-theme-set]").forEach((b) =>
    b.addEventListener("click", () => {
      setTheme(b.dataset.themeSet as ThemeChoice);
      root.querySelectorAll<HTMLButtonElement>("[data-theme-set]").forEach((x) =>
        x.classList.toggle("active", x.dataset.themeSet === b.dataset.themeSet),
      );
    }),
  );
}
