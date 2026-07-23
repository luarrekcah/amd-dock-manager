/**
 * app.js — Renderer Process Logic
 * AMD Dock Manager — QEMU TCG Engine
 *
 * NO inline onclick/oninput in HTML. All events are wired here via
 * addEventListener — required by CSP "script-src 'self'".
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  vmState: 'stopped',
  containers: [],
  config: { cpuCores: 4, memoryMB: 4096, sshPort: 2222, dockerPort: 2375 },
  autoscroll: true,
  uptimeStart: null,
  uptimeInterval: null,
  containerRefreshInterval: null,
  setupRunning: false,
};

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function on(id, event, fn) {
  const el = $(id);
  if (el) el.addEventListener(event, fn);
  else console.warn(`[app] Element not found: #${id}`);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ─────────────────────────────────────────────────────────────────────────────
//  INIT — all wiring happens here, after DOM is ready
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  wireSetupWizard();
  wireDashboard();
  wireContainers();
  wireSettings();
  wireLogs();
  wireModal();
  wireNavigation();
  setupEventSubscriptions();
  checkFirstRun();
});

// ─────────────────────────────────────────────────────────────────────────────
//  WIRE — Setup Wizard
// ─────────────────────────────────────────────────────────────────────────────
function wireSetupWizard() {
  on('btn-begin-setup',  'click', beginSetup);
  on('btn-retry-setup',  'click', retrySetup);
  on('btn-finish-setup', 'click', finishSetup);
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIRE — Dashboard
// ─────────────────────────────────────────────────────────────────────────────
function wireDashboard() {
  on('btn-start',    'click', () => vmControl('start'));
  on('btn-stop',     'click', () => vmControl('stop'));
  on('btn-restart',  'click', () => vmControl('restart'));
  on('btn-terminal', 'click', openTerminal);
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIRE — Containers (event delegation for dynamic rows)
// ─────────────────────────────────────────────────────────────────────────────
function wireContainers() {
  on('btn-refresh-containers', 'click', refreshContainers);

  // Event delegation — handles all action buttons inside the table
  const tbody = $('containers-body');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action      = btn.dataset.action;
      const containerId = btn.dataset.containerid;
      const name        = btn.dataset.name || containerId;

      if (action === 'logs') {
        showContainerLogs(containerId, name);
      } else {
        doContainerAction(action, containerId);
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIRE — Settings
// ─────────────────────────────────────────────────────────────────────────────
function wireSettings() {
  on('btn-save-settings', 'click', saveSettings);

  on('setting-cpu', 'input', (e) => updateSlider('cpu', e.target.value));
  on('setting-ram', 'input', (e) => updateSlider('ram', e.target.value));
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIRE — Logs
// ─────────────────────────────────────────────────────────────────────────────
function wireLogs() {
  on('btn-clear-logs',  'click', clearLogs);
  on('btn-autoscroll',  'click', toggleAutoscroll);
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIRE — Modal
// ─────────────────────────────────────────────────────────────────────────────
function wireModal() {
  on('btn-modal-close', 'click', closeLogsModal);

  const overlay = $('logs-modal');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeLogsModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLogsModal();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIRE — Navigation
// ─────────────────────────────────────────────────────────────────────────────
function wireNavigation() {
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  FIRST-RUN CHECK
// ─────────────────────────────────────────────────────────────────────────────
async function checkFirstRun() {
  try {
    const res = await window.electronAPI.isSetupComplete();
    if (!res.complete) {
      showSetupOverlay();
    } else {
      await loadInitialState();
    }
  } catch (err) {
    console.error('[app] checkFirstRun:', err);
    await loadInitialState();
  }
}

async function loadInitialState() {
  try {
    const [stateRes, configRes, logsRes] = await Promise.all([
      window.electronAPI.getVMState(),
      window.electronAPI.getConfig(),
      window.electronAPI.getVMLogs(),
    ]);
    applyVMState(stateRes.state);
    applyConfig(configRes);
    if (logsRes.logs && logsRes.logs.length > 0) {
      logsRes.logs.forEach(appendLog);
    }
  } catch (err) {
    console.error('[app] loadInitialState:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  IPC EVENT SUBSCRIPTIONS  (Main → Renderer push events)
// ─────────────────────────────────────────────────────────────────────────────
function setupEventSubscriptions() {
  window.electronAPI.on('vm-state-changed',  ({ state: s }) => applyVMState(s));
  window.electronAPI.on('vm-log',            (entry)        => appendLog(entry));
  window.electronAPI.on('vm-error',          ({ message })  => showToast(message, 'error', 6000));
  window.electronAPI.on('resource-update',   ({ cpu, memUsed, memTotal }) => updateResourceMetrics(cpu, memUsed, memTotal));
  window.electronAPI.on('docker-sock-ready', ({ envVar })   => {
    const hint = $('env-hint');
    const val  = $('env-value');
    if (hint && val) { val.textContent = envVar; hint.style.display = 'block'; }
    showToast(`Docker socket pronto! ${envVar}`, 'success', 8000);
  });

  // Setup push events
  window.electronAPI.on('setup-step',     handleSetupStep);
  window.electronAPI.on('setup-progress', handleSetupProgress);
  window.electronAPI.on('setup-log',      handleSetupLog);
  window.electronAPI.on('setup-done',     handleSetupDone);
  window.electronAPI.on('setup-error',    handleSetupError);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP WIZARD
// ─────────────────────────────────────────────────────────────────────────────
function showSetupOverlay() {
  $('setup-overlay').classList.remove('hidden');
}

function hideSetupOverlay() {
  const overlay = $('setup-overlay');
  overlay.style.opacity = '0';
  overlay.style.transition = 'opacity 0.4s ease';
  setTimeout(() => overlay.classList.add('hidden'), 400);
}

async function beginSetup() {
  state.setupRunning = true;
  
  const btn = $('btn-begin-setup');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon">↻</span> Em progresso...';
  }

  $('setup-intro').classList.add('hidden');
  $('setup-progress-panel').classList.remove('hidden');

  try {
    await window.electronAPI.startSetup();
    // Progress arrives via push events
  } catch (err) {
    showSetupError(err.message);
  }
}

async function retrySetup() {
  $('setup-error-panel').classList.add('hidden');
  $('setup-log-panel').innerHTML = '';
  document.querySelectorAll('.setup-step').forEach((s) => {
    delete s.dataset.status;
    const dot = s.querySelector('.step-dot');
    if (dot) dot.textContent = '';
  });
  const btn = $('btn-begin-setup');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">▶</span> Iniciar Setup Autônomo';
  }
  state.setupRunning = false;
  await beginSetup();
}

async function finishSetup() {
  hideSetupOverlay();
  await loadInitialState();
  await vmControl('start');
}

function handleSetupStep({ id, label, status }) {
  const stepEl = $(`step-${id}`);
  if (stepEl) {
    // Deactivate any previous active step
    if (status === 'active') {
      document.querySelectorAll('.setup-step[data-status="active"]').forEach((s) => {
        if (s !== stepEl) s.dataset.status = '';
      });
    }
    stepEl.dataset.status = status;
  }
  const labelEl = $('setup-current-label');
  if (labelEl) labelEl.textContent = label;
}

function handleSetupProgress({ percent, label }) {
  const wrap  = $('setup-download-wrap');
  const bar   = $('download-bar');
  const stats = $('download-stats');
  if (wrap)  wrap.classList.remove('hidden');
  if (bar)   bar.style.width = `${percent}%`;
  if (stats) stats.textContent = label || `${percent}%`;
}

function handleSetupLog(entry) {
  appendSetupLog(entry);
  appendLog(entry); // mirror to main logs
}

function handleSetupDone() {
  state.setupRunning = false;
  $('setup-progress-panel').classList.add('hidden');
  $('setup-done-panel').classList.remove('hidden');
  document.querySelectorAll('.setup-step').forEach((s) => { s.dataset.status = 'done'; });
}

function handleSetupError({ message }) {
  state.setupRunning = false;
  showSetupError(message);
}

function showSetupError(message) {
  $('setup-error-panel').classList.remove('hidden');
  $('setup-error-message').textContent = message;
  const lbl = $('setup-current-label');
  if (lbl) lbl.textContent = 'Error during setup';
}

function appendSetupLog(entry) {
  const panel = $('setup-log-panel');
  if (!panel) return;
  const div = document.createElement('div');
  div.className = `setup-log-line log-${entry.type}`;
  const t = entry.time
    ? new Date(entry.time).toLocaleTimeString('pt-BR', { hour12: false })
    : '—';
  div.textContent = `${t} ${entry.line}`;
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
  while (panel.children.length > 200) panel.removeChild(panel.firstChild);
}

// ─────────────────────────────────────────────────────────────────────────────
//  VM STATE
// ─────────────────────────────────────────────────────────────────────────────
function applyVMState(newState) {
  state.vmState = newState;

  const LABELS = {
    stopped: 'Offline', starting: 'Starting...',
    running: 'Running', stopping: 'Stopping...', error: 'Error',
  };

  const indicator       = $('engine-indicator');
  const statusText      = $('status-text');
  const btnStart        = $('btn-start');
  const btnStop         = $('btn-stop');
  const btnRestart      = $('btn-restart');
  const uptimeDot       = $('uptime-dot');
  const uptimeStateTxt  = $('uptime-state-text');

  if (indicator)      indicator.dataset.state = newState;
  if (statusText)     statusText.textContent  = LABELS[newState] || newState;

  const isRunning = newState === 'running';
  const isBusy    = newState === 'starting' || newState === 'stopping';

  if (btnStart)   btnStart.disabled   = isRunning || isBusy;
  if (btnStop)    btnStop.disabled    = !isRunning || isBusy;
  if (btnRestart) btnRestart.disabled = !isRunning;
  if (uptimeDot)  uptimeDot.classList.toggle('active', isRunning);
  if (uptimeStateTxt) uptimeStateTxt.textContent = isRunning ? 'Engine online' : 'Engine offline';

  // Uptime counter
  if (isRunning && !state.uptimeStart) {
    state.uptimeStart    = Date.now();
    state.uptimeInterval = setInterval(updateUptime, 1000);
  } else if (!isRunning) {
    clearInterval(state.uptimeInterval);
    state.uptimeInterval = null;
    state.uptimeStart    = null;
    const el = $('uptime-value');
    if (el) el.textContent = '—';
  }

  // Container auto-refresh
  if (isRunning && !state.containerRefreshInterval) {
    refreshContainers();
    state.containerRefreshInterval = setInterval(refreshContainers, 10000);
  } else if (!isRunning) {
    clearInterval(state.containerRefreshInterval);
    state.containerRefreshInterval = null;
    showContainerState('offline');
  }
}

function updateUptime() {
  if (!state.uptimeStart) return;
  const d = Math.floor((Date.now() - state.uptimeStart) / 1000);
  const el = $('uptime-value');
  if (el) {
    const h = Math.floor(d / 3600);
    const m = Math.floor((d % 3600) / 60);
    const s = d % 60;
    el.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
}

function pad(n) { return String(n).padStart(2, '0'); }

// ─────────────────────────────────────────────────────────────────────────────
//  VM CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
async function vmControl(action) {
  const btnIds = { start: 'btn-start', stop: 'btn-stop', restart: 'btn-restart' };
  const btn = $(btnIds[action]);
  if (btn) btn.disabled = true;

  try {
    if (action === 'start')   { showToast('Iniciando QEMU TCG engine...', 'info'); await window.electronAPI.startVM(); }
    if (action === 'stop')    { showToast('Parando engine...', 'warn');             await window.electronAPI.stopVM(); }
    if (action === 'restart') { showToast('Forçando reinicialização...', 'warn');   await window.electronAPI.restartVM(); }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function openTerminal() {
  try {
    const res = await window.electronAPI.openDockerTerminal();
    if (res.envCmd) {
      await navigator.clipboard.writeText(res.envCmd);
      showToast(`Copiado: ${res.envCmd}`, 'success', 5000);
    }
  } catch (err) {
    showToast('Failed to copy command.', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESOURCE METRICS
// ─────────────────────────────────────────────────────────────────────────────
function updateResourceMetrics(cpu, memUsed, memTotal) {
  const cpuVal = $('cpu-value');
  const cpuBar = $('cpu-bar');
  if (cpuVal) cpuVal.textContent = `${cpu.toFixed(1)}%`;
  if (cpuBar) {
    cpuBar.style.width      = `${Math.min(cpu, 100)}%`;
    cpuBar.style.background = cpu > 90
      ? 'linear-gradient(90deg,#ef4444,#f59e0b)'
      : 'linear-gradient(90deg,#e8611a,#f59e0b)';
  }
  if (memTotal > 0) {
    const pct = (memUsed / memTotal) * 100;
    const ramVal = $('ram-value');
    const ramBar = $('ram-bar');
    const ramLbl = $('ram-total-label');
    if (ramVal) ramVal.textContent = `${memUsed} MB`;
    if (ramBar) ramBar.style.width = `${Math.min(pct, 100)}%`;
    if (ramLbl) ramLbl.textContent = `Total: ${memTotal} MB alocado`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONTAINERS
// ─────────────────────────────────────────────────────────────────────────────
async function refreshContainers() {
  if (state.vmState !== 'running') { showContainerState('offline'); return; }
  showContainerState('loading');
  try {
    const res = await window.electronAPI.listContainers();
    if (res.error) { showContainerState('offline'); return; }
    state.containers = res.containers || [];
    if (state.containers.length === 0) {
      showContainerState('empty');
    } else {
      renderContainersTable(state.containers);
      showContainerState('table');
    }
  } catch (err) {
    console.error('[app] refreshContainers:', err);
    showContainerState('offline');
  }
}

function showContainerState(s) {
  const map = { offline: 'placeholder', loading: 'loading', empty: 'empty', table: 'table-wrapper' };
  ['placeholder', 'loading', 'empty', 'table-wrapper'].forEach((id) => {
    $(`containers-${id}`)?.classList.add('hidden');
  });
  $(`containers-${map[s]}`)?.classList.remove('hidden');
}

function renderContainersTable(containers) {
  const tbody = $('containers-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  containers.forEach((c) => {
    const st        = (c.State || c.Status || 'unknown').toLowerCase();
    const isRunning = st.includes('up') || st === 'running';
    const isPaused  = st.includes('paused');
    const badge     = isRunning ? 'badge-running' : isPaused ? 'badge-paused' : 'badge-exited';
    const badgeTxt  = isRunning ? 'Running'       : isPaused ? 'Paused'       : 'Exited';
    const id        = escapeHtml(c.ID || c.Id || '');
    const name      = escapeHtml(c.Names || c.Name || '—');

    const tr = document.createElement('tr');

    // Status
    const tdStatus = document.createElement('td');
    tdStatus.innerHTML = `<span class="status-badge ${badge}"><span class="badge-dot"></span>${badgeTxt}</span>`;

    // Name
    const tdName = document.createElement('td');
    tdName.innerHTML = `<span class="container-name">${name}</span>`;

    // Image
    const tdImage = document.createElement('td');
    tdImage.innerHTML = `<span class="container-image">${escapeHtml(c.Image || '—')}</span>`;

    // Ports
    const tdPorts = document.createElement('td');
    tdPorts.innerHTML = `<span class="container-ports">${escapeHtml(c.Ports || '—')}</span>`;

    // State text
    const tdState = document.createElement('td');
    tdState.innerHTML = `<span class="container-image">${escapeHtml(c.Status || st)}</span>`;

    // Actions — use data attributes, handled by event delegation in wireContainers()
    const tdActions = document.createElement('td');
    const actionHtml = isRunning
      ? `<button class="action-btn danger"  data-action="stop"    data-containerid="${id}" data-name="${name}">Stop</button>`
      : `<button class="action-btn primary" data-action="start"   data-containerid="${id}" data-name="${name}">Start</button>`;
    tdActions.innerHTML = `
      <div class="row-actions">
        ${actionHtml}
        <button class="action-btn" data-action="restart" data-containerid="${id}" data-name="${name}">Restart</button>
        <button class="action-btn" data-action="logs"    data-containerid="${id}" data-name="${name}">Logs</button>
      </div>`;

    tr.append(tdStatus, tdName, tdImage, tdPorts, tdState, tdActions);
    tbody.appendChild(tr);
  });
}

async function doContainerAction(action, containerId) {
  try {
    const res = await window.electronAPI.containerAction(action, containerId);
    if (res.success) {
      showToast(`Container ${action}: OK`, 'success');
      await refreshContainers();
    } else {
      showToast(`Failed: ${res.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function showContainerLogs(containerId, name) {
  const modal = $('logs-modal');
  const title = $('modal-title');
  const out   = $('modal-log-output');
  if (!modal) return;
  if (title) title.textContent = `Logs — ${name}`;
  if (out)   out.textContent   = 'Loading...';
  modal.classList.remove('hidden');
  try {
    const res = await window.electronAPI.containerLogs(containerId, 200);
    if (out) {
      out.textContent  = res.success ? res.logs : `Error: ${res.error}`;
      out.scrollTop    = out.scrollHeight;
    }
  } catch (err) {
    if (out) out.textContent = `Error: ${err.message}`;
  }
}

function closeLogsModal() {
  $('logs-modal')?.classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
function applyConfig(config) {
  state.config = config;

  const cpuSlider = $('setting-cpu');
  const ramSlider = $('setting-ram');
  const sshPort   = $('setting-ssh-port');
  const dockPort  = $('setting-docker-port');

  if (cpuSlider) { cpuSlider.value = config.cpuCores; updateSlider('cpu', config.cpuCores); }
  if (ramSlider) { ramSlider.value = config.memoryMB; updateSlider('ram', config.memoryMB); }
  if (sshPort)   sshPort.value  = config.sshPort;
  if (dockPort)  dockPort.value = config.dockerPort;

  const cpuLbl = $('cpu-cores-label');
  const ramLbl = $('ram-total-label');
  if (cpuLbl) cpuLbl.textContent = `Alocado: ${config.cpuCores} cores (TCG multi-thread)`;
  if (ramLbl) ramLbl.textContent = `Total: ${config.memoryMB} MB alocado`;
}

function updateSlider(type, value) {
  const n = parseInt(value, 10);
  if (type === 'cpu') {
    const el = $('cpu-slider-val');
    if (el) el.innerHTML = `${n} <span>cores</span>`;
  } else {
    const el = $('ram-slider-val');
    if (el) el.innerHTML = `${n} <span>MB</span>`;
  }
}

async function saveSettings() {
  const cfg = {
    cpuCores:   parseInt($('setting-cpu')?.value      || state.config.cpuCores, 10),
    memoryMB:   parseInt($('setting-ram')?.value      || state.config.memoryMB, 10),
    sshPort:    parseInt($('setting-ssh-port')?.value  || state.config.sshPort, 10),
    dockerPort: parseInt($('setting-docker-port')?.value || state.config.dockerPort, 10),
  };
  try {
    const res = await window.electronAPI.saveConfig(cfg);
    if (res.success) {
      applyConfig(res.config);
      showToast('Settings saved! Reinicie a VM para aplicar.', 'success');
    }
  } catch (err) {
    showToast(`Failed to save: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOGS
// ─────────────────────────────────────────────────────────────────────────────
function appendLog(entry) {
  const panel = $('log-panel');
  if (!panel) return;
  const t   = entry.time ? new Date(entry.time).toLocaleTimeString('pt-BR', { hour12: false }) : '—';
  const div = document.createElement('div');
  div.className = `log-entry log-${entry.type}`;
  div.innerHTML = `
    <span class="log-time">${escapeHtml(t)}</span>
    <span class="log-type">${escapeHtml(entry.type)}</span>
    <span class="log-msg">${escapeHtml(entry.line)}</span>`;
  panel.appendChild(div);
  if (state.autoscroll) panel.scrollTop = panel.scrollHeight;
  while (panel.children.length > 300) panel.removeChild(panel.firstChild);
}

function clearLogs() {
  const p = $('log-panel');
  if (p) p.innerHTML = '';
  showToast('Logs limpos.', 'info');
}

function toggleAutoscroll() {
  state.autoscroll = !state.autoscroll;
  const btn = $('btn-autoscroll');
  if (btn) {
    btn.textContent = state.autoscroll ? 'Auto-scroll ON' : 'Auto-scroll OFF';
    btn.setAttribute('aria-pressed', String(state.autoscroll));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────
function switchView(viewId) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const active = b.dataset.view === viewId;
    b.classList.toggle('active', active);
    b.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('hidden', v.id !== `view-${viewId}`);
  });
  if (viewId === 'containers') refreshContainers();
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOASTS
// ─────────────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  const container = $('toast-container');
  if (!container) return;
  const icons = { success: '✓', error: '✕', warn: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity   = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
