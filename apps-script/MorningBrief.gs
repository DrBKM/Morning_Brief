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
const HABIT_TAB = 'Habits';         // daily WRYTINGS ticks (created automatically)
const SUGAR_TAB = 'Diabetes';        // blood-sugar log (created automatically)
const HABITS = [['W', 'Writing 200 words on my day (30 min)'], ['R', 'Reading a research article (1 hr)'],
  ['Y', 'Revising Physics (1 hr)'], ['T', 'Trading plan and execution (1 hr)'], ['I', 'Instruments revision (15 min)'],
  ['N', 'Sharpening negotiation skills (15 min)'], ['G', 'Measuring gravity of the present situation (15 min)'],
  ['S', 'Spirituality and health (mental and physical)']];
const SUGAR_TYPES = ['Fasting', 'Post-meal (2 hr)', 'Pre-meal', 'Bedtime', 'Random'];
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
  if (token && p.token === token && p.what === 'nse') {   // GitHub Action: NSE data when NSE blocks GitHub
    return json_(nseFetch_(String(p.path || '')));
  }
  if (token && p.token === token) {                       // GitHub Action: full morning data
    const res = { ok: true, tz: Session.getScriptTimeZone(), journalKey: journalKey_() };
    try { res.tasks = readTasks_(); } catch (err) { res.tasks = { error: String(err) }; }
    try { res.emails = readEmails_(); } catch (err) { res.emails = []; res.mailError = String(err); }
    try { res.watch = readWatch_(); } catch (err) { res.watch = { error: String(err) }; }
    return json_(res);
  }
  if (p.jkey && p.jkey === journalKey_()) {               // web page: journal, habits, sugar log
    const out = { ok: true, journal: readJournal_(80) };
    try { out.habits = readHabits_(400); } catch (err) { out.habitError = String(err); }
    try { out.sugar = readSugar_(400); } catch (err) { out.sugarError = String(err); }
    return json_(out);
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
    if (b.action === 'habit') return json_(saveHabit_(b));
    if (b.action === 'sugar') return json_(addSugar_(b));
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

/* ---------------- daily habits: W R Y T I N G S ---------------- */
// Columns: Date | W R Y T I N G S (✓ or ✗) | Done | Note.  Summary for any date range on the right (cells N1:R14).
function habitSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(HABIT_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(HABIT_TAB);
  const head = ['Date'].concat(HABITS.map(h => h[0])).concat(['Done (of 8)', 'Note']);
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8eefc');
  sh.setFrozenRows(1); sh.setColumnWidth(1, 100); sh.setColumnWidths(2, 8, 38); sh.setColumnWidth(11, 260);
  HABITS.forEach((h, i) => sh.getRange(1, 2 + i).setNote(h[1]));
  const tick = SpreadsheetApp.newDataValidation().requireValueInList(['✓', '✗'], true).setAllowInvalid(false).build();
  sh.getRange('B2:I1000').setDataValidation(tick).setHorizontalAlignment('center');
  sh.getRange('A2:A1000').setNumberFormat('yyyy-mm-dd');
  sh.getRange('J2').setFormula('=ARRAYFORMULA(IF(A2:A="",,MMULT((B2:I="✓")*1,SEQUENCE(8,1,1,0))))');
  // summary block
  sh.getRange('M1:R1').setValues([['Summary', 'From', 'To', '', '', '']]).setFontWeight('bold');
  sh.getRange('N2').setFormula('=TODAY()-29'); sh.getRange('O2').setFormula('=TODAY()');
  sh.getRange('N2:O2').setNumberFormat('yyyy-mm-dd').setBackground('#fff8e1');
  sh.getRange('M3:R3').setValues([['Habit', 'Done ✓', 'Missed ✗', 'Not marked', '% done', 'Days in range']]).setFontWeight('bold');
  const rng = '$A$2:$A,">="&$N$2,$A$2:$A,"<="&$O$2';
  HABITS.forEach((h, i) => {
    const col = String.fromCharCode(66 + i), r = 4 + i;
    sh.getRange(r, 13).setValue(h[0] + '  ' + h[1]);
    sh.getRange(r, 14).setFormula(`=COUNTIFS(${col}$2:${col},"✓",${rng})`);
    sh.getRange(r, 15).setFormula(`=COUNTIFS(${col}$2:${col},"✗",${rng})`);
    sh.getRange(r, 18).setFormula('=$O$2-$N$2+1');
    sh.getRange(r, 16).setFormula(`=R${r}-N${r}-O${r}`);
    sh.getRange(r, 17).setFormula(`=IFERROR(N${r}/R${r},0)`).setNumberFormat('0%');
  });
  sh.getRange('M12').setValue('All 8 done (full days)').setFontWeight('bold');
  sh.getRange('N12').setFormula(`=COUNTIFS($J$2:$J,8,${rng})`);
  sh.getRange('M13').setValue('Average habits done per day').setFontWeight('bold');
  sh.getRange('N13').setFormula(`=IFERROR(SUMIFS($J$2:$J,${rng})/($O$2-$N$2+1),0)`).setNumberFormat('0.0');
  sh.getRange('M14').setValue('Change From / To (yellow) to see any period.').setFontStyle('italic');
  sh.setColumnWidth(13, 330);
  return sh;
}
function readHabits_(n) {
  const sh = habitSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const v = sh.getRange(2, 1, last - 1, 11).getDisplayValues().filter(r => r[0]);
  return v.slice(-n).map(r => ({ date: r[0], marks: r.slice(1, 9).map(c => c === '✓' || c === '✗' ? c : '·').join(''), note: r[10] }));
}
function saveHabit_(b) {
  const date = String(b.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad date' };
  const marks = HABITS.map((h, i) => { const m = String((b.marks || '')[i] || ''); return m === '✓' || m === '✗' ? m : ''; });
  const sh = habitSheet_(), last = sh.getLastRow();
  let row = 0;
  if (last >= 2) {
    const dates = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    for (let i = 0; i < dates.length; i++) if (dates[i][0] === date) { row = i + 2; break; }
  }
  if (!row) {
    row = Math.max(2, last + 1);
    const [y, m, d] = date.split('-').map(Number);
    sh.getRange(row, 1).setValue(new Date(y, m - 1, d));
  }
  sh.getRange(row, 2, 1, 8).setValues([marks]);
  if (b.note != null) sh.getRange(row, 11).setValue(String(b.note).slice(0, 300));
  return { ok: true };
}

/* ---------------- diabetes log ---------------- */
// Columns: Date | Time | Type | Reading (mg/dL) | Note.  Averages for any date range on the right.
function sugarSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(SUGAR_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(SUGAR_TAB);
  sh.getRange(1, 1, 1, 5).setValues([['Date', 'Time', 'Type', 'Reading (mg/dL)', 'Note']]).setFontWeight('bold').setBackground('#e8eefc');
  sh.setFrozenRows(1); sh.setColumnWidth(3, 130); sh.setColumnWidth(5, 220);
  sh.getRange('A2:A2000').setNumberFormat('yyyy-mm-dd');
  sh.getRange('C2:C2000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(SUGAR_TYPES, true).build());
  sh.getRange('H1:L1').setValues([['Averages', 'From', 'To', '', '']]).setFontWeight('bold');
  sh.getRange('I2').setFormula('=TODAY()-29'); sh.getRange('J2').setFormula('=TODAY()');
  sh.getRange('I2:J2').setNumberFormat('yyyy-mm-dd').setBackground('#fff8e1');
  sh.getRange('H3:L3').setValues([['Type', 'Average', 'Readings', 'Lowest', 'Highest']]).setFontWeight('bold');
  const rng = '$A$2:$A,">="&$I$2,$A$2:$A,"<="&$J$2';
  ['All readings'].concat(SUGAR_TYPES).forEach((t, k) => {
    const r = 4 + k, cond = k === 0 ? '' : `,$C$2:$C,"${t}"`;
    sh.getRange(r, 8).setValue(t);
    sh.getRange(r, 9).setFormula(`=IFERROR(ROUND(AVERAGEIFS($D$2:$D,${rng}${cond}),0),"-")`);
    sh.getRange(r, 10).setFormula(`=COUNTIFS(${rng}${cond},$D$2:$D,"<>")`);
    sh.getRange(r, 11).setFormula(`=IFERROR(MINIFS($D$2:$D,${rng}${cond}),"-")`);
    sh.getRange(r, 12).setFormula(`=IFERROR(MAXIFS($D$2:$D,${rng}${cond}),"-")`);
  });
  sh.getRange('H11').setValue('Change From / To (yellow) to see any period.').setFontStyle('italic');
  sh.setColumnWidth(8, 150);
  return sh;
}
function readSugar_(n) {
  const sh = sugarSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 5).getDisplayValues().filter(r => r[0] && r[3]).slice(-n)
    .map(r => ({ date: r[0], time: r[1], type: r[2], value: r[3], note: r[4] }));
}
function addSugar_(b) {
  const v = Number(b.value), date = String(b.date || '').slice(0, 10);
  if (!(v > 20 && v < 700)) return { ok: false, error: 'reading should be in mg/dL (20–700)' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad date' };
  const [y, m, d] = date.split('-').map(Number);
  const type = SUGAR_TYPES.indexOf(b.type) >= 0 ? b.type : 'Random';
  sugarSheet_().appendRow([new Date(y, m - 1, d), String(b.time || '').slice(0, 5), type, v, String(b.note || '').slice(0, 200)]);
  return { ok: true };
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

/* ---------------- NSE data relay (only nseindia.com addresses) ---------------- */
function nseFetch_(path) {
  if (!/^\/(api\/[\w\-]+(\?[\w=&%.\-]*)?|content\/nsccl\/fao_participant_oi_\d{8}\.csv)$/.test(path)) return { ok: false, error: 'path not allowed' };
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const host = path.indexOf('/content/') === 0 ? 'https://nsearchives.nseindia.com' : 'https://www.nseindia.com';
  let cookie = '';
  if (host.indexOf('www.') > 0) {                 // NSE wants the cookies its own web page sets
    const home = UrlFetchApp.fetch('https://www.nseindia.com/option-chain', { headers: { 'User-Agent': ua, 'Accept': 'text/html' }, muteHttpExceptions: true, followRedirects: true });
    let sc = home.getAllHeaders()['Set-Cookie'] || [];
    if (!Array.isArray(sc)) sc = [sc];
    cookie = sc.map(c => String(c).split(';')[0]).join('; ');
  }
  const r = UrlFetchApp.fetch(host + path, { headers: { 'User-Agent': ua, 'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.nseindia.com/option-chain', 'Cookie': cookie }, muteHttpExceptions: true, followRedirects: true });
  return { ok: r.getResponseCode() === 200, status: r.getResponseCode(), body: r.getContentText().slice(0, 2500000) };
}

/* ---------------- one-time helpers ---------------- */
function setToken() {
  let t = props_().getProperty('BRIEF_TOKEN');
  if (!t) { t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); props_().setProperty('BRIEF_TOKEN', t); }
  journalKey_(); journalSheet_(); habitSheet_(); sugarSheet_(); readTasks_(); readEmails_(); readWatch_();   // permission prompts + creates the journal tab
  Logger.log('GAS_TOKEN = ' + t);
}
function testOutput() {
  Logger.log(JSON.stringify({ watch: readWatch_(), journal: readJournal_(5), tasks: readTasks_() }).slice(0, 4000));
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
