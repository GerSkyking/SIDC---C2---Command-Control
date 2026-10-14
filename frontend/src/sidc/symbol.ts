// Zwei-Wege-Symbolrendering wie in ATAKmaps:
//  1. milsymbol.js — live aus dem SIDC (deckt praktisch alle Affiliation-/
//     Echelon-/Modifier-Kombinationen ab)
//  2. vorgerendertes APP-6D-PNG unter /assets/app6d-icons/<sidc>.png als Rückfall
//     für die ~Funktions-IDs, die milsymbol nicht kennt (v.a. Linien/Flächen)
//  3. schlägt beides fehl → aufrufende Stelle zeigt einen Ersatzpunkt
import ms from "milsymbol";
import type { Map as MlMap } from "maplibre-gl";
import { iconUrl, markerLabelCategory } from "./sidc";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const symCache = new Map<string, RgbaImage | null>();

/** milsymbol → RGBA-Bilddaten für `map.addImage`, oder null wenn der SIDC
 *  von milsymbol nicht darstellbar ist. */
export function milsymbolImage(sidc: string, size = 32): RgbaImage | null {
  if (symCache.has(sidc)) return symCache.get(sidc) ?? null;
  let out: RgbaImage | null = null;
  try {
    const sym = new ms.Symbol(sidc, { size, standard: "APP6" });
    if (sym.isValid()) {
      const canvas = sym.asCanvas() as HTMLCanvasElement;
      const ctx = canvas.getContext("2d");
      if (ctx && canvas.width > 0 && canvas.height > 0) {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        out = { width: canvas.width, height: canvas.height, data: img.data };
      }
    }
  } catch {
    out = null;
  }
  symCache.set(sidc, out);
  return out;
}

/** Id, unter der ein (ggf. umgefärbtes) Icon in der Karte registriert wird. */
export function mapIconId(sidc: string, tint?: string): string {
  return tint ? `${sidc}|${tint}` : sidc;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** Färbt die dunklen (schwarzen) Symbolanteile um — Rahmenfarben bleiben erhalten. */
function recolorDark(img: RgbaImage, hex: string): RgbaImage {
  const rgb = parseHex(hex);
  if (!rgb) return img;
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0 && Math.max(data[i], data[i + 1], data[i + 2]) < 90) {
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
    }
  }
  return { width: img.width, height: img.height, data };
}

function toDataUrl(img: RgbaImage): string {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c.toDataURL("image/png");
}

const srcCache = new Map<string, string>();

/** Für `<img>`-Vorschauen: milsymbol als data-URL, sonst der PNG-Pfad. */
export function iconSrc(sidc: string, size = 28, tint?: string): string {
  const key = tint ? `${sidc}|${size}|${tint}` : sidc;
  const hit = srcCache.get(key);
  if (hit !== undefined) return hit;
  let src = iconUrl(sidc);
  try {
    const sym = new ms.Symbol(sidc, { size, standard: "APP6" });
    if (sym.isValid()) {
      const canvas = sym.asCanvas() as HTMLCanvasElement;
      if (tint && canvas.width > 0 && canvas.height > 0) {
        const d = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
        src = toDataUrl(recolorDark({ width: d.width, height: d.height, data: d.data }, tint));
      } else {
        src = canvas.toDataURL("image/png");
      }
    }
  } catch {
    /* fällt auf PNG zurück */
  }
  srcCache.set(key, src);
  return src;
}

/**
 * Lädt ein SIDC-Icon in die MapLibre-Karte (milsymbol → PNG → nichts).
 * Gibt true zurück, wenn ein Icon registriert wurde, sonst false
 * (dann sollte die Karte einen Ersatzpunkt zeigen).
 */
export async function ensureMapIcon(map: MlMap, sidc: string, tint?: string): Promise<boolean> {
  const id = mapIconId(sidc, tint);
  if (map.hasImage(id)) return true;
  const live = milsymbolImage(sidc, 32);
  if (live) {
    if (!map.hasImage(id)) map.addImage(id, tint ? recolorDark(live, tint) : live);
    return true;
  }
  try {
    const img = await map.loadImage(iconUrl(sidc));
    let out: Parameters<MlMap["addImage"]>[1] = img.data;
    if (tint) {
      const src = img.data as CanvasImageSource & { width: number; height: number };
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      out = recolorDark({ width: d.width, height: d.height, data: d.data }, tint);
    }
    if (!map.hasImage(id)) map.addImage(id, out);
    return true;
  } catch {
    return false;
  }
}

/** Natürliche Pixelgröße des zuletzt für diese SIDC geladenen Icons (milsymbol-
 * Canvas oder PNG), oder null solange noch nichts geladen wurde. */
export function iconNaturalSize(sidc: string): { w: number; h: number } | null {
  const img = symCache.get(sidc);
  return img ? { w: img.width, h: img.height } : null;
}

const LABEL_TEXT_SIZE_PX = 11; // muss zu "text-size" der Label-Layer passen
const LABEL_MARGIN_EM = 4 / LABEL_TEXT_SIZE_PX; // etwas Luft zwischen Icon-Rand und Text

/**
 * Text-Offset (in "em" des Label-Textes) für Einheitstext/Zusatztext, aus der
 * TATSÄCHLICHEN gerenderten Icon-Größe berechnet (statt eines geschätzten
 * Fixwerts) — der Text sitzt damit immer knapp außerhalb des Icons, egal wie
 * groß/klein/nach welchem Symbol-Typ es skaliert wird.
 * `iconSizeFactor` = kompletter Multiplikator aus der "icon-size"-Layer-Property
 * (z. B. 0.8 * Marker-Scale), damit die Icon-Naturgröße korrekt umgerechnet wird.
 * `textScale` = Multiplikator auf "text-size" (Standard 1). Offset ist in em,
 * also relativ zur tatsächlichen Textgröße — ohne diesen Ausgleich würde der
 * Text bei größerem textScale automatisch weiter vom Icon wegrücken, obwohl
 * der gewünschte Pixel-Abstand nur von der Icon-Größe abhängen soll.
 */
export function markerLabelOffsets(
  sidc: string,
  iconSizeFactor: number,
  textScale = 1,
): { unit: [number, number]; ai: [number, number] } {
  const nat = iconNaturalSize(sidc) ?? { w: 32, h: 32 };
  const halfXem = ((nat.w * iconSizeFactor) / 2 / LABEL_TEXT_SIZE_PX + LABEL_MARGIN_EM) / textScale;
  const halfYem = ((nat.h * iconSizeFactor) / 2 / LABEL_TEXT_SIZE_PX + LABEL_MARGIN_EM) / textScale;
  const cat = markerLabelCategory(sidc);
  if (cat === "text") {
    // Nur-Text-Marker: Text sitzt mittig auf dem Ankerpunkt, Zusatztext darunter.
    return { unit: [0, 0], ai: [0, 1.2] };
  }
  if (cat === "line") {
    // Einheitstext oben/zentriert, Zusatztext unten/zentriert.
    return { unit: [0, -halfYem], ai: [0, halfYem] };
  }
  if (cat === "cm") {
    // Zusatztext oben/zentriert, Einheitstext rechts im oberen/mittleren Bereich.
    return { unit: [halfXem, -halfYem * 0.4], ai: [0, -halfYem] };
  }
  // Default (Land Unit u. a.): Zusatztext rechts/mittig, Einheitstext links,
  // mittig zwischen Icon-Mitte und -Unterkante.
  return { unit: [-halfXem, halfYem * 0.5], ai: [halfXem, 0] };
}
