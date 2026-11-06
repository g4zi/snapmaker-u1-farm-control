// U1 Farm Control — Electron ana süreç
// Yazıcıları Moonraker API üzerinden yoklar, her yazıcı için sistem tepsisinde
// yüzde gösteren dinamik bir ikon tutar.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const I18N = require('./renderer/i18n.js');

const POLL_MS = 2000;
const DEFAULT_CONFIG = {
  printers: [], // ilk açılışta Ayarlar'dan eklenir
  trayPerPrinter: true,
  notifications: true,
  startMinimized: false,
};

let win = null;
let trays = {};          // printerId -> Tray
let mainTray = null;     // trayPerPrinter=false iken tek tepsi
let config = null;
let states = {};         // printerId -> son durum
let metaCache = {};      // host|filename -> metadata
let quitting = false;
let startHidden = false;

const cfgPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    return { ...DEFAULT_CONFIG, ...c };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(config, null, 2));
}

// ---------------- Moonraker ----------------
async function api(host, pathName, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 4000);
  try {
    const r = await fetch(`http://${host}:7125${pathName}`, { method: opts.method || 'GET', signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

const QUERY_OBJECTS = [
  'print_stats', 'display_status', 'virtual_sdcard', 'heater_bed', 'extruder', 'extruder1', 'extruder2', 'extruder3',
  'toolhead', 'fan', 'webhooks', 'idle_timeout', 'gcode_move', 'print_task_config', 'pause_resume',
  'temperature_sensor cavity', 'led cavity_led', 'fan_generic cavity_fan', 'system_stats', 'motion_report',
  'filament_feed left', 'filament_feed right', 'machine_state_manager',
  'filament_motion_sensor e0_filament', 'filament_motion_sensor e1_filament', 'filament_motion_sensor e2_filament', 'filament_motion_sensor e3_filament',
];
const QUERY = '/printer/objects/query?' + QUERY_OBJECTS.map(encodeURIComponent).join('&');

async function getMeta(host, filename) {
  if (!filename) return null;
  const key = host + '|' + filename;
  if (metaCache[key]) return metaCache[key];
  try {
    const m = await api(host, '/server/files/metadata?filename=' + encodeURIComponent(filename));
    metaCache[key] = m;
    return m;
  } catch {
    return null;
  }
}

async function pollPrinter(p) {
  const prev = states[p.id];
  let s;
  try {
    const r = await api(p.host, QUERY);
    const st = r.status;
    const ps = st.print_stats || {};
    const meta = await getMeta(p.host, ps.filename);
    s = { online: true, klippy: st.webhooks?.state || 'unknown', status: st, meta, ts: Date.now() };
  } catch (e) {
    // Klippy kapalı olabilir ama Moonraker açık olabilir
    let klippy = 'offline';
    try {
      const info = await api(p.host, '/server/info', { timeout: 2500 });
      klippy = info.klippy_state || 'offline';
    } catch {}
    s = { online: klippy !== 'offline', klippy, error: String(e.message || e), status: null, meta: null, ts: Date.now() };
  }
  states[p.id] = s;
  handleTransitions(p, prev, s);
  return s;
}

function stateOf(s) {
  if (!s || !s.online) return 'offline';
  if (s.klippy !== 'ready') return 'error';
  return s.status?.print_stats?.state || 'standby';
}

function progressOf(s) {
  const st = s?.status;
  if (!st) return 0;
  // Snapmaker: virtual_sdcard.progress dosya pozisyonu tabanlı, display_status M73 tabanlı
  const d = st.display_status?.progress;
  const v = st.virtual_sdcard?.progress;
  const p = (typeof d === 'number' && d > 0) ? d : (v || 0);
  return Math.max(0, Math.min(1, p));
}

// Dil: config.language ('auto' → sistem dili)
let L = I18N.make('en');
const t = (k, v) => L.t(k, v);
function applyLanguage() { L = I18N.make(I18N.resolve(config.language, app.getLocale())); }
const stateName = (st) => t('state.' + st);

function handleTransitions(p, prev, s) {
  if (!config.notifications || !prev) return;
  const a = stateOf(prev), b = stateOf(s);
  if (a === b) return;
  const file = s.status?.print_stats?.filename || prev.status?.print_stats?.filename || '';
  let title = null, body = file;
  if (b === 'complete' && a === 'printing') title = t('n.complete', { name: p.name });
  else if (b === 'error') title = t('n.error', { name: p.name }), body = s.status?.print_stats?.message || s.error || file;
  else if (b === 'paused') title = t('n.paused', { name: p.name });
  else if (b === 'cancelled') title = t('n.cancelled', { name: p.name });
  else if (b === 'offline') title = t('n.offline', { name: p.name }), body = p.host;
  else if (b === 'printing' && (a === 'standby' || a === 'complete' || a === 'cancelled')) title = t('n.started', { name: p.name });
  if (title && Notification.isSupported()) {
    const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') });
    n.on('click', showWindow);
    n.show();
  }
}

async function pollAll() {
  await Promise.all(config.printers.map(pollPrinter));
  if (win && !win.isDestroyed()) win.webContents.send('states', states);
  updateTrays();
}

// ---------------- Tepsi ikonları ----------------
// İkonlar renderer'daki canvas ile çiziliyor (yüzde rakamı + halka) ve buraya data URL olarak geliyor.
let trayImages = {}; // id -> dataURL

function trayTooltip(p) {
  const s = states[p.id];
  const st = stateOf(s);
  let t = `${p.name} — ${stateName(st)}`;
  if (st === 'printing' || st === 'paused') {
    t += ' ' + L.t('pct', { n: Math.floor(progressOf(s) * 100) });
    const eta = etaSeconds(s);
    if (eta != null) t += '\n' + L.t('tray.remaining', { d: fmtDur(eta) });
    const fn = s.status.print_stats.filename || '';
    if (fn) t += `\n${fn.replace(/\.gcode$/i, '')}`;
  }
  return t.slice(0, 127);
}

function etaSeconds(s) {
  const st = s?.status;
  if (!st) return null;
  const prog = progressOf(s);
  const dur = st.print_stats?.print_duration || 0;
  const est = s.meta?.estimated_time;
  let byFile = (prog > 0.02 && dur > 60) ? dur / prog - dur : null;
  let bySlicer = est ? Math.max(0, est * (1 - prog)) : null;
  if (byFile != null && bySlicer != null) {
    const w = Math.min(1, prog * 2); // ilerledikçe gerçek süreye daha çok güven
    return byFile * w + bySlicer * (1 - w);
  }
  return byFile ?? bySlicer;
}
const fmtDur = (sec) => L.fmtDur(sec, true);

function buildMenu() {
  const items = config.printers.map((p) => {
    const s = states[p.id];
    const st = stateOf(s);
    const pct = (st === 'printing' || st === 'paused') ? ' — ' + t('pct', { n: Math.floor(progressOf(s) * 100) }) : '';
    return { label: `${p.name}: ${stateName(st)}${pct}`, click: showWindow };
  });
  return Menu.buildFromTemplate([
    { label: 'U1 Farm Control', enabled: false },
    { type: 'separator' },
    ...items,
    { type: 'separator' },
    { label: t('menu.open'), click: showWindow },
    ...config.printers.map((p) => ({ label: t('menu.web', { name: p.name }), click: () => shell.openExternal(`http://${p.host}`) })),
    { type: 'separator' },
    { label: t('menu.quit'), click: () => { quitting = true; app.quit(); } },
  ]);
}

function blankIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
}

function ensureTrays() {
  const want = config.trayPerPrinter && config.printers.length ? config.printers.map((p) => p.id) : ['__main'];
  for (const id of Object.keys(trays)) {
    if (!want.includes(id)) { trays[id].destroy(); delete trays[id]; }
  }
  for (const id of want) {
    if (!trays[id]) {
      const t = new Tray(blankIcon());
      t.on('click', showWindow);
      t.on('double-click', showWindow);
      trays[id] = t;
    }
  }
}

function updateTrays() {
  ensureTrays();
  const menu = buildMenu();
  if (config.trayPerPrinter && config.printers.length) {
    for (const p of config.printers) {
      const t = trays[p.id];
      if (!t) continue;
      t.setToolTip(trayTooltip(p));
      t.setContextMenu(menu);
      const img = trayImages[p.id];
      if (img) t.setImage(nativeImage.createFromDataURL(img));
    }
  } else {
    const t = trays.__main;
    t.setToolTip(config.printers.length ? config.printers.map(trayTooltip).join('\n').slice(0, 127) : t('tray.noPrinters'));
    t.setContextMenu(menu);
    if (trayImages.__main) t.setImage(nativeImage.createFromDataURL(trayImages.__main));
  }
}

// ---------------- Pencere ----------------
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'U1 Farm Control',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: !(config.startMinimized || startHidden),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Alta alınınca tepsiye küçül
  win.on('minimize', (e) => { e.preventDefault(); win.hide(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------------- Kamera ----------------
// Stok U1 firmware'inde kamera kendiliğinden yayın yapmaz; Moonraker websocket'ine
// camera.start_monitor gönderilince /server/files/camera/monitor.jpg dosyasını güncellemeye başlar.
function wakeCamera(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, info) => { if (done) return; done = true; try { ws.close(); } catch {} resolve({ ok, info }); };
    const ws = new WebSocket(`ws://${host}:7125/websocket`, { handshakeTimeout: 4000 });
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'camera.start_monitor', params: { domain: 'lan', interval: 0 }, id: 4242 })));
    ws.on('message', (data) => {
      try {
        const j = JSON.parse(data.toString());
        if (j.id === 4242) finish(!j.error, j.result || j.error);
      } catch {}
    });
    ws.on('error', (e) => finish(false, String(e.message || e)));
    setTimeout(() => finish(false, t('err.timeout')), 6000);
  });
}
ipcMain.handle('camera:wake', (_e, id) => {
  const p = config.printers.find((x) => x.id === id);
  return p ? wakeCamera(p.host) : { ok: false, info: t('err.notFound') };
});

// ---------------- IPC ----------------
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e, c) => {
  config = { ...config, ...c };
  saveConfig();
  applyLanguage();
  metaCache = {};
  for (const id of Object.keys(states)) if (!config.printers.find((p) => p.id === id)) delete states[id];
  pollAll();
  return config;
});
ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('autostart:set', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.on('tray:images', (_e, imgs) => { trayImages = imgs; updateTrays(); });
ipcMain.handle('open:external', (_e, url) => shell.openExternal(url));

ipcMain.handle('printer:action', async (_e, { id, action, value }) => {
  const p = config.printers.find((x) => x.id === id);
  if (!p) throw new Error(t('err.notFound'));
  const gcode = (script) => api(p.host, '/printer/gcode/script?script=' + encodeURIComponent(script), { method: 'POST', timeout: 15000 });
  switch (action) {
    case 'pause': return api(p.host, '/printer/print/pause', { method: 'POST', timeout: 15000 });
    case 'resume': return api(p.host, '/printer/print/resume', { method: 'POST', timeout: 15000 });
    case 'cancel': return api(p.host, '/printer/print/cancel', { method: 'POST', timeout: 15000 });
    case 'estop': return api(p.host, '/printer/emergency_stop', { method: 'POST' });
    case 'firmware_restart': return api(p.host, '/printer/firmware_restart', { method: 'POST' });
    case 'light': return gcode(`SET_LED LED=cavity_led RED=${value ? 1 : 0} GREEN=${value ? 1 : 0} BLUE=${value ? 1 : 0} WHITE=${value ? 1 : 0}`);
    case 'speed': return gcode(`M220 S${Math.round(value)}`);
    case 'flow': return gcode(`M221 S${Math.round(value)}`);
    case 'fan': return gcode(`M106 S${Math.round(value * 255 / 100)}`);
    case 'bed': return gcode(`SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${Math.round(value)}`);
    case 'nozzle': return gcode(`SET_HEATER_TEMPERATURE HEATER=${value.heater} TARGET=${Math.round(value.target)}`);
    case 'unload': {
      // Dokunmatik ekranın kullandığı akış: ısıt → AUTO_FEEDING UNLOAD prepare/doing → ısıtıcıyı kapat
      const list = Array.isArray(value) ? value : [value];
      const st = await api(p.host, '/printer/objects/query?print_stats&toolhead');
      const ps = st.status.print_stats?.state;
      if (ps === 'printing' || ps === 'paused') throw new Error(t('err.unloadPrinting'));
      const lines = [];
      if ((st.status.toolhead?.homed_axes || '') !== 'xyz') lines.push('G28');
      lines.push('AUTO_FEEDING_BATCH ACTION=START');
      for (const i of list) {
        const n = Number(i);
        if (!(n >= 0 && n <= 3)) throw new Error(t('err.badHead'));
        lines.push(`AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=${n} UNLOAD=1 STAGE=prepare`);
        lines.push(`AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=${n} UNLOAD=1 STAGE=doing`);
      }
      lines.push('AUTO_FEEDING_BATCH');
      return api(p.host, '/printer/gcode/script?script=' + encodeURIComponent(lines.join('\n')), { method: 'POST', timeout: 15 * 60 * 1000 });
    }
    case 'cooldown': return gcode('TURN_OFF_HEATERS');
    case 'gcode': return gcode(String(value));
    case 'history': return api(p.host, '/server/history/list?limit=15&order=desc');
    case 'files': return api(p.host, '/server/files/list?root=gcodes');
    case 'start': return api(p.host, '/printer/print/start?filename=' + encodeURIComponent(value), { method: 'POST', timeout: 15000 });
    default: throw new Error(t('err.unknown', { a: action }));
  }
});

// ---------------- Başlat ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId('com.u1farm.control');
  app.whenReady().then(() => {
    config = loadConfig();
    applyLanguage();
    startHidden = process.argv.includes('--hidden');
    createWindow();
    ensureTrays();
    pollAll();
    setInterval(pollAll, POLL_MS);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', (e) => e.preventDefault?.());
}

