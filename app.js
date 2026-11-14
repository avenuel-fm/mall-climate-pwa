/* 쇼핑몰 공조 관리 앱 — 순수 JS, 빌드 불필요
 * 설정은 모두 config.json 에서 읽습니다. (불러오지 못하면 아래 DEFAULTS 사용) */
(function () {
  'use strict';

  /* ===================== 기본 설정 (config.json 으로 덮어씀) ===================== */
  const DEFAULTS = {
    siteId: 'mall-001',
    siteName: '○○몰',
    siteSubtitle: '공조 에너지 관리',
    floors: ['6F', '5F', '4F', '3F', '2F', '1F', 'B1F'],
    zones: ['1구역', '2구역', '3구역'],
    floorZones: { B1F: ['1구역'] },
    legacyZones: { 'A구역': '1구역', 'B구역': '2구역', 'C구역': '3구역' },
    chartDays: 5,
    retainDays: 90,
    ranges: { temp: { min: 23, max: 26 }, humidity: { min: 40, max: 60 } },
    levels: [
      { key: 'comfort', label: '쾌적', maxDI: 74, color: '#1f8a4c', bg: '#e3f4ea', advice: '현재 공조 설정을 유지하세요.' },
      { key: 'caution', label: '주의', maxDI: 78, color: '#b86e00', bg: '#fff1d6', advice: '불쾌감이 올라가는 구간입니다. 공조기 설정을 점검하세요.' },
      { key: 'discomfort', label: '불쾌', maxDI: null, color: '#c92a2a', bg: '#fde4e4', advice: '고객 불쾌 구간입니다. 공조기 가동을 즉시 조정하세요.' }
    ],
    outdoorDiff: { tempWarn: 7, humidityWarn: 25 },
    advice: {
      tempHigh: '온도가 높습니다. 냉방 강화 또는 설정온도를 낮추세요.',
      tempLow: '온도가 낮습니다. 과냉방 가능성이 있어요. 설정온도를 올리면 에너지를 절감할 수 있습니다.',
      humidityHigh: '습도가 높습니다. 제습 운전 또는 환기량을 늘리세요.',
      humidityLow: '습도가 낮습니다. 가습을 검토하세요.',
      inRange: '온도·습도가 쾌적 범위 안에 있습니다.',
      diffLargeCooling: '실외가 훨씬 더운데 실내가 너무 차갑습니다. 과냉방 가능성이 있어 설정온도 상향을 검토하세요.',
      diffLargeHeating: '실내가 실외보다 훨씬 따뜻합니다. 과난방 가능성이 있어 난방 설정 하향을 검토하세요.',
      diffHumidity: '실내외 습도 차이가 큽니다. 제습·가습 설비 가동 상태를 확인하세요.',
      freeCooling: '외기가 실내보다 쾌적합니다. 외기 도입(외기냉방)으로 에너지를 절감할 수 있는지 검토하세요.'
    },
    sheets: { url: '', token: '' },
    hvac: { enabled: true, label: '공조기', count: 39, perPage: 5, minuteStep: 10, editDays: 31, defaultStart: '10:00', defaultEnd: '19:00', defaultEndByDay: { 0: '19:30', 5: '19:30', 6: '19:30' } },
    curtain: {
      enabled: true, label: '에어커튼', perPage: 5, minuteStep: 10, editDays: 31, defaultStart: '10:00', defaultEnd: '20:00',
      groups: [
        { key: 'B1G24', name: '지하1층 24게이트', count: 2 },
        { key: '1G1OUT', name: '1층 1게이트 OUT', count: 7 }, { key: '1G1IN', name: '1층 1게이트 IN', count: 5 },
        { key: '1G2OUT', name: '1층 2게이트 OUT', count: 3 }, { key: '1G2IN', name: '1층 2게이트 IN', count: 3 },
        { key: '1G6OUT', name: '1층 6게이트 OUT', count: 3 }, { key: '1G6IN', name: '1층 6게이트 IN', count: 3 },
        { key: '1REAR', name: '1층 후방 피난도어', count: 8 },
        { key: '4BR', name: '4층 브릿지', count: 1, single: true }, { key: '6BR', name: '6층 브릿지', count: 1, single: true }
      ]
    },
    weather: { enabled: true, label: '잠실 에비뉴엘', lat: 37.5131, lon: 127.1043, refreshMin: 10 },
    ui: { tabbarBottomOffset: 0 }
  };

  const CHART_LOCAL = 'vendor/chart.umd.js';
  const CHART_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
  const DAY = 86400000;

  /* ===================== 상태 ===================== */
  const S = {
    cfg: null, cfgLoaded: false, repKind: 'climate',
    records: [],
    settings: { url: '', token: '', autoNext: true, floorIdx: 0, zoneIdx: 0, outCache: null, deletedIds: [] },
    chart: null, syncing: false, syncState: 'local', syncMsg: ''
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');

  function merge(base, over) {
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
    const out = {};
    Object.keys(base).forEach((k) => { out[k] = over && k in over ? merge(base[k], over[k]) : base[k]; });
    if (over) Object.keys(over).forEach((k) => { if (!(k in out) && k[0] !== '_') out[k] = over[k]; });
    return out;
  }

  /* ===================== 날짜 ===================== */
  const fmtMD = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate(); };
  const fmtHM = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const fmtDT = (ts) => fmtMD(ts) + ' ' + fmtHM(ts);
  const fmtYMD = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const fmtFull = (ts) => fmtYMD(ts) + ' ' + fmtHM(ts);
  const dayStart = (ts, offsetDays) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (offsetDays || 0)).getTime(); };
  const windowFrom = () => dayStart(Date.now(), -(S.cfg.chartDays - 1));

  /* ===================== 계산 ===================== */
  const r1 = (v) => Math.round(v * 10) / 10;
  const signed = (v, unit) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(r1(v)).toFixed(1) + unit;

  // 불쾌지수 (Discomfort Index)
  function calcDI(t, h) { return 0.81 * t + 0.01 * h * (0.99 * t - 14.3) + 46.3; }

  function levelOf(di) {
    const L = S.cfg.levels;
    for (let i = 0; i < L.length; i++) if (L[i].maxDI == null || di < L[i].maxDI) return L[i];
    return L[L.length - 1];
  }
  const levelIdx = (lv) => S.cfg.levels.indexOf(lv);

  function analyze(t, h, ot, oh) {
    const C = S.cfg, A = C.advice, R = C.ranges;
    const di = calcDI(t, h);
    const level = levelOf(di);
    const lines = [];
    lines.push({ text: level.advice });
    let inRange = true;
    if (t > R.temp.max) { lines.push({ text: A.tempHigh, warn: true }); inRange = false; }
    if (t < R.temp.min) { lines.push({ text: A.tempLow, warn: true }); inRange = false; }
    if (h > R.humidity.max) { lines.push({ text: A.humidityHigh, warn: true }); inRange = false; }
    if (h < R.humidity.min) { lines.push({ text: A.humidityLow, warn: true }); inRange = false; }
    if (inRange) lines.push({ text: A.inRange });

    let diff = null;
    if (ot != null || oh != null) {
      diff = { dt: ot != null ? t - ot : null, dh: oh != null ? h - oh : null, ddi: null, odi: null };
      if (ot != null && oh != null) { diff.odi = calcDI(ot, oh); diff.ddi = di - diff.odi; }
      if (diff.dt != null && Math.abs(diff.dt) >= C.outdoorDiff.tempWarn) {
        lines.push({ text: ot > t ? A.diffLargeCooling : A.diffLargeHeating, warn: true });
      }
      if (diff.dh != null && Math.abs(diff.dh) >= C.outdoorDiff.humidityWarn) {
        lines.push({ text: A.diffHumidity, warn: true });
      }
      if (diff.odi != null && level !== C.levels[0] && levelOf(diff.odi) === C.levels[0] && diff.odi < di) {
        lines.push({ text: A.freeCooling });
      }
    }
    return { di, level, lines, diff };
  }

  /* ===================== 저장소 ===================== */
  const KEY_REC = () => 'mallclimate:' + S.cfg.siteId + ':records';
  const KEY_SET = () => 'mallclimate:' + S.cfg.siteId + ':settings';

  function loadStore() {
    try { S.records = JSON.parse(localStorage.getItem(KEY_REC()) || '[]'); } catch (e) { S.records = []; }
    if (!Array.isArray(S.records)) S.records = [];
    try { Object.assign(S.settings, JSON.parse(localStorage.getItem(KEY_SET()) || '{}')); } catch (e) { /* 무시 */ }
    const cutoff = Date.now() - S.cfg.retainDays * DAY;
    S.records = S.records.filter((r) => r && typeof r.ts === 'number' && r.ts >= cutoff);
    S.records.forEach(fixZone);
  }
  // 예전 구역 이름(A/B/C구역)을 새 이름(1/2/3구역)으로 자동 변환
  function fixZone(r) {
    const m = S.cfg.legacyZones;
    if (r && m && typeof m === 'object' && m[r.zone]) r.zone = m[r.zone];
    return r;
  }
  // 층별 구역 목록 (예: B1F는 1구역만)
  function zonesOf(floor) {
    const fz = S.cfg.floorZones;
    return fz && Array.isArray(fz[floor]) && fz[floor].length ? fz[floor] : S.cfg.zones;
  }
  function saveRecords() { try { localStorage.setItem(KEY_REC(), JSON.stringify(S.records)); } catch (e) { toast('기록을 저장하지 못했습니다. 기기 저장 공간을 확보하고 시크릿 모드가 아닌 창에서 다시 저장하세요', true); } }
  function saveSettings() { try { localStorage.setItem(KEY_SET(), JSON.stringify(S.settings)); } catch (e) { /* 무시 */ } }

  const sheetUrl = () => (S.settings.url || S.cfg.sheets.url || '').trim();
  const sheetToken = () => (S.settings.token || S.cfg.sheets.token || '').trim();

  /* ===================== UI 공통 ===================== */
  let toastTimer;
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hideToast = () => $('#toast').classList.remove('show');
  // err=true: 오류 안내는 사라지지 않고, 누르거나 Esc·탭 이동 때 닫힘
  function toast(msg, err) {
    const el = $('#toast');
    el.textContent = msg; el.classList.add('show'); el.classList.toggle('err', !!err);
    clearTimeout(toastTimer);
    if (!err) toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function lvStyle(lv) { return 'background:' + lv.bg + ';color:' + lv.color; }

  /* ----- 설정 탭 잠금 (고정 비밀번호) ----- */
  const PIN = '0621';
  function setLocked(lock) {
    const body = $('#moreBody'), ov = $('#moreLock');
    if (!body || !ov) return;
    body.classList.toggle('locked', lock);
    if (lock) body.setAttribute('inert', ''); else body.removeAttribute('inert');
    body.setAttribute('aria-hidden', String(lock));
    ov.hidden = !lock;
    if (lock) { $('#pinInput').value = ''; $('#pinMsg').textContent = ''; }
  }
  function checkPin() {
    const inp = $('#pinInput');
    if (inp.value.trim() === PIN) { setLocked(false); window.scrollTo(0, 0); return; }
    $('#pinMsg').textContent = '비밀번호가 맞지 않습니다';
    inp.value = '';
    const box = $('#pinBox'); box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
    inp.focus();
  }

  function switchTab(name) {
    const prev = ($('.tab.active') || {}).id;
    if ($('#toast').classList.contains('err')) hideToast();
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    $$('.tabbtn').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.body.dataset.tab = name;
    window.scrollTo(0, 0);
    // 설정 탭은 들어올 때마다 잠금, 나가면 다시 잠금
    if (name === 'more' && prev !== 'tab-more') { setLocked(true); setTimeout(() => { const i = $('#pinInput'); if (i) i.focus(); }, 80); }
    if (name !== 'more') setLocked(true);
    if (name === 'chart') renderChartTab();
    if (name === 'report') renderReport();
    if (name === 'more') renderMore();
    if ((name === 'hvac' || name === 'curtain') && window.USAGE) window.USAGE.render(name);
  }

  /* ===================== 입력 탭 ===================== */
  function buildSeg(container, items, idxKey, onChange) {
    container.innerHTML = '';
    items.forEach((name, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'seg'; b.textContent = name;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(S.settings[idxKey] === i));
      b.addEventListener('click', () => {
        S.settings[idxKey] = i; saveSettings();
        if (onChange) onChange();
      });
      container.appendChild(b);
    });
  }
  // 층·구역 버튼을 다시 그림 (선택한 층에 없는 구역 버튼은 표시하지 않음)
  function renderLocation() {
    const C = S.cfg;
    if (S.settings.floorIdx >= C.floors.length || S.settings.floorIdx < 0) S.settings.floorIdx = 0;
    const zs = zonesOf(C.floors[S.settings.floorIdx]);
    if (S.settings.zoneIdx >= zs.length || S.settings.zoneIdx < 0) S.settings.zoneIdx = 0;
    buildSeg($('#floorGrid'), C.floors, 'floorIdx', renderLocation);
    buildSeg($('#zoneGrid'), zs, 'zoneIdx', renderLocation);
  }
  const refreshSeg = renderLocation;

  function readNum(id) {
    const el = $(id), v = el.value.trim().replace(',', '.');
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function readInputs() {
    return { t: readNum('#inT'), h: readNum('#inH'), ot: readNum('#outT'), oh: readNum('#outH') };
  }

  function validate(v, strict) {
    const errs = [];
    const chk = (val, lo, hi, label, id, required) => {
      const bad = (required && (val == null || Number.isNaN(val))) || (val != null && (Number.isNaN(val) || val < lo || val > hi));
      const show = !!bad && (strict || val != null);
      $(id).classList.toggle('bad', show);
      if (show) $(id).setAttribute('aria-invalid', 'true'); else $(id).removeAttribute('aria-invalid');
      if (bad) errs.push(label + '를 ' + lo + '~' + hi + ' 사이 숫자로 입력하세요');
    };
    chk(v.t, -30, 60, '실내 온도', '#inT', true);
    chk(v.h, 0, 100, '실내 습도', '#inH', true);
    chk(v.ot, -40, 60, '실외 온도', '#outT', false);
    chk(v.oh, 0, 100, '실외 습도', '#outH', false);
    return errs;
  }

  function renderLive() {
    const box = $('#liveResult');
    const v = readInputs();
    const errs = validate(v, false);
    if (v.t == null || v.h == null || errs.length) { box.hidden = true; return; }
    const a = analyze(v.t, v.h, v.ot, v.oh);
    box.hidden = false;
    box.style.borderColor = a.level.color;
    let html = '<div class="head"><div class="di">불쾌지수<b>' + a.di.toFixed(1) + '</b></div>' +
      '<span class="pill" style="' + lvStyle(a.level) + '">' + esc(a.level.label) + '</span></div><ul>' +
      a.lines.map((l) => '<li' + (l.warn ? ' class="warnline"' : '') + '>' + esc(l.text) + '</li>').join('') + '</ul>';
    if (a.diff) {
      const d = a.diff;
      html += '<div class="diffbox"><h3>실내 − 실외 차이</h3><div class="diffrow">' +
        '<div>온도<strong>' + (d.dt != null ? signed(d.dt, '°C') : '—') + '</strong></div>' +
        '<div>습도<strong>' + (d.dh != null ? signed(d.dh, '%') : '—') + '</strong></div>' +
        '<div>불쾌지수<strong>' + (d.ddi != null ? signed(d.ddi, '') : '—') + '</strong></div></div></div>';
    }
    box.innerHTML = html;
  }

  function fillOutdoorFromCache() {
    const c = S.settings.outCache, hint = $('#outHint');
    if (c && Date.now() - c.ts < 2 * 3600 * 1000 && $('#outT').value === '' && $('#outH').value === '') {
      if (c.ot != null) $('#outT').value = c.ot;
      if (c.oh != null) $('#outH').value = c.oh;
      S.outAuto = true;
      const m = Math.max(0, Math.round((Date.now() - c.ts) / 60000));
      hint.hidden = false;
      hint.textContent = m + '분 전에 입력한 실외값입니다. 달라졌으면 고쳐 주세요.';
    } else if (!c || Date.now() - c.ts >= 2 * 3600 * 1000) {
      hint.hidden = true;
    }
  }

  function saveRecord() {
    const v = readInputs();
    const errs = validate(v, true);
    if (errs.length) { toast(errs[0], true); const b = $('.field input.bad'); if (b) b.focus(); return; }
    let ts = Date.now();
    const tv = $('#inTime').value;
    $('#inTime').removeAttribute('aria-invalid');
    if (tv) {
      ts = new Date(tv).getTime();
      if (!Number.isFinite(ts) || ts > Date.now() + 5 * 60000) {
        $('#inTime').setAttribute('aria-invalid', 'true'); $('#inTime').focus();
        toast('측정 시각을 지금보다 이전 시각으로 고르세요', true); return;
      }
    }
    const floor = S.cfg.floors[S.settings.floorIdx], zone = zonesOf(floor)[S.settings.zoneIdx];
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      site: S.cfg.siteId, ts, floor, zone,
      t: v.t, h: v.h, ot: v.ot, oh: v.oh,
      di: r1(calcDI(v.t, v.h)), synced: false
    };
    S.records.push(rec);
    saveRecords();
    if (v.ot != null || v.oh != null) { S.settings.outCache = { ot: v.ot, oh: v.oh, ts: Date.now() }; }

    const lv = levelOf(rec.di);
    $('#inT').value = ''; $('#inH').value = ''; $('#inTime').value = '';
    $('#outHint').hidden = true;
    let msg = '저장됨: ' + floor + ' ' + zone + ' · ' + lv.label;
    if ($('#autoNext').checked) {
      S.settings.zoneIdx++;
      if (S.settings.zoneIdx >= zonesOf(floor).length) { S.settings.zoneIdx = 0; S.settings.floorIdx = (S.settings.floorIdx + 1) % S.cfg.floors.length; }
      const nf = S.cfg.floors[S.settings.floorIdx];
      msg += '  →  다음: ' + nf + ' ' + zonesOf(nf)[S.settings.zoneIdx];
    }
    S.settings.autoNext = $('#autoNext').checked;
    saveSettings(); refreshSeg(); renderLive(); updateBadge();
    window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
    toast(msg);
    if (sheetUrl()) push().catch(() => {});
  }

  /* ===================== 그래프 ===================== */
  let chartPromise = null;
  function loadScript(src, cors) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; if (cors) s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = () => rej(new Error('load fail: ' + src));
      document.head.appendChild(s);
    });
  }
  function ensureChart() {
    if (window.Chart) return Promise.resolve();
    if (!chartPromise) {
      chartPromise = loadScript(CHART_LOCAL)
        .then(() => { if (!window.Chart) throw new Error('no Chart'); })
        .catch(() => loadScript(CHART_CDN, true))
        .then(() => { if (!window.Chart) throw new Error('no Chart'); })
        .catch((e) => { chartPromise = null; throw e; });
    }
    return chartPromise;
  }

  const match = (r, floor, zone) => (floor === 'all' || r.floor === floor) && (zone === 'all' || r.zone === zone);
  const sortedRecs = () => S.records.slice().sort((a, b) => a.ts - b.ts);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  function buildSeries(floor, zone) {
    const from = windowFrom();
    const f = sortedRecs().filter((r) => r.ts >= from && match(r, floor, zone));
    const single = floor !== 'all' && zone !== 'all';
    if (single) {
      return { mode: 'raw', n: f.length, T: f.map((r) => ({ x: r.ts, y: r.t })), H: f.map((r) => ({ x: r.ts, y: r.h })) };
    }
    const groups = {};
    f.forEach((r) => { const k = dayStart(r.ts); (groups[k] = groups[k] || []).push(r); });
    const keys = Object.keys(groups).map(Number).sort((a, b) => a - b);
    return {
      mode: 'avg', n: f.length,
      T: keys.map((k) => ({ x: k + DAY / 2, y: r1(avg(groups[k].map((r) => r.t))) })),
      H: keys.map((k) => ({ x: k + DAY / 2, y: Math.round(avg(groups[k].map((r) => r.h)) * 10) / 10 }))
    };
  }

  function makeChart(canvas, series, extra) {
    const R = S.cfg.ranges, min = windowFrom(), max = dayStart(Date.now(), 1);
    const band = {
      id: 'comfortBand',
      beforeDatasetsDraw(chart) {
        const a = chart.chartArea, y = chart.scales.yT;
        if (!a || !y) return;
        const top = Math.max(a.top, Math.min(y.getPixelForValue(R.temp.max), y.getPixelForValue(R.temp.min)));
        const bot = Math.min(a.bottom, Math.max(y.getPixelForValue(R.temp.max), y.getPixelForValue(R.temp.min)));
        if (bot <= top) return;
        const c = chart.ctx; c.save(); c.fillStyle = 'rgba(217,72,15,0.08)';
        c.fillRect(a.left, top, a.right - a.left, bot - top); c.restore();
      }
    };
    const cfg = {
      type: 'line',
      data: {
        datasets: [
          { label: '온도(°C)', data: series.T, yAxisID: 'yT', borderColor: '#d9480f', backgroundColor: '#d9480f', borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 6, tension: 0.2 },
          { label: '습도(%)', data: series.H, yAxisID: 'yH', borderColor: '#1c7ed6', backgroundColor: '#1c7ed6', borderWidth: 2.5, pointStyle: 'rectRot', pointRadius: 5, pointHoverRadius: 7, tension: 0.2 }
        ]
      },
      options: Object.assign({
        responsive: true, maintainAspectRatio: false, parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 14 }, usePointStyle: true } },
          tooltip: {
            callbacks: {
              title: (items) => (series.mode === 'raw' ? fmtDT(items[0].parsed.x) : fmtMD(items[0].parsed.x) + ' 일평균'),
              label: (item) => ' ' + item.dataset.label.replace(/\(.*\)/, '') + ' ' + item.parsed.y.toFixed(1) + (item.datasetIndex === 0 ? '°C' : '%')
            }
          }
        },
        scales: {
          x: { type: 'linear', min, max, ticks: { stepSize: DAY, autoSkip: false, maxRotation: 0, callback: (v) => (v >= max ? '' : fmtMD(v)) }, grid: { color: '#ececec' } },
          yT: { type: 'linear', position: 'left', suggestedMin: R.temp.min - 4, suggestedMax: R.temp.max + 4, title: { display: true, text: '온도(°C)' } },
          yH: { type: 'linear', position: 'right', suggestedMin: R.humidity.min - 20, suggestedMax: R.humidity.max + 20, grid: { drawOnChartArea: false }, title: { display: true, text: '습도(%)' } }
        }
      }, extra || {}),
      plugins: [band]
    };
    return new window.Chart(canvas, cfg);
  }

  function fillFilter(sel, items, allLabel) {
    sel.innerHTML = '<option value="all">' + allLabel + '</option>' + items.map((x) => '<option value="' + esc(x) + '">' + esc(x) + '</option>').join('');
  }

  function renderChartTab() {
    $('#chartDaysLabel').textContent = S.cfg.chartDays;
    const floor = $('#cFloor').value, zone = $('#cZone').value;
    const series = buildSeries(floor, zone);
    $('#chartEmpty').hidden = series.n > 0;
    $('#chartMode').textContent = (series.mode === 'raw'
      ? floor + ' ' + zone + ' 측정값을 그대로 표시합니다.'
      : '선택 범위 전체의 일별 평균을 표시합니다. (층·구역을 모두 고르면 개별 측정값)') +
      ' 연한 주황 띠는 쾌적 온도 범위(' + S.cfg.ranges.temp.min + '~' + S.cfg.ranges.temp.max + '°C)입니다.';
    if (S.chart) { S.chart.destroy(); S.chart = null; }
    ensureChart().then(() => {
      if (S.chart) S.chart.destroy();
      S.chart = makeChart($('#mainChart'), series);
    }).catch(() => {
      $('#chartEmpty').hidden = false;
      $('#chartEmpty').textContent = '그래프 라이브러리를 불러오지 못했습니다. 인터넷에 연결한 뒤 다시 열어 주세요.';
    });
    renderList(floor, zone);
  }

  function levelPill(di) { const lv = levelOf(di); return '<span class="st" style="' + lvStyle(lv) + '">' + esc(lv.label) + '</span>'; }

  function renderList(floor, zone) {
    const from = windowFrom();
    const list = sortedRecs().filter((r) => r.ts >= from && match(r, floor, zone)).reverse();
    $('#listCount').textContent = list.length + '건';
    const box = $('#recList');
    if (!list.length) { box.innerHTML = '<p class="hint">이 기간에 저장된 기록이 없습니다</p>'; return; }
    box.innerHTML = list.slice(0, 60).map((r) => {
      const out = r.ot != null || r.oh != null
        ? '<br><small>실외 ' + (r.ot != null ? r.ot.toFixed(1) + '°C' : '—') + ' / ' + (r.oh != null ? r.oh + '%' : '—') + '</small>' : '';
      return '<div class="rec"><div><div class="t">' + fmtDT(r.ts) + ' · ' + esc(r.floor) + ' ' + esc(r.zone) +
        (r.synced || !sheetUrl() ? '' : ' <span class="unsynced">· 미전송</span>') + '</div>' +
        '<div class="v">' + r.t.toFixed(1) + '°C · ' + r.h + '% <small>DI ' + r.di.toFixed(1) + '</small>' + out + '</div></div>' +
        levelPill(r.di) +
        '<div class="del"><button type="button" data-del="' + esc(r.id) + '">삭제</button></div></div>';
    }).join('') + (list.length > 60 ? '<p class="hint">최근 60건만 표시합니다. 전체는 CSV로 저장하세요.</p>' : '');
  }

  function deleteRecord(id) {
    const r = S.records.find((x) => x.id === id);
    if (!r) return;
    const note = r.synced ? '\n(구글 시트에 이미 저장된 기록은 시트에서 직접 지워야 합니다)' : '';
    if (!confirm(fmtDT(r.ts) + ' ' + r.floor + ' ' + r.zone + ' 기록을 삭제할까요?' + note)) return;
    S.records = S.records.filter((x) => x.id !== id);
    if (r.synced) { S.settings.deletedIds.push(id); S.settings.deletedIds = S.settings.deletedIds.slice(-500); saveSettings(); }
    saveRecords(); renderChartTab(); updateBadge();
  }

  /* ===================== 리포트 ===================== */
  let reportSeq = 0;
  function setRepKind(k) {
    S.repKind = k;
    $$('#rKind .seg').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kind === k)));
    $('#climateCtl').hidden = k !== 'climate';
    $('#usageCtl').hidden = k === 'climate';
    renderReport();
  }
  function openReport(k) { switchTab('report'); setRepKind(k); }
  async function renderReport() {
    if (S.repKind && S.repKind !== 'climate' && window.USAGE) { reportSeq++; return window.USAGE.renderReport(S.repKind, $('#report')); }
    const seq = ++reportSeq;
    const floor = $('#rFloor').value, zone = $('#rZone').value;
    const C = S.cfg, from = windowFrom();
    const recs = sortedRecs().filter((r) => r.ts >= from && match(r, floor, zone));
    const el = $('#report');
    const scope = (floor === 'all' ? '전체 층' : floor) + ' / ' + (zone === 'all' ? '전체 구역' : zone);

    let html = '<h1>' + esc(C.siteName) + ' 실내 온습도 리포트</h1>' +
      '<p class="meta">기간 ' + fmtYMD(from) + ' ~ ' + fmtYMD(Date.now()) + ' · 대상 ' + esc(scope) + ' · 출력 ' + fmtFull(Date.now()) + '</p>';

    if (!recs.length) {
      el.innerHTML = html + '<p class="hint">이 기간에 저장된 기록이 없습니다</p>';
      return;
    }

    // 요약
    const aT = avg(recs.map((r) => r.t)), aH = avg(recs.map((r) => r.h)), aD = avg(recs.map((r) => r.di));
    const counts = C.levels.map(() => 0);
    recs.forEach((r) => { counts[levelIdx(levelOf(r.di))]++; });
    const withOut = recs.filter((r) => r.ot != null);
    const aDT = withOut.length ? avg(withOut.map((r) => r.t - r.ot)) : null;
    html += '<h3>요약</h3><div class="kpis">' +
      kpi('측정 건수', recs.length + '건') +
      kpi('평균 온도', aT.toFixed(1) + '°C') +
      kpi('평균 습도', aH.toFixed(0) + '%') +
      kpi('평균 불쾌지수', aD.toFixed(1)) +
      kpi('최고 / 최저 온도', Math.max.apply(null, recs.map((r) => r.t)).toFixed(1) + ' / ' + Math.min.apply(null, recs.map((r) => r.t)).toFixed(1) + '°C') +
      kpi('쾌적 비율', Math.round(counts[0] / recs.length * 100) + '%') +
      kpi('실내외 평균 온도차', aDT == null ? '—' : signed(aDT, '°C')) +
      kpi('실외 입력 건수', withOut.length + '건') + '</div>';

    html += '<h3>상태 분포</h3><div class="stbar">' +
      C.levels.map((lv, i) => '<span style="width:' + (counts[i] / recs.length * 100) + '%;background:' + lv.color + '"></span>').join('') + '</div>' +
      '<div class="legend">' + C.levels.map((lv, i) => '<span><i style="background:' + lv.color + '"></i>' + esc(lv.label) + ' ' + counts[i] + '건 (' + Math.round(counts[i] / recs.length * 100) + '%)</span>').join('') + '</div>';

    // 층·구역 현황
    const zs = zone === 'all' ? C.zones : [zone], fs = floor === 'all' ? C.floors : [floor];
    let mrows = '', recLines = [];
    fs.forEach((f) => {
      let cells = '<th class="l">' + esc(f) + '</th>';
      zs.forEach((z) => {
        if (zonesOf(f).indexOf(z) < 0) { cells += '<td class="na">해당 없음</td>'; return; }
        const g = recs.filter((r) => r.floor === f && r.zone === z);
        if (!g.length) { cells += '<td>—</td>'; return; }
        const t = avg(g.map((r) => r.t)), h = avg(g.map((r) => r.h)), d = avg(g.map((r) => r.di)), lv = levelOf(d);
        cells += '<td style="' + lvStyle(lv) + '"><b>' + d.toFixed(1) + ' ' + esc(lv.label) + '</b><small>' + t.toFixed(1) + '°C · ' + h.toFixed(0) + '% · ' + g.length + '건</small></td>';
        const A = C.advice, R = C.ranges, tag = f + ' ' + z + ' (평균 ' + t.toFixed(1) + '°C, ' + h.toFixed(0) + '%): ';
        if (t > R.temp.max) recLines.push(tag + A.tempHigh);
        else if (t < R.temp.min) recLines.push(tag + A.tempLow);
        if (h > R.humidity.max) recLines.push(tag + A.humidityHigh);
        else if (h < R.humidity.min) recLines.push(tag + A.humidityLow);
        if (!recLines.length || recLines[recLines.length - 1].indexOf(tag) !== 0) { if (levelIdx(lv) > 0) recLines.push(tag + lv.advice); }
      });
      mrows += '<tr>' + cells + '</tr>';
    });
    html += '<h3>층·구역별 평균 불쾌지수</h3><div class="scroll"><table class="matrix"><thead><tr><th class="l">층</th>' +
      zs.map((z) => '<th>' + esc(z) + '</th>').join('') + '</tr></thead><tbody>' + mrows + '</tbody></table></div>';

    // 권고
    if (aDT != null && Math.abs(aDT) >= C.outdoorDiff.tempWarn) {
      recLines.push('실내외 평균 온도차 ' + signed(aDT, '°C') + ': ' + (aDT < 0 ? C.advice.diffLargeCooling : C.advice.diffLargeHeating));
    }
    html += '<h3>조치 권고</h3>' + (recLines.length
      ? '<ul>' + recLines.slice(0, 14).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' + (recLines.length > 14 ? '<p class="hint">외 ' + (recLines.length - 14) + '건 (상세 기록표 참고)</p>' : '')
      : '<p>' + esc(C.advice.inRange) + ' 평균 기준으로 조정이 필요한 구역이 없습니다.</p>');

    // 그래프
    html += '<h3>추이 그래프</h3><div id="rptChartSlot"></div>';

    // 상세
    if ($('#rDetail').checked) {
      html += '<h3>상세 기록 (' + recs.length + '건)</h3><div class="scroll"><table><thead><tr>' +
        '<th class="l">시각</th><th>층</th><th>구역</th><th>실내<br>온도</th><th>실내<br>습도</th><th>불쾌<br>지수</th><th>상태</th><th>실외<br>온도</th><th>실외<br>습도</th></tr></thead><tbody>' +
        recs.map((r) => { const lv = levelOf(r.di); return '<tr><td class="l">' + fmtDT(r.ts) + '</td><td>' + esc(r.floor) + '</td><td>' + esc(r.zone) + '</td><td>' + r.t.toFixed(1) + '</td><td>' + r.h + '</td><td>' + r.di.toFixed(1) + '</td><td style="' + lvStyle(lv) + '">' + esc(lv.label) + '</td><td>' + (r.ot != null ? r.ot.toFixed(1) : '—') + '</td><td>' + (r.oh != null ? r.oh : '—') + '</td></tr>'; }).join('') +
        '</tbody></table></div>';
    }

    html += '<p class="foot">불쾌지수 = 0.81×T + 0.01×H×(0.99×T−14.3) + 46.3 (T: 온도 °C, H: 상대습도 %). 판정 기준: ' + levelRangeText() +
      ' · 쾌적 범위: 온도 ' + C.ranges.temp.min + '~' + C.ranges.temp.max + '°C, 습도 ' + C.ranges.humidity.min + '~' + C.ranges.humidity.max + '%</p>';

    el.innerHTML = html;

    // 그래프 이미지 (인쇄 품질 위해 이미지로 변환)
    try {
      await ensureChart();
      if (seq !== reportSeq) return;
      const series = buildSeries(floor, zone);
      const cv = document.createElement('canvas'); cv.width = 900; cv.height = 420;
      const ch = makeChart(cv, series, { responsive: false, animation: false, devicePixelRatio: 2 });
      const url = ch.toBase64Image(); ch.destroy();
      const slot = $('#rptChartSlot');
      if (slot) slot.innerHTML = '<img class="chartimg" alt="온습도 추이 그래프" src="' + url + '"><p class="hint">' +
        (series.mode === 'raw' ? '개별 측정값' : '일별 평균') + ' · 연한 주황 띠: 쾌적 온도 범위</p>';
    } catch (e) {
      const slot = $('#rptChartSlot');
      if (slot) slot.innerHTML = '<p class="hint">그래프 라이브러리를 불러오지 못해 그래프를 넣지 못했습니다.</p>';
    }
  }
  const kpi = (l, v) => '<div class="kpi"><span>' + l + '</span><strong>' + v + '</strong></div>';

  function levelRangeText() {
    let prev = null;
    return S.cfg.levels.map((lv) => {
      const t = lv.maxDI == null ? esc(lv.label) + ' ' + prev + ' 이상' : esc(lv.label) + ' ' + (prev == null ? '' : prev + '~') + lv.maxDI + ' 미만';
      prev = lv.maxDI; return t;
    }).join(', ');
  }

  async function printReport() {
    await renderReport();
    // 이미지 반영 후 인쇄
    setTimeout(() => window.print(), 150);
  }

  /* ===================== CSV ===================== */
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function exportCSV(recs, tag) {
    if (!recs.length) { toast('내보낼 기록이 없습니다'); return; }
    const head = ['측정시각', '층', '구역', '실내온도(°C)', '실내습도(%)', '불쾌지수', '상태', '실외온도(°C)', '실외습도(%)', '실내외온도차(°C)', '실내외습도차(%)', '시트전송'];
    const rows = recs.map((r) => {
      const lv = levelOf(r.di);
      return [fmtFull(r.ts), r.floor, r.zone, r.t, r.h, r.di, lv.label,
        r.ot == null ? '' : r.ot, r.oh == null ? '' : r.oh,
        r.ot == null ? '' : r1(r.t - r.ot), r.oh == null ? '' : r1(r.h - r.oh), r.synced ? 'Y' : ''];
    });
    const text = '﻿' + [head].concat(rows).map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = S.cfg.siteName.replace(/[\\/:*?"<>|\s]/g, '') + '_' + tag + '_' + fmtYMD(Date.now()).replace(/-/g, '') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('CSV 저장: ' + recs.length + '건');
  }

  /* ===================== Google Sheets 동기화 ===================== */
  function updateBadge() {
    const b = $('#syncBadge');
    const pend = S.records.filter((r) => !r.synced).length + (window.USAGE ? window.USAGE.pendingCount() : 0);
    b.className = 'badge';
    if (!sheetUrl()) { b.textContent = '로컬 저장'; return; }
    if (S.syncing) { b.textContent = '동기화 중…'; b.classList.add('pending'); return; }
    if (S.syncState === 'err') { b.textContent = '전송 오류'; b.classList.add('err'); return; }
    if (pend) { b.textContent = '미전송 ' + pend + '건'; b.classList.add('pending'); return; }
    b.textContent = '시트 저장됨'; b.classList.add('ok');
  }

  const strip = (r) => ({ id: r.id, site: r.site, ts: r.ts, floor: r.floor, zone: r.zone, t: r.t, h: r.h, ot: r.ot, oh: r.oh, di: r.di });

  async function push() {
    const url = sheetUrl();
    if (!url) return;
    const pend = S.records.filter((r) => !r.synced);
    for (let i = 0; i < pend.length; i += 50) {
      const chunk = pend.slice(i, i + 50);
      const res = await fetch(url, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'append', token: sheetToken(), records: chunk.map(strip) })
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '서버 오류');
      chunk.forEach((r) => { r.synced = true; });
      saveRecords();
    }
    S.syncState = 'ok'; updateBadge();
  }

  async function pull() {
    const url = sheetUrl();
    if (!url) return 0;
    const u = new URL(url);
    u.searchParams.set('action', 'list'); u.searchParams.set('token', sheetToken());
    u.searchParams.set('site', S.cfg.siteId); u.searchParams.set('days', String(S.cfg.chartDays));
    const res = await fetch(u.toString(), { redirect: 'follow' });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '서버 오류');
    const have = new Map(S.records.map((r) => [r.id, r]));
    const dead = new Set(S.settings.deletedIds);
    let added = 0;
    (j.records || []).forEach((r) => {
      if (dead.has(r.id)) return;
      if (have.has(r.id)) { have.get(r.id).synced = true; return; }
      if (typeof r.ts !== 'number' || !Number.isFinite(r.t) || !Number.isFinite(r.h)) return;
      S.records.push({ id: r.id, site: r.site, ts: r.ts, floor: r.floor, zone: fixZone(r).zone, t: r.t, h: r.h, ot: r.ot == null ? null : r.ot, oh: r.oh == null ? null : r.oh, di: r.di, synced: true });
      added++;
    });
    saveRecords();
    return added;
  }

  async function syncNow(silent) {
    if (!sheetUrl()) { if (!silent) toast('먼저 구글 시트 주소를 입력하세요'); return; }
    if (S.syncing) return;
    S.syncing = true; updateBadge();
    try {
      await push();
      const added = await pull();
      if (window.USAGE) await window.USAGE.sync();
      S.syncState = 'ok';
      S.syncMsg = '동기화 완료 ' + fmtHM(Date.now()) + (added ? ' · 다른 기기 기록 ' + added + '건 가져옴' : '');
      if (!silent) toast(S.syncMsg);
    } catch (e) {
      S.syncState = 'err';
      S.syncMsg = '동기화 실패: ' + (e && e.message ? e.message : e) + ' (인터넷·주소·인증 키를 확인하세요. 기록은 이 기기에 안전하게 남아 있습니다)';
      if (!silent) toast('동기화하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요. 기록은 이 기기에 남아 있습니다', true);
    } finally {
      S.syncing = false; updateBadge();
      const st = $('#syncStatus'); if (st) st.textContent = S.syncMsg;
      if ($('#tab-chart').classList.contains('active')) renderChartTab();
      if (window.USAGE) ['hvac', 'curtain'].forEach((k) => { if ($('#tab-' + k).classList.contains('active')) window.USAGE.render(k); });
      if (window.USAGE && S.repKind !== 'climate' && $('#tab-report').classList.contains('active')) renderReport();
    }
  }

  /* ===================== 실외 날씨 (헤더) ===================== */
  const WX_KEY = () => 'mallclimate:' + S.cfg.siteId + ':weather';
  function renderWeather() {
    const el = $('#wx'), W = S.cfg.weather;
    if (!W.enabled) { el.hidden = true; return; }
    const w = S.weather;
    if (!w) { el.innerHTML = '<b>실외 —</b><small>불러오는 중</small>'; return; }
    const stale = Date.now() - w.ts > 40 * 60000;
    el.title = W.label + ' 현재 기온 (Open-Meteo)';
    el.innerHTML = '<b>실외 ' + w.t.toFixed(1) + '°C</b><small>' + (stale ? fmtHM(w.ts) + ' 기준 · 오래된 값' : '습도 ' + w.h + '% · ' + fmtHM(w.ts)) + '</small>';
  }
  async function fetchWeather() {
    const W = S.cfg.weather;
    if (!W.enabled) return;
    try {
      const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + W.lat + '&longitude=' + W.lon +
        '&current=temperature_2m,relative_humidity_2m&timezone=Asia%2FSeoul';
      const res = await fetch(u, { cache: 'no-store' });
      const j = await res.json();
      const c = j && j.current;
      if (!c || typeof c.temperature_2m !== 'number') throw new Error('no data');
      S.weather = { t: c.temperature_2m, h: Math.round(c.relative_humidity_2m), ts: Date.now() };
      try { localStorage.setItem(WX_KEY(), JSON.stringify(S.weather)); } catch (e) { /* 무시 */ }
      applyWeatherToOutdoor();
    } catch (e) { /* 오프라인 등: 마지막 값 유지 */ }
    renderWeather();
  }
  // 실외 입력칸이 비었거나 자동 입력 상태이면 현재 날씨로 채움
  function applyWeatherToOutdoor() {
    const w = S.weather;
    if (!w || Date.now() - w.ts > 30 * 60000) return;
    const empty = $('#outT').value === '' && $('#outH').value === '';
    if (!empty && !S.outAuto) return;
    $('#outT').value = w.t.toFixed(1); $('#outH').value = w.h;
    S.outAuto = true;
    const hint = $('#outHint');
    hint.hidden = false;
    hint.textContent = S.cfg.weather.label + ' 현재 날씨(' + fmtHM(w.ts) + ' 기준)를 자동 입력했습니다. 다르면 고쳐 주세요.';
    renderLive();
  }

  /* ===================== 설정 탭 ===================== */
  function renderMore() {
    $('#sheetUrl').value = sheetUrl();
    $('#sheetToken').value = sheetToken();
    $('#syncStatus').textContent = S.syncMsg || (sheetUrl() ? '' : '아직 연결되지 않았습니다. 기록은 이 기기에만 저장됩니다.');
    const C = S.cfg;
    $('#cfgInfo').innerHTML = '<dl>' +
      '<dt>설정 파일</dt><dd>' + (S.cfgLoaded ? 'config.json 적용 중' : '⚠ config.json을 읽지 못해 기본값 사용 중') + '</dd>' +
      '<dt>매장</dt><dd>' + esc(C.siteName) + ' (' + esc(C.siteId) + ')</dd>' +
      '<dt>층</dt><dd>' + esc(C.floors.join(', ')) + '</dd>' +
      '<dt>구역</dt><dd>' + esc(C.zones.join(', ')) + Object.keys(C.floorZones || {}).map((f) => ' (' + esc(f) + ': ' + esc(C.floorZones[f].join(', ')) + '만)').join('') + '</dd>' +
      '<dt>쾌적 범위</dt><dd>온도 ' + C.ranges.temp.min + '~' + C.ranges.temp.max + '°C · 습도 ' + C.ranges.humidity.min + '~' + C.ranges.humidity.max + '%</dd>' +
      '<dt>판정 기준</dt><dd>' + levelRangeText() + '</dd>' +
      '<dt>실내외 경고</dt><dd>온도차 ' + C.outdoorDiff.tempWarn + '°C · 습도차 ' + C.outdoorDiff.humidityWarn + '%p 이상</dd>' +
      '<dt>기록 보관</dt><dd>' + S.records.length + '건 (최대 ' + C.retainDays + '일)</dd>' +
      '<dt>' + esc(C.hvac.label) + '</dt><dd>' + (C.hvac.enabled ? C.hvac.count + '대 · ' + C.hvac.perPage + '대씩 · ' + C.hvac.minuteStep + '분 단위 · 기간 제한 없이 보관' : '사용 안 함') + '</dd>' +
      '<dt>' + esc(C.curtain.label) + '</dt><dd>' + (C.curtain.enabled ? C.curtain.groups.reduce((a, g) => a + (Number(g.count) || 0), 0) + '대 · ' + C.curtain.perPage + '대씩 · ' + C.curtain.minuteStep + '분 단위 · 기간 제한 없이 보관' : '사용 안 함') + '</dd>' +
      '<dt>실외 날씨</dt><dd>' + (C.weather.enabled ? esc(C.weather.label) + ' (' + C.weather.lat + ', ' + C.weather.lon + ')' : '사용 안 함') + '</dd></dl>';
  }

  /* ===================== 초기화 ===================== */
  async function init() {
    let loaded = null;
    try { const r = await fetch('config.json', { cache: 'no-cache' }); if (r.ok) loaded = await r.json(); } catch (e) { /* 기본값 사용 */ }
    S.cfgLoaded = !!loaded;
    S.cfg = merge(DEFAULTS, loaded || {});
    const C = S.cfg;
    if (!Array.isArray(C.floors) || !C.floors.length) C.floors = DEFAULTS.floors;
    if (!Array.isArray(C.zones) || !C.zones.length) C.zones = DEFAULTS.zones;
    if (!Array.isArray(C.levels) || !C.levels.length) C.levels = DEFAULTS.levels;
    C.levels[C.levels.length - 1].maxDI = null;
    C.chartDays = Math.max(1, Math.min(31, Number(C.chartDays) || 5));

    loadStore();

    document.title = C.siteName + ' 공조 관리';
    $('#siteName').textContent = C.siteName;
    $('#siteSub').textContent = C.siteSubtitle || '';
    $('#autoNext').checked = S.settings.autoNext !== false;
    $('#chartDaysLabel').textContent = C.chartDays;

    document.body.dataset.tab = 'input';
    renderLocation();
    setLocked(true);
    $('#pinOk').addEventListener('click', checkPin);
    $('#toast').addEventListener('click', hideToast);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideToast(); });
    $('#pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkPin(); });
    $('#pinInput').addEventListener('input', () => { if ($('#pinInput').value.length >= 4) checkPin(); });
    [['#cFloor', '#cZone'], ['#rFloor', '#rZone']].forEach((p) => { fillFilter($(p[0]), C.floors, '전체 층'); fillFilter($(p[1]), C.zones, '전체 구역'); });

    $$('.tabbtn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    ['#inT', '#inH', '#outT', '#outH'].forEach((id) => $(id).addEventListener('input', renderLive));
    $('#saveBtn').addEventListener('click', saveRecord);
    $('#cFloor').addEventListener('change', renderChartTab);
    $('#cZone').addEventListener('change', renderChartTab);
    $('#rFloor').addEventListener('change', renderReport);
    $('#rZone').addEventListener('change', renderReport);
    $('#rDetail').addEventListener('change', renderReport);
    $('#recList').addEventListener('click', (e) => { const id = e.target.getAttribute && e.target.getAttribute('data-del'); if (id) deleteRecord(id); });
    $('#printBtn').addEventListener('click', printReport);
    $('#csvBtn').addEventListener('click', () => {
      const f = $('#rFloor').value, z = $('#rZone').value, from = windowFrom();
      exportCSV(sortedRecs().filter((r) => r.ts >= from && match(r, f, z)), '최근' + C.chartDays + '일');
    });
    $('#csvAll').addEventListener('click', () => exportCSV(sortedRecs(), '전체'));
    $('#wipeBtn').addEventListener('click', () => {
      if (!confirm('이 기기에 저장된 모든 기록을 삭제할까요?\n(구글 시트에 저장된 기록은 지워지지 않습니다)')) return;
      S.settings.deletedIds = S.settings.deletedIds.concat(S.records.filter((r) => r.synced).map((r) => r.id)).slice(-500);
      S.records = []; saveRecords(); saveSettings(); updateBadge(); renderMore(); toast('삭제했습니다');
    });
    $('#sheetSave').addEventListener('click', () => {
      const u = $('#sheetUrl').value.trim();
      if (u && !/^https:\/\//.test(u)) { toast('주소는 https:// 로 시작해야 합니다'); return; }
      S.settings.url = u; S.settings.token = $('#sheetToken').value.trim(); saveSettings();
      S.syncState = 'local'; updateBadge(); toast(u ? '저장했습니다. 동기화를 눌러 확인하세요' : '시트 연결을 해제했습니다');
    });
    $('#syncNow').addEventListener('click', () => {
      S.settings.url = $('#sheetUrl').value.trim(); S.settings.token = $('#sheetToken').value.trim(); saveSettings();
      syncNow(false);
    });
    $('#syncBadge').addEventListener('click', () => { if (sheetUrl()) syncNow(false); else switchTab('more'); });
    window.addEventListener('online', () => syncNow(true));

    ['#outT', '#outH'].forEach((id) => $(id).addEventListener('input', () => { S.outAuto = false; }));
    document.documentElement.style.setProperty('--tab-offset', (Number(C.ui.tabbarBottomOffset) || 0) + 'px');
    if (!C.hvac.enabled) $('.tabbtn[data-tab=hvac]').hidden = true;
    if (!C.curtain.enabled) $('.tabbtn[data-tab=curtain]').hidden = true;
    $$('#rKind .seg').forEach((b) => {
      if ((b.dataset.kind === 'hvac' && !C.hvac.enabled) || (b.dataset.kind === 'curtain' && !C.curtain.enabled)) b.hidden = true;
      b.addEventListener('click', () => setRepKind(b.dataset.kind));
    });

    try { S.weather = JSON.parse(localStorage.getItem(WX_KEY()) || 'null'); } catch (e) { S.weather = null; }
    renderWeather();
    $('#wx').addEventListener('click', () => {
      if (!S.weather) { fetchWeather(); return; }
      $('#outT').value = S.weather.t.toFixed(1); $('#outH').value = S.weather.h; S.outAuto = true;
      renderLive(); switchTab('input'); toast('실외값을 현재 날씨로 채웠습니다');
    });
    if (C.weather.enabled) {
      fetchWeather();
      setInterval(fetchWeather, Math.max(2, Number(C.weather.refreshMin) || 10) * 60000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && (!S.weather || Date.now() - S.weather.ts > 5 * 60000)) fetchWeather();
      });
    }

    fillOutdoorFromCache();
    updateBadge();
    renderMore();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    if (sheetUrl() && navigator.onLine !== false) syncNow(true);
  }

  // 다른 파일(usage.js)에서 쓰는 공통 기능
  window.MC = {
    ready: false, openReport, S, $, $$, esc, pad, DAY, fmtYMD, fmtMD, fmtHM, dayStart,
    toast, ensureChart, sheetUrl, sheetToken, updateBadge, syncNow
  };
  init().then(() => {
    window.MC.ready = true;
    document.dispatchEvent(new Event('mc-ready'));
  });
})();
