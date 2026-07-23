'use strict';

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const SetupManager = require('./setup-manager');
const { autoUpdater } = require('electron-updater');

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS & PATHS
// ─────────────────────────────────────────────────────────────────────────────
const APP_DATA_DIR   = path.join(app.getPath('home'), '.amd-dock-manager');
const DISK_IMAGE_PATH = path.join(APP_DATA_DIR, 'core_dock_image.qcow2');
const SSH_KEY_PATH   = path.join(APP_DATA_DIR, 'vm_ssh_key');
const CONFIG_PATH    = path.join(APP_DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  cpuCores: 4,
  memoryMB: 4096,
  sshPort: 2222,
  dockerPort: 2375,
  diskSizeGB: 20,
};

// ─────────────────────────────────────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let vmProcess = null;
let sshTunnelProcess = null;
let vmState = 'stopped';
let resourceMonitorInterval = null;
let logBuffer = [];
let setupManager = null;

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function ensureAppDataDir() {
  if (!fs.existsSync(APP_DATA_DIR)) fs.mkdirSync(APP_DATA_DIR, { recursive: true });
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
    }
  } catch (e) { console.error('[Config]', e.message); }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  ensureAppDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function pushLog(line, type = 'info') {
  const entry = { time: new Date().toISOString(), type, line };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  sendToRenderer('vm-log', entry);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function setVmState(newState) {
  vmState = newState;
  pushLog(`VM state → ${newState}`, 'system');
  sendToRenderer('vm-state-changed', { state: newState });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP MANAGER — Autonomous first-run setup
// ─────────────────────────────────────────────────────────────────────────────
function initSetupManager() {
  setupManager = new SetupManager(APP_DATA_DIR);

  // Forward setup events to renderer
  setupManager.on('step', (payload) => sendToRenderer('setup-step', payload));
  setupManager.on('progress', (payload) => sendToRenderer('setup-progress', payload));
  setupManager.on('log', (entry) => {
    logBuffer.push(entry);
    if (logBuffer.length > 500) logBuffer.shift();
    sendToRenderer('setup-log', entry);
    sendToRenderer('vm-log', entry);  // also show in main log view
  });
  setupManager.on('done', () => sendToRenderer('setup-done', {}));
  setupManager.on('error', (err) => sendToRenderer('setup-error', err));
}

// ─────────────────────────────────────────────────────────────────────────────
//  QEMU TCG COMMAND BUILDER
//  ⚠ CRITICAL: -accel tcg is MANDATORY. HVF is NEVER used.
//  On AMD Hackintosh, HVF causes immediate HV_ERROR crash.
// ─────────────────────────────────────────────────────────────────────────────
function buildQemuArgs(config) {
  return [
    '-machine', 'q35',
    '-accel',   'tcg,thread=multi',
    '-cpu',     'max',
    '-m',       `${config.memoryMB}M`,
    '-smp',     `${config.cpuCores},cores=${config.cpuCores}`,
    '-drive',   `file=${DISK_IMAGE_PATH},if=virtio,cache=writeback,discard=unmap`,
    '-nic', [
      'user',
      `hostfwd=tcp::${config.sshPort}-:22`,
      `hostfwd=tcp::${config.dockerPort}-:2375`,
      'model=virtio-net-pci',
    ].join(','),
    '-display', 'none',
    '-vga',     'none',
    '-monitor', `unix:${path.join(APP_DATA_DIR, 'qemu-monitor.sock')},server,nowait`,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  VM LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────
async function startVM() {
  if (vmState === 'running' || vmState === 'starting') {
    pushLog('VM already running or starting.', 'warn');
    return;
  }

  const config = loadConfig();
  ensureAppDataDir();

  if (!fs.existsSync(DISK_IMAGE_PATH)) {
    setVmState('error');
    pushLog(`Disco virtual não encontrado: ${DISK_IMAGE_PATH}`, 'error');
    sendToRenderer('vm-error', { message: 'Setup incompleto. Execute o setup primeiro.' });
    return;
  }

  setVmState('starting');

  const qemuArgs = buildQemuArgs(config);
  const qemuBin = 'qemu-system-x86_64';

  pushLog(`Iniciando QEMU TCG (accel=tcg, sem HVF)`, 'system');
  pushLog(`CMD: ${qemuBin} ${qemuArgs.join(' ')}`, 'debug');

  try {
    vmProcess = spawn(qemuBin, qemuArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });

    vmProcess.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => pushLog(l, 'stdout')));
    vmProcess.stderr.on('data', (d) => {
      const text = d.toString();
      if (text.includes('HV_ERROR') || text.toLowerCase().includes('hvf')) {
        pushLog('⚠ CRÍTICO: Referência a HVF detectada! Verifique os args.', 'error');
      }
      text.split('\n').filter(Boolean).forEach(l => pushLog(l, 'stderr'));
    });

    vmProcess.on('error', (err) => {
      pushLog(`Erro QEMU: ${err.message}`, 'error');
      setVmState('error');
      vmProcess = null;
    });

    vmProcess.on('exit', (code, signal) => {
      pushLog(`QEMU encerrado: code=${code} signal=${signal}`, 'system');
      setVmState(vmState === 'stopping' ? 'stopped' : (code === 0 ? 'stopped' : 'error'));
      vmProcess = null;
      stopResourceMonitor();
      teardownSSHTunnel();
    });

    await waitForSSH(config.sshPort, 120000);
    await setupSSHTunnel(config);
    setVmState('running');
    startResourceMonitor();

  } catch (err) {
    pushLog(`Failed to start VM: ${err.message}`, 'error');
    setVmState('error');
    if (vmProcess) { vmProcess.kill('SIGKILL'); vmProcess = null; }
  }
}

async function stopVM() {
  if (vmState === 'stopped' || vmState === 'stopping') return;
  setVmState('stopping');
  stopResourceMonitor();
  teardownSSHTunnel();

  const monitorSock = path.join(APP_DATA_DIR, 'qemu-monitor.sock');
  if (fs.existsSync(monitorSock)) {
    try {
      await execAsync(`echo "system_powerdown" | socat - UNIX-CONNECT:${monitorSock}`);
      pushLog('Sinal de desligamento enviado.', 'system');
      await sleep(10000);
    } catch (e) { pushLog(`Monitor falhou: ${e.message}`, 'warn'); }
  }

  if (vmProcess) {
    vmProcess.kill('SIGTERM');
    await sleep(2000);
    if (vmProcess) vmProcess.kill('SIGKILL');
    vmProcess = null;
  }
  setVmState('stopped');
}

async function forceRestart() {
  pushLog('Reinicialização forçada...', 'system');
  await stopVM();
  await sleep(1500);
  await startVM();
}

// ─────────────────────────────────────────────────────────────────────────────
//  SSH TUNNEL — Maps VM's docker.sock to macOS host
// ─────────────────────────────────────────────────────────────────────────────
async function setupSSHTunnel(config) {
  const localSocketPath = path.join(APP_DATA_DIR, 'docker.sock');
  const sshArgs = [
    '-fNT',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=15',
    '-i', SSH_KEY_PATH,
    '-p', `${config.sshPort}`,
    '-L', `${localSocketPath}:/var/run/docker.sock`,
    'root@127.0.0.1',
  ];

  pushLog('Creating docker.sock tunnel via SSH...', 'system');

  return new Promise((resolve) => {
    sshTunnelProcess = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    sshTunnelProcess.stderr.on('data', (d) => pushLog(`[SSH] ${d.toString().trim()}`, 'debug'));
    sshTunnelProcess.on('error', (e) => pushLog(`SSH tunnel error: ${e.message}`, 'error'));
    sshTunnelProcess.on('exit', (code) => pushLog(`SSH tunnel closed (code=${code})`, 'system'));

    sendToRenderer('docker-sock-ready', {
      socketPath: localSocketPath,
      envVar: `DOCKER_HOST=unix://${localSocketPath}`,
    });
    setTimeout(resolve, 2000);
  });
}

function teardownSSHTunnel() {
  if (sshTunnelProcess) {
    sshTunnelProcess.kill('SIGTERM');
    sshTunnelProcess = null;
    pushLog('SSH tunnel closed.', 'system');
  }
  const p = path.join(APP_DATA_DIR, 'docker.sock');
  if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DOCKER COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
function sshExec(command) {
  const config = loadConfig();
  const cmd = [
    'ssh',
    '-q',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=5',
    '-i', SSH_KEY_PATH,
    '-p', config.sshPort,
    'root@127.0.0.1',
    `"${command}"`,
  ].join(' ');
  return execAsync(cmd);
}

async function listContainers() {
  try {
    const raw = await sshExec('docker ps -a --format \\"{{json .}}\\"');
    return raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (err) {
    pushLog(`listContainers: ${err.message}`, 'error');
    return [];
  }
}

async function containerAction(action, containerId) {
  if (!['start','stop','restart','rm'].includes(action)) return { success: false, error: 'Invalid action' };
  try {
    await sshExec(`docker ${action} ${containerId}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getContainerLogs(containerId, lines = 100) {
  try {
    const logs = await sshExec(`docker logs --tail=${lines} --timestamps ${containerId} 2>&1`);
    return { success: true, logs };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESOURCE MONITOR
// ─────────────────────────────────────────────────────────────────────────────
function startResourceMonitor() {
  if (resourceMonitorInterval) return;
  resourceMonitorInterval = setInterval(async () => {
    if (vmState !== 'running') return;
    try {
      const cpuRaw = await sshExec("top -bn1 | grep '%Cpu' | awk '{print $2}'");
      const memRaw = await sshExec("free -m | awk 'NR==2{printf \"%s %s\",$3,$2}'");
      const [memUsed, memTotal] = memRaw.trim().split(' ');
      sendToRenderer('resource-update', {
        cpu: parseFloat(cpuRaw.trim()) || 0,
        memUsed: parseInt(memUsed) || 0,
        memTotal: parseInt(memTotal) || 0,
      });
    } catch (_) {}
  }, 3000);
}

function stopResourceMonitor() {
  if (resourceMonitorInterval) { clearInterval(resourceMonitorInterval); resourceMonitorInterval = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').trim() || (stdout || '').trim() || err.message;
        reject(new Error(msg));
      } else resolve(stdout);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForSSH(port, timeoutMs = 60000) {
  const start = Date.now();
  pushLog(`Waiting for SSH on port ${port}...`, 'system');
  while (Date.now() - start < timeoutMs) {
    try {
      // We use SSH instead of nc -z because QEMU opens the TCP port immediately,
      // but the guest sshd takes time to boot and accept connections.
      await execAsync(`ssh -q -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -i "${SSH_KEY_PATH}" -p ${port} root@127.0.0.1 exit`);
      pushLog('SSH available and authenticated!', 'system');
      await sleep(1000);
      return;
    } catch (_) { await sleep(3000); }
  }
  throw new Error(`SSH timeout após ${timeoutMs / 1000}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  IPC HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
function registerIpcHandlers() {
  // VM Control
  ipcMain.handle('vm:start',    async () => { await startVM();     return { state: vmState }; });
  ipcMain.handle('vm:stop',     async () => { await stopVM();      return { state: vmState }; });
  ipcMain.handle('vm:restart',  async () => { await forceRestart(); return { state: vmState }; });
  ipcMain.handle('vm:getState', ()      => ({ state: vmState }));
  ipcMain.handle('vm:getLogs',  ()      => ({ logs: logBuffer }));

  // Config
  ipcMain.handle('config:get',  () => loadConfig());
  ipcMain.handle('config:save', (_, cfg) => {
    const merged = { ...loadConfig(), ...cfg };
    saveConfig(merged);
    pushLog(`Config salva: CPU=${merged.cpuCores} RAM=${merged.memoryMB}MB`, 'system');
    return { success: true, config: merged };
  });

  // Docker
  ipcMain.handle('docker:listContainers',  async ()      => {
    if (vmState !== 'running') return { containers: [], error: 'VM não está rodando' };
    return { containers: await listContainers() };
  });
  ipcMain.handle('docker:containerAction', async (_, a)  => {
    if (vmState !== 'running') return { success: false, error: 'VM não está rodando' };
    return containerAction(a.action, a.containerId);
  });
  ipcMain.handle('docker:containerLogs',   async (_, a)  => {
    if (vmState !== 'running') return { success: false, error: 'VM não está rodando' };
    return getContainerLogs(a.containerId, a.lines || 100);
  });

  // ── SETUP IPC ─────────────────────────────────────────────────────────────
  ipcMain.handle('setup:isComplete', () => ({
    complete: setupManager ? setupManager.isSetupComplete() : false,
  }));

  ipcMain.handle('setup:start', async () => {
    if (!setupManager) initSetupManager();
    // Run async — events are pushed to renderer via sendToRenderer
    setupManager.runSetup().catch((err) => {
      console.error('[Setup] Fatal error:', err);
    });
    return { started: true };
  });

  ipcMain.handle('setup:abort', () => {
    if (setupManager) setupManager.abort();
    return { aborted: true };
  });

  // Shell helper
  ipcMain.handle('shell:openDockerTerminal', () => {
    const socketPath = path.join(APP_DATA_DIR, 'docker.sock');
    return { envCmd: `export DOCKER_HOST=unix://${socketPath}` };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  WINDOW & TRAY
// ─────────────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: process.env.NODE_ENV === 'development',
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'AMD Dock Manager', enabled: false },
    { type: 'separator' },
    { label: 'Mostrar',   click: () => mainWindow?.show() },
    { label: 'Iniciar VM', click: () => startVM() },
    { label: 'Parar VM',   click: () => stopVM() },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  tray.setToolTip('AMD Dock Manager — QEMU TCG');
}

// ─────────────────────────────────────────────────────────────────────────────
//  APP LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureAppDataDir();
  initSetupManager();
  registerIpcHandlers();
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', async () => {
  if (setupManager) setupManager.abort();
  if (vmState === 'running' || vmState === 'starting') await stopVM();
});

app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
