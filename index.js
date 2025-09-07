'use strict';

const utils = require('@iobroker/adapter-core');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

class WsBridge extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'ws-bridge' });
    this.wss = null;
    this.clients = new Set();

    // Dateipfade relativ zum Adapter-Ordner
    this.configPath = path.resolve(__dirname, 'data', 'config.json');
    this.housePath  = path.resolve(__dirname, 'data', 'haus.json');

    this.port = 9400;
    this.token = '';
    this.houseStructure = { floors: [] };

    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    this.log.info(`WS-BRIDGE STARTED from ${__filename} @${new Date().toISOString()} ###MARKER:42###`);

    // 1) Dateien laden
    const cfg = this.readJSON(this.configPath, { port: 9400, token: '' });
    this.port = Number(cfg.port) || 9400;
    this.token = (cfg.token || '').toString();
    this.houseStructure = this.readJSON(this.housePath, { floors: [] });

    // 2) WS-Server starten
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

    this.log.info(`ws-bridge running on port ${this.port} (files: ${this.configPath}, ${this.housePath})`);
  }

  onClientMessage(ws, raw) {
    let msg = raw;
    try { msg = JSON.parse(raw); } catch {/* allow plain string */}
    const isGet =
      (typeof msg === 'string' && msg === 'getStructure') ||
      (msg && typeof msg === 'object' && msg.type === 'getStructure');

    if (isGet) {
      // Immer frisch von Platte laden, falls du mal nur house.json austauschst
      const current = this.readJSON(this.housePath, this.houseStructure);
      ws.send(JSON.stringify({ type: 'structure', structure: current }));
      return;
    }

    ws.send(JSON.stringify({ type: 'error', error: 'unknown request' }));
  }

  readJSON(file, fallback) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      return JSON.parse(text);
    } catch (e) {
      this.log.warn(`Failed to read JSON ${file}: ${e}`);
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
