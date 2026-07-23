#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  AMD Dock Manager — Initial Setup Script
#  Creates the disk image and SSH key for the QEMU TCG VM.
#  Run this ONCE before starting the app.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

APP_DIR="$HOME/.amd-dock-manager"
DISK_IMAGE="$APP_DIR/core_dock_image.qcow2"
SSH_KEY="$APP_DIR/vm_ssh_key"
DISK_SIZE_GB="${1:-20}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()  { echo -e "${RED}[error]${NC} $*"; exit 1; }

# ── Pre-flight checks ────────────────────────────────────────────────────────
log "Checking dependencies..."

command -v qemu-system-x86_64 &>/dev/null || err "qemu not found. Install with: brew install qemu"
command -v qemu-img           &>/dev/null || err "qemu-img not found (should come with qemu)."
command -v ssh-keygen         &>/dev/null || err "ssh-keygen not found."

log "qemu-system-x86_64: $(qemu-system-x86_64 --version | head -1)"

# ── Create data directory ────────────────────────────────────────────────────
mkdir -p "$APP_DIR"
log "Data dir: $APP_DIR"

# ── Generate SSH keypair ─────────────────────────────────────────────────────
if [ ! -f "$SSH_KEY" ]; then
  log "Generating SSH keypair..."
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -C "amd-dock-manager-vm" -q
  chmod 600 "$SSH_KEY"
  log "SSH key: $SSH_KEY"
  log "Public key (inject into VM's authorized_keys):"
  cat "${SSH_KEY}.pub"
else
  warn "SSH key already exists: $SSH_KEY"
fi

# ── Create QCOW2 disk image ──────────────────────────────────────────────────
if [ ! -f "$DISK_IMAGE" ]; then
  log "Creating ${DISK_SIZE_GB}GB QCOW2 disk image..."
  qemu-img create -f qcow2 "$DISK_IMAGE" "${DISK_SIZE_GB}G"
  log "Disk image created: $DISK_IMAGE"
else
  warn "Disk image already exists: $DISK_IMAGE"
  log "Current size: $(qemu-img info --output json "$DISK_IMAGE" | grep virtual-size)"
fi

# ── Print next steps ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  AMD Dock Manager Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Data directory : $APP_DIR"
echo "  Disk image     : $DISK_IMAGE (${DISK_SIZE_GB}GB)"
echo "  SSH private key: $SSH_KEY"
echo ""
echo -e "${YELLOW}  NEXT STEPS:${NC}"
echo "  1. Install a lightweight Linux onto the disk image:"
echo "     qemu-system-x86_64 \\"
echo "       -accel tcg,thread=multi \\"
echo "       -machine q35 \\"
echo "       -m 2048 -smp 2 \\"
echo "       -cdrom ~/Downloads/alpine-standard.iso \\"
echo "       -drive file=$DISK_IMAGE,if=virtio \\"
echo "       -nic user,model=virtio-net-pci \\"
echo "       -boot d"
echo ""
echo "  2. Inside the VM, install Docker and configure it to listen on"
echo "     /var/run/docker.sock (default). Also add your SSH public key:"
echo "     cat ${SSH_KEY}.pub >> ~/.ssh/authorized_keys"
echo ""
echo "  3. Launch: npm start"
echo ""

