// Favoriten-Panel: gespeicherte Marker-Vorlagen direkt per Klick platzieren.
import { api } from "../api";
import { esc } from "../esc";
import { t } from "../i18n";
import { icon } from "../icons";
import { makeMovable } from "../movable";
import { toastError } from "../notify";
import { iconSrc } from "../sidc/symbol";
import type { PlanCtx } from "./ctx";

export async function initFavorites(ctx: PlanCtx): Promise<void> {
  const { root, planId } = ctx;
  // ── Favoriten ─────────────────────────────────────────────────────────
  const favPanel = root.querySelector<HTMLDivElement>("#favPanel")!;
  const mvFav = makeMovable(favPanel, { plan: planId, key: "fav", pinnable: true });
  if (mvFav.isPinned()) favPanel.hidden = false;
  let favs = await api.favorites();
  const renderFavs = () => {
    favPanel.innerHTML =
      `<div class="fav-head">${t("fav.heading")}</div>` +
      (favs.length
        ? favs
            .map(
              (f) => `<div class="fav" data-fav="${esc(f.id)}">
                <img src="${esc(iconSrc(f.sidc, 28, f.tint || undefined))}" width="24" height="24" data-hide-on-error/>
                <span>${esc(f.label)}</span><button class="icon-btn" data-delfav="${esc(f.id)}" title="${t("common.delete")}">${icon("x", 14)}</button></div>`,
            )
            .join("")
        : `<div class="muted">${t("fav.hint")}</div>`);
    favPanel.querySelectorAll<HTMLElement>("[data-fav]").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest("[data-delfav]")) return; // auch Klick aufs SVG im Löschen-Knopf
        const f = favs.find((x) => x.id === el.dataset.fav)!;
        ctx.ui.setMode("place");
        ctx.awaitingPos = false; // Favorit direkt per Klick platzieren
        ctx.chainGroup = f.is_multipoint ? Math.floor(Math.random() * 1e9) : null;
        ctx.chainIndex = 0;
        ctx.pending = {
          sidc: f.sidc,
          unit_text: f.unit_text,
          ai_text: f.ai_text,
          locked: false,
          timestamp_visible: true,
          rotation_degrees: f.rotation_degrees,
          tint: f.tint || "",
          is_multipoint: f.is_multipoint,
          max_line_points: f.max_line_points,
        };
      }),
    );
    favPanel.querySelectorAll<HTMLButtonElement>("[data-delfav]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api.deleteFavorite(b.dataset.delfav!);
          favs = await api.favorites();
          renderFavs();
        } catch (err) {
          toastError(err);
        }
      }),
    );
  };
  renderFavs();
  root.querySelector("#tool-fav")!.addEventListener("click", () => {
    favPanel.hidden = !favPanel.hidden;
    if (!favPanel.hidden) {
      if (!mvFav.hasPos()) {
        const b = (root.querySelector("#tool-fav") as HTMLElement).getBoundingClientRect();
        favPanel.style.top = `${Math.max(b.top, ctx.ui.belowTopbar())}px`;
        favPanel.style.left = `${b.right + 6}px`;
        favPanel.style.right = "auto";
      }
      mvFav.bringIntoView();
    }
  });
  // Nach „Als Favorit speichern“ im Marker-Panel: Liste neu laden und Panel zeigen
  ctx.ui.reloadFavs = async () => {
    favs = await api.favorites();
    renderFavs();
    favPanel.hidden = false;
  };
}
