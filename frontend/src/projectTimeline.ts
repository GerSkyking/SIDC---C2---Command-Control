// Tab „Zeitleiste": Überschriften mit Zeitangabe (## 06:30 Anmarsch) aus den Dateien, vertikal nach Tag gruppiert;
// relative Einträge (## T+01:30 …) stehen in einer eigenen Gruppe. Klick öffnet die Datei.
import { esc } from "./esc";
import { icon } from "./icons";
import { t } from "./i18n";
import { projectLink, refApi, type TimelineEntry } from "./projectRefs";
import type { ProjCtx } from "./projectUtil";

const pad = (n: number): string => String(n).padStart(2, "0");

function clock(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "–";
  const m = Math.max(0, Math.round(min));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function mountTimeline(host: HTMLElement, ctx: ProjCtx): void {
  host.innerHTML = `
    <div class="tl">
      <div class="tl-bar">
        <p class="muted tl-intro">${t("tl.intro")}</p>
        <button type="button" id="tlReload" title="${esc(t("proj.img.reload"))}">${icon("versions", 14)} ${t("proj.img.reload")}</button>
      </div>
      <details class="tl-syntax"><summary>${t("tl.syntax")}</summary>${syntaxHtml()}</details>
      <div id="tlBody"><p class="muted">${t("common.loading")}</p></div>
    </div>`;
  const body = host.querySelector<HTMLElement>("#tlBody")!;

  const entryHtml = (e: TimelineEntry, rel: boolean): string => {
    const space = e.space === "builder" && ctx.isBuilder ? "builder" : "public";
    return `<li class="tl-item">
      <span class="tl-time">${rel ? "T+" : ""}${clock(e.minutes)}</span>
      <span class="tl-dot" aria-hidden="true"></span>
      <a class="tl-card" href="${esc(projectLink(ctx.id, space, "doc=" + e.doc_id))}">
        <strong class="tl-head">${esc(e.heading)}</strong>
        <span class="tl-doc muted">${icon("notes", 12)} ${esc(e.doc_name.replace(/\.md$/i, ""))}${
          e.space === "builder" ? ` <span class="dir-space" title="${esc(t("proj.tab.builder"))}">${icon("lock", 12)}</span>` : ""
        }</span>
      </a></li>`;
  };

  const paint = (list: TimelineEntry[]) => {
    if (!list.length) {
      body.innerHTML = `<div class="tl-empty muted">${icon("clock", 36)}<h3>${t("tl.empty")}</h3><p>${t("tl.emptyHint")}</p>${syntaxHtml()}</div>`;
      return;
    }
    const byMin = (a: TimelineEntry, b: TimelineEntry) => (a.minutes ?? 0) - (b.minutes ?? 0);
    const days = new Map<number, TimelineEntry[]>();
    const rel: TimelineEntry[] = [];
    for (const e of list) {
      if (e.relative) rel.push(e);
      else {
        const d = e.day && e.day > 0 ? e.day : 1;
        if (!days.has(d)) days.set(d, []);
        days.get(d)!.push(e);
      }
    }
    const sec = (title: string, items: TimelineEntry[], isRel: boolean, id: string) =>
      `<section class="tl-group" aria-labelledby="${id}">
        <h3 id="${id}">${icon(isRel ? "versions" : "calendar", 15)} ${esc(title)} <span class="dir-count">${items.length}</span></h3>
        <ol class="tl-list">${[...items].sort(byMin).map((e) => entryHtml(e, isRel)).join("")}</ol></section>`;
    body.innerHTML =
      [...days.keys()]
        .sort((a, b) => a - b)
        .map((d) => sec(t("tl.day").replace("{n}", String(d)), days.get(d)!, false, `tl-d${d}`))
        .join("") + (rel.length ? sec(t("tl.relative"), rel, true, "tl-rel") : "");
  };

  const load = async () => {
    try {
      paint(await refApi.timeline(ctx.id));
    } catch (e) {
      body.innerHTML = `<p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`;
    }
  };
  host.querySelector("#tlReload")!.addEventListener("click", () => void load());
  void load();
}

function syntaxHtml(): string {
  return `<table class="tl-syntax-tbl"><tbody>
    <tr><td><code>## 06:30 ${esc(t("tl.ex.title"))}</code></td><td>${t("tl.syn.time")}</td></tr>
    <tr><td><code>## ${esc(t("tl.ex.day"))} 2 · 06:30 ${esc(t("tl.ex.attack"))}</code><br><code>## T2 06:30 …</code></td><td>${t("tl.syn.day")}</td></tr>
    <tr><td><code>## T+01:30 ${esc(t("tl.ex.contact"))}</code><br><code>## H+90 …</code></td><td>${t("tl.syn.rel")}</td></tr>
  </tbody></table>`;
}
