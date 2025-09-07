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

    // Keine stateChange-Events mehr nötig, solange keine Whitelist/Streams gewünscht sind
    // this.on('stateChange', this.onStateChange.bind(this));
  }

  async onReady() {
    // 1) Config aus io-package.json -> native
    this.port = Number(this.config.port) || 9400;
    this.token = (this.config.token || '').toString();
    this.houseStructure = this.safeParseJSON(this.config.houseStructure, { floors: [] });
    if (!this.validateStructure(this.houseStructure)) {
      this.log.warn('houseStructure has invalid shape. Falling back to { floors: [] }');
      this.houseStructure = { floors: [] };
    }

    // 2) WebSocket-Server starten
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on('connection', (ws, req) => {
      // Token prüfen (optional)
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

      // Begrüßung + Hausstruktur senden
      ws.send(JSON.stringify({
        type: 'hello',
        adapter: 'ws-bridge',
        time: new Date().toISOString()
      }));
      ws.send(JSON.stringify({
        type: 'structure',
        structure: this.houseStructure
      }));
    });

    this.log.info(`WebSocket server listening on port ${this.port}`);
  }

  // ---- Helpers ----
  safeParseJSON(text, fallback) {
    if (text && typeof text === 'object') return text; // bereits geparst
    try { return JSON.parse(text); }
    catch (e) {
      this.log.warn(`Invalid JSON in houseStructure: ${String(e)}`);
      return fallback;
    }
  }

  validateStructure(s) {
    // Minimalprüfung: Objekt mit Array "floors"
    return !!(s && typeof s === 'object' && Array.isArray(s.floors));
  }

  onUnload(callback) {
    try {
      if (this.wss) {
        for (const ws of this.clients) {
          try { ws.terminate(); } catch {}
        }
        this.wss.close();
      }
      this.clients.clear();
      callback();
    } catch (e) {
      callback();
    }
  }
}

if (module && module.parent) {
  module.exports = (options) => new WsBridge(options);
} else {
  new WsBridge();
}
