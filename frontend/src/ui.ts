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

export type NavSection = "plans" | "trash" | "users" | "log" | "config";

/** Linke Navigationsleiste für die Nicht-Karten-Ansichten. */
export function sidebar(
  active: NavSection,
  opts: { isAdmin: boolean; username: string },
): string {
  const collapsed = localStorage.getItem("sidc_sidebar") === "1";
  const item = (id: NavSection, ic: string, label: string, href: string, sub = false) =>
    `<a class="sb-item ${sub ? "sb-sub" : ""} ${active === id ? "active" : ""}" href="${href}" title="${label}">${icon(ic)}<span>${label}</span></a>`;
  return `<nav class="sidebar ${collapsed ? "collapsed" : ""}" id="sidebar">
    <div class="sb-top">
      <button class="sb-toggle icon-btn" id="sbToggle" title="Menü">${icon("chevron")}</button>
      <span class="sb-brand">SIDC – C2</span>
    </div>
    <div class="sb-nav">
      ${item("plans", "plan", t("nav.plans"), "#/")}
      ${item("trash", "trash", t("nav.trash"), "#/trash")}
      ${
        opts.isAdmin
          ? `<div class="sb-group">${t("nav.admin")}</div>` +
            item("users", "users", t("admin.usersGroups"), "#/admin/users", true) +
            item("log", "audit", t("admin.log"), "#/admin/log", true) +
            item("config", "settings", t("admin.config"), "#/admin/config", true)
          : ""
      }
    </div>
    <div class="sb-foot">
      <div class="sb-user">${icon("users", 16)}<span>${opts.username}</span></div>
    </div>
  </nav>`;
}

export function wireSidebar(root: ParentNode): void {
  const sb = root.querySelector<HTMLElement>("#sidebar");
  root.querySelector("#sbToggle")?.addEventListener("click", () => {
    const now = sb?.classList.toggle("collapsed");
    try {
      localStorage.setItem("sidc_sidebar", now ? "1" : "0");
    } catch {
      /* ignore */
    }
  });
}
