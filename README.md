# ⬡ AMD Dock Manager

> **QEMU TCG Docker Manager for AMD Hackintosh**  
> Bypasses Apple's `Hypervisor.framework` (HVF) using pure software emulation via QEMU TCG — the only viable Docker engine for AMD Ryzentosh.

---

## ⚡ Why This Exists

On macOS with AMD CPUs (Hackintosh/Ryzentosh), `Hypervisor.framework` (HVF) is **not supported**. Any virtualization tool that relies on HVF — including Docker Desktop — crashes immediately with:

```
Error: HV_ERROR
qemu: could not enable HVF virtualization
```

**Solution**: Force QEMU to use **TCG (Tiny Code Generator)** — pure software emulation that works regardless of CPU vendor.

The critical flags:
```bash
# MANDATORY — never use -accel hvf on AMD Hackintosh
qemu-system-x86_64 -accel tcg,thread=multi -machine q35 ...
```

---

## 📁 Project Structure

```
ryzentosh-docker/
├── package.json                   # Electron app manifest
├── README.md
├── scripts/
│   └── setup.sh                   # One-time setup: disk image + SSH key
└── src/
    ├── main/
    │   ├── main.js                # Electron Main Process
    │   │                          #   → QEMU child_process management
    │   │                          #   → SSH tunnel (docker.sock)
    │   │                          #   → IPC handlers
    │   │                          #   → Resource monitor
    │   └── preload.js             # contextBridge — secure IPC bridge
    └── renderer/
        ├── index.html             # UI structure (4 views)
        ├── styles.css             # Dark glassmorphism design
        └── app.js                 # UI logic (vanilla JS)
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron Main Process                       │
│                         (main.js)                               │
│                                                                 │
│  ┌──────────────┐   spawn()    ┌──────────────────────────────┐ │
│  │  IPC Handler │ ──────────▶  │   QEMU TCG Process           │ │
│  │  (vm:start)  │              │   qemu-system-x86_64         │ │
│  └──────┬───────┘              │   -accel tcg,thread=multi    │ │
│         │                      │   -machine q35               │ │
│  ┌──────▼───────┐              │   -m 4096M -smp 4            │ │
│  │  SSH Tunnel  │              │   [NO -accel hvf EVER]       │ │
│  │  (docker.sock│              └──────────────────────────────┘ │
│  │  → macOS)    │                         ▲                     │
│  └──────────────┘                         │ stdout/stderr        │
│         │                                 │                     │
│  ┌──────▼────────────────────────────┐    │                     │
│  │  Resource Monitor (SSH polling)   │────┘                     │
│  └───────────────────────────────────┘                          │
└──────────────────────────────────────────────────────────────────┘
         │ IPC (contextBridge)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Renderer Process (UI)                         │
│  ┌────────────┐ ┌──────────────┐ ┌───────────┐ ┌───────────┐  │
│  │ Dashboard  │ │  Containers  │ │  Settings │ │   Logs    │  │
│  │ Status     │ │  docker ps -a│ │ CPU/RAM   │ │ TCG stdout│  │
│  │ CPU/RAM    │ │  Start/Stop  │ │ sliders   │ │ /stderr   │  │
│  │ Controls   │ │  Logs modal  │ │           │ │           │  │
│  └────────────┘ └──────────────┘ └───────────┘ └───────────┘  │
└─────────────────────────────────────────────────────────────────┘

DOCKER_HOST=unix://~/.amd-dock-manager/docker.sock  ← use in terminal
```

---

## 🚀 Quick Start

AMD Dock Manager is **100% autonomous**. You don't need to manually install QEMU, Docker CLI, or configure virtual machines. The app handles everything for you!

### 1. Launch the App

Clone the repository, install the Electron dependencies, and start the app:

```bash
git clone https://github.com/devluar/ryzentosh-docker.git
cd ryzentosh-docker
npm install
npm start
```

### 2. 1-Click Automated Setup

When you open the app for the first time, you will see the **Automated Setup** screen.
Simply click **"Iniciar Setup Autônomo"**. The AMD Dock Manager will automatically:
1. Check for and install `qemu` and `docker` CLI on your macOS host (via Homebrew, if missing).
2. Generate SSH keys for secure communication.
3. Create a virtual disk (20GB).
4. Download the official Alpine Linux Virtual ISO.
5. Boot QEMU and perform the entire OS formatting and installation automatically via the serial console.
6. Install and configure Docker and Docker Compose (v2) inside the VM.

The entire process takes about 5 to 10 minutes depending on your CPU. When it finishes, the VM is powered off and you're ready to go!

### 3. Use Docker from your Terminal!

The app creates a secure SSH tunnel that exposes the Docker Socket from inside the VM directly to your Mac.

To use your terminal normally (without Docker Desktop), just export the `DOCKER_HOST` variable:
```bash
export DOCKER_HOST=unix://$HOME/.amd-dock-manager/docker.sock

# That's it! All your commands will hit the QEMU VM:
docker ps
docker compose up -d
docker run -p 8080:80 nginx
```

---

## 🔧 IPC API Reference

| Channel | Direction | Description |
|---------|-----------|-------------|
| `vm:start` | Renderer → Main | Start QEMU TCG VM |
| `vm:stop` | Renderer → Main | Graceful shutdown |
| `vm:restart` | Renderer → Main | Force restart |
| `vm:getState` | Renderer → Main | Get current state |
| `vm:getLogs` | Renderer → Main | Get log buffer |
| `config:get` | Renderer → Main | Load config |
| `config:save` | Renderer → Main | Save CPU/RAM/ports |
| `docker:listContainers` | Renderer → Main | `docker ps -a` |
| `docker:containerAction` | Renderer → Main | start/stop/restart |
| `docker:containerLogs` | Renderer → Main | `docker logs` |
| `vm-state-changed` | Main → Renderer | State push event |
| `vm-log` | Main → Renderer | Real-time log entry |
| `resource-update` | Main → Renderer | CPU/RAM metrics |
| `docker-sock-ready` | Main → Renderer | Socket path ready |

---

## ⚠️ Important Notes

- **TCG is slower than HVF** by design. This is the tradeoff for AMD compatibility.
- **multi-threaded TCG** (`thread=multi`) significantly improves performance.
- The VM must be fully booted before Docker commands will work.
- The SSH tunnel requires the VM to have `sshd` running and your public key installed.

