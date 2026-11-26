/**
 * Morning Brief helper (version 2)
 *  - gives the GitHub Action your tasks, important Gmail and the FFA_TIE watchlist
 *  - writes the daily news / lean back into FFA_TIE (columns C and D)
 *  - keeps the Trade_Journal tab that the web page adds decisions to
 *  - marks today's decisions Correct / Wrong at 3:45 PM (optional trigger)
 *
 * Setup (once):
 *  1. Paste this file over the old MorningBrief file -> Save.
 *  2. Run setToken() once (allow access). It keeps an existing token, so GitHub secrets stay valid.
 *  3. Run installAutoResult() once if you want automatic Correct/Wrong marking at 3:45 PM.
 *  4. Deploy -> Manage deployments -> Edit (pencil) -> Version: New version -> Deploy.
 *     (Keep the same deployment so the /exec URL does not change.)
 */
const SHEET_ID = '1zbibhAo405h4YtCEoxrr2ztyeoaUlgnv4Ip3jRdAGPQ';
const TAB_GID = 1149256767;          // task tab (#gid=... in your link)
const MAX_ROWS = 150;                // newest task rows sent to Claude
const WATCH_TAB = 'FFA_TIE';         // stock watchlist tab
const JOURNAL_TAB = 'Trade_Journal'; // created automatically
const MAIL_QUERY = 'in:inbox newer_than:1d (is:important OR is:starred) -category:promotions -category:social';
const J_HEAD = ['ID', 'Date', 'Time', 'Instrument', 'Direction', 'Entry', 'Stop loss', 'Target',
                'Points / reason', 'Confidence', 'Result', 'Exit / close', 'Result note', 'Updated'];

function props_() { return PropertiesService.getScriptProperties(); }
function journalKey_() {
  let k = props_().getProperty('JOURNAL_KEY');
  if (!k) { k = Utilities.getUuid().replace(/-/g, ''); props_().setProperty('JOURNAL_KEY', k); }
  return k;
}
function ss_() { return SpreadsheetApp.openById(SHEET_ID); }

/* ---------------- GET ---------------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const token = props_().getProperty('BRIEF_TOKEN');
  if (token && p.token === token) {                       // GitHub Action: full morning data
    const res = { ok: true, tz: Session.getScriptTimeZone(), journalKey: journalKey_() };
    try { res.tasks = readTasks_(); } catch (err) { res.tasks = { error: String(err) }; }
    try { res.emails = readEmails_(); } catch (err) { res.emails = []; res.mailError = String(err); }
    try { res.watch = readWatch_(); } catch (err) { res.watch = { error: String(err) }; }
    return json_(res);
  }
  if (p.jkey && p.jkey === journalKey_()) {               // web page: trade journal
    return json_({ ok: true, journal: readJournal_(80) });
  }
  return json_({ ok: false, error: 'unauthorised' });
}

/* ---------------- POST ---------------- */
function doPost(e) {
  let b = {};
  try { b = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: 'bad request' }); }
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const token = props_().getProperty('BRIEF_TOKEN');
    if (b.action === 'watch' && token && b.token === token) return json_(writeWatch_(b.items || [], b.date || ''));
    if (b.jkey !== journalKey_()) return json_({ ok: false, error: 'unauthorised' });
    if (b.action === 'add') return json_(addTrade_(b.t || {}));
    if (b.action === 'result') return json_(setResult_(b));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally { lock.releaseLock(); }
}

/* ---------------- tasks + mail ---------------- */
function readTasks_() {
  const sh = ss_().getSheets().filter(s => s.getSheetId() === TAB_GID)[0];
  if (!sh) return { error: 'tab not found' };
  const v = sh.getDataRange().getDisplayValues();
  const rows = v.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
  return { sheet: sh.getName(), header: v[0], rows: rows.slice(-MAX_ROWS) };
}
function readEmails_() {
  return GmailApp.search(MAIL_QUERY, 0, 25).map(t => {
    const m = t.getMessages().pop();
    return {
      from: m.getFrom(), subject: m.getSubject(), date: m.getDate().toISOString(),
      snippet: m.getPlainBody().replace(/\s+/g, ' ').slice(0, 300),
      unread: t.isUnread(), link: 'https://mail.google.com/mail/u/0/#inbox/' + t.getId()
    };
  });
}

/* ---------------- watchlist (FFA_TIE) ---------------- */
// Columns are found by their header text, so you can move them around.
// "Fundamentals" + "Fund. checked" are added right after "Why" the first time.
function watchCols_(sh) {
  let head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  if (!head.some(h => /fundamental/i.test(h))) {
    sh.insertColumnsAfter(2, 2);
    sh.getRange(1, 3, 1, 2).setValues([['Fundamentals (auto · every 15 days)', 'Fund. checked']]).setFontWeight('bold');
    sh.setColumnWidth(3, 420); sh.getRange(2, 3, Math.max(1, sh.getMaxRows() - 1), 1).setWrap(true);
    head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  }
  const col = re => head.findIndex(h => re.test(h)) + 1;   // 0 = not found
  return { fund: col(/fundamental/i), checked: col(/checked/i), news: col(/news/i), action: col(/action/i) };
}
function readWatch_() {
  const sh = ss_().getSheetByName(WATCH_TAB);
  if (!sh) return { error: 'tab ' + WATCH_TAB + ' not found' };
  const c = watchCols_(sh), v = sh.getDataRange().getDisplayValues(), out = [];
  const at = (row, k) => c[k] ? row[c[k] - 1] || '' : '';
  for (let i = 1; i < v.length && out.length < 120; i++) {
    if (String(v[i][0]).trim()) out.push({ row: i + 1, stock: v[i][0], why: v[i][1] || '', fund: at(v[i], 'fund'),
      checked: at(v[i], 'checked'), news: at(v[i], 'news'), action: at(v[i], 'action') });
  }
  return { sheet: WATCH_TAB, header: v[0], rows: out };
}
// News / Action get "🤖 date: ..." and are never written over text you typed yourself.
// Fundamentals: your own text is kept until its 'Fund. checked' date is 15 days old, then refreshed.
function writeWatch_(items, date) {
  const sh = ss_().getSheetByName(WATCH_TAB);
  if (!sh) return { ok: false, error: 'tab not found' };
  const c = watchCols_(sh), today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  const auto = t => !t || /^(🤖|✅|🟡|🔴|⚪)/.test(t);
  let n = 0;
  items.forEach(it => {
    const r = Number(it.row); if (!(r > 1)) return;
    const put = (col, text, prefix) => {
      if (!col || !text) return false;
      const cell = sh.getRange(r, col), old = String(cell.getDisplayValue()).trim();
      if (!auto(old)) return false;
      cell.setValue(prefix ? '🤖 ' + date + ': ' + text : text); n++; return true;
    };
    put(c.news, it.news, true);
    put(c.action, it.lean, true);
    if (c.fund && it.fund) { sh.getRange(r, c.fund).setValue(it.fund); n++; }      // 15-day refresh replaces any text
    if (c.checked && (it.fund || it.stamp)) sh.getRange(r, c.checked).setNumberFormat('@').setValue(today);
  });
  return { ok: true, written: n };
}

/* ---------------- trade journal ---------------- */
function journalSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(JOURNAL_TAB);
  if (!sh) {
    sh = ss.insertSheet(JOURNAL_TAB);
    sh.getRange(1, 1, 1, J_HEAD.length).setValues([J_HEAD]).setFontWeight('bold').setBackground('#e8eefc');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readJournal_(n) {
  const sh = journalSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - n + 1);
  return sh.getRange(start, 1, last - start + 1, J_HEAD.length).getDisplayValues().reverse()
    .map(r => { const o = {}; J_HEAD.forEach((h, i) => o[h] = r[i]); return o; });
}
function addTrade_(t) {
  const sh = journalSheet_(), now = new Date(), tz = 'Asia/Kolkata';
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  const id = 'T' + Utilities.formatDate(now, tz, 'yyMMddHHmmss');
  sh.appendRow([id, Utilities.formatDate(now, tz, 'yyyy-MM-dd'), Utilities.formatDate(now, tz, 'HH:mm'),
    clip(t.instrument, 40).toUpperCase(), clip(t.direction, 20), clip(t.entry, 20), clip(t.sl, 20), clip(t.target, 20),
    clip(t.points, 1500), clip(t.confidence, 20), 'Open', '', '', '']);
  return { ok: true, id: id };
}
function setResult_(b) {
  const sh = journalSheet_(), ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (let i = 1; i < ids.length; i++) {
    if (String(ids[i][0]) === String(b.id)) {
      const r = i + 1;
      sh.getRange(r, 11, 1, 4).setValues([[String(b.result || 'Open').slice(0, 30), String(b.exit || '').slice(0, 20),
        String(b.note || '').slice(0, 500), Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm')]]);
      return { ok: true };
    }
  }
  return { ok: false, error: 'decision not found' };
}

/* ------- automatic Correct / Wrong at 3:45 PM for plain stock / index entries ------- */
function autoResult() {
  const tz = 'Asia/Kolkata', now = new Date(), day = Utilities.formatDate(now, tz, 'u');
  if (day === '6' || day === '7') return;                          // Saturday / Sunday
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const sh = journalSheet_(), last = sh.getLastRow(); if (last < 2) return;
  const v = sh.getRange(2, 1, last - 1, J_HEAD.length).getDisplayValues();
  const px = ss_().getSheetByName('_px') || ss_().insertSheet('_px'); px.hideSheet();
  v.forEach((r, i) => {
    const [id, date, , inst, dir, entry] = r, res = r[10];
    if (date !== today || (res && res !== 'Open') || !inst || /\s/.test(inst.trim())) return;
    const e = parseFloat(String(entry).replace(/[^\d.]/g, '')); if (!(e > 0)) return;
    const up = /buy|long|bull/i.test(dir), down = /sell|short|bear/i.test(dir); if (!up && !down) return;
    const sym = inst.indexOf(':') > 0 ? inst : ({ NIFTY: 'INDEXNSE:NIFTY_50', BANKNIFTY: 'INDEXNSE:NIFTY_BANK', SENSEX: 'INDEXBOM:SENSEX' }[inst] || 'NSE:' + inst);
    px.getRange('A1').setFormula('=GOOGLEFINANCE("' + sym + '","price")'); SpreadsheetApp.flush(); Utilities.sleep(1500);
    const c = Number(px.getRange('A1').getValue()); if (!(c > 0)) return;
    const ok = up ? c > e : c < e;
    sh.getRange(i + 2, 11, 1, 4).setValues([[ok ? 'Correct (auto)' : 'Wrong (auto)', c,
      'close ' + c + ' vs entry ' + e, Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm')]]);
  });
}
function installAutoResult() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'autoResult').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('autoResult').timeBased().everyDays(1).atHour(15).nearMinute(45).inTimezone('Asia/Kolkata').create();
  Logger.log('autoResult will run every weekday around 3:45 PM IST');
}

/* ---------------- one-time helpers ---------------- */
function setToken() {
  let t = props_().getProperty('BRIEF_TOKEN');
  if (!t) { t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); props_().setProperty('BRIEF_TOKEN', t); }
  journalKey_(); journalSheet_(); readTasks_(); readEmails_(); readWatch_();   // permission prompts + creates the journal tab
  Logger.log('GAS_TOKEN = ' + t);
}
function testOutput() {
  Logger.log(JSON.stringify({ watch: readWatch_(), journal: readJournal_(5), tasks: readTasks_() }).slice(0, 4000));
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
