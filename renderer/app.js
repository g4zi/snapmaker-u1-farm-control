// U1 Farm Control — arayüz
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let config = null;
let states = {};
const cards = {}; // id -> element
const camOn = {}; // id -> bool (kamera açık mı) — localStorage'da saklanır
const camCtl = {}; // id -> { frameTimer, wakeTimer, busy, lastWake }
function camPref(id) {
  try { const v = localStorage.getItem('cam:' + id); return v == null ? true : v === '1'; } catch { return true; }
}
function setCamPref(id, on) { try { localStorage.setItem('cam:' + id, on ? '1' : '0'); } catch {} }

// Dil: config.language ('auto' veya kod) → I18N (renderer/i18n.js)
let L = I18N.make('en');
const t = (k, v) => L.t(k, v);
const stateName = (st) => t('state.' + st);
const pctText = (n) => t('pct', { n });
const STATE_COLOR = {
  printing: '#3fb950', paused: '#f0a500', complete: '#58a6ff', cancelled: '#a5b4c3',
  error: '#f85149', standby: '#a5b4c3', offline: '#6e7681',
};

// ---------------- yardımcılar ----------------
function stateOf(s) {
  if (!s || !s.online) return 'offline';
  if (s.klippy !== 'ready') return 'error';
  return s.status?.print_stats?.state || 'standby';
}
function progressOf(s) {
  const st = s?.status;
  if (!st) return 0;
  const d = st.display_status?.progress;
  const v = st.virtual_sdcard?.progress;
  const p = (typeof d === 'number' && d > 0) ? d : (v || 0);
  return Math.max(0, Math.min(1, p));
}
function etaSeconds(s) {
  const st = s?.status;
  if (!st) return null;
  const prog = progressOf(s);
  const dur = st.print_stats?.print_duration || 0;
  const est = s.meta?.estimated_time;
  const byFile = (prog > 0.02 && dur > 60) ? dur / prog - dur : null;
  const bySlicer = est ? Math.max(0, est * (1 - prog)) : null;
  if (byFile != null && bySlicer != null) {
    const w = Math.min(1, prog * 2);
    return byFile * w + bySlicer * (1 - w);
  }
  return byFile ?? bySlicer;
}
const fmtDur = (sec) => L.fmtDur(sec);
function fmtClock(sec) {
  if (sec == null) return '—';
  const d = new Date(Date.now() + sec * 1000);
  const today = new Date();
  const t = d.toLocaleTimeString(L.locale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return t;
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return L.t('tomorrow', { t });
  return d.toLocaleDateString(L.locale, { day: '2-digit', month: 'short' }) + ' ' + t;
}
const t0 = (v) => (v == null ? '—' : Math.round(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanName = (f) => (f || '').replace(/\.gcode$/i, '');

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 2600);
}

async function act(id, action, value, okMsg) {
  try {
    const r = await window.farm.action(id, action, value);
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(t('error.prefix', { msg: (e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }), true);
    throw e;
  }
}

function confirmBox(title, text) {
  return new Promise((res) => {
    const d = $('#confirm');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    d.returnValue = '';
    d.showModal();
    d.addEventListener('close', () => res(d.returnValue === 'yes'), { once: true });
  });
}

function argbToCss(rgba) {
  if (!rgba) return '#888';
  return '#' + String(rgba).slice(0, 6);
}

// ---------------- kart oluşturma ----------------
function buildCard(p) {
  const el = document.createElement('section');
  el.className = 'card';
  el.innerHTML = `
    <div class="card-head">
      <span class="dot" data-f="dot"></span>
      <div class="title">
        <h2>${esc(p.name)}</h2>
        <div class="host">${esc(p.host)}</div>
      </div>
      <span class="badge" data-f="badge">—</span>
      <button class="btn ghost small" data-a="files" title="${t('tip.files')}">${t('btn.files')}</button>
      <button class="btn ghost small" data-a="web" title="${t('tip.web')}">${t('btn.web')}</button>
    </div>
    <div data-f="online">
      <div class="card-body">
        <div>
          <div class="cam" data-f="cam">
            <img class="thumb" data-f="thumb" alt="" hidden />
            <img class="stream" data-f="stream" alt="" hidden />
            <span class="cam-msg" data-f="cammsg">${t('cam.off')}</span>
            <div class="cam-tools">
              <button class="btn small" data-a="cam" title="${t('tip.cam')}">📷</button>
              <button class="btn small" data-a="full" title="${t('tip.full')}">⛶</button>
            </div>
          </div>
        </div>
        <div>
          <div class="progress-wrap">
            <div class="ring">
              <svg width="128" height="128" viewBox="0 0 128 128">
                <circle cx="64" cy="64" r="54" stroke="#0b0f14" stroke-width="12" fill="none"/>
                <circle data-f="arc" cx="64" cy="64" r="54" stroke="#ff7a18" stroke-width="12" fill="none" stroke-linecap="round"
                  stroke-dasharray="339.3" stroke-dashoffset="339.3" style="transition: stroke-dashoffset .6s, stroke .3s"/>
              </svg>
              <div class="pct"><b data-f="pct">0%</b><span data-f="pctsub">—</span></div>
            </div>
            <div class="file">
              <div class="fname" data-f="fname">${t('job.none')}</div>
              <div class="fsub" data-f="fsub"></div>
              <div class="bar"><i data-f="bar"></i></div>
            </div>
          </div>
          <div class="stats">
            <div class="stat"><div class="k">${t('stat.remain')}</div><div class="v" data-f="remain">—</div></div>
            <div class="stat"><div class="k">${t('stat.eta')}</div><div class="v" data-f="eta">—</div></div>
            <div class="stat"><div class="k">${t('stat.elapsed')}</div><div class="v" data-f="elapsed">—</div></div>
            <div class="stat"><div class="k">${t('stat.layer')}</div><div class="v" data-f="layer">—</div></div>
            <div class="stat"><div class="k">${t('stat.fil')}</div><div class="v" data-f="fil">—</div></div>
            <div class="stat"><div class="k">${t('stat.speed')}</div><div class="v" data-f="speedv">—</div></div>
          </div>
        </div>
      </div>
      <div style="padding: 0 16px">
        <div class="section-title"><span>${t('sec.heads')}</span><span data-f="headinfo"></span></div>
        <div class="heads" data-f="heads"></div>
        <div class="section-title"><span>${t('sec.fil')}</span><span data-f="filinfo"></span></div>
        <div class="fils" data-f="fils"></div>
        <div class="fil-actions">
          <button class="btn small" data-a="unloadsel" title="${t('fil.unloadSelTip')}">${t('fil.unloadSel')}</button>
          <button class="btn small" data-a="unloadall" title="${t('fil.unloadAllTip')}">${t('fil.unloadAll')}</button>
        </div>
        <div class="section-title"><span>${t('sec.env')}</span><span data-f="sys"></span></div>
        <div class="temps">
          <div class="temp" data-a="bed" title="${t('env.bedTip')}"><div class="k">${t('env.bed')}</div><div class="v" data-f="bed">—</div></div>
          <div class="temp"><div class="k">${t('env.chamber')}</div><div class="v" data-f="cavity">—</div></div>
          <div class="temp"><div class="k">${t('env.fan')}</div><div class="v" data-f="fanv">—</div></div>
        </div>
      </div>
      <div class="section-title" style="padding: 0 16px; margin-top: 16px"><span>${t('sec.adjust')}</span></div>
      <div class="sliders">
        <div class="slider"><div class="k"><span>${t('sl.speed')}</span><b data-f="spd">100%</b></div><input type="range" min="50" max="200" step="5" value="100" data-s="speed"></div>
        <div class="slider"><div class="k"><span>${t('sl.flow')}</span><b data-f="flw">100%</b></div><input type="range" min="75" max="125" step="1" value="100" data-s="flow"></div>
        <div class="slider"><div class="k"><span>${t('sl.fan')}</span><b data-f="fanp">0%</b></div><input type="range" min="0" max="100" step="5" value="0" data-s="fan"></div>
      </div>
      <div class="controls">
        <button class="btn warn" data-a="pause">${t('ctl.pause')}</button>
        <button class="btn good" data-a="resume">${t('ctl.resume')}</button>
        <button class="btn danger" data-a="cancel">${t('ctl.cancel')}</button>
        <button class="btn" data-a="light">${t('ctl.light')}</button>
        <button class="btn" data-a="cooldown">${t('ctl.cool')}</button>
        <span class="spacer"></span>
        <button class="btn danger" data-a="estop" title="${t('ctl.estopTip')}">${t('ctl.estop')}</button>
      </div>
    </div>
    <div class="offline-box" data-f="offline" hidden>
      <b>${t('off.title')}</b>
      <span data-f="offmsg"></span>
      <div style="margin-top: 14px"><button class="btn small" data-a="frestart">${t('off.restart')}</button></div>
    </div>`;

  // ---- olaylar ----
  const f = (n) => $(`[data-f="${n}"]`, el);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    const s = states[p.id];
    if (a === 'web') return window.farm.openExternal(`http://${p.host}`);
    if (a === 'files') return openFiles(p);
    if (a === 'cam') { camOn[p.id] = !camOn[p.id]; setCamPref(p.id, camOn[p.id]); return updateCam(p, el, s); }
    if (a === 'full') { f('cam').classList.toggle('fullscreen'); return; }
    if (a === 'pause') return act(p.id, 'pause', null, t('toast.pausing'));
    if (a === 'resume') return act(p.id, 'resume', null, t('toast.resuming'));
    if (a === 'cancel') {
      if (await confirmBox(t('cf.cancelTitle'), `${p.name}: ${cleanName(s?.status?.print_stats?.filename)}`)) act(p.id, 'cancel', null, t('toast.cancelling'));
      return;
    }
    if (a === 'estop') {
      if (await confirmBox(t('cf.estopTitle'), t('cf.estopText', { name: p.name }))) act(p.id, 'estop', null, t('toast.estop'));
      return;
    }
    if (a === 'unload' || a === 'unloadall' || a === 'unloadsel') {
      let list;
      if (a === 'unload') list = [Number(b.dataset.i)];
      else if (a === 'unloadall') list = [0, 1, 2, 3].filter((i) => filLoaded(s, i) !== false);
      else list = $$('.fil input[type=checkbox]:checked', el).map((c) => Number(c.dataset.i));
      if (!list.length) return toast(a === 'unloadsel' ? t('fil.selectFirst') : t('fil.nothing'), true);
      const names = list.map((i) => `T${i} (${filName(s, i)})`).join(', ');
      if (!(await confirmBox(t('fil.confirmTitle'), t('fil.confirmText', { name: p.name, list: names })))) return;
      unloading[p.id] = new Set(list);
      updateCard(p, el, states[p.id]);
      toast(t('fil.started', { list: list.map((i) => 'T' + i).join(', ') }));
      try {
        await act(p.id, 'unload', list);
        toast(t('fil.doneToast', { name: p.name }));
        $$('.fil input[type=checkbox]', el).forEach((c) => (c.checked = false));
      } catch {} finally {
        delete unloading[p.id];
        updateCard(p, el, states[p.id]);
      }
      return;
    }
    if (a === 'frestart') return act(p.id, 'firmware_restart', null, t('toast.restarting'));
    if (a === 'light') {
      const on = isLightOn(s);
      return act(p.id, 'light', !on, on ? t('toast.lightOff') : t('toast.lightOn'));
    }
    if (a === 'cooldown') {
      if (await confirmBox(t('cf.coolTitle'), t('cf.coolText'))) act(p.id, 'cooldown', null, t('toast.heatersOff'));
      return;
    }
    if (a === 'bed') {
      const v = await prompt2(t('pr.bed'), s?.status?.heater_bed?.target ?? 0);
      if (v != null) act(p.id, 'bed', v, `${t('env.bed')} → ${v}°C`);
      return;
    }
    if (a === 'head') {
      const heater = b.dataset.h;
      const v = await prompt2(t('pr.head', { i: b.dataset.i }), s?.status?.[heater]?.target ?? 0);
      if (v != null) act(p.id, 'nozzle', { heater, target: v }, `T${b.dataset.i} → ${v}°C`);
    }
  });
  // sürgüler: sürüklerken değer göster, bırakınca gönder
  $$('input[type=range]', el).forEach((r) => {
    const label = { speed: 'spd', flow: 'flw', fan: 'fanp' }[r.dataset.s];
    r.addEventListener('input', () => { r._dragging = true; f(label).textContent = r.value + '%'; });
    r.addEventListener('change', async () => {
      try { await act(p.id, r.dataset.s, +r.value, `${t('sl.' + r.dataset.s)} → ${pctText(r.value)}`); }
      finally { setTimeout(() => (r._dragging = false), 2500); }
    });
  });
  camOn[p.id] = camPref(p.id);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') f('cam').classList.remove('fullscreen'); });
  return el;
}

// Küçük sayı giriş penceresi (Electron'da window.prompt yok)
function prompt2(label, def) {
  return new Promise((res) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog" class="dlg small"><h2>${esc(label)}</h2>
      <input class="input" type="number" min="0" max="350" value="${esc(def)}" autofocus />
      <div class="dlg-actions"><button class="btn ghost" value="no">${t('cancel')}</button><button class="btn primary" value="yes">${t('pr.set')}</button></div></form>`;
    document.body.appendChild(d);
    d.showModal();
    d.addEventListener('close', () => {
      const v = d.returnValue === 'yes' ? Number($('input', d).value) : null;
      d.remove();
      res(v != null && !isNaN(v) ? v : null);
    });
  });
}

const unloading = {}; // id -> Set(kafa index) — işlem sürerken
const FEED_MAP = [['left', 'extruder0'], ['left', 'extruder1'], ['right', 'extruder2'], ['right', 'extruder3']];
const CH_KEY = {
  load_finish: 'loaded', loading: 'loading', unloading: 'unloading', unload_finish: 'unloaded',
  idle: 'empty', none: 'empty', preload: 'preload', preload_finish: 'preloaded', runout: 'runout',
};
const chText = (state) => (CH_KEY[state] ? t('fil.st.' + CH_KEY[state]) : null);
function feedCh(s, i) {
  const [mod, key] = FEED_MAP[i];
  return s?.status?.['filament_feed ' + mod]?.[key];
}
function filLoaded(s, i) {
  const sen = s?.status?.[`filament_motion_sensor e${i}_filament`];
  const ch = feedCh(s, i);
  if (sen && sen.filament_detected === false && (!ch || !ch.filament_detected)) return false;
  if (sen?.filament_detected || ch?.filament_detected) return true;
  return null;
}
function filName(s, i) {
  const c = s?.status?.print_task_config || {};
  return `${c.filament_vendor?.[i] || ''} ${c.filament_type?.[i] || ''}${c.filament_sub_type?.[i] ? ' ' + c.filament_sub_type[i] : ''}`.trim() || '—';
}

function isLightOn(s) {
  const c = s?.status?.['led cavity_led']?.color_data?.[0];
  return !!c && c.some((x) => x > 0.01);
}

// Kamera: stok U1'de camera.start_monitor ile uyandırılır, kareler monitor.jpg olarak gelir.
const CAM_FRAME_MS = 1000;
const CAM_WAKE_MS = 8000;
function camStart(p, el) {
  const c = camCtl[p.id] || (camCtl[p.id] = {});
  if (c.frameTimer) return;
  const f = (n) => $(`[data-f="${n}"]`, el);
  f('cammsg').textContent = t('cam.waking');
  const wake = async () => {
    c.lastWake = Date.now();
    const r = await window.farm.wakeCamera(p.id);
    if (!r.ok && !c.gotFrame) f('cammsg').textContent = t('cam.failed', { msg: r.info?.message || r.info || '' });
  };
  wake();
  c.wakeTimer = setInterval(wake, CAM_WAKE_MS);
  c.fails = 0;
  c.frameTimer = setInterval(() => {
    if (c.busy || document.hidden) return;
    c.busy = true;
    const url = `http://${p.host}:7125/server/files/camera/monitor.jpg?t=${Date.now()}`;
    const img = new Image();
    img.onload = () => {
      c.busy = false; c.fails = 0; c.gotFrame = true;
      if (!camOn[p.id]) return;
      const st = f('stream');
      st.src = url; // önbellekte, titreme olmaz
      st.hidden = false;
      f('thumb').hidden = true;
      f('cammsg').innerHTML = `<span class="live">●</span> ${t('cam.live')} · ` + new Date().toLocaleTimeString(L.locale);
    };
    img.onerror = () => {
      c.busy = false; c.fails++;
      if (c.fails >= 3) {
        f('cammsg').textContent = t('cam.waiting');
        if (Date.now() - (c.lastWake || 0) > 3000) wake();
        c.fails = 0;
      }
    };
    img.src = url;
  }, CAM_FRAME_MS);
}
function camStop(p, el) {
  const c = camCtl[p.id];
  if (c) { clearInterval(c.frameTimer); clearInterval(c.wakeTimer); delete camCtl[p.id]; }
  const f = (n) => $(`[data-f="${n}"]`, el);
  f('stream').removeAttribute('src');
  f('stream').hidden = true;
  f('cammsg').textContent = t('cam.off');
}

function updateCam(p, el, s) {
  const f = (n) => $(`[data-f="${n}"]`, el);
  const stream = f('stream');
  const want = !!camOn[p.id] && stateOf(s) !== 'offline';
  $('[data-a="cam"]', el).classList.toggle('on', !!camOn[p.id]);
  if (want) camStart(p, el); else if (camCtl[p.id] || stream.src) camStop(p, el);
  // önizleme resmi
  const thumbs = s?.meta?.thumbnails;
  const thumb = f('thumb');
  if (thumbs?.length) {
    const best = [...thumbs].sort((a, b) => b.width - a.width)[0];
    const fn = s.status?.print_stats?.filename || '';
    const dir = fn.includes('/') ? fn.slice(0, fn.lastIndexOf('/') + 1) : '';
    const url = `http://${p.host}:7125/server/files/gcodes/${encodeURI(dir + best.relative_path)}`;
    if (thumb.dataset.url !== url) { thumb.src = url; thumb.dataset.url = url; }
    thumb.hidden = !stream.hidden;
  } else {
    thumb.hidden = true;
    thumb.dataset.url = '';
  }
}

// ---------------- kart güncelleme ----------------
function updateCard(p, el, s) {
  const f = (n) => $(`[data-f="${n}"]`, el);
  const st = stateOf(s);
  el.dataset.state = st;
  f('dot').className = 'dot ' + st;
  f('badge').className = 'badge ' + st;
  f('badge').textContent = stateName(st);

  const offline = st === 'offline' || (st === 'error' && !s?.status);
  f('online').hidden = offline;
  f('offline').hidden = !offline;
  if (offline) {
    if (camCtl[p.id]) camStop(p, el);
    f('offmsg').textContent = st === 'offline'
      ? t('off.msg', { host: p.host })
      : t('off.klippy', { s: s?.klippy, e: s?.error || '' });
    return;
  }

  const S = s.status;
  const ps = S.print_stats || {};
  const active = st === 'printing' || st === 'paused';
  const prog = progressOf(s);
  const pct = Math.floor(prog * 100);
  const hasJob = !!ps.filename && st !== 'standby';

  // ilerleme
  f('pct').textContent = hasJob ? pct + '%' : '—';
  f('pctsub').textContent = stateName(st);
  f('arc').setAttribute('stroke-dashoffset', String(339.3 * (1 - (hasJob ? prog : 0))));
  f('arc').setAttribute('stroke', STATE_COLOR[st] || '#ff7a18');
  f('bar').style.width = (hasJob ? prog * 100 : 0) + '%';
  f('fname').textContent = hasJob ? cleanName(ps.filename) : t('job.none');
  const meta = s.meta;
  const subs = [];
  if (hasJob && meta) {
    if (meta.slicer) subs.push(`${meta.slicer} ${meta.slicer_version || ''}`.trim());
    if (meta.layer_height) subs.push(t('job.layer', { h: meta.layer_height }));
    if (meta.filament_weight_total) subs.push(`${meta.filament_weight_total.toFixed(0)} g`);
    if (meta.estimated_time) subs.push(t('job.est', { d: fmtDur(meta.estimated_time) }));
  }
  if (ps.message) subs.push('⚠ ' + ps.message);
  if (!hasJob && st === 'standby') subs.push(t('job.idle'));
  f('fsub').textContent = subs.join(' · ');

  const eta = active ? etaSeconds(s) : null;
  f('remain').textContent = active ? fmtDur(eta) : (st === 'complete' ? t('done') : '—');
  f('eta').textContent = active ? fmtClock(eta) : '—';
  f('elapsed').textContent = hasJob ? fmtDur(ps.total_duration) : '—';
  const L = ps.info || {};
  f('layer').textContent = hasJob && L.total_layer ? `${L.current_layer ?? 0} / ${L.total_layer}` : '—';
  f('fil').textContent = hasJob ? (ps.filament_used / 1000).toFixed(2) + ' m' : '—';
  const vel = S.motion_report?.live_velocity;
  f('speedv').textContent = active && vel != null ? `${Math.round(vel)} mm/s` : '—';

  // kafalar
  const ptc = S.print_task_config || {};
  const activeExt = S.toolhead?.extruder;
  const heads = ['extruder', 'extruder1', 'extruder2', 'extruder3'];
  const headsEl = f('heads');
  if (!headsEl.children.length) {
    headsEl.innerHTML = heads.map((h, i) => `
      <div class="head" data-a="head" data-h="${h}" data-i="${i}" data-badge="${t('head.badge')}" title="${t('head.tip', { i })}">
        <div class="spool"><span class="sw"></span><span class="tn">T${i}</span></div>
        <div class="ft"></div>
        <div class="tt"></div>
        <div class="heat"><i></i></div>
      </div>`).join('');
  }
  heads.forEach((h, i) => {
    const he = headsEl.children[i];
    const e = S[h] || {};
    he.classList.toggle('active', active && activeExt === h);
    $('.sw', he).style.background = argbToCss(ptc.filament_color_rgba?.[i]);
    const exist = ptc.filament_exist?.[i];
    $('.ft', he).textContent = exist === false ? t('fil.none') : `${ptc.filament_vendor?.[i] || ''} ${ptc.filament_type?.[i] || ''}${ptc.filament_sub_type?.[i] ? ' ' + ptc.filament_sub_type[i] : ''}`.trim();
    $('.tt', he).innerHTML = `${t0(e.temperature)}°<small> / ${t0(e.target)}°</small>`;
    $('.heat i', he).style.width = Math.round((e.power || 0) * 100) + '%';
  });
  f('headinfo').textContent = activeExt ? t('head.active', { i: heads.indexOf(activeExt) }) : '';

  // filament
  const filsEl = f('fils');
  if (!filsEl.children.length) {
    filsEl.innerHTML = [0, 1, 2, 3].map((i) => `
      <div class="fil">
        <label class="fil-sel"><input type="checkbox" data-i="${i}" /></label>
        <span class="sw"></span>
        <div class="fil-name"><b>T${i}</b> <span class="fn"></span></div>
        <div class="fil-state"><span class="dot"></span><span class="fs"></span></div>
        <button class="btn small" data-a="unload" data-i="${i}">${t('fil.unload')}</button>
      </div>`).join('');
  }
  const busySet = unloading[p.id];
  [0, 1, 2, 3].forEach((i) => {
    const row = filsEl.children[i];
    const ch = feedCh(s, i);
    const loaded = filLoaded(s, i);
    $('.sw', row).style.background = loaded === false ? 'transparent' : argbToCss(ptc.filament_color_rgba?.[i]);
    $('.sw', row).style.borderStyle = loaded === false ? 'dashed' : 'solid';
    $('.fn', row).textContent = loaded === false ? t('fil.none') : filName(s, i);
    let txt, cls;
    if (busySet?.has(i)) { txt = t('fil.st.unloading'); cls = 'paused'; }
    else if (ch?.channel_error && ch.channel_error !== 'ok') { txt = t('fil.st.error', { e: ch.channel_error }); cls = 'error'; }
    else if (loaded === false) { txt = t('fil.st.empty'); cls = 'offline'; }
    else { txt = chText(ch?.channel_state) || (ch?.channel_state ? ch.channel_state.replace(/_/g, ' ') : (loaded ? t('fil.st.loaded') : '?')); cls = loaded ? 'printing' : 'standby'; }
    $('.fs', row).textContent = txt;
    $('.dot', row).className = 'dot ' + cls;
    $('[data-a="unload"]', row).disabled = active || !!busySet || loaded === false;
    $('input', row).disabled = active || !!busySet || loaded === false;
  });
  const loadedCount = [0, 1, 2, 3].filter((i) => filLoaded(s, i) !== false).length;
  f('filinfo').textContent = busySet ? t('fil.busy') : active ? t('fil.locked') : t('fil.loadedCount', { n: loadedCount });
  $('[data-a="unloadall"]', el).disabled = active || !!busySet || !loadedCount;
  $('[data-a="unloadsel"]', el).disabled = active || !!busySet;

  const bed = S.heater_bed || {};
  f('bed').innerHTML = `${t0(bed.temperature)}°<small> / ${t0(bed.target)}°</small>`;
  const cav = S['temperature_sensor cavity'];
  f('cavity').innerHTML = cav ? `${t0(cav.temperature)}°<small> ${t('env.max', { t: t0(cav.measured_max_temp) })}</small>` : '—';
  const fanPct = Math.round((S.fan?.speed || 0) * 100);
  f('fanv').textContent = pctText(fanPct);
  const sys = S.system_stats;
  f('sys').textContent = sys ? t('sys.info', { l: Math.round((sys.sysload || 0) * 100) / 100, m: Math.round((sys.memavail || 0) / 1024) }) : '';

  // sürgüler (kullanıcı oynamıyorsa senkronla)
  const gm = S.gcode_move || {};
  const syncSlider = (name, val, label) => {
    const r = $(`input[data-s="${name}"]`, el);
    if (!r._dragging) { r.value = val; f(label).textContent = val + '%'; }
  };
  syncSlider('speed', Math.round((gm.speed_factor || 1) * 100), 'spd');
  syncSlider('flow', Math.round((gm.extrude_factor || 1) * 100), 'flw');
  syncSlider('fan', fanPct, 'fanp');

  // butonlar
  $('[data-a="pause"]', el).disabled = st !== 'printing';
  $('[data-a="resume"]', el).disabled = st !== 'paused';
  $('[data-a="cancel"]', el).disabled = !active;
  $('[data-a="light"]', el).classList.toggle('on', isLightOn(s));
  $$('input[type=range]', el).forEach((r) => (r.disabled = !active && r.dataset.s !== 'fan'));

  updateCam(p, el, s);
}

// ---------------- özet ----------------
function updateSummary() {
  const counts = {};
  let html = '';
  for (const p of config.printers) {
    const s = states[p.id];
    const st = stateOf(s);
    counts[st] = (counts[st] || 0) + 1;
    const pct = (st === 'printing' || st === 'paused') ? ` <b>${pctText(Math.floor(progressOf(s) * 100))}</b>` : '';
    const eta = st === 'printing' ? ` · ${fmtDur(etaSeconds(s))}` : '';
    html += `<span class="chip"><span class="dot ${st}"></span>${esc(p.name)}${pct}<span>${eta}</span></span>`;
  }
  const printing = counts.printing || 0;
  html += `<span class="chip">${t('active')} <b>${printing}/${config.printers.length}</b></span>`;
  $('#summary').innerHTML = html;
  document.title = printing
    ? 'U1 Farm — ' + config.printers.filter((p) => stateOf(states[p.id]) === 'printing').map((p) => pctText(Math.floor(progressOf(states[p.id]) * 100))).join(' · ')
    : 'U1 Farm Control';
}

// ---------------- tepsi ikonu çizimi ----------------
function drawTrayIcon(items) {
  // items: [{st, pct}] — 1 veya 2 yazıcı
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };

  const rows = items.length;
  const h = 32 / rows;
  items.forEach((it, i) => {
    const y = i * h;
    const col = STATE_COLOR[it.st] || '#888';
    // arka plan
    rr(0, y + (rows > 1 ? 0.5 : 0), 32, h - (rows > 1 ? 1 : 0), rows > 1 ? 4 : 7);
    g.fillStyle = '#161b22'; g.fill();
    // ilerleme dolgusu (soldan sağa)
    const showPct = it.st === 'printing' || it.st === 'paused';
    g.save();
    rr(0, y + (rows > 1 ? 0.5 : 0), 32, h - (rows > 1 ? 1 : 0), rows > 1 ? 4 : 7);
    g.clip();
    if (showPct) {
      g.fillStyle = col;
      g.globalAlpha = 0.85;
      if (rows === 1) g.fillRect(0, 32 - 32 * it.pct / 100, 32, 32 * it.pct / 100); // aşağıdan yukarı
      else g.fillRect(0, y, 32 * it.pct / 100, h);
      g.globalAlpha = 1;
    } else {
      g.fillStyle = col; g.globalAlpha = 0.35; g.fillRect(0, y, 32, h); g.globalAlpha = 1;
    }
    g.restore();
    // çerçeve
    rr(1, y + 1, 30, h - 2, rows > 1 ? 4 : 7);
    g.lineWidth = 2; g.strokeStyle = col; g.stroke();

    // metin
    let text;
    if (showPct) text = String(it.pct);
    else text = { complete: '✓', error: '!', offline: '×', cancelled: '–', standby: '•' }[it.st] || '•';
    const big = rows === 1;
    let size = big ? (text.length >= 3 ? 15 : 22) : (text.length >= 3 ? 11 : 14);
    if (!showPct) size = big ? 22 : 14;
    g.font = `900 ${size}px "Segoe UI", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = '#000'; g.lineJoin = 'round';
    const ty = y + h / 2 + 1;
    g.strokeText(text, 16, ty);
    g.fillStyle = '#fff';
    g.fillText(text, 16, ty);
  });
  return c.toDataURL('image/png');
}

let lastTrayKey = '';
function updateTrayIcons() {
  const items = config.printers.map((p) => {
    const s = states[p.id];
    return { id: p.id, st: stateOf(s), pct: Math.floor(progressOf(s) * 100) };
  });
  const key = JSON.stringify(items) + config.trayPerPrinter;
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  const imgs = {};
  if (!items.length) return; // yazıcı yoksa uygulama ikonu kalır
  if (config.trayPerPrinter) for (const it of items) imgs[it.id] = drawTrayIcon([it]);
  else imgs.__main = drawTrayIcon(items.slice(0, 2));
  window.farm.sendTrayImages(imgs);
}

// ---------------- dosyalar / geçmiş ----------------
let filesCtx = null;
async function openFiles(p) {
  filesCtx = { p, tab: 'files', data: null };
  $('#filesTitle').textContent = t('files.title', { name: p.name });
  $('#fileSearch').value = '';
  $$('#files .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'files'));
  $('#files').showModal();
  loadFilesTab();
}
async function loadFilesTab() {
  const { p, tab } = filesCtx;
  const list = $('#filesList');
  list.innerHTML = `<div class="offline-box">${t('files.loading')}</div>`;
  try {
    if (tab === 'files') {
      const r = await act(p.id, 'files');
      filesCtx.data = r.filter((x) => /\.gcode$/i.test(x.path)).sort((a, b) => b.modified - a.modified);
    } else {
      const r = await act(p.id, 'history');
      filesCtx.data = r.jobs || [];
    }
    renderFiles();
  } catch {
    list.innerHTML = `<div class="offline-box">${t('files.failed')}</div>`;
  }
}
function renderFiles() {
  const { p, tab, data } = filesCtx;
  const q = $('#fileSearch').value.toLowerCase();
  const list = $('#filesList');
  const busy = ['printing', 'paused'].includes(stateOf(states[p.id]));
  if (tab === 'files') {
    const rows = data.filter((x) => x.path.toLowerCase().includes(q)).slice(0, 200);
    list.innerHTML = rows.map((x) => {
      const base = x.path.replace(/\.gcode$/i, '');
      const dir = x.path.includes('/') ? x.path.slice(0, x.path.lastIndexOf('/') + 1) : '';
      const name = x.path.slice(dir.length).replace(/\.gcode$/i, '');
      const th = `http://${p.host}:7125/server/files/gcodes/${encodeURI(dir + '.thumbs/' + name + '-48x48.png')}`;
      return `<div class="frow"><img src="${th}" onerror="this.style.visibility='hidden'" />
        <div class="fi"><b title="${esc(x.path)}">${esc(base)}</b><span>${new Date(x.modified * 1000).toLocaleString(L.locale)} · ${(x.size / 1048576).toFixed(1)} MB</span></div>
        <button class="btn small primary" data-print="${esc(x.path)}" ${busy ? `disabled title="${t('files.busy')}"` : ''}>${t('files.print')}</button></div>`;
    }).join('') || `<div class="offline-box">${t('files.empty')}</div>`;
  } else {
    const rows = data.filter((x) => (x.filename || '').toLowerCase().includes(q));
    const ic = { completed: '✅', cancelled: '✖', error: '⛔', in_progress: '▶', klippy_shutdown: '⚠', server_exit: '⚠' };
    list.innerHTML = rows.map((j) => `<div class="frow">
        <div style="font-size:22px;width:48px;text-align:center">${ic[j.status] || '•'}</div>
        <div class="fi"><b>${esc(cleanName(j.filename))}</b>
        <span>${new Date(j.start_time * 1000).toLocaleString(L.locale)} · ${fmtDur(j.print_duration)} · ${((j.filament_used || 0) / 1000).toFixed(2)} m · ${esc(j.status)}</span></div></div>`).join('')
      || `<div class="offline-box">${t('files.histEmpty')}</div>`;
  }
}
$('#filesList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-print]');
  if (!b) return;
  const fn = b.dataset.print;
  if (await confirmBox(t('cf.printTitle'), t('cf.printText', { name: filesCtx.p.name, file: cleanName(fn) }))) {
    await act(filesCtx.p.id, 'start', fn, t('toast.printStarted'));
    $('#files').close();
  }
});
$$('#files .tab').forEach((t) => t.addEventListener('click', () => {
  filesCtx.tab = t.dataset.tab;
  $$('#files .tab').forEach((x) => x.classList.toggle('active', x === t));
  loadFilesTab();
}));
$('#fileSearch').addEventListener('input', () => filesCtx?.data && renderFiles());
$('#filesClose').addEventListener('click', () => $('#files').close());

// ---------------- ayarlar ----------------
function printerRow(p) {
  const d = document.createElement('div');
  d.className = 'prow';
  d.dataset.id = p.id;
  d.innerHTML = `<input class="input" data-k="name" placeholder="${t('set.name')}" value="${esc(p.name)}" />
    <input class="input" data-k="host" placeholder="${t('set.ip')}" value="${esc(p.host)}" />
    <button type="button" class="btn ghost small" title="${t('set.remove')}">✕</button>`;
  $('button', d).onclick = () => d.remove();
  return d;
}
$('#btnSettings').addEventListener('click', async () => {
  const rows = $('#printerRows');
  rows.innerHTML = '';
  config.printers.forEach((p) => rows.appendChild(printerRow(p)));
  $('#optTrayPer').checked = config.trayPerPrinter;
  $('#optNotif').checked = config.notifications;
  $('#optStartMin').checked = config.startMinimized;
  $('#optAutostart').checked = await window.farm.getAutostart();
  $('#optLang').value = config.language || 'auto';
  $('#settings').showModal();
});
$('#addPrinter').addEventListener('click', () => {
  $('#printerRows').appendChild(printerRow({ id: 'p' + Date.now(), name: 'U1 - #' + ($('#printerRows').children.length + 1), host: '' }));
});
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'ok') return;
  const printers = $$('#printerRows .prow').map((r) => ({
    id: r.dataset.id, name: $('[data-k=name]', r).value.trim() || t('set.defaultName'), host: $('[data-k=host]', r).value.trim(),
  })).filter((p) => p.host);
  config = await window.farm.setConfig({
    printers,
    trayPerPrinter: $('#optTrayPer').checked,
    notifications: $('#optNotif').checked,
    startMinimized: $('#optStartMin').checked,
    language: $('#optLang').value,
  });
  await window.farm.setAutostart($('#optAutostart').checked);
  if (I18N.resolve(config.language, navigator.language) !== L.lang) {
    location.reload(); // dil değişti: arayüzü yeni dille baştan kur
    return;
  }
  rebuild();
  lastTrayKey = '';
  toast(t('toast.saved'));
});

// ---------------- sabit metinler (index.html) ----------------
function applyStaticTexts() {
  document.documentElement.lang = L.lang;
  $$('[data-i18n]').forEach((e) => (e.textContent = t(e.dataset.i18n)));
  $$('[data-i18n-html]').forEach((e) => (e.innerHTML = t(e.dataset.i18nHtml)));
  $$('[data-i18n-title]').forEach((e) => (e.title = t(e.dataset.i18nTitle)));
  $$('[data-i18n-ph]').forEach((e) => (e.placeholder = t(e.dataset.i18nPh)));
  const sel = $('#optLang');
  sel.innerHTML = `<option value="auto">${t('set.auto')}</option>` +
    Object.entries(I18N.LANGS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
}

// ---------------- ana döngü ----------------
function rebuild() {
  const grid = $('#grid');
  $('#empty').hidden = config.printers.length > 0;
  for (const id of Object.keys(cards)) {
    if (!config.printers.find((p) => p.id === id)) { camStop({ id }, cards[id]); cards[id].remove(); delete cards[id]; }
  }
  for (const p of config.printers) {
    const old = cards[p.id];
    // ad/IP değiştiyse kartı yeniden oluştur
    if (old && (old._name !== p.name || old._host !== p.host)) { camStop(p, old); old.remove(); delete cards[p.id]; }
    if (!cards[p.id]) {
      const el = buildCard(p);
      el._name = p.name; el._host = p.host;
      cards[p.id] = el;
    }
    grid.appendChild(cards[p.id]);
  }
  render();
}

function render() {
  for (const p of config.printers) if (cards[p.id]) updateCard(p, cards[p.id], states[p.id]);
  updateSummary();
  updateTrayIcons();
}

(async () => {
  config = await window.farm.getConfig();
  L = I18N.make(I18N.resolve(config.language, navigator.language));
  applyStaticTexts();
  rebuild();
  $('#emptyAdd').addEventListener('click', () => $('#btnSettings').click());
  if (!config.printers.length) {
    // ilk açılış: ayarları aç ve boş bir satır ekle
    $('#btnSettings').click();
    setTimeout(() => !$('#printerRows').children.length && $('#addPrinter').click(), 50);
  }
  window.farm.onStates((s) => { states = s; render(); });
})();
