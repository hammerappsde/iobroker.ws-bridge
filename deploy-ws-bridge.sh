#!/bin/bash
# deploy-ws-bridge-lxd.sh
# Deployt iobroker.ws-bridge in einen per SSH erreichbaren LXD-Container.
#
# Usage (direkt):
#   ./deploy-ws-bridge-lxd.sh <LXD-IP/Host> <USER> [IOBROKER_PATH]
#   ./deploy-ws-bridge-lxd.sh 10.0.3.42 root /opt/iobroker
#
# Usage (mit Jump-Host, z.B. QNAP-Host als Proxy):
#   SSH_JUMP="admin@qnap-host" ./deploy-ws-bridge-lxd.sh <LXD-IP/Host> <USER> [IOBROKER_PATH]
#
# Voraussetzungen:
# - SSH-Zugang in den Container (Port 22) ODER via ProxyJump (QNAP-Host)
# - Node/npm & ioBroker im Container unter /opt/iobroker (oder Pfad angeben)
# - Optional: sudo vorhanden (damit im richtigen User-Kontext ausgeführt wird)

set -euo pipefail

LXD_HOST="${1:-192.168.10.2}"
LXD_USER="${2:-rene}"
IOBROKER_PATH="${3:-/opt/iobroker}"
PKG_GLOB="iobroker.ws-bridge-*.tgz"

if [[ -z "$LXD_HOST" || -z "$LXD_USER" ]]; then
  echo "Usage: $0 <LXD-IP/Host> <USER> [IOBROKER_PATH=/opt/iobroker]"
  exit 1
fi

# Optionaler Jump Host (Proxy), z.B. der QNAP-Host:
# Beispiel-Aufruf:
#   SSH_JUMP="admin@qnap-host" ./deploy-ws-bridge-lxd.sh 10.0.3.42 root
SSH_JUMP="${SSH_JUMP:-}"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
if [[ -n "$SSH_JUMP" ]]; then
  SSH_OPTS+=(-J "$SSH_JUMP")
fi

REMOTE="$LXD_USER@$LXD_HOST"

# 1) Ins Projekt-Root (Ordner dieses Skripts)
cd "$(dirname "$0")"

# 2) Alte tgz-Packs lokal aufräumen
echo "🧹 Entferne alte lokale tgz-Pakete…"
rm -f $PKG_GLOB 2>/dev/null || true

# 3) Neues Paket bauen
echo "📦 Erzeuge npm-Pack…"
PKG_LINE="$(npm pack)"
PKG="$(echo "$PKG_LINE" | tail -n1)"
if [[ ! -f "$PKG" ]]; then
  echo "❌ Paket nicht gefunden: $PKG"
  exit 1
fi
echo "✅ Paket erstellt: $PKG"

# 4) Paket in den Container nach /tmp kopieren
REMOTE_TMP="/tmp/$PKG"
echo "🚀 Übertrage Paket in den Container: $REMOTE_TMP"
scp "${SSH_OPTS[@]}" "$PKG" "$REMOTE:$REMOTE_TMP"

# 5) Installation/Update im Container
#    - Versucht, Befehle als 'iobroker'-User laufen zu lassen, wenn vorhanden.
#    - Fällt sonst auf root bzw. aktuellen User zurück.
echo "🔧 Installiere/aktualisiere im Container…"
ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s <<'EOF'
set -euo pipefail

IOBROKER_PATH='"$IOBROKER_PATH"'
REMOTE_TMP='"$REMOTE_TMP"'

cd "\$IOBROKER_PATH" || { echo "❌ Pfad nicht gefunden: \$IOBROKER_PATH"; exit 1; }

# Bestimmen, wie wir Befehle ausführen (iobroker-User bevorzugt)
IOB_USER="iobroker"
SUDO_RUN=""
if id "\$IOB_USER" >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO_RUN="sudo -H -u \$IOB_USER"
  else
    # su-Fallback
    SUDO_RUN="su -s /bin/bash -c"
  fi
fi

# Wrapper-Funktion zum Ausführen im passenden Kontext
run_cmd() {
  if [[ -n "\$SUDO_RUN" ]]; then
    if [[ "\$SUDO_RUN" == su* ]]; then
      # su -s /bin/bash -c "<cmd>" iobroker
      su -s /bin/bash -c "$1" "\$IOB_USER"
    else
      # sudo -H -u iobroker <cmd>
      bash -c "\$SUDO_RUN \"$1\""
    fi
  else
    bash -c "$1"
  fi
}

# Prüfen, ob npm & iobroker da sind
if ! command -v npm >/dev/null 2>&1; then
  echo "❌ 'npm' nicht im PATH. Ist Node/npm im Container installiert?"
  exit 1
fi

if ! command -v iobroker >/dev/null 2>&1; then
  # Versuche: in /opt/iobroker/iobroker
  if [[ -x "./iobroker" ]]; then
    export PATH="\$PWD:\$PATH"
  else
    echo "❌ 'iobroker' CLI nicht im PATH und nicht im aktuellen Verzeichnis."
    exit 1
  fi
fi

echo "📥 npm i \$REMOTE_TMP"
run_cmd "npm i '\$REMOTE_TMP'"

# Prüfen, ob Instanz existiert
if iobroker list instances | grep -q 'system.adapter.ws-bridge.'; then
  echo "🔁 Instanz vorhanden → Upload & Restart"
  run_cmd "iobroker upload ws-bridge"
else
  echo "➕ Instanz nicht vorhanden → Anlegen"
  run_cmd "iobroker add ws-bridge --enabled"
fi

echo "♻️  Starte Adapter neu…"
run_cmd "iobroker restart ws-bridge || true"

echo "✅ Deployment im Container abgeschlossen."
EOF

echo "🎉 Fertig! Die neue Version läuft jetzt (oder ist zumindest hochgeladen)."
