'use strict';

/**
 * setup-manager.js — Autonomous First-Run Setup
 *
 * Handles everything needed to get the AMD Dock Manager running
 * from zero, without any manual user interaction:
 *
 *  1. Check & install QEMU via Homebrew
 *  2. Generate SSH keypair
 *  3. Create QCOW2 disk image
 *  4. Download Alpine Linux virt ISO (~58MB)
 *  5. Boot VM in install mode + automate via TCP serial console
 *  6. Post-install: Docker, SSH authorized_keys, docker daemon config
 *  7. First normal boot verification
 */

const { exec, spawn }  = require('child_process');
const net              = require('net');
const https            = require('https');
const http             = require('http');
const fs               = require('fs');
const path             = require('path');
const os               = require('os');
const { EventEmitter } = require('events');

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ALPINE_ISO_URL  = 'https://dl-cdn.alpinelinux.org/alpine/v3.19/releases/x86_64/alpine-virt-3.19.4-x86_64.iso';
const ALPINE_ISO_SHA  = null; // optional — skip sha check for now
const SERIAL_PORT     = 4445; // TCP port for QEMU serial console
const INSTALL_TIMEOUT = 30 * 60 * 1000; // 30 minutes max for VM install

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP MANAGER CLASS
// ─────────────────────────────────────────────────────────────────────────────
class SetupManager extends EventEmitter {
  constructor(appDataDir) {
    super();
    this.appDataDir    = appDataDir;
    this.diskImagePath = path.join(appDataDir, 'core_dock_image.qcow2');
    this.isoPath       = path.join(appDataDir, 'alpine-virt.iso');
    this.sshKeyPath    = path.join(appDataDir, 'vm_ssh_key');
    this.configPath    = path.join(appDataDir, 'config.json');
    this.setupDonePath = path.join(appDataDir, '.setup_complete');
    this.installProc   = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns true if setup was already completed on a previous run. */
  isSetupComplete() {
    return (
      fs.existsSync(this.setupDonePath) &&
      fs.existsSync(this.diskImagePath) &&
      fs.existsSync(this.sshKeyPath)
    );
  }

  /**
   * Run the full autonomous setup sequence.
   * Emits progress events: 'step', 'progress', 'log', 'done', 'error'
   */
  async runSetup() {
    try {
      this.emit('step', { id: 'start', label: 'Iniciando setup autônomo...', status: 'active' });
      this._ensureDir(this.appDataDir);

      // 1. QEMU
      await this._stepInstallQemu();

      // 1.5 Docker CLI
      await this._stepInstallDockerCLI();

      // 2. SSH Key
      await this._stepGenerateSSHKey();

      // 3. Disk image
      await this._stepCreateDiskImage();

      // 4. Download Alpine ISO
      await this._stepDownloadISO();

      // 5. Install Alpine + Docker inside VM (automated via serial console)
      await this._stepInstallVM();

      // 6. Mark setup as done
      fs.writeFileSync(this.setupDonePath, new Date().toISOString());

      this.emit('step', { id: 'done', label: 'Setup concluído!', status: 'done' });
      this.emit('done');

    } catch (err) {
      this.emit('error', { message: err.message, stack: err.stack });
      throw err;
    }
  }

  // ── Step 1: Install QEMU ───────────────────────────────────────────────────
  async _stepInstallQemu() {
    this.emit('step', { id: 'qemu', label: 'Verificando QEMU...', status: 'active' });

    // Check if already installed
    try {
      await this._exec('which qemu-system-x86_64');
      const ver = await this._exec('qemu-system-x86_64 --version');
      this._log(`QEMU already installed: ${ver.trim().split('\n')[0]}`);
      this.emit('step', { id: 'qemu', label: 'QEMU instalado ✓', status: 'done' });
      return;
    } catch (_) {
      this._log('QEMU não encontrado. Instalando via Homebrew...');
    }

    // Check brew
    try {
      await this._exec('which brew');
    } catch (_) {
      throw new Error(
        'Homebrew não encontrado. Instale o Homebrew primeiro:\n' +
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
      );
    }

    // brew install qemu — streams output
    this.emit('step', { id: 'qemu', label: 'Instalando QEMU via Homebrew...', status: 'active' });
    this._log('Running: brew install qemu');
    this._log('Isso pode levar alguns minutos...');

    await new Promise((resolve, reject) => {
      const proc = spawn('brew', ['install', 'qemu'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (d) => this._log(d.toString().trimEnd()));
      proc.stderr.on('data', (d) => this._log(d.toString().trimEnd()));

      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`brew install qemu failed with code ${code}`));
      });
      proc.on('error', reject);
    });

    this._log('QEMU instalado com sucesso!');
    this.emit('step', { id: 'qemu', label: 'QEMU instalado ✓', status: 'done' });
  }

  // ── Step 1.5: Install Docker CLI ───────────────────────────────────────────
  async _stepInstallDockerCLI() {
    this.emit('step', { id: 'docker-cli', label: 'Verificando Docker CLI no host...', status: 'active' });

    try {
      await this._exec('which docker');
      const ver = await this._exec('docker --version');
      this._log(`Docker CLI already installed on Mac: ${ver.trim()}`);
      this.emit('step', { id: 'docker-cli', label: 'Docker CLI instalado ✓', status: 'done' });
      return;
    } catch (_) {
      this._log('Docker CLI não encontrado. Instalando via Homebrew (apenas o CLI)...');
    }

    this.emit('step', { id: 'docker-cli', label: 'Instalando Docker CLI...', status: 'active' });
    this._log('Running: brew install docker');

    await new Promise((resolve, reject) => {
      const proc = spawn('brew', ['install', 'docker'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', (d) => this._log(d.toString().trimEnd()));
      proc.stderr.on('data', (d) => this._log(d.toString().trimEnd()));
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`brew install docker failed with code ${code}`));
      });
      proc.on('error', reject);
    });

    this._log('Docker CLI successfully installed.');
    this.emit('step', { id: 'docker-cli', label: 'Docker CLI instalado ✓', status: 'done' });
  }

  // ── Step 2: SSH Keypair ────────────────────────────────────────────────────
  async _stepGenerateSSHKey() {
    this.emit('step', { id: 'ssh', label: 'Gerando chave SSH...', status: 'active' });

    if (fs.existsSync(this.sshKeyPath)) {
      this._log('SSH key already exists.');
      this.emit('step', { id: 'ssh', label: 'Chave SSH ✓', status: 'done' });
      return;
    }

    await this._exec(
      `ssh-keygen -t ed25519 -f "${this.sshKeyPath}" -N "" -C "amd-dock-manager-vm" -q`
    );
    await this._exec(`chmod 600 "${this.sshKeyPath}"`);
    this._log(`Keypair gerada: ${this.sshKeyPath}`);
    this.emit('step', { id: 'ssh', label: 'Chave SSH gerada ✓', status: 'done' });
  }

  // ── Step 3: QCOW2 Disk Image ───────────────────────────────────────────────
  async _stepCreateDiskImage() {
    this.emit('step', { id: 'disk', label: 'Criando disco virtual...', status: 'active' });

    if (fs.existsSync(this.diskImagePath)) {
      this._log('Virtual disk already exists.');
      this.emit('step', { id: 'disk', label: 'Disco virtual ✓', status: 'done' });
      return;
    }

    await this._exec(`qemu-img create -f qcow2 "${this.diskImagePath}" 20G`);
    this._log(`QCOW2 disk created: ${this.diskImagePath} (20GB)`);
    this.emit('step', { id: 'disk', label: 'Disco virtual criado ✓', status: 'done' });
  }

  // ── Step 4: Download Alpine ISO ────────────────────────────────────────────
  async _stepDownloadISO() {
    this.emit('step', { id: 'iso', label: 'Verificando Alpine Linux ISO...', status: 'active' });

    if (fs.existsSync(this.isoPath) && fs.statSync(this.isoPath).size > 10_000_000) {
      this._log(`ISO already downloaded: ${this.isoPath}`);
      this.emit('step', { id: 'iso', label: 'Alpine ISO ✓ (cache)', status: 'done' });
      return;
    }

    this._log(`Baixando Alpine Linux virt 3.19.4...`);
    this._log(`URL: ${ALPINE_ISO_URL}`);
    this.emit('step', { id: 'iso', label: 'Baixando Alpine Linux (~58MB)...', status: 'active' });

    await this._downloadFile(ALPINE_ISO_URL, this.isoPath);

    this._log(`ISO baixada: ${this.isoPath}`);
    this.emit('step', { id: 'iso', label: 'Alpine ISO baixada ✓', status: 'done' });
  }

  // ── Step 5: Install Alpine + Docker in VM ─────────────────────────────────
  async _stepInstallVM() {
    this.emit('step', { id: 'vm-install', label: 'Instalando Alpine Linux na VM...', status: 'active' });
    this._log('Starting installation VM with QEMU TCG...');
    this._log('WARNING: This may take 5-8 minutes (TCG software emulation).');

    // Read SSH public key to inject into VM
    const pubKey = fs.readFileSync(`${this.sshKeyPath}.pub`, 'utf-8').trim();

    // The post-install script that runs inside the VM
    // It installs Docker, configures SSH, and sets up the daemon
    const postInstallScript = this._buildPostInstallScript(pubKey);

    // Build the answerfile for Alpine's setup-alpine
    const answerfile = this._buildAlpineAnswerfile();

    // Start a minimal HTTP server to serve the answerfile + post-install script
    // Alpine (via QEMU user network) reaches the host at 10.0.2.2
    const { server, port } = await this._startFileServer({
      '/answerfile':    { content: answerfile,        type: 'text/plain' },
      '/postinstall.sh':{ content: postInstallScript, type: 'text/plain' },
    });

    try {
      await this._runVMInstallation(port, pubKey);
    } finally {
      server.close();
    }

    this.emit('step', { id: 'vm-install', label: 'Alpine Linux instalado ✓', status: 'done' });
  }

  // ─────────────────────────────────────────────────────────────────────────
  _buildAlpineAnswerfile() {
    // Alpine setup-alpine answerfile format
    // Ref: https://wiki.alpinelinux.org/wiki/Alpine_setup_scripts
    return [
      'KEYMAPOPTS="us us"',
      'HOSTNAMEOPTS="-n amd-dock-vm"',
      'DEVDOPTS="mdev"',
      'INTERFACESOPTS="auto lo',
      'iface lo inet loopback',
      '',
      'auto eth0',
      'iface eth0 inet dhcp',
      '    hostname amd-dock-vm',
      '"',
      'TIMEZONEOPTS="-z UTC"',
      'PROXYOPTS="none"',
      'APKREPOSOPTS="-1"',
      'SSHDOPTS="-c openssh"',
      'NTPOPTS="-c none"',
      'USEROPTS="none"',
      'DISKOPTS="-v -m sys /dev/vda"',
      'LBUOPTS="none"',
      'APKCACHEOPTS="none"',
    ].join('\n');
  }

  _buildPostInstallScript(pubKey) {
    // This runs in the Live CD environment after Alpine base install, acting on /mnt
    // Sets up Docker, SSH authorized_keys, and docker daemon
    return `#!/bin/sh
set -e

echo "==> Enabling community repositories..."
sed -i 's/^#//g' /mnt/etc/apk/repositories
apk update --root /mnt

echo "==> Post-install: Installing Docker..."
apk add --root /mnt docker docker-compose openssh curl

echo "==> Enabling services..."
ln -sf /etc/init.d/docker /mnt/etc/runlevels/default/docker
ln -sf /etc/init.d/sshd /mnt/etc/runlevels/default/sshd
ln -sf /etc/init.d/local /mnt/etc/runlevels/default/local

echo "==> Configuring Docker daemon..."
mkdir -p /mnt/etc/docker
cat > /mnt/etc/docker/daemon.json << 'DAEMON'
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2375"],
  "storage-driver": "overlay2",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
DAEMON

echo "==> Configuring SSH..."
mkdir -p /mnt/root/.ssh
chmod 700 /mnt/root/.ssh
echo "${pubKey}" > /mnt/root/.ssh/authorized_keys
chmod 600 /mnt/root/.ssh/authorized_keys
sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/g' /mnt/etc/ssh/sshd_config
echo "AllowStreamLocalForwarding yes" >> /mnt/etc/ssh/sshd_config

echo "==> Setting SSH server options..."
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /mnt/etc/ssh/sshd_config
sed -i 's/#PubkeyAuthentication.*/PubkeyAuthentication yes/' /mnt/etc/ssh/sshd_config
sed -i 's/#AuthorizedKeysFile.*/AuthorizedKeysFile .ssh\\/authorized_keys/' /mnt/etc/ssh/sshd_config

# Generate SSH host keys for the new system
chroot /mnt ssh-keygen -A

echo "==> Creating marker file..."
touch /mnt/root/.amd_dock_setup_complete
echo "setup_complete"
`;
  }

  async _startFileServer(files) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const file = files[req.url];
        if (file) {
          res.writeHead(200, { 'Content-Type': file.type });
          res.end(file.content);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ server, port });
      });

      server.on('error', reject);
    });
  }

  async _runVMInstallation(httpPort, pubKey) {
    // QEMU args for installation boot:
    //  - boots from ISO
    //  - serial console via TCP (we'll connect and automate it)
    //  - no display (headless)
    //  - user networking with host HTTP access via 10.0.2.2
    const qemuArgs = [
      '-machine', 'q35',
      '-accel',   'tcg,thread=multi',
      '-cpu',     'max',
      '-m',       '1024M',
      '-smp',     '2',
      '-drive',   `file=${this.diskImagePath},if=virtio,cache=unsafe`,
      '-cdrom',   this.isoPath,
      '-boot',    'order=d,once=d',   // boot from CDROM first
      '-nic',     'user,model=virtio-net-pci',
      '-serial',  `tcp::${SERIAL_PORT},server,nowait`,
      '-display', 'none',
      '-vga',     'none',
    ];

    this._log(`Serial console TCP on port ${SERIAL_PORT}`);
    this._log('CMD: qemu-system-x86_64 ' + qemuArgs.join(' '));

    this.installProc = spawn('qemu-system-x86_64', qemuArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    this.installProc.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) this._log(`[QEMU] ${t}`);
    });

    // Wait for QEMU to start accepting serial connections
    await this._sleep(3000);

    let qemuExited = false;
    const qemuExitPromise = new Promise((resolve) => {
      this.installProc.on('exit', (code) => {
        qemuExited = true;
        this._log(`Installation QEMU exited (code=${code})`);
        resolve(code);
      });
    });

    try {
      await Promise.race([
        this._automateInstallation(httpPort, pubKey),
        qemuExitPromise,
        this._sleep(INSTALL_TIMEOUT).then(() => { throw new Error('Installation timeout após 30 minutos'); }),
      ]);
    } finally {
      if (!qemuExited && this.installProc) {
        this.installProc.kill('SIGKILL');
        this.installProc = null;
      }
    }
  }

  async _automateInstallation(httpPort, pubKey) {
    // Connect to QEMU serial console
    const socket = await this._connectSerial(SERIAL_PORT, 15000);
    this._log('Serial console connected!');

    const send = (text) => {
      socket.write(text);
    };

    let buffer = '';
    let logLine = '';
    let flushTimer = null;
    const waitFor = (pattern, timeoutMs = 120000) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timeout esperando por: ${pattern}`));
        }, timeoutMs);

        const onData = (data) => {
          const chunk = data.toString();
          buffer += chunk;
          
          if (flushTimer) clearTimeout(flushTimer);

          const strChunk = chunk.toString();
          
          // Clean logging: print only full lines and strip ANSI
          for (let i = 0; i < strChunk.length; i++) {
            if (strChunk[i] === '\n') {
              const clean = logLine.replace(/\r/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
              if (clean) this._log(`[VM] ${clean}`);
              logLine = '';
            } else {
              logLine += strChunk[i];
            }
          }
          
          // Flush partial lines if no more data comes in 500ms
          // This allows us to see interactive prompts that lack \n
          if (logLine.length > 0) {
            flushTimer = setTimeout(() => {
              const clean = logLine.replace(/\r/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
              if (clean) this._log(`[VM] ${clean}`);
              logLine = '';
            }, 1000);
          }
          
          // Remove ANSI escape sequences (like cursor position reports)
          const cleanBuffer = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
          
          // If setup asks for a password unexpectedly, just answer it
          if (cleanBuffer.includes('New password: ') || cleanBuffer.includes('Retype password: ')) {
             socket.write('root\n');
             buffer = '';
             return;
          }

          if (
            (typeof pattern === 'string' && cleanBuffer.includes(pattern)) ||
            (pattern instanceof RegExp && pattern.test(cleanBuffer))
          ) {
            clearTimeout(timer);
            socket.removeListener('data', onData);
            const matchedString = cleanBuffer;
            buffer = ''; // reset buffer after match
            resolve(matchedString);
          }
        };
        socket.on('data', onData);
      });
    };

    this._log('Waiting for Alpine to boot...');

    // ── Phase 1: Alpine boot → login ────────────────────────────────────────
    await waitFor('localhost login:', 180000);
    this._log('>> Login prompt detected. Logging in as root...');
    await this._sleep(500);
    send('root\n');

    // ── Phase 2: Create answerfile or skip if installed ─────────────────────
    await waitFor(/[#$]\s*$/, 15000);
    this._log('>> Shell detected. Checking if disk is already formatted...');
    await this._sleep(300);

    send('mount /dev/vda3 /mnt 2>/dev/null || mount /dev/vda2 /mnt 2>/dev/null || mount /dev/vda1 /mnt 2>/dev/null\n');
    await waitFor(/[#$]\s*$/, 15000);
    send('echo "MOUNT_STATUS=$?"\n');
    // Wait for the status AND the subsequent prompt to avoid race conditions clearing the buffer
    const mountStatus = await waitFor(/MOUNT_STATUS=(\d+)[\s\S]*?[#$]\s*$/, 15000);

    if (mountStatus && mountStatus.includes('MOUNT_STATUS=0')) {
      this._log('>> Disk already formatted! Skipping Alpine installation...');
      
      // Start networking manually since we skipped setup-alpine
      this._log('>> Iniciando rede no Live CD...');
      send('setup-interfaces -a -r\n');
      await waitFor(/(?:localhost|amd-dock-vm):~#\s*$/, 15000);
      send('rc-service networking start || true\n');
      await waitFor(/(?:localhost|amd-dock-vm):~#\s*$/, 15000);

      await this._sleep(500);
    } else {
      // Create answerfile via echo instead of downloading it
      this._log('>> Virgin disk detected. Injecting answerfile via console...');
      const answerfile = this._buildAlpineAnswerfile();
      send("cat > /tmp/answerfile << 'EOF'\n");
      await this._sleep(100);
      for (const line of answerfile.split('\n')) {
        send(line + '\n');
        await this._sleep(50);
      }
      send("EOF\n");
      await waitFor(/[#$]\s*$/, 15000);

      this._log('>> Answerfile created. Starting setup-alpine...');
      await this._sleep(300);

      // Run setup-alpine with the answerfile
      send('ERASE_DISKS="/dev/vda" ROOTPASS="root" setup-alpine -f /tmp/answerfile\n');
      this._log('Alpine installation in progress (waiting for "Installation is complete")...');

      // Wait for disk format prompt OR end of installation
      const match = await waitFor(/erase|Erase|format|Installation is complete|reboot|poweroff|Rebooting|(?:localhost|amd-dock-vm):~#\s*$/i, 1200000);
      
      // If it asked to erase, confirm it, then wait for completion
      if (match && /erase|Erase|format/i.test(match)) {
        await this._sleep(500);
        send('y\n');
        this._log('>> Disk formatting confirmed. Waiting for file copy (may take a while)...');
        await waitFor(/Installation is complete|reboot|poweroff|Rebooting|(?:localhost|amd-dock-vm):~#\s*$/i, 1200000);
      }

      this._log('>> Base installation complete!');
      await this._sleep(2000);

      // Mount the installed system for Phase 3
      send('mount /dev/vda3 /mnt 2>/dev/null || mount /dev/vda2 /mnt 2>/dev/null || mount /dev/vda1 /mnt\n');
      await waitFor(/(?:localhost|amd-dock-vm):~#\s*$/, 30000);
      await this._sleep(300);
    }

    // Ensure network is up before downloading
    this._log('>> Aguardando rede interna (QEMU SLIRP)...');
    send('while ! ping -c 1 -W 1 10.0.2.2 >/dev/null 2>&1; do sleep 1; done\n');
    await waitFor(/(?:localhost|amd-dock-vm):~#\s*$/, 30000);

    // Inject post-install script via wget (Live CD has network access to 10.0.2.2)
    // This avoids all serial console buffer/echo corruption issues.
    this._log('>> Downloading post-install script via internal HTTP...');
    send(`wget http://10.0.2.2:${httpPort}/postinstall.sh -O /mnt/postinstall.sh\n`);
    await waitFor(/(?:localhost|amd-dock-vm):~#\s*$/, 15000);

    send('chmod +x /mnt/postinstall.sh\n');
    await waitFor(/(?:localhost|amd-dock-vm):~#\s*$/, 5000);

    // Ensure DNS works in live environment (usually already works, but just in case)
    // Wait, live environment already has network. We don't need to do anything.

    send('/mnt/postinstall.sh\n');
    this._log('Executing post-install script (Docker, SSH)...');

    await waitFor(/Setup complete|setup_complete|poweroff|halt/i, 300000);
    this._log('>> Post-install complete!');
    await this._sleep(2000);

    // Power off the installation VM
    send('poweroff\n');
    await waitFor(/Power down|reboot: Power down|Powering off/i, 30000);

    socket.destroy();
    this._log('VM de instalação encerrada com sucesso!');
  }

  async _connectSerial(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await new Promise((resolve, reject) => {
          const socket = net.createConnection({ port, host: '127.0.0.1' }, () => resolve(socket));
          socket.on('error', reject);
        });
      } catch (_) {
        await this._sleep(1000);
      }
    }
    throw new Error(`Não foi possível conectar ao serial TCP :${port} após ${timeoutMs / 1000}s`);
  }

  // ── File Download ──────────────────────────────────────────────────────────
  async _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(destPath);
      let downloaded = 0;
      let total = 0;

      const handleResponse = (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location;
          this._log(`Redirect → ${redirectUrl}`);
          const mod = redirectUrl.startsWith('https') ? https : http;
          mod.get(redirectUrl, handleResponse).on('error', reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download falhou: HTTP ${res.statusCode}`));
          return;
        }

        total = parseInt(res.headers['content-length'] || '0', 10);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          dest.write(chunk);
          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            this.emit('progress', {
              id: 'iso-download',
              percent: pct,
              downloaded,
              total,
              label: `Baixando Alpine ISO: ${pct}% (${this._formatBytes(downloaded)} / ${this._formatBytes(total)})`,
            });
          }
        });

        res.on('end', () => { dest.end(); resolve(); });
        res.on('error', (e) => { dest.destroy(); fs.unlinkSync(destPath); reject(e); });
      };

      const mod = url.startsWith('https') ? https : http;
      mod.get(url, handleResponse).on('error', (e) => {
        dest.destroy();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(e);
      });
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  _exec(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _log(msg) {
    const entry = { time: new Date().toISOString(), type: 'setup', line: msg };
    console.log('[setup]', msg);
    this.emit('log', entry);
  }

  _formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Abort an in-progress installation (e.g. user closes app) */
  abort() {
    if (this.installProc) {
      this.installProc.kill('SIGKILL');
      this.installProc = null;
    }
  }
}

module.exports = SetupManager;
