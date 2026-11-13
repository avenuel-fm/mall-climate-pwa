/**
 * 쇼핑몰 공조 관리 앱 — 구글 시트 저장용 Apps Script (버전 3)
 *
 * 사용법은 README.md 의 "구글 시트 연결" 부분을 보세요.
 * 아래 TOKEN 값을 본인만 아는 문자열로 바꾸고, 앱의 [설정] 탭 '인증 키'에 같은 값을 넣습니다.
 *
 * 시트 2개를 자동으로 만듭니다.
 *   '기록'   : 실내외 온습도 기록 (추가만 함, 같은 id는 중복 저장 안 함)
 *   '공조기' : 공조기별 일일 가동시간, 급기/배기 온도 (같은 날짜·번호는 덮어씀)
 *
 * 코드를 수정/교체했다면 [배포 > 배포 관리 > 편집(연필) > 버전: 새 버전 > 배포]를 꼭 해야 반영됩니다.
 */
const TOKEN = 'avenuel02';
const SHEET_NAME = '기록';
const HEADERS = ['id', '매장ID', '측정시각', '층', '구역', '실내온도', '실내습도', '불쾌지수', '실외온도', '실외습도', 'ts'];

// 공조기/에어커튼 시트 공통 열 구성 (공조기 시트의 기존 열 순서는 그대로 유지)
const USAGE = {
  hvac: { sheet: '공조기', unitLabel: '공조기번호' },
  curtain: { sheet: '에어커튼', unitLabel: '에어커튼번호' }
};
const U_HEAD = ['id', '매장ID', '날짜', '번호', '가동시작', '가동종료', '가동시간(시간)', '급기온도', '배기온도', '수정시각', 'startMin', 'endMin', '미가동', '구분'];
const VERSION = 3;

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getUsageSheet_(kind) {
  const def = USAGE[kind];
  if (!def) throw new Error('알 수 없는 종류: ' + kind);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(def.sheet);
  const head = U_HEAD.slice(); head[3] = def.unitLabel;
  if (!sh) {
    sh = ss.insertSheet(def.sheet);
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange('C:C').setNumberFormat('@'); // 날짜를 글자로 보관 (자동 날짜 변환 방지)
  } else if (sh.getLastColumn() < U_HEAD.length) {
    // 예전 버전(공조기 시트)에는 '미가동', '구분' 열이 없으므로 추가
    sh.getRange(1, 13, 1, 2).setValues([[head[12], head[13]]]);
  }
  return sh;
}

function json_(obj) {
  obj.v = VERSION;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 앱 → 시트
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return json_({ ok: false, error: '인증 키가 다릅니다' });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (body.action === 'upsertUsage') return json_(upsertUsage_(body.kind, body.records || []));
      return json_(appendRecords_(body.records || []));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 온습도 기록 추가 (같은 id는 중복 저장하지 않음)
function appendRecords_(records) {
  const sh = getSheet_();
  const last = sh.getLastRow();
  const ids = new Set(last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : []);
  const rows = [];
  records.forEach(function (r) {
    if (ids.has(String(r.id))) return;
    ids.add(String(r.id));
    const d = new Date(r.ts);
    rows.push([
      r.id, r.site || '',
      Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd HH:mm'),
      r.floor, r.zone, r.t, r.h, r.di,
      r.ot == null ? '' : r.ot, r.oh == null ? '' : r.oh,
      r.ts
    ]);
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  return { ok: true, saved: rows.length };
}

// 분(0~1440) → '오전 10:30'
function timeText_(min) {
  if (min === '' || min == null) return '';
  const m = Number(min);
  if (m >= 1440) return '오전 12:00 (24시)';
  const h24 = Math.floor(m / 60), mm = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return (h24 < 12 ? '오전 ' : '오후 ') + h12 + ':' + (mm < 10 ? '0' + mm : mm);
}

// 사용시간 기록: 같은 (매장, 날짜, 번호)는 최신 수정시각 기준으로 덮어씀
function upsertUsage_(kind, records) {
  const sh = getUsageSheet_(kind);
  const last = sh.getLastRow();
  const rowOf = {};
  const updOf = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 10).getValues().forEach(function (r, i) {
      rowOf[String(r[0])] = i + 2;
      updOf[String(r[0])] = Number(r[9]) || 0;
    });
  }
  const appendRows = [];
  const seen = {};
  let saved = 0;
  records.forEach(function (r) {
    const id = [r.site || '', r.date, r.unit].join('|');
    const off = !!r.off;
    const hasTime = !off && r.startMin != null && r.endMin != null;
    const unit = kind === 'hvac' ? Number(r.unit) : String(r.unit);
    const row = [
      id, r.site || '', String(r.date), unit,
      hasTime ? timeText_(r.startMin) : '', hasTime ? timeText_(r.endMin) : '',
      off ? 0 : (hasTime ? Math.round((r.endMin - r.startMin) / 60 * 100) / 100 : ''),
      '', '',
      Number(r.updatedAt) || Date.now(),
      off || r.startMin == null ? '' : r.startMin, off || r.endMin == null ? '' : r.endMin,
      off ? 'Y' : '', r.grp || ''
    ];
    if (id in rowOf) {
      if (row[9] >= updOf[id]) {
        sh.getRange(rowOf[id], 1, 1, row.length).setValues([row]);
        updOf[id] = row[9];
        saved++;
      }
    } else if (!(id in seen)) {
      seen[id] = true;
      appendRows.push(row);
      saved++;
    }
  });
  if (appendRows.length) {
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 3, appendRows.length, 1).setNumberFormat('@');
    sh.getRange(start, 1, appendRows.length, U_HEAD.length).setValues(appendRows);
  }
  return { ok: true, saved: saved };
}

// 시트 → 앱
function doGet(e) {
  try {
    const p = e.parameter || {};
    if (p.token !== TOKEN) return json_({ ok: false, error: '인증 키가 다릅니다' });
    if (p.action === 'listUsage') return json_(listUsage_(p));
    return json_(listRecords_(p));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 최근 N일 온습도 기록
function listRecords_(p) {
  const days = Math.max(1, Math.min(60, Number(p.days) || 5));
  const since = Date.now() - days * 86400000;
  const sh = getSheet_();
  const last = sh.getLastRow();
  const out = [];
  if (last > 1) {
    sh.getRange(2, 1, last - 1, HEADERS.length).getValues().forEach(function (r) {
      const ts = Number(r[10]);
      if (!ts || ts < since) return;
      if (p.site && String(r[1]) !== p.site) return;
      out.push({
        id: String(r[0]), site: r[1], ts: ts, floor: String(r[3]), zone: String(r[4]),
        t: Number(r[5]), h: Number(r[6]), di: Number(r[7]),
        ot: r[8] === '' ? null : Number(r[8]), oh: r[9] === '' ? null : Number(r[9])
      });
    });
  }
  return { ok: true, records: out };
}

// 최근 N일 사용시간 기록 (days 가 크면 전체 기간)
function listUsage_(p) {
  const days = Math.max(1, Math.min(36500, Number(p.days) || 7));
  const cutoff = Utilities.formatDate(new Date(Date.now() - (days - 1) * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
  const kind = p.kind || 'hvac';
  const sh = getUsageSheet_(kind);
  const last = sh.getLastRow();
  const out = [];
  if (last > 1) {
    const dates = sh.getRange(2, 3, last - 1, 1).getValues();
    // cutoff 이후 날짜의 행만 연속 구간으로 묶어서 읽기 (기록이 수년치 쌓여도 빠르게)
    const runs = [];
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i][0] instanceof Date ? Utilities.formatDate(dates[i][0], 'Asia/Seoul', 'yyyy-MM-dd') : String(dates[i][0]);
      if (d < cutoff) continue;
      const row = i + 2, lastRun = runs[runs.length - 1];
      if (lastRun && lastRun[1] === row - 1) lastRun[1] = row; else runs.push([row, row]);
    }
    const readRun = function (a, b) {
      sh.getRange(a, 1, b - a + 1, U_HEAD.length).getValues().forEach(function (r) {
        if (p.site && String(r[1]) !== p.site) return;
        const date = r[2] instanceof Date ? Utilities.formatDate(r[2], 'Asia/Seoul', 'yyyy-MM-dd') : String(r[2]);
        out.push({
          site: String(r[1]), date: date, unit: kind === 'hvac' ? Number(r[3]) : String(r[3]),
          startMin: r[10] === '' ? null : Number(r[10]), endMin: r[11] === '' ? null : Number(r[11]),
          off: String(r[12]) === 'Y', grp: String(r[13] || ''),
          updatedAt: Number(r[9]) || 0
        });
      });
    };
    if (runs.length > 40) readRun(2, last); else runs.forEach(function (x) { readRun(x[0], x[1]); });
  }
  return { ok: true, records: out };
}
