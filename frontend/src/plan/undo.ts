// Undo/Redo der eigenen Aktionen (verschieben, bearbeiten, sperren) — Knöpfe in der Topbar und Strg+Z/Y.
import type { Cmd, PlanCtx } from "./ctx";

export function initUndo(ctx: PlanCtx): void {
  const { root, canEdit, sig } = ctx;
  // ── Undo/Redo (eigene Aktionen: verschieben, bearbeiten, sperren) ─────
  const undoStack: Cmd[] = [];
  const redoStack: Cmd[] = [];
  const UNDO_MAX = 60;
  const updateUndoBtns = (): void => {
    root.querySelector<HTMLButtonElement>("#undo")?.toggleAttribute("disabled", !undoStack.length);
    root.querySelector<HTMLButtonElement>("#redo")?.toggleAttribute("disabled", !redoStack.length);
  };
  const pushCmd = (c: Cmd): void => {
    undoStack.push(c);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
    updateUndoBtns();
  };
  ctx.ui.pushCmd = pushCmd;
  const doUndo = (): void => {
    const c = undoStack.pop();
    if (!c) return;
    c.undo();
    redoStack.push(c);
    updateUndoBtns();
  };
  ctx.ui.doUndo = doUndo;
  const doRedo = (): void => {
    const c = redoStack.pop();
    if (!c) return;
    c.redo();
    undoStack.push(c);
    updateUndoBtns();
  };

  ctx.ui.doRedo = doRedo;
  root.querySelector("#undo")?.addEventListener("click", doUndo);
  root.querySelector("#redo")?.addEventListener("click", doRedo);
  updateUndoBtns();
  if (canEdit) {
    const onUndoKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tg = e.target as HTMLElement | null;
      // In Eingabefeldern gehört Ctrl+Z/Y dem Browser (Text-Undo)
      if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        doRedo();
      }
    };
    document.addEventListener("keydown", onUndoKey, { signal: sig });
  }
}
