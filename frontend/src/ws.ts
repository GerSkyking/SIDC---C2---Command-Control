// WebSocket-Client für einen Plan. Optimistisches Anlegen mit cid, Server bestätigt
// per marker.upsert{cid} oder lehnt mit reject{cid} ab.

export type WsMessage = Record<string, any> & { type: string };
type Handler = (msg: WsMessage) => void;

export class PlanSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private reconnectDelay = 1000;
  private closed = false;

  constructor(private planId: string) {}

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/plans/${this.planId}/live`);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as WsMessage;
      this.handlers.forEach((h) => h(msg));
    };
    this.ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    };
    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.handlers.forEach((h) => h({ type: "_open" }));
    };
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

export function cid(): string {
  return "c" + Math.random().toString(36).slice(2, 10);
}
