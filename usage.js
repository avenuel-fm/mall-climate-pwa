/* 사용시간 모듈: 공조기 / 에어커튼 공용
 * - 가동 시작·종료 시각 입력(오전/오후, 시, 10분 단위), 미가동(0시간) 체크
 * - 기록은 기간 제한 없이 이 기기(IndexedDB)와 구글 시트에 계속 저장
 * - 리포트(리포트 탭): 기간별 통계, 최근 3일 비교(전일보다 길면 빨강/짧으면 파랑), 미입력 대수
 * 설정(대수/그룹, 페이지당 개수, 분 단위, 기본 시각)은 config.json 의 "hvac", "curtain" 항목 */
(function () {
  'use strict';

  async function boot() {
    const M = window.MC;
    const { S, $, $$, esc, pad } = M;
    const C = S.cfg;
    const PULL_DAYS = 7;                       // 평소 동기화 때 시트에서 가져오는 최근 일수
    const OLD_MSG = '구글 시트 스크립트가 예전 버전입니다. 새 Code.gs로 교체하고 [새 버전]으로 다시 배포하세요 (README 4번)';
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const todayStr = () => M.fmtYMD(Date.now());
    const wideMQ = window.matchMedia('(min-width: 1100px)');
    const isWide = () => wideMQ.matches;

    /* ===================== 시간 변환 ===================== */
    function parseHM(v, d) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
      return m ? Math.min(1439, Number(m[1]) * 60 + Number(m[2])) : d;
    }
    function toMin(ap, h, m) {
      if (!ap || !h || m === '') return null;
      let hh = Number(h) % 12; if (ap === 'pm') hh += 12;
      return hh * 60 + Number(m);
    }
    function parts(min) {
      if (min == null) return ['', '', ''];
      if (min >= 1440) return ['am', '12', '0'];
      const h24 = Math.floor(min / 60);
      return [h24 < 12 ? 'am' : 'pm', String(h24 % 12 || 12), String(min % 60)];
    }
    const mkDraft = (s, e) => { const a = parts(s), b = parts(e); return { sAp: a[0], sH: a[1], sM: a[2], eAp: b[0], eH: b[1], eM: b[2], off: false }; };
    const fmtDur = (m) => Math.floor(m / 60) + '시간' + (m % 60 ? ' ' + pad(m % 60) + '분' : '');
    const timeLabel = (m) => { const p = parts(m); return (p[0] === 'am' ? '오전 ' : '오후 ') + p[1] + ':' + pad(p[2]); };
    const hrs = (min) => (min / 60).toFixed(1) + 'h';
    // 가동 분: 미가동=0, 시작·종료 있으면 차이, 아니면 null(입력 없음)
    function runMin(r) {
      if (!r) return null;
      if (r.off) return 0;
      return r.startMin != null && r.endMin != null ? r.endMin - r.startMin : null;
    }
    const ukey = (r) => String(r.unit);

    /* ===================== 저장소: IndexedDB (기간 제한 없음) ===================== */
    const DBN = 'mallclimate-' + C.siteId;
    const FB_KEY = 'mallclimate:' + C.siteId + ':usage-fallback';
    let db = null;
    function openDB() {
      return new Promise((resolve) => {
        if (!window.indexedDB) { resolve(null); return; }
        let req;
        try { req = indexedDB.open(DBN, 1); } catch (e) { resolve(null); return; }
        req.onupgradeneeded = () => { req.result.createObjectStore('usage', { keyPath: 'key' }); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
    }
    const idbAll = () => new Promise((res, rej) => {
      const rq = db.transaction('usage', 'readonly').objectStore('usage').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
    });
    const idbPut = (list) => new Promise((res, rej) => {
      if (!list.length) { res(); return; }
      const tx = db.transaction('usage', 'readwrite'), os = tx.objectStore('usage');
      list.forEach((o) => os.put(o));
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
    const idbClear = () => new Promise((res, rej) => {
      const tx = db.transaction('usage', 'readwrite'); tx.objectStore('usage').clear();
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });

    /* ===================== 종류(공조기/에어커튼) 정의 ===================== */
    const kinds = {};
    function makeKind(id, cfg, rootSel, defLabel) {
      const root = $(rootSel);
      if (!cfg || !cfg.enabled || !root) return null;
      const label = cfg.label || defLabel;
      const units = [];
      const fg = id === 'hvac' && Array.isArray(cfg.floorGroups) && cfg.floorGroups.length ? cfg.floorGroups : null;
      if (fg) {
        // 층별 묶음: 층마다 이름·색·기본 종료시각을 따로 가질 수 있음
        fg.forEach((g) => (g.units || []).forEach((i) => {
          const name = (g.names && g.names[i]) || g.name + ' ' + i + '번 ' + label;
          units.push({ key: String(i), val: Number(i), grp: '', title: name, full: name, tone: g.tone || '', floor: g.name,
            defStart: g.defaultStart ? parseHM(g.defaultStart, null) : null,
            defEnd: g.defaultEnd ? parseHM(g.defaultEnd, null) : null, endByDay: g.defaultEndByDay || null });
        }));
      } else if (id === 'hvac') {
        const n = Math.max(1, Number(cfg.count) || 39);
        for (let i = 1; i <= n; i++) units.push({ key: String(i), val: i, grp: '', title: i + '번 ' + label, full: i + '번 ' + label });
      } else {
        const toneOf = (g) => /^B1/.test(g.key) ? 'b1' : /^1.*OUT$/.test(g.key) ? 'f1out' : /^1.*IN$/.test(g.key) ? 'f1in' : /^1/.test(g.key) ? 'f1' : /^4/.test(g.key) ? 'f4' : /^6/.test(g.key) ? 'f6' : '';
        (cfg.groups || []).forEach((g) => {
          const cnt = Math.max(1, Number(g.count) || 1);
          for (let n = 1; n <= cnt; n++) {
            const key = g.key + '-' + n;
            units.push(g.single
              ? { key, val: key, grp: '', title: g.name, full: g.name, tone: toneOf(g) }
              : { key, val: key, grp: g.name, title: n + '번', full: g.name + ' ' + n + '번', tone: toneOf(g) });
          }
        });
      }
      const step = [5, 10, 15, 20, 30, 60].includes(Number(cfg.minuteStep)) ? Number(cfg.minuteStep) : 10;
      const K = {
        id, label, cfg, root, units, unitMap: new Map(units.map((u) => [u.key, u])),
        per: Math.max(1, Number(cfg.perPage) || 5), step,
        defStart: parseHM(cfg.defaultStart, 600), defEnd: parseHM(cfg.defaultEnd, 1200),
        endByDay: cfg.defaultEndByDay || {},
        editDays: Math.max(1, Number(cfg.editDays) || 31),
        map: new Map(), drafts: {}, date: todayStr(), page: 0,
        draftKey: 'mallclimate:' + C.siteId + ':usage-drafts:' + id
      };
      // 폰 페이지: 층 묶음이 있으면 한 페이지 = 한 층, 아니면 perPage 대씩
      K.pageUnits = []; K.pageLabels = []; K.pageTitles = [];
      if (fg) {
        fg.forEach((g) => {
          const pu = units.filter((u) => u.floor === g.name);
          if (!pu.length) return;
          K.pageUnits.push(pu); K.pageLabels.push(g.name); K.pageTitles.push(g.name + ' ' + label + ' ' + pu.length + '대');
        });
      } else {
        for (let a = 0; a < units.length; a += K.per) {
          const b = Math.min(units.length, a + K.per);
          K.pageUnits.push(units.slice(a, b)); K.pageLabels.push((a + 1) + '–' + b);
          K.pageTitles.push(id === 'hvac' ? (a + 1) + '~' + b + '번 ' + label : label + ' ' + (a + 1) + '~' + b);
        }
      }
      K.pages = K.pageUnits.length;
      K.byFloor = !!fg;
      // PC 전체 화면: 구역별 열 (zoneRows). 어느 구역에도 없는 장비는 '구역 미지정' 열
      if (Array.isArray(cfg.zoneRows) && cfg.zoneRows.length) {
        const map = new Map(units.map((u) => [u.key, u])), used = new Set();
        K.zoneRows = cfg.zoneRows.map((z) => ({
          name: z.name, units: (z.units || []).map(String).filter((k) => map.has(k) && !used.has(k) && used.add(k)).map((k) => map.get(k))
        }));
        K.zoneRest = units.filter((u) => !used.has(u.key));
      }
      K.rid = (date, key) => date + '|' + key;
      kinds[id] = K;
      return K;
    }
    makeKind('hvac', C.hvac, '#tab-hvac', '공조기');
    makeKind('curtain', C.curtain, '#tab-curtain', '에어커튼');
    const KL = Object.keys(kinds).map((k) => kinds[k]);
    if (!KL.length) return;

    /* ===================== 불러오기 / 저장 ===================== */
    db = await openDB();
    let rows = [];
    if (db) { try { rows = await idbAll(); } catch (e) { db = null; } }
    if (!db) { try { rows = JSON.parse(localStorage.getItem(FB_KEY) || '[]'); } catch (e) { rows = []; } }
    rows.forEach((r) => { const K = kinds[r.kind]; if (K && r.id) K.map.set(r.id, r); });
    KL.forEach((K) => { try { K.drafts = JSON.parse(localStorage.getItem(K.draftKey) || '{}') || {}; } catch (e) { K.drafts = {}; } });

    function saveDrafts(K) { try { localStorage.setItem(K.draftKey, JSON.stringify(K.drafts)); } catch (e) { /* 무시 */ } }
    function persist(K, list) {
      list.forEach((r) => { r.key = K.id + '|' + r.id; r.kind = K.id; });
      if (db) return idbPut(list).catch(() => M.toast('기록을 저장하지 못했을 수 있습니다. 기기 저장 공간을 확보한 뒤 [저장]을 다시 누르세요', true));
      try {
        const all = []; KL.forEach((k) => k.map.forEach((r) => all.push(r)));
        localStorage.setItem(FB_KEY, JSON.stringify(all));
      } catch (e) { M.toast('이 브라우저에서는 기록을 저장하지 못했습니다. 시크릿 모드가 아닌 창에서 다시 저장하세요', true); }
      return Promise.resolve();
    }

    // 예전 버전(공조기 localStorage 기록) 이전
    (function migrate() {
      const K = kinds.hvac, legacyKey = 'mallclimate:' + C.siteId + ':hvac';
      if (!K) return;
      let old; try { old = JSON.parse(localStorage.getItem(legacyKey) || 'null'); } catch (e) { old = null; }
      if (!Array.isArray(old) || !old.length) return;
      const list = [];
      old.forEach((o) => {
        if (!o || !DATE_RE.test(o.date) || !K.unitMap.has(String(o.unit))) return;
        const id = K.rid(o.date, String(o.unit));
        if (K.map.has(id)) return;
        const r = { id, site: C.siteId, date: o.date, unit: Number(o.unit), startMin: o.startMin == null ? null : o.startMin, endMin: o.endMin == null ? null : o.endMin, off: false, updatedAt: o.updatedAt || Date.now(), synced: !!o.synced };
        K.map.set(id, r); list.push(r);
      });
      persist(K, list).then(() => { try { localStorage.removeItem(legacyKey); localStorage.removeItem(legacyKey + ':drafts'); } catch (e) { /* 무시 */ } });
    })();

    /* ===================== 드래프트 / 입력 규칙 ===================== */
    // 요일별 기본 종료시각 (config 의 defaultEndByDay: 0=일 … 6=토). 입력 화면에서 고른 날짜의 요일 기준
    // 장비(u)에 층별 종료시각이 있으면 그것을 우선
    const endFor = (K, date, u) => {
      const dow = new Date(String(date).replace(/-/g, '/') + ' 00:00:00').getDay();
      const def = u && u.defEnd != null ? u.defEnd : K.defEnd, byDay = (u && u.endByDay) || K.endByDay;
      return byDay[dow] != null ? parseHM(byDay[dow], def) : def;
    };
    const startFor = (K, u) => (u && u.defStart != null ? u.defStart : K.defStart);
    const defaultDraft = (K, u) => mkDraft(startFor(K, u), endFor(K, K.date, u));
    function recToDraft(K, r, u) {
      if (!r) return defaultDraft(K, u);
      if (r.off) return Object.assign(defaultDraft(K, u), { off: true });
      return mkDraft(r.startMin, r.endMin);
    }
    function getDraft(K, key) {
      const k = K.rid(K.date, key);
      return K.drafts[k] || recToDraft(K, K.map.get(k), K.unitMap.get(key));
    }
    function parseDraft(d) {
      const out = { startMin: null, endMin: null, off: false, err: '', empty: false };
      if (d.off) { out.off = true; return out; }
      const sv = [d.sAp, d.sH, d.sM], ev = [d.eAp, d.eH, d.eM];
      const sCnt = sv.filter((x) => x !== '').length, eCnt = ev.filter((x) => x !== '').length;
      if (sCnt === 0 && eCnt === 0) { out.empty = true; return out; }
      if ((sCnt > 0 && sCnt < 3) || (eCnt > 0 && eCnt < 3)) { out.err = '시각의 오전/오후·시·분을 모두 선택하세요'; return out; }
      if ((sCnt === 3) !== (eCnt === 3)) { out.err = '시작과 종료 시각을 모두 입력하세요'; return out; }
      const s = toMin(sv[0], sv[1], sv[2]); let e = toMin(ev[0], ev[1], ev[2]);
      if (e <= s) { if (e === 0) e = 1440; else { out.err = '종료가 시작보다 빠릅니다'; return out; } }
      out.startMin = s; out.endMin = e;
      return out;
    }
    function sameAsSaved(rec, p) {
      if (!rec) return p.empty;
      return !!rec.off === p.off && (rec.startMin == null ? null : rec.startMin) === p.startMin && (rec.endMin == null ? null : rec.endMin) === p.endMin;
    }

    /* ===================== 입력 화면 ===================== */
    const optsAP = '<option value="">구분</option><option value="am">오전</option><option value="pm">오후</option>';
    const optsH = '<option value="">시</option>' + Array.from({ length: 12 }, (_, i) => '<option value="' + (i + 1) + '">' + (i + 1) + '시</option>').join('');
    // name: 화면 낭독기가 읽는 이름 (예: "6층 39번 공조기 시작 시")
    const sel = (f, opts, v, name) => '<select data-f="' + f + '" aria-label="' + esc(name) + '">' + opts.replace('value="' + v + '"', 'value="' + v + '" selected') + '</select>';
    const optsMin = (K) => { let o = '<option value="">분</option>'; for (let m = 0; m < 60; m += K.step) o += '<option value="' + m + '">' + pad(m) + '분</option>'; return o; };

    function cardHTML(K, u) {
      const d = getDraft(K, u.key), om = optsMin(K), n = u.full + ' ';
      return '<div class="hv-card" data-key="' + esc(u.key) + '"><div class="hv-head"><div class="hv-name"' + (u.tone ? ' data-tone="' + u.tone + '"' : '') + '>' +
        (u.grp ? '<small class="hv-grp">' + esc(u.grp) + '</small>' : '') + '<b>' + esc(u.title) + '</b></div>' +
        '<label class="hv-off"><input type="checkbox" data-f="off"' + (d.off ? ' checked' : '') + ' aria-label="' + esc(n + '미가동') + '"><span>미가동</span></label></div>' +
        '<div class="hv-row"><span>시작</span>' + sel('sAp', optsAP, d.sAp, n + '시작 오전/오후') + sel('sH', optsH, d.sH, n + '시작 시') + sel('sM', om, d.sM, n + '시작 분') + '</div>' +
        '<div class="hv-row"><span>종료</span>' + sel('eAp', optsAP, d.eAp, n + '종료 오전/오후') + sel('eH', optsH, d.eH, n + '종료 시') + sel('eM', om, d.eM, n + '종료 분') + '</div>' +
        '<div class="hv-foot"><span class="hv-sum"></span><span class="hv-state"></span></div></div>';
    }

    function refreshCard(K, key) {
      const card = $('.hv-card[data-key="' + key + '"]', K.root);
      if (!card) return;
      const d = getDraft(K, key), p = parseDraft(d), rec = K.map.get(K.rid(K.date, key));
      const stEl = $('.hv-state', card), sum = $('.hv-sum', card);
      card.classList.toggle('invalid', !!p.err);
      card.classList.toggle('off', p.off);
      $$('select', card).forEach((s) => { s.disabled = p.off; });
      let cls = '', txt = '';
      if (p.err) { cls = 'err'; txt = '입력 확인'; }
      else if (sameAsSaved(rec, p)) { if (rec) { cls = 'ok'; txt = '저장됨'; } }
      else { cls = 'warn'; txt = '미저장'; }
      stEl.className = 'hv-state ' + cls; stEl.textContent = txt;
      if (p.err) sum.innerHTML = '<span class="e">' + esc(p.err) + '</span>';
      else if (p.off) sum.innerHTML = '미가동 · <b>0시간</b>';
      else if (p.startMin != null) sum.innerHTML = '가동 <b>' + fmtDur(p.endMin - p.startMin) + '</b>';
      else sum.textContent = '입력 없음';
    }

    // 화면에 보이는 단위 범위 (PC: 전체, 폰: 현재 페이지)
    function visibleUnits(K) {
      if (isWide()) return K.units;
      return K.pageUnits[K.page] || [];
    }

    // PC 표: 가로(열)=구역, 세로(행)=층. 열 너비는 그 구역에서 가장 많은 칸의 대수에 맞춤
    // 구역 미지정 장비: 그 층에 구역 장비가 하나도 없으면(예: B3층) 그 줄 전체에 펼쳐 놓고, 아니면 '구역 미지정' 열을 따로 둠
    function matrixHTML(K) {
      const rest = K.zoneRest || [], inRow = (list, p) => list.filter((u) => u.floor === p[0].floor);
      const spanRest = K.pageUnits.every((p) => !inRow(rest, p).length || K.zoneRows.every((z) => !inRow(z.units, p).length));
      const Z = rest.length && !spanRest ? K.zoneRows.concat([{ name: '구역 미지정', units: rest }]) : K.zoneRows;
      const cols = Z.map((z) => Math.max(1, ...K.pageUnits.map((p) => inRow(z.units, p).length)));
      const cell = (n, list, extra) => '<div class="hv-cell" style="' + (extra || '') + 'grid-template-columns:repeat(' + n + ',minmax(0,1fr))">' + list.map((u) => cardHTML(K, u)).join('') + '</div>';
      return '<div class="hv-matrix" style="grid-template-columns:54px ' + cols.map((c) => c + 'fr').join(' ') + '">' +
        '<div class="hv-corner">전체 ' + K.units.length + '대</div>' + Z.map((z) => '<div class="hv-zname">' + esc(z.name) + ' <small>' + z.units.length + '대</small></div>').join('') +
        K.pageUnits.map((p) => {
          const spread = spanRest && inRow(rest, p).length;
          return '<div class="hv-fname" data-tone="' + esc(p[0].tone || '') + '">' + esc(p[0].floor) + (spread ? '<small>구역 미지정</small>' : '') + '</div>' +
            (spread ? cell(cols.reduce((a, b) => a + b, 0), inRow(rest, p), 'grid-column:span ' + Z.length + ';')
              : Z.map((z, i) => cell(cols[i], inRow(z.units, p))).join(''));
        }).join('') + '</div>';
    }

    function renderInput(K) {
      const wide = isWide();
      if (wide) K.page = 0;
      const vu = visibleUnits(K), zoned = wide && !!K.zoneRows && !!K.byFloor, list = $('.js-list', K.root);
      $('.js-title', K.root).textContent = wide ? '전체 ' + K.units.length + '대 ' + K.label : K.pageTitles[K.page];
      $('.js-count', K.root).textContent = wide ? '' : (K.page + 1) + ' / ' + K.pages + ' 페이지';
      list.classList.toggle('zoned', zoned);
      K.root.classList.toggle('is-zoned', zoned);
      list.innerHTML = zoned ? matrixHTML(K) : vu.map((u) => cardHTML(K, u)).join('');
      vu.forEach((u) => refreshCard(K, u.key));
      $('.js-prev', K.root).disabled = K.page <= 0;
      $('.js-next', K.root).disabled = K.page >= K.pages - 1;
      $('.js-chips', K.root).innerHTML = K.pageLabels.map((t, i) =>
        '<button type="button" class="hv-chip" data-page="' + i + '"' + (i === K.page ? ' aria-current="true"' : '') + '>' + esc(t) + '</button>').join('');
      const di = $('.js-date', K.root);
      // 층별로 시각이 다른 경우 안내에 함께 표시 (예: 6층 오후 9:50, B3층 오전 8:30 ~ 오후 6:40)
      const own = K.units.filter((u, i, a) => (u.defEnd != null || u.defStart != null) && (!i || a[i - 1].floor !== u.floor))
        .map((u) => u.floor + ' ' + (u.defStart != null ? timeLabel(u.defStart) + ' ~ ' : '') + timeLabel(endFor(K, K.date, u)));
      $('.js-defs', K.root).textContent = timeLabel(K.defStart) + ' ~ ' + timeLabel(endFor(K, K.date)) + (own.length ? ', ' + own.join(', ') : '');
      di.value = K.date; di.max = todayStr(); di.min = M.fmtYMD(M.dayStart(Date.now(), -(K.editDays - 1)));
    }

    function goPage(K, p) {
      K.page = Math.max(0, Math.min(K.pages - 1, p));
      renderInput(K);
      window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }

    function onFieldChange(K, e) {
      const f = e.target.getAttribute('data-f'), card = e.target.closest('.hv-card');
      if (!f || !card) return;
      const key = card.dataset.key, k = K.rid(K.date, key);
      if (!K.drafts[k]) K.drafts[k] = recToDraft(K, K.map.get(k), K.unitMap.get(key));
      K.drafts[k][f] = f === 'off' ? e.target.checked : e.target.value;
      saveDrafts(K);
      refreshCard(K, key);
    }

    // 저장: ① 직접 바꾼 항목(모든 페이지) ② 지금 화면에 보이는 항목 중 아직 기록이 없는 것(기본 시각 그대로)
    function saveAll(K) {
      const date = K.date, now = Date.now(), vis = new Set(visibleUnits(K).map((u) => u.key));
      let n = 0, errKey = '', errMsg = '';
      const changed = [];
      K.units.forEach((u) => {
        const k = K.rid(date, u.key), rec = K.map.get(k);
        let d = K.drafts[k];
        if (!d) { if (vis.has(u.key) && !rec) d = defaultDraft(K, u); else return; }
        const p = parseDraft(d);
        if (p.err) { if (!errKey) { errKey = u.key; errMsg = p.err; } return; }
        if (!rec && p.empty) { delete K.drafts[k]; return; }
        if (rec && sameAsSaved(rec, p)) { delete K.drafts[k]; return; }
        const nr = { id: k, site: C.siteId, date, unit: u.val, grp: u.grp, startMin: p.startMin, endMin: p.endMin, off: p.off, updatedAt: now, synced: false };
        K.map.set(k, nr); changed.push(nr);
        delete K.drafts[k]; n++;
      });
      saveDrafts(K);
      persist(K, changed);
      M.updateBadge();
      if (errKey) {
        if (!isWide()) K.page = Math.max(0, K.pageUnits.findIndex((p) => p.some((u) => u.key === errKey)));
        renderInput(K);
        M.toast((n ? n + '대 저장 · ' : '') + K.unitMap.get(errKey).full + ': ' + errMsg);
      } else {
        renderInput(K);
        M.toast(n ? n + '대 저장했습니다 (' + date + ')' : '저장할 변경 내용이 없습니다');
      }
      if (n && M.sheetUrl()) M.syncNow(true);
    }

    /* ===================== 리포트 ===================== */
    const rep = { period: '30', sort: 'num' };
    const PERIODS = { '30': ['30일', 30], '90': ['90일', 90], '365': ['1년', 365], all: ['전체', null] };
    let repSeq = 0;

    function computeStats(K, periodKey) {
      const days = PERIODS[periodKey][1];
      const today = todayStr();
      const from = days ? M.fmtYMD(M.dayStart(Date.now(), -(days - 1))) : '0000-00-00';
      const lastDays = [-4, -3, -2, -1].map((o) => M.fmtYMD(M.dayStart(Date.now(), o)));
      const per = new Map(K.units.map((u) => [u.key, { u, days: 0, totalMin: 0, cmp: [null, null, null, null] }]));
      const dayAgg = new Map();
      const dayTotals = [null, null, null, null];
      const todayEntered = new Set();
      let nRec = 0, totalMin = 0, totalRecs = 0, oldest = null;
      K.map.forEach((r) => {
        const m = runMin(r);
        if (m == null) return;
        const key = ukey(r), p = per.get(key);
        if (!p) return;
        totalRecs++;
        if (!oldest || r.date < oldest) oldest = r.date;
        if (r.date >= from && r.date <= today) {
          p.days++; p.totalMin += m; nRec++; totalMin += m;
          let d = dayAgg.get(r.date); if (!d) { d = { n: 0, total: 0 }; dayAgg.set(r.date, d); }
          d.n++; d.total += m;
        }
        const li = lastDays.indexOf(r.date);
        if (li >= 0) { p.cmp[li] = m; dayTotals[li] = (dayTotals[li] || 0) + m; }
        if (r.date === today) todayEntered.add(key);
      });
      return { days, from, today, per, dayAgg, dayTotals, lastDays, todayEntered, nRec, totalMin, totalRecs, oldest };
    }

    // 전일보다 길면 빨강(▲), 짧으면 파랑(▼)
    function cmpCell(arr, i) {
      const v = arr[i];
      if (v == null) return '—';
      const t = hrs(v), prev = arr[i - 1];
      if (prev != null && v > prev) return '<span class="up">▲ ' + t + '</span>';
      if (prev != null && v < prev) return '<span class="down">▼ ' + t + '</span>';
      return t;
    }

    async function renderReport(kindId, el) {
      const K = kinds[kindId];
      if (!K) { el.innerHTML = '<p class="hint">사용하지 않는 항목입니다. (config.json에서 enabled 확인)</p>'; return; }
      const seq = ++repSeq;
      const st = computeStats(K, rep.period);
      const plabel = PERIODS[rep.period][0];
      const total = K.units.length;
      const missing = K.units.filter((u) => !st.todayEntered.has(u.key));
      const todayAgg = st.dayAgg.get(st.today);

      let html = '<h1>' + esc(C.siteName) + ' ' + esc(K.label) + ' 사용시간 리포트</h1>' +
        '<p class="meta">기간 ' + (st.days ? st.from : (st.oldest || st.today)) + ' ~ ' + st.today + ' (' + plabel + ') · 출력 ' + M.fmtYMD(Date.now()) + ' ' + M.fmtHM(Date.now()) + '</p>';

      // 요약 (오늘 입력 현황은 '미입력 대수'를 보여줌)
      const kp = (l, v, cls) => '<div class="kpi"><span>' + l + '</span><strong' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</strong></div>';
      html += '<h3>요약</h3><div class="kpis">' +
        kp('오늘 미입력', missing.length ? missing.length + '대 / ' + total + '대' : '전체 입력 완료', missing.length ? 'up' : '') +
        kp('오늘 가동시간 합계', todayAgg ? (todayAgg.total / 60).toFixed(1) + '시간' : '—') +
        kp('1대 1일 평균 가동', st.nRec ? (st.totalMin / 60 / st.nRec).toFixed(1) + '시간' : '—') +
        kp(plabel + ' 합계', (st.totalMin / 60).toFixed(1) + '시간') +
        kp('기록된 날', st.dayAgg.size + '일') +
        kp('누적 기록', st.totalRecs + '건') + '</div>';
      if (missing.length) {
        const names = missing.slice(0, 14).map((u) => u.full).join(', ');
        html += '<p class="hint">오늘 미입력: ' + esc(names) + (missing.length > 14 ? ' 외 ' + (missing.length - 14) + '대' : '') + '</p>';
      }

      // 최근 3일 비교
      const dl = st.lastDays.slice(1).map((d) => M.fmtMD(new Date(d.replace(/-/g, '/')).getTime()));
      const rows = Array.from(st.per.values());
      if (rep.sort === 'desc') rows.sort((a, b) => (b.days ? b.totalMin / b.days : -1) - (a.days ? a.totalMin / a.days : -1));
      if (rep.sort === 'asc') rows.sort((a, b) => (a.days ? a.totalMin / a.days : 1e9) - (b.days ? b.totalMin / b.days : 1e9));
      const maxAvg = Math.max(60, ...rows.map((r) => (r.days ? r.totalMin / r.days : 0)));
      html += '<h3>' + esc(K.label) + ' 사용시간 (오늘 제외 최근 3일 비교)</h3>' +
        '<p class="hint"><span class="up">▲ 빨강</span> 전날보다 가동시간이 길어짐 · <span class="down">▼ 파랑</span> 전날보다 짧아짐 · — 미입력</p>' +
        '<div class="scroll"><table class="hv-table"><thead><tr><th class="l">' + esc(K.label) + '</th><th>입력일</th><th>1일 평균</th><th></th><th>' + plabel + ' 합계</th>' +
        dl.map((d, i) => '<th>' + (3 - i) + '일 전<br><small>' + d + '</small></th>').join('') + '</tr></thead><tbody>' +
        '<tr class="tot"><td class="l">전체 합계</td><td>' + st.dayAgg.size + '</td><td>' + (st.nRec ? hrs(st.totalMin / st.nRec) : '—') + '</td><td></td><td>' + hrs(st.totalMin) + '</td>' +
        [1, 2, 3].map((i) => '<td>' + cmpCell(st.dayTotals, i) + '</td>').join('') + '</tr>' +
        rows.map((r) => {
          const avg = r.days ? r.totalMin / r.days : null;
          return '<tr' + (r.days ? '' : ' class="dim"') + '><td class="l">' + esc(r.u.full) + '</td><td>' + r.days + '</td><td>' + (avg == null ? '—' : fmtDur(Math.round(avg))) +
            '</td><td><div class="hv-bar"><i style="width:' + (avg == null ? 0 : avg / maxAvg * 100) + '%"></i></div></td><td>' + (r.days ? hrs(r.totalMin) : '—') + '</td>' +
            [1, 2, 3].map((i) => '<td>' + cmpCell(r.cmp, i) + '</td>').join('') + '</tr>';
        }).join('') + '</tbody></table></div>';

      // 그래프
      html += '<h3>일별 사용시간 추이</h3><div id="usageChartSlot"></div>';

      // 일별 기록 (최근 31일)
      const nDays = Math.min(31, st.days || 31);
      let drows = '';
      for (let i = 0; i < nDays; i++) {
        const ds = M.fmtYMD(M.dayStart(Date.now(), -i)), a = st.dayAgg.get(ds);
        drows += '<tr' + (a ? '' : ' class="dim"') + '><td class="l">' + ds + '</td><td>' + (a ? a.n + ' / ' + total : '미입력') + '</td><td>' + (a ? hrs(a.total) : '—') + '</td><td>' + (a ? hrs(a.total / a.n) : '—') + '</td></tr>';
      }
      html += '<h3>일일 기록 (최근 ' + nDays + '일)</h3><div class="scroll"><table class="hv-table"><thead><tr><th class="l">날짜</th><th>입력 대수</th><th>합계</th><th>1대 평균</th></tr></thead><tbody>' + drows + '</tbody></table></div>' +
        '<p class="foot">이 기기에 저장된 ' + esc(K.label) + ' 기록 ' + st.totalRecs + '건' + (st.oldest ? ' (' + st.oldest + ' ~)' : '') + ' · 기록은 기간 제한 없이 계속 보관됩니다. 전체 일별 기록은 CSV로 저장하세요. 미가동은 0시간으로 계산합니다.</p>';
      el.innerHTML = html;

      // 그래프는 인쇄 품질을 위해 이미지로 변환
      try {
        await M.ensureChart();
        if (seq !== repSeq) return;
        const monthly = !st.days || st.days > 120;
        const keys = Array.from(st.dayAgg.keys()).sort();
        let labels = [], tot = [], avgs = [];
        if (monthly) {
          const mm = new Map();
          keys.forEach((k) => { const m = k.slice(0, 7), d = st.dayAgg.get(k); const a = mm.get(m) || { total: 0, n: 0 }; a.total += d.total; a.n += d.n; mm.set(m, a); });
          Array.from(mm.keys()).sort().forEach((m) => { const a = mm.get(m); labels.push(m); tot.push(Math.round(a.total / 6) / 10); avgs.push(Math.round(a.total / a.n / 6) / 10); });
        } else {
          for (let i = st.days - 1; i >= 0; i--) {
            const ds = M.fmtYMD(M.dayStart(Date.now(), -i)), a = st.dayAgg.get(ds);
            labels.push(M.fmtMD(M.dayStart(Date.now(), -i))); tot.push(a ? Math.round(a.total / 6) / 10 : 0); avgs.push(a ? Math.round(a.total / a.n / 6) / 10 : null);
          }
        }
        const slot = $('#usageChartSlot');
        if (!slot) return;
        if (!keys.length) { slot.innerHTML = '<p class="hint">이 기간에 저장된 기록이 없습니다</p>'; return; }
        const cv = document.createElement('canvas'); cv.width = 900; cv.height = 380;
        const ch = new window.Chart(cv, {
          type: 'bar',
          data: { labels, datasets: [
            { type: 'bar', label: monthly ? '월 합계(시간)' : '일 합계(시간)', data: tot, yAxisID: 'y', backgroundColor: '#0f766e', borderRadius: 3 },
            { type: 'line', label: '1대 평균(시간)', data: avgs, yAxisID: 'y2', borderColor: '#d9480f', backgroundColor: '#d9480f', borderWidth: 2.5, pointRadius: 2.5, tension: 0.2, spanGaps: true }
          ] },
          options: { responsive: false, animation: false, devicePixelRatio: 2,
            plugins: { legend: { position: 'bottom', labels: { usePointStyle: true } } },
            scales: { x: { ticks: { autoSkip: true, maxTicksLimit: 12, maxRotation: 0 } },
              y: { beginAtZero: true, suggestedMax: monthly ? undefined : 500, title: { display: true, text: '합계(시간)' } },
              y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: '1대 평균(시간)' } } } }
        });
        const url = ch.toBase64Image(); ch.destroy();
        slot.innerHTML = '<img class="chartimg" alt="사용시간 추이 그래프" src="' + url + '">';
      } catch (e) {
        const slot = $('#usageChartSlot');
        if (slot) slot.innerHTML = '<p class="hint">그래프 라이브러리를 불러오지 못해 그래프를 넣지 못했습니다.</p>';
      }
    }

    /* ===================== 내보내기 / 백업 / 복원 ===================== */
    function download(name, text, mime) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime }));
      a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    const stamp = () => todayStr().replace(/-/g, '');
    const safeName = () => C.siteName.replace(/[\\/:*?"<>|\s]/g, '');
    const csvCell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

    function exportCSV(kindId) {
      const K = kinds[kindId]; if (!K) return;
      const recs = Array.from(K.map.values()).filter((r) => runMin(r) != null && K.unitMap.has(ukey(r)))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : K.units.indexOf(K.unitMap.get(ukey(a))) - K.units.indexOf(K.unitMap.get(ukey(b)))));
      if (!recs.length) { M.toast('내보낼 기록이 없습니다'); return; }
      const head = ['날짜', K.label, '가동시작', '가동종료', '가동시간(시간)', '미가동', '시트전송'];
      const out = recs.map((r) => [r.date, K.unitMap.get(ukey(r)).full, r.off ? '' : timeLabel(r.startMin), r.off ? '' : timeLabel(r.endMin), Math.round(runMin(r) / 6) / 10, r.off ? 'Y' : '', r.synced ? 'Y' : '']);
      download(safeName() + '_' + K.label + '_사용기록_' + stamp() + '.csv', '﻿' + [head].concat(out).map((x) => x.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
      M.toast('CSV 저장: ' + recs.length + '건 (기간 전체)');
    }
    function exportBackup() {
      const all = []; KL.forEach((K) => K.map.forEach((r) => all.push(Object.assign({}, r, { kind: K.id }))));
      all.forEach((r) => { delete r.key; });
      download(safeName() + '_사용시간백업_' + stamp() + '.json', JSON.stringify({ type: 'mallclimate-usage', version: 2, site: C.siteId, exportedAt: Date.now(), records: all }), 'application/json');
      M.toast('백업 파일을 저장했습니다 (' + all.length + '건)');
    }

    // 같은 날짜·번호는 updatedAt이 최신인 쪽을 사용. 변경된 기록은 저장소에 반영
    function mergeRecords(K, list, fromSheet) {
      let n = 0; const changed = [];
      list.forEach((r) => {
        if (!r || typeof r.date !== 'string' || !DATE_RE.test(r.date)) return;
        const key = String(r.unit), u = K.unitMap.get(key);
        if (!u) return;
        const id = K.rid(r.date, key), cur = K.map.get(id);
        if (cur && cur.updatedAt >= (r.updatedAt || 0)) { if (fromSheet && cur.updatedAt === r.updatedAt && !cur.synced) { cur.synced = true; changed.push(cur); } return; }
        const nr = { id, site: C.siteId, date: r.date, unit: u.val, grp: u.grp, startMin: r.startMin == null ? null : Number(r.startMin), endMin: r.endMin == null ? null : Number(r.endMin), off: !!r.off, updatedAt: r.updatedAt || Date.now(), synced: !!fromSheet };
        K.map.set(id, nr); changed.push(nr); delete K.drafts[id]; n++;
      });
      return { n, changed };
    }
    function importBackup(file) {
      const fr = new FileReader();
      fr.onload = async () => {
        try {
          const j = JSON.parse(fr.result);
          if (!j || !Array.isArray(j.records) || !(j.type === 'mallclimate-usage' || j.type === 'mallclimate-hvac')) throw new Error('형식');
          let total = 0;
          for (const K of KL) {
            const list = j.records.filter((r) => (r.kind || 'hvac') === K.id);
            const res = mergeRecords(K, list, false);
            res.changed.forEach((r) => { r.synced = false; });
            await persist(K, res.changed); total += res.n;
          }
          M.updateBadge(); refreshAll();
          M.toast('백업에서 ' + total + '건을 불러왔습니다');
          if (total && M.sheetUrl()) M.syncNow(true);
        } catch (e) { M.toast('백업 파일을 읽지 못했습니다. 이 앱의 [백업 파일 저장]으로 만든 .json 파일을 고르세요', true); }
      };
      fr.readAsText(file);
    }

    /* ===================== 구글 시트 동기화 ===================== */
    async function getList(K, days) {
      const u = new URL(M.sheetUrl());
      u.searchParams.set('action', 'listUsage'); u.searchParams.set('kind', K.id); u.searchParams.set('token', M.sheetToken());
      u.searchParams.set('site', C.siteId); u.searchParams.set('days', String(days));
      const res = await fetch(u.toString(), { redirect: 'follow' });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || K.label + ' 불러오기 오류');
      if (!(j.v >= 3)) throw new Error(OLD_MSG);   // 예전 스크립트면 아무것도 쓰지 않고 중단
      return j.records || [];
    }
    async function syncKind(K, pullDays) {
      const url = M.sheetUrl();
      if (!url) return 0;
      // 1) 먼저 읽기로 스크립트 버전 확인 + 다른 기기 기록 가져오기
      const remote = await getList(K, pullDays);
      const res0 = mergeRecords(K, remote, true);
      await persist(K, res0.changed);
      // 2) 아직 시트에 없는 기록 보내기
      const pend = Array.from(K.map.values()).filter((r) => !r.synced);
      for (let i = 0; i < pend.length; i += 100) {
        const chunk = pend.slice(i, i + 100), sent = chunk.map((r) => [r.id, r.updatedAt]);
        const res = await fetch(url, {
          method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'upsertUsage', kind: K.id, token: M.sheetToken(), records: chunk.map((r) => ({ site: r.site, date: r.date, unit: r.unit, grp: r.grp || '', startMin: r.startMin == null ? null : r.startMin, endMin: r.endMin == null ? null : r.endMin, off: !!r.off, updatedAt: r.updatedAt })) })
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || K.label + ' 저장 오류');
        const done = [];
        sent.forEach((x) => { const cur = K.map.get(x[0]); if (cur && cur.updatedAt === x[1]) { cur.synced = true; done.push(cur); } });
        await persist(K, done);
      }
      return res0.n;
    }
    async function sync() { for (const K of KL) await syncKind(K, PULL_DAYS); }
    async function pullAll() {
      if (!M.sheetUrl()) { M.toast('[설정] 탭에서 구글 시트 주소를 먼저 입력하세요'); return; }
      M.toast('시트에서 전체 기간을 불러오는 중… (기록이 많으면 시간이 걸립니다)');
      try {
        let n = 0;
        for (const K of KL) {
          const remote = await getList(K, 36500);
          const res = mergeRecords(K, remote, true);
          await persist(K, res.changed); n += res.n;
        }
        M.updateBadge(); refreshAll();
        M.toast('전체 기간 불러오기 완료: 새로 ' + n + '건');
      } catch (e) { M.toast('불러오지 못했습니다(' + (e && e.message ? e.message : e) + '). 인터넷 연결을 확인하고 다시 누르세요', true); }
    }

    /* ===================== 화면 연결 ===================== */
    function refreshAll() {
      KL.forEach((K) => { if (K.root.classList.contains('active')) renderInput(K); });
      if ($('#tab-report').classList.contains('active') && M.S.repKind !== 'climate') renderReport(M.S.repKind, $('#report'));
    }

    KL.forEach((K) => {
      const r = K.root;
      r.classList.add('usage-tab');
      r.innerHTML =
        '<div class="card hv-top">' +
        '<div class="hv-datebox"><label class="field sm"><span>날짜</span><input class="js-date" type="date"></label>' +
        '<button class="btn js-today" type="button">오늘로</button></div>' +
        '<button type="button" class="btn hv-stats-btn js-stats">' + esc(K.label) + ' 리포트 보기</button>' +
        '<button type="button" class="btn primary hv-savebtn hv-save-top js-save">저장</button></div>' +
        '<p class="hint hv-hint">시작·종료 시각은 기본값(<span class="js-defs"></span>)이 미리 선택되어 있습니다. 다르면 바꾸고, 가동하지 않았으면 <b>미가동</b>을 체크하세요(0시간으로 기록). 마지막에 [저장]을 누르세요. 화면에 보이는 항목이 한 번에 저장됩니다.</p>' +
        '<div class="hv-title"><span class="js-title"></span><small class="js-count"></small></div>' +
        '<div class="hv-stage"><button class="hv-nav js-prev" type="button" aria-label="이전 페이지">‹</button>' +
        '<div class="hv-list js-list"></div>' +
        '<button class="hv-nav js-next" type="button" aria-label="다음 페이지">›</button></div>' +
        '<div class="hv-chips js-chips"></div>' +
        '<button type="button" class="btn primary big hv-savebtn hv-save-bottom js-save">저장</button>';

      $('.js-prev', r).addEventListener('click', () => goPage(K, K.page - 1));
      $('.js-next', r).addEventListener('click', () => goPage(K, K.page + 1));
      $('.js-chips', r).addEventListener('click', (e) => { const p = e.target.getAttribute('data-page'); if (p != null) goPage(K, Number(p)); });
      $('.js-list', r).addEventListener('change', (e) => onFieldChange(K, e));
      $$('.js-save', r).forEach((b) => b.addEventListener('click', () => saveAll(K)));
      $('.js-date', r).addEventListener('change', (e) => {
        const v = e.target.value;
        if (!v || v < e.target.min || v > todayStr()) { M.toast('최근 ' + K.editDays + '일 이내 날짜만 입력/수정할 수 있습니다'); e.target.value = K.date; return; }
        K.date = v; renderInput(K);
      });
      $('.js-today', r).addEventListener('click', () => { K.date = todayStr(); renderInput(K); });
      $('.js-stats', r).addEventListener('click', () => M.openReport(K.id));
      renderInput(K);
    });
    if (wideMQ.addEventListener) wideMQ.addEventListener('change', () => KL.forEach((K) => { if (K.root.classList.contains('active')) renderInput(K); }));
    else if (wideMQ.addListener) wideMQ.addListener(() => KL.forEach((K) => { if (K.root.classList.contains('active')) renderInput(K); }));

    // 리포트 탭의 사용시간용 컨트롤
    $('#rPeriod').addEventListener('change', (e) => { rep.period = e.target.value; refreshAll(); });
    $('#rSort').addEventListener('change', (e) => { rep.sort = e.target.value; refreshAll(); });
    $('#uPrint').addEventListener('click', async () => { await renderReport(M.S.repKind, $('#report')); setTimeout(() => window.print(), 150); });
    $('#uCsv').addEventListener('click', () => exportCSV(M.S.repKind));
    $('#uBackup').addEventListener('click', exportBackup);
    $('#uRestore').addEventListener('click', () => $('#uFile').click());
    $('#uFile').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
    $('#uSync').addEventListener('click', () => { if (!M.sheetUrl()) { M.toast('[설정] 탭에서 구글 시트 주소를 먼저 입력하세요'); return; } M.syncNow(false); });
    $('#uPullAll').addEventListener('click', pullAll);

    window.USAGE = {
      kinds: Object.keys(kinds),
      render(id) { const K = kinds[id]; if (K) renderInput(K); },
      renderReport,
      sync,
      pendingCount: () => KL.reduce((a, K) => { let n = 0; K.map.forEach((r) => { if (!r.synced) n++; }); return a + n; }, 0),
      clearAllLocal: async () => { if (db) await idbClear(); KL.forEach((K) => K.map.clear()); try { localStorage.removeItem(FB_KEY); } catch (e) { /* 무시 */ } }
    };
    M.updateBadge();
    document.dispatchEvent(new Event('usage-ready'));
  }

  if (window.MC && window.MC.ready) boot();
  else document.addEventListener('mc-ready', boot, { once: true });
})();
