/**
 * API ĐIỂM DANH HỘI NGHỊ VC-NLĐ TRƯỜNG DƯỢC 2026  (chạy sau Cloudflare Worker)
 * Gắn vào Google Sheet danh sách. Chỉ Worker gọi được nhờ API_SECRET.
 *
 * Cột trong Sheet nhận theo TÊN TIÊU ĐỀ (hàng 1), thứ tự không quan trọng:
 *   Họ tên | Đơn vị | Số điện thoại | Email | Link tài liệu
 * Script tự thêm cột còn thiếu: Email, Điểm danh lúc, Trạng thái mail.
 */

// Chuỗi bí mật dùng chung với Worker (secret GAS_SECRET). ĐỔI thành chuỗi ngẫu nhiên dài.
const API_SECRET = 'DOI-CHUOI-NAY-THANH-MAT-KHAU-DAI-NGAU-NHIEN';

const EVENT_NAME = 'Hội nghị Viên chức - Người lao động Trường Dược năm 2026';
const SHEET_NAME = ''; // để trống = trang tính đầu tiên
const TZ = 'Asia/Ho_Chi_Minh';

const COLS = {
  name: 'Họ tên',
  unit: 'Đơn vị',
  phone: 'Số điện thoại',
  email: 'Email',
  link: 'Link tài liệu',
  at: 'Điểm danh lúc',
  mail: 'Trạng thái mail'
};

/* ---------- Điểm vào API ---------- */

function doGet() {
  return ContentService.createTextOutput('API điểm danh đang chạy.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req || req.secret !== API_SECRET) throw new Error('unauthorized');
    switch (req.action) {
      case 'checkIn':    out = checkIn_(req.phone); break;
      case 'stats':      out = stats_(); break;
      case 'setPresent': out = setPresent_(Number(req.row), !!req.present); break;
      case 'setClosed':  out = setClosed_(!!req.closed); break;
      case 'resend':     out = resend_(); break;
      default: throw new Error('unknown action');
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Chạy 1 lần trong trình soạn thảo để cấp quyền và chuẩn bị cột. */
function setup() {
  const ctx = load_();
  const sh = ctx.sh;
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, ctx.idx.phone + 1, rows, 1).setNumberFormat('@');
  sh.getRange(2, ctx.idx.at + 1, rows, 1).setNumberFormat('@');
  SpreadsheetApp.flush();
  MailApp.getRemainingDailyQuota(); // kích hoạt xin quyền gửi mail
  Logger.log('Đã sẵn sàng. Số người trong danh sách: ' + ctx.people.length);
}

/* ---------- Điểm danh ---------- */

function checkIn_(phone) {
  const key = normPhone_(phone);
  if (key.length < 9) {
    return { ok: false, code: 'invalid', message: 'Số điện thoại không hợp lệ. Vui lòng nhập lại.' };
  }
  if (isClosed_()) {
    return { ok: false, code: 'closed', message: 'Hội nghị đã kết thúc điểm danh.' };
  }

  let person;
  let already = false;
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ctx = load_();
    const matches = ctx.people.filter(function (p) { return normPhone_(p.phone) === key; });
    if (!matches.length) {
      return {
        ok: false, code: 'notfound',
        message: 'Không tìm thấy số điện thoại này trong danh sách. Vui lòng kiểm tra lại hoặc liên hệ ban tổ chức.'
      };
    }
    // Số điện thoại trùng nhiều dòng: ưu tiên dòng chưa điểm danh
    person = matches.filter(function (p) { return !p.at; })[0] || matches[0];
    if (person.at) {
      already = true;
    } else {
      const now = Utilities.formatDate(new Date(), TZ, 'HH:mm:ss dd/MM/yyyy');
      ctx.sh.getRange(person.row, ctx.idx.at + 1).setNumberFormat('@').setValue(now);
      person.at = now;
      SpreadsheetApp.flush();
    }
  } finally {
    lock.releaseLock();
  }

  const res = { ok: true, already: already, name: person.name, unit: person.unit, at: person.at, mailNote: '' };
  if (already) return res;

  const status = sendMail_(person);
  const c2 = load_();
  c2.sh.getRange(person.row, c2.idx.mail + 1).setValue(status);
  if (status.indexOf('Đã gửi') === 0) {
    res.mailNote = 'Link tài liệu đã được gửi tới email ' + maskEmail_(person.email) + '.';
  } else if (!person.email) {
    res.mailNote = 'Chưa có email trong danh sách nên chưa gửi được mail. Ban tổ chức sẽ gửi sau.';
  } else {
    res.mailNote = 'Chưa gửi được mail tự động, ban tổ chức sẽ gửi lại sau.';
  }
  return res;
}

/* ---------- Quản trị (Worker đã kiểm tra mật khẩu admin) ---------- */

function stats_() {
  const ctx = load_();
  const byUnit = {};
  let present = 0;
  ctx.people.forEach(function (p) {
    const u = byUnit[p.unit] || (byUnit[p.unit] = { unit: p.unit, total: 0, present: 0 });
    u.total++;
    if (p.at) { u.present++; present++; }
  });
  const units = Object.keys(byUnit).map(function (k) {
    const u = byUnit[k];
    u.absent = u.total - u.present;
    u.pct = u.total ? Math.round((u.present / u.total) * 1000) / 10 : 0;
    return u;
  }).sort(function (a, b) { return a.unit.localeCompare(b.unit, 'vi'); });

  const total = ctx.people.length;
  return {
    ok: true,
    closed: isClosed_(),
    total: total,
    present: present,
    absent: total - present,
    pct: total ? Math.round((present / total) * 1000) / 10 : 0,
    units: units,
    people: ctx.people.map(function (p) {
      return { row: p.row, name: p.name, unit: p.unit, phone: p.phone, email: p.email, at: p.at, mail: p.mail };
    }),
    updated: Utilities.formatDate(new Date(), TZ, 'HH:mm:ss dd/MM/yyyy')
  };
}

function setClosed_(closed) {
  PropertiesService.getScriptProperties().setProperty('closed', closed ? '1' : '0');
  return { ok: true, closed: closed };
}

function setPresent_(row, present) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ctx = load_();
    const target = ctx.people.filter(function (p) { return p.row === row; })[0];
    if (!target) throw new Error('Không tìm thấy dòng ' + row);
    const atCell = ctx.sh.getRange(row, ctx.idx.at + 1).setNumberFormat('@');
    const mailCell = ctx.sh.getRange(row, ctx.idx.mail + 1);
    if (present) {
      atCell.setValue(Utilities.formatDate(new Date(), TZ, 'HH:mm:ss dd/MM/yyyy'));
      mailCell.setValue('Điểm danh thủ công (chưa gửi mail)');
    } else {
      atCell.setValue('');
      mailCell.setValue('');
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/** Gửi lại mail cho người đã điểm danh nhưng chưa gửi được (kể cả điểm danh hộ). */
function resend_() {
  const ctx = load_();
  let sent = 0, failed = 0, skipped = 0;
  ctx.people.forEach(function (p) {
    if (!p.at || p.mail.indexOf('Đã gửi') === 0) return;
    if (!p.email || !p.link) { skipped++; return; }
    const status = sendMail_(p);
    ctx.sh.getRange(p.row, ctx.idx.mail + 1).setValue(status);
    if (status.indexOf('Đã gửi') === 0) sent++; else failed++;
  });
  return { ok: true, sent: sent, failed: failed, skipped: skipped };
}

/* ---------- Hàm nội bộ ---------- */

function isClosed_() {
  return PropertiesService.getScriptProperties().getProperty('closed') === '1';
}

function normPhone_(s) {
  let d = String(s == null ? '' : s).replace(/\D/g, '');
  if (d.indexOf('84') === 0 && d.length >= 11) d = d.slice(2);
  return d.replace(/^0+/, '');
}

function maskEmail_(e) {
  const m = String(e || '').split('@');
  if (m.length !== 2) return e || '';
  return m[0].slice(0, Math.min(2, m[0].length)) + '***@' + m[1];
}

function fmt_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm:ss dd/MM/yyyy');
  return String(v == null ? '' : v).trim();
}

function load_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });

  const idx = {};
  Object.keys(COLS).forEach(function (k) {
    let i = headers.indexOf(COLS[k]);
    if (i < 0) {
      headers.push(COLS[k]);
      i = headers.length - 1;
      if (i + 1 > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
      sh.getRange(1, i + 1).setValue(COLS[k]).setFontWeight('bold');
    }
    idx[k] = i;
  });

  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, headers.length).getValues() : [];

  // Dòng chưa có link tài liệu thì dùng link đầu tiên tìm thấy trong cột (link chung)
  let defaultLink = '';
  rows.some(function (r) {
    const l = String(r[idx.link] || '').trim();
    if (l) { defaultLink = l; return true; }
    return false;
  });

  const people = [];
  rows.forEach(function (r, i) {
    const name = String(r[idx.name] || '').trim();
    if (!name) return;
    people.push({
      row: i + 2,
      name: name,
      unit: String(r[idx.unit] || '').trim() || '(Chưa rõ đơn vị)',
      phone: String(r[idx.phone] || '').trim(),
      email: String(r[idx.email] || '').trim(),
      link: String(r[idx.link] || '').trim() || defaultLink,
      at: fmt_(r[idx.at]),
      mail: String(r[idx.mail] || '').trim()
    });
  });
  return { sh: sh, idx: idx, people: people };
}

function sendMail_(p) {
  if (!p.email) return 'Không có email';
  if (!p.link) return 'Không có link tài liệu';
  try {
    const esc = function (s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    const html =
      '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222">' +
      '<p>Kính gửi thầy/cô <b>' + esc(p.name) + '</b> (' + esc(p.unit) + '),</p>' +
      '<p>Ban tổ chức xin ghi nhận thầy/cô đã điểm danh tham dự <b>' + esc(EVENT_NAME) + '</b>.</p>' +
      '<p>Thầy/cô vui lòng truy cập tài liệu Hội nghị tại đường dẫn sau:</p>' +
      '<p><a href="' + esc(p.link) + '" style="display:inline-block;background:#0f766e;color:#fff;' +
      'padding:10px 18px;border-radius:8px;text-decoration:none">Mở tài liệu Hội nghị</a></p>' +
      '<p style="color:#666;font-size:13px">Nếu nút không hoạt động, hãy sao chép liên kết này vào trình duyệt:<br>' +
      esc(p.link) + '</p>' +
      '<p>Trân trọng cảm ơn.<br>Ban tổ chức Hội nghị</p></div>';
    MailApp.sendEmail({
      to: p.email,
      subject: '[Trường Dược] Tài liệu ' + EVENT_NAME,
      htmlBody: html,
      body: 'Kính gửi ' + p.name + ', tài liệu Hội nghị: ' + p.link,
      name: 'Ban tổ chức Hội nghị Trường Dược'
    });
    return 'Đã gửi ' + Utilities.formatDate(new Date(), TZ, 'HH:mm dd/MM/yyyy');
  } catch (err) {
    return 'Lỗi gửi mail: ' + String(err && err.message ? err.message : err).slice(0, 120);
  }
}
