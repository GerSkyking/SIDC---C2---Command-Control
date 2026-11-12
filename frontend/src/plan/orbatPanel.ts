// ORBAT-Panel: Kräfteübersicht im Plan (verknüpfte ORBATs, Baum auf-/zuklappen, Knoten als Marker setzen).
import { api, type Orbat } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { makeMovable } from "../movable";
import { toastError } from "../notify";
import type { PlanCtx } from "./ctx";

export function initOrbatPanel(ctx: PlanCtx): void {
  const { root, planId, canEdit, isMB } = ctx;
  // ── ORBAT-Panel (Kräfteübersicht im Plan) ─────────────────────────────
  const orbatPanel = root.querySelector<HTMLDivElement>("#orbatPanel")!;
  const orbatBtn = root.querySelector<HTMLButtonElement>("#orbatBtn")!;
  const orbOpen = new Set<string>();
  let orbatAvail: Orbat[] = [];
  ctx.ui.ensureOrbatCache = ensureOrbatCache;
  async function ensureOrbatCache(): Promise<void> {
    if (ctx.planOrbatCache.length) return;
    ctx.planOrbatCache = await api.planOrbats(planId).catch(() => []);
  }
  // Daten laden (Netz), dann rendern.
  async function refreshOrbatPanel(): Promise<void> {
    try {
      ctx.planOrbatCache = await api.planOrbats(planId);
    } catch {
      /* keine */
    }
    if (isMB) orbatAvail = await api.orbats().catch(() => []);
    renderOrbatPanel();
  }
  // Reines Rendern aus dem Cache — Baum auf-/zuklappen läuft ohne Netz.
  function renderOrbatPanel(): void {
    const linked = ctx.planOrbatCache;
    const avail = orbatAvail;
    const st = (s: string) => `<span class="st-pill st-${s}">${t("orbat.status." + s)}</span>`;
    const nodeRows = (o: Orbat): string => {
      const ns = o.nodes ?? [];
      const kids = new Map<string, typeof ns>();
      for (const n of ns) {
        const k = n.parent_id ?? "";
        (kids.get(k) ?? kids.set(k, []).get(k)!).push(n);
      }
      const descSum = (id: string): number =>
        (kids.get(id) ?? []).reduce((a, n) => a + (n.qty_current ?? 0) + descSum(n.id), 0);
      // Alle Knoten im Teilbaum, die selbst Kinder haben (inkl. dem Knoten) — für
      // das rekursive Auf-/Zuklappen.
      const subExpandable = (id: string): string[] => {
        const ch = kids.get(id) ?? [];
        if (!ch.length) return [];
        const out = [id];
        for (const c of ch) out.push(...subExpandable(c.id));
        return out;
      };
      const rec = (pid: string, d: number): string =>
        (kids.get(pid) ?? [])
          .sort((a, b) => a.ordering - b.ordering)
          .map((n) => {
            const ch = kids.get(n.id) ?? [];
            const op = orbOpen.has(n.id);
            const sub = subExpandable(n.id);
            const subAllOpen = sub.length > 0 && sub.every((x) => orbOpen.has(x));
            return (
              `<div class="orb-row" style="margin-left:${d * 0.9}rem">` +
              (ch.length
                ? `<button class="orb-tw" data-otw="${n.id}" title="${t("orbat.toggleOne")}">${icon(op ? "chevronDown" : "chevron", 12)}</button>` +
                  `<button class="orb-tw" data-otwall="${n.id}" data-sub="${sub.join(",")}" title="${t("orbat.toggleAll")}">${icon(subAllOpen ? "minus" : "plus", 12)}</button>`
                : `<span class="orb-tw"></span>`) +
              `<span class="orb-name">${esc(n.name)}</span>` +
              `<span class="orb-qty">${n.qty_current ?? "?"}/${n.qty_planned ?? "?"}${ch.length ? ` <span class="orb-sub-sum">+${descSum(n.id)}</span>` : ""}</span>${st(n.status)}` +
              (isMB && canEdit && !o.released
                ? `<button class="icon-btn" data-oplace="${esc(n.id)}" data-osidc="${esc(n.sidc ?? "")}" data-oname="${esc(n.name ?? "")}" title="${t("orbat.placeOnMap")}">${icon("marker", 12)}</button>`
                : "") +
              `</div>` +
              (op ? rec(n.id, d + 1) : "")
            );
          })
          .join("");
      return rec("", 0) || `<div class="muted">${t("orbat.noNodes")}</div>`;
    };
    orbatPanel.innerHTML =
      `<div class="fav-head">${t("orbat.inPlan")}</div>` +
      linked
        .map(
          (o) =>
            `<div class="orb-plan-item"><div class="row">` +
            `<span class="badge aff-${o.affiliation}">${t("orbat.aff." + o.affiliation)}</span>` +
            `<strong class="grow">${esc(o.name)}</strong>` +
            (o.released ? `<span class="muted">${t("plan.readonly")}</span>` : "") +
            (isMB ? `<button class="icon-btn" data-orm="${o.id}" title="${t("common.delete")}">${icon("x", 14)}</button>` : "") +
            `</div>${nodeRows(o)}` +
            (() => {
              const ns = o.nodes ?? [];
              const tc = ns.reduce((a, n) => a + (n.qty_current ?? 0), 0);
              const tp = ns.reduce((a, n) => a + (n.qty_planned ?? 0), 0);
              return ns.length
                ? `<div class="orb-total">${t("orbat.totalStrength")}: <strong>${tc} / ${tp}</strong></div>`
                : "";
            })() +
            `</div>`,
        )
        .join("") +
      (isMB && avail.length
        ? `<div class="row" style="margin-top:.5rem"><select id="orb-pick" title="${t("tip.orb.pick")}" aria-label="${t("tip.orb.pick")}">${avail
            .filter((a) => !linked.some((l) => l.id === a.id))
            .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`)
            .join("")}</select><button id="orb-link">${t("orbat.addToPlan")}</button></div>`
        : "") +
      (isMB ? `<a href="#/orbat" class="muted">${t("nav.orbat")} →</a>` : "");

    orbatPanel.querySelectorAll<HTMLButtonElement>("[data-otw]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.otw!;
        orbOpen.has(id) ? orbOpen.delete(id) : orbOpen.add(id);
        renderOrbatPanel(); // rein lokal — kein Netz
      }),
    );
    orbatPanel.querySelectorAll<HTMLButtonElement>("[data-otwall]").forEach((b) =>
      b.addEventListener("click", () => {
        const ids = (b.dataset.sub || "").split(",").filter(Boolean);
        const allOpen = ids.every((x) => orbOpen.has(x));
        ids.forEach((x) => (allOpen ? orbOpen.delete(x) : orbOpen.add(x)));
        renderOrbatPanel();
      }),
    );
    orbatPanel.querySelectorAll<HTMLButtonElement>("[data-orm]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.removePlanOrbat(planId, b.dataset.orm!).catch(() => {});
        void refreshOrbatPanel();
      }),
    );
    orbatPanel.querySelectorAll<HTMLButtonElement>("[data-oplace]").forEach((b) =>
      b.addEventListener("click", () => {
        ctx.chainGroup = null;
        ctx.awaitingPos = false;
        ctx.pending = {
          sidc: b.dataset.osidc || "10060000000000000000",
          unit_text: b.dataset.oname || "",
          ai_text: "",
          locked: false,
          timestamp_visible: true,
          rotation_degrees: -1,
          is_multipoint: false,
          max_line_points: 0,
          orbat_node_id: b.dataset.oplace!,
          orbat_strength: 1,
        };
        ctx.ui.setMode("place");
        if (!mvOrbat.isPinned()) orbatPanel.hidden = true;
      }),
    );
    orbatPanel.querySelector("#orb-link")?.addEventListener("click", async () => {
      const id = orbatPanel.querySelector<HTMLSelectElement>("#orb-pick")!.value;
      if (id) {
        await api.addPlanOrbat(planId, id).catch(toastError);
        void refreshOrbatPanel();
      }
    });
  }
  const mvOrbat = makeMovable(orbatPanel, { plan: planId, key: "orbat", pinnable: true, resizable: true });
  orbatBtn.addEventListener("click", () => {
    orbatPanel.hidden = !orbatPanel.hidden;
    if (!orbatPanel.hidden) {
      if (!mvOrbat.hasPos()) ctx.ui.placeNextToTool(orbatPanel, orbatBtn);
      if (ctx.planOrbatCache.length) renderOrbatPanel(); // sofort aus Cache
      else orbatPanel.innerHTML = `<div class="fav-head">${t("orbat.inPlan")}</div><div class="muted">…</div>`;
      void refreshOrbatPanel();
      mvOrbat.bringIntoView();
    }
  });
  if (mvOrbat.isPinned()) {
    orbatPanel.hidden = false;
    void refreshOrbatPanel();
  }

}
