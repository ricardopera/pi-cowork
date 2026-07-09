import type { WireEvent } from "./events";

export class SessionSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<(e: WireEvent) => void>();
  constructor(private sessionId: string) {}

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () =>
      this.ws!.send(JSON.stringify({ type: "subscribe", sessionId: this.sessionId }));
    this.ws.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as WireEvent;
        this.listeners.forEach((l) => l(e));
      } catch {
        /* ignore non-json */
      }
    };
  }
  onEvent(l: (e: WireEvent) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  abort() {
    this.ws?.send(JSON.stringify({ type: "abort", sessionId: this.sessionId }));
  }
  close() {
    this.ws?.close();
    this.ws = null;
  }
}
