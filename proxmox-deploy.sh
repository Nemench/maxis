#!/usr/bin/env bash
# MAXIS KOT — Proxmox LXC auto-provisioner
# Run this on the PROXMOX HOST (not inside a container)
# Usage: bash <(curl -sSL https://raw.githubusercontent.com/Nemench/maxis/main/proxmox-deploy.sh)
set -euo pipefail

# ── Configurable defaults (override with env vars) ────────────────────────────
CTID="${CTID:-200}"
CT_HOSTNAME="${CT_HOSTNAME:-maxis}"
MEMORY="${MEMORY:-512}"        # MB
SWAP="${SWAP:-512}"            # MB
DISK="${DISK:-4}"              # GB
CORES="${CORES:-2}"
STORAGE="${STORAGE:-}"         # auto-detect if empty
BRIDGE="${BRIDGE:-vmbr0}"
PORT="${PORT:-3000}"

RED='\033[0;31m'; BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${BLUE}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✔ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
error() { echo -e "${RED}✘ $*${NC}"; exit 1; }

# ── Must run on Proxmox host ──────────────────────────────────────────────────
command -v pct &>/dev/null || error "pct not found — run this on the Proxmox host, not inside a container."
[ "$(id -u)" -eq 0 ] || error "Run as root"

# ── Clean up any previous failed container ────────────────────────────────────
if pct status "$CTID" &>/dev/null; then
  warn "Container $CTID already exists — removing it and starting fresh..."
  pct stop "$CTID" --force 2>/dev/null || true
  pct destroy "$CTID" --purge 2>/dev/null || true
  ok "Old container removed"
fi

# ── Auto-detect storage ───────────────────────────────────────────────────────
if [ -z "$STORAGE" ]; then
  if pvesm status | awk '{print $1}' | grep -qx "local-lvm"; then
    STORAGE="local-lvm"
  elif pvesm status | awk '{print $1}' | grep -qx "local"; then
    STORAGE="local"
  else
    STORAGE=$(pvesm status | awk 'NR>1 {print $1; exit}')
  fi
fi
info "Using storage: $STORAGE"

# ── Find or download Debian 12 template ──────────────────────────────────────
info "Looking for Debian 12 template..."
TEMPLATE_PATH=$(find /var/lib/vz/template/cache /mnt -name "debian-12-standard*.tar.*" 2>/dev/null | head -1 || true)

if [ -z "$TEMPLATE_PATH" ]; then
  info "Downloading Debian 12 template..."
  pveam update >/dev/null 2>&1 || true
  TEMPLATE_NAME=$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)
  [ -n "$TEMPLATE_NAME" ] || error "Could not find debian-12-standard template. Run: pveam update"
  pveam download local "$TEMPLATE_NAME"
  TEMPLATE_PATH=$(find /var/lib/vz/template/cache -name "debian-12-standard*.tar.*" | head -1)
fi
ok "Template: $(basename "$TEMPLATE_PATH")"

# ── Create the container ──────────────────────────────────────────────────────
info "Creating container $CTID ($CT_HOSTNAME)..."
pct create "$CTID" "$TEMPLATE_PATH" \
  --hostname "$CT_HOSTNAME" \
  --memory "$MEMORY" \
  --swap "$SWAP" \
  --cores "$CORES" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --nameserver "8.8.8.8 8.8.4.4" \
  --unprivileged 1 \
  --features nesting=1 \
  --start 1

ok "Container created and started"

# ── Wait for container to be ready ───────────────────────────────────────────
info "Waiting for container to boot..."
for i in $(seq 1 30); do
  if pct exec "$CTID" -- bash -c "echo ok" &>/dev/null; then
    break
  fi
  sleep 2
done
pct exec "$CTID" -- bash -c "echo ok" &>/dev/null || error "Container did not become ready in time"

# ── Force DNS — remove symlink (Debian 12 uses systemd-resolved) and write real file
info "Configuring DNS..."
pct exec "$CTID" -- bash -c "rm -f /etc/resolv.conf && printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /etc/resolv.conf"

# ── Wait for DHCP to assign a default route ──────────────────────────────────
info "Waiting for network (DHCP)..."
for i in $(seq 1 30); do
  if pct exec "$CTID" -- bash -c "ip route show default | grep -q default" &>/dev/null; then
    break
  fi
  sleep 2
done
pct exec "$CTID" -- bash -c "ip route show default | grep -q default" \
  || error "Container has no default route after 60s. Check that $BRIDGE is connected to your network."

# ── Verify internet reachability (by IP, not DNS) ────────────────────────────
if ! pct exec "$CTID" -- bash -c "ping -c1 -W5 8.8.8.8 > /dev/null 2>&1"; then
  error "Container cannot reach the internet (ping 8.8.8.8 failed). Check your Proxmox bridge/firewall."
fi
ok "Network is up"

# ── Bootstrap curl ────────────────────────────────────────────────────────────
info "Bootstrapping container..."
pct exec "$CTID" -- bash -c "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl
"

# ── Run MAXIS installer inside the container ──────────────────────────────────
info "Installing MAXIS inside container $CTID..."
pct exec "$CTID" -- bash -c "
  export DEBIAN_FRONTEND=noninteractive PORT=${PORT}
  bash <(curl -sSL https://raw.githubusercontent.com/Nemench/maxis/main/install.sh)
"

# ── Get container IP ──────────────────────────────────────────────────────────
CT_IP=$(pct exec "$CTID" -- bash -c "hostname -I | awk '{print \$1}'" 2>/dev/null || echo "<container-ip>")

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   MAXIS is running in container ${CTID}!               ║${NC}"
echo -e "${GREEN}║                                                      ║${NC}"
echo -e "${GREEN}║   http://${CT_IP}:${PORT}                          ║${NC}"
echo -e "${GREEN}║   Default login: Admin / 0000                        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Container: pct [start|stop|enter] $CTID"
echo "  App logs:  pct exec $CTID -- journalctl -u maxis -f"
echo "  Update:    pct exec $CTID -- bash /opt/maxis/install.sh"
echo ""
warn "Override defaults with env vars:  CTID=201 MEMORY=1024 STORAGE=local-lvm bash <(curl ...)"
