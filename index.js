'use strict';

const utils = require('@iobroker/adapter-core');
const { WebSocketServer } = require('ws');

class WsBridge extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'ws-bridge' });

    this.wss = null;
    this.clients = new Set();

    this.port = 9400;
    this.token = '';
    this.houseStructure = { floors: [] };

    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    // nur die drei Settings laden
    this.port = Number(this.config.port) || 9400;
    this.token = (this.config.token || '').toString();
    this.houseStructure = this.safeParseJSON(this.config.houseStructure, { floors: [] });

    // WS-Server starten
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on('connection', (ws, req) => {
      // Token prüfen
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        const qToken = url.searchParams.get('token') || '';
        if (this.token && qToken !== this.token) {
          ws.close(1008, 'invalid token');
          return;
        }
      } catch {
        ws.close(1008, 'bad request');
        return;
      }

      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('message', (buf) => this.onClientMessage(ws, buf.toString()));
    });

    this.log.info(`ws-bridge listening on port ${this.port}`);
  }

  // --- minimaler Request-Handler: nur getStructure ---
  onClientMessage(ws, raw) {
    let msg = raw;
    try {
      // akzeptiere sowohl JSON {"type":"getStructure"} als auch plain "getStructure"
      msg = JSON.parse(raw);
    } catch { /* raw bleibt string */ }

    const isGet =
      (typeof msg === 'string' && msg === 'getStructure') ||
      (msg && typeof msg === 'object' && msg.type === 'getStructure');

    if (isGet) {
      ws.send(JSON.stringify({ type: 'structure', structure: this.houseStructure }));
      return;
    }

    // optional: kurze Fehlermeldung für unbekannte Messages
    ws.send(JSON.stringify({ type: 'error', error: 'unknown request' }));
  }

  // --- helpers ---
  safeParseJSON(text, fallback) {
    if (text && typeof text === 'object') return text;
    try { return JSON.parse(text); }
    catch {
      this.log.warn('houseStructure is not valid JSON; using fallback {floors: []}');
      return fallback;
    }
  }

  onUnload(cb) {
    try {
      if (this.wss) {
        for (const ws of this.clients) { try { ws.terminate(); } catch {} }
        this.wss.close();
      }
      this.clients.clear();
      cb();
    } catch {
      cb();
    }
  }
}

if (module && module.parent) {
  module.exports = (options) => new WsBridge(options);
} else {
  new WsBridge();
}
