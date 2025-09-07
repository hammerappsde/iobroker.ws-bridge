'use strict';

const utils = require('@iobroker/adapter-core');
const { WebSocketServer } = require('ws');

class WsBridge extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'ws-bridge' });
        this.wss = null;
        this.clients = new Set();
        this.whitelist = [];
        this.token = '';
        this.port = 9400;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        // Konfig aus io-package.json -> native
        this.port = Number(this.config.port) || 9400;
        this.token = (this.config.token || '').toString();
        this.whitelist = Array.isArray(this.config.exposeStates) ? this.config.exposeStates : [];
        this.allowWrite = !!this.config.allowWrite;

        // Auf ausgewählte States subscriben (Patterns sind erlaubt)
        if (this.whitelist.length) {
            for (const pat of this.whitelist) {
                try {
                    await this.subscribeForeignStatesAsync(pat);
                    this.log.info(`Subscribed: ${pat}`);
                } catch (e) {
                    this.log.warn(`Subscribe failed for ${pat}: ${e}`);
                }
            }
        }

        // WebSocket-Server starten
        this.wss = new WebSocketServer({ port: this.port });
        this.wss.on('connection', async (ws, req) => {
            try {
                const url = new URL(req.url || '/', 'http://localhost');
                const qToken = url.searchParams.get('token') || '';
                if (this.token && qToken !== this.token) {
                    ws.close(1008, 'invalid token');
                    return;
                }
            } catch (_) {
                // Bei merkwürdiger URL lieber trennen
                ws.close(1008, 'bad request');
                return;
            }

            this.clients.add(ws);
            ws.on('close', () => this.clients.delete(ws));
            ws.on('message', (buf) => this.onClientMessage(ws, buf.toString()));

            // Begrüßung + Initial-Snapshot
            ws.send(JSON.stringify({ type: 'hello', adapter: 'ws-bridge', time: new Date().toISOString() }));
            try {
                await this.sendSnapshot(ws);
            } catch (e) {
                this.log.warn(`Snapshot failed: ${e}`);
            }
        });

        this.log.info(`WebSocket server listening on port ${this.port}`);
    }

    async sendSnapshot(ws) {
        const items = [];
        for (const pattern of this.whitelist) {
            // Alle States auflösen, die auf das Pattern matchen
            const objs = await this.getForeignObjectsAsync(pattern, 'state');
            const ids = Object.keys(objs || {});
            for (const id of ids) {
                const s = await this.getForeignStateAsync(id);
                items.push({ id, val: s && s.val, ts: s && s.ts, lc: s && s.lc, ack: s && s.ack });
            }
        }
        ws.send(JSON.stringify({ type: 'snapshot', items }));
    }

    onStateChange(id, state) {
        if (!state) return; // gelöscht

        // Wenn Whitelist gesetzt, nur erlaubte IDs/Patterns durchlassen
        if (this.whitelist.length) {
            const allowed = this.whitelist.some(p => this.idMatchesPattern(id, p));
            if (!allowed) return;
        }

        const msg = JSON.stringify({
            type: 'state',
            id,
            val: state.val,
            ack: state.ack,
            ts: state.ts,
            lc: state.lc
        });

        for (const ws of this.clients) {
            try { ws.send(msg); } catch (_) {}
        }
    }

    idMatchesPattern(id, pattern) {
        if (!pattern || pattern === '*') return true;
        // Sehr einfache Pattern-Matche ("*" als Wildcard)
        const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        const re = new RegExp(`^${esc}$`);
        return re.test(id);
    }

    async onClientMessage(ws, raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }

        if (msg.type === 'get' && Array.isArray(msg.ids)) {
            const items = [];
            for (const id of msg.ids) {
                const s = await this.getForeignStateAsync(id);
                items.push({ id, val: s && s.val, ts: s && s.ts, lc: s && s.lc, ack: s && s.ack });
            }
            ws.send(JSON.stringify({ type: 'getResult', items }));
        }

        if (msg.type === 'subscribe' && Array.isArray(msg.ids)) {
            for (const id of msg.ids) {
                try { await this.subscribeForeignStatesAsync(id); } catch (_) {}
            }
            ws.send(JSON.stringify({ type: 'subscribed', ids: msg.ids }));
        }

        if (msg.type === 'setState' && typeof msg.id === 'string') {
            if (!this.allowWrite) return;
            try {
                await this.setForeignStateAsync(msg.id, msg.value, msg.ack === true);
                ws.send(JSON.stringify({ type: 'setResult', ok: true, id: msg.id }));
            } catch (e) {
                ws.send(JSON.stringify({ type: 'setResult', ok: false, id: msg.id, error: String(e) }));
            }
        }
    }

    onUnload(callback) {
        try {
            if (this.wss) {
                for (const ws of this.clients) {
                    try { ws.terminate(); } catch (_) {}
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