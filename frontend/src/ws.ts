// WebSocket-Client für einen Plan. Optimistisches Anlegen mit cid, Server bestätigt
// per marker.upsert{cid} oder lehnt mit reject{cid} ab.
//
// Synthetische Events (gehen durch dieselben Handler wie Servernachrichten):
//   { type: "_open",  reconnect: boolean }  – Verbindung steht; reconnect=true ab der 2. Verbindung
//                                             (dann Snapshot neu laden, lokal verpasste Änderungen).
//   { type: "_close" }                      – Verbindung weg (Reconnect läuft automatisch).

export type WsMessage = Record<string, any> & { type: string };
type Handler = (msg: WsMessage) => void;

export class PlanSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private reconnectDelay = 1000;
  private reconnectTimer: number | null = null;
  private closed = false;
  private everOpened = false;
  /** Wird aufgerufen, wenn eine Änderung nicht gesendet werden konnte (Verbindung weg). */
  onDropped?: (msg: WsMessage) => void;

  /** path: Standard `/plans/<id>/live`; für Share-Links z.B. `/public/plans/<token>/live`. */
  constructor(private planId: string, private path?: string) {}

  connect(): void {
    if (this.closed) return;
    this.reconnectTimer = null;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}${this.path ?? `/plans/${this.planId}/live`}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (e) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(e.data) as WsMessage;
      } catch {
        return;
      }
      this.handlers.forEach((h) => h(msg));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.handlers.forEach((h) => h({ type: "_close" }));
      if (this.closed) return;
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    };
    ws.onopen = () => {
      this.reconnectDelay = 1000;
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.handlers.forEach((h) => h({ type: "_open", reconnect }));
    };
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Liefert false, wenn die Nachricht nicht gesendet werden konnte (Verbindung weg). */
  send(msg: WsMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      if (msg.type !== "presence.cursor") this.onDropped?.(msg); // Zeiger-Updates sind egal, Änderungen nicht
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}

export function cid(): string {
  return "c" + Math.random().toString(36).slice(2, 10);
}
