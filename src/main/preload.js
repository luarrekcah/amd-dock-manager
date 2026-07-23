'use strict';

/**
 * preload.js — Context Bridge
 * Exposes IPC channels to the renderer via contextBridge.
 * Node.js APIs are NEVER directly accessible in the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of all push-events Main can send to Renderer
const ALLOWED_EVENTS = [
  'vm-state-changed',
  'vm-log',
  'vm-error',
  'resource-update',
  'docker-sock-ready',
  // Setup events
  'setup-step',
  'setup-progress',
  'setup-log',
  'setup-done',
  'setup-error',
];

contextBridge.exposeInMainWorld('electronAPI', {

  // ── VM Control ────────────────────────────────────────────────────────────
  startVM:    () => ipcRenderer.invoke('vm:start'),
  stopVM:     () => ipcRenderer.invoke('vm:stop'),
  restartVM:  () => ipcRenderer.invoke('vm:restart'),
  getVMState: () => ipcRenderer.invoke('vm:getState'),
  getVMLogs:  () => ipcRenderer.invoke('vm:getLogs'),

  // ── Config ────────────────────────────────────────────────────────────────
  getConfig:  ()    => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // ── Docker ────────────────────────────────────────────────────────────────
  listContainers:  ()              => ipcRenderer.invoke('docker:listContainers'),
  containerAction: (action, id)    => ipcRenderer.invoke('docker:containerAction', { action, containerId: id }),
  containerLogs:   (id, lines)     => ipcRenderer.invoke('docker:containerLogs', { containerId: id, lines }),

  // ── Autonomous Setup ──────────────────────────────────────────────────────
  /** Check if the first-run setup is already complete. */
  isSetupComplete: () => ipcRenderer.invoke('setup:isComplete'),
  /** Start the autonomous setup sequence. Results come via push events. */
  startSetup:      () => ipcRenderer.invoke('setup:start'),
  /** Abort an ongoing setup (e.g., user closes app mid-install). */
  abortSetup:      () => ipcRenderer.invoke('setup:abort'),

  // ── Shell ─────────────────────────────────────────────────────────────────
  openDockerTerminal: () => ipcRenderer.invoke('shell:openDockerTerminal'),

  // ── Event Subscriptions (Main → Renderer push) ────────────────────────────
  /**
   * Subscribe to any whitelisted push event.
   * Returns an unsubscribe cleanup function.
   */
  on: (event, handler) => {
    if (!ALLOWED_EVENTS.includes(event)) {
      console.warn(`[preload] Blocked unknown event: ${event}`);
      return () => {};
    }
    const wrapped = (_, payload) => handler(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },

  once: (event, handler) => {
    if (!ALLOWED_EVENTS.includes(event)) return;
    ipcRenderer.once(event, (_, payload) => handler(payload));
  },
});
