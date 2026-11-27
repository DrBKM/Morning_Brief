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
// Daily writing ritual: paste the link (or ID) of your Evening_Rituals Google Doc between the quotes
const RITUAL_DOC = '';
const RITUAL_TAB = 'Evening_Ritual';   // the doc tab whose title contains this text (yours: Dailly_Evening_Ritual…)
const RITUAL_NEWEST_FIRST = true;      // new days go above the latest dated entry (false = at the end of the tab)
const SUGAR_TAB = 'Diabetes';        // blood-sugar log (created automatically)
const HABITS = [['W', 'Writing 200 words on my day (30 min)'], ['R', 'Reading a research article (1 hr)'],
  ['Y', 'Revising Physics (1 hr)'], ['T', 'Trading plan and execution (1 hr)'], ['I', 'Instruments revision (15 min)'],
  ['N', 'Sharpening negotiation skills (15 min)'], ['G', 'Measuring gravity of the present situation (15 min)'],
  ['S', 'Spirituality and health (mental and physical)']];
const SUGAR_TYPES = ['Fasting', 'Post-meal (2 hr)', 'Pre-meal', 'Bedtime', 'Random'];
const J_BASE = ['ID', 'Date', 'Time', 'Instrument', 'Direction', 'Entry', 'Stop loss', 'Target',
                'Points / reason', 'Confidence', 'Result', 'Exit / close', 'Result note', 'Updated'];
// TRENDS checklist: columns O..T (✓ / ✗), score in U, GO / NO-GO in V, report from column X
const CHECK = [['T', 'Trend with momentum'], ['R', 'Risk & reward'], ['E', 'Entry time & candlestick pattern'],
               ['N', 'No overtrade / aggressive trade'], ['D', 'Disciplined & without distractions'],
               ['S', 'Stop button: no time & money waste']];
const CHECK_HEAD = CHECK.map(c => c[0] + ': ' + c[1]);
const J_HEAD = J_BASE.concat(CHECK_HEAD, ['Checklist (of 6)', 'Verdict']);
const QUOTE = 'Trade the market, not your mind';
const KEY_LINE = 'Key: Thousand times one punch';

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
    try { res.pis = readPis_(); } catch (err) { res.pis = { error: String(err) }; }
    return json_(res);
  }
  if (p.jkey && p.jkey === journalKey_()) {               // web page: journal, habits, sugar log
    const out = { ok: true, journal: readJournal_(80) };
    try { out.habits = readHabits_(400); } catch (err) { out.habitError = String(err); }
    try { out.sugar = readSugar_(400); } catch (err) { out.sugarError = String(err); }
    try { out.projects = readProjects_(); } catch (err) { out.projectError = String(err); }
    try { out.ritual = readRitual_(10); } catch (err) { out.ritualError = String(err.message || err); }
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
    if (b.action === 'pis' && token && b.token === token) return json_(writePis_(b.rows || [], b.date || '', b.gov || []));
    if (b.jkey !== journalKey_()) return json_({ ok: false, error: 'unauthorised' });
    if (b.action === 'add') return json_(addTrade_(b.t || {}));
    if (b.action === 'result') return json_(setResult_(b));
    if (b.action === 'habit') return json_(saveHabit_(b));
    if (b.action === 'sugar') return json_(addSugar_(b));
    if (b.action === 'project') return json_(updateProject_(b));
    if (b.action === 'ritual') return json_(writeRitual_(b));
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
    sh.getRange(1, 1, 1, J_BASE.length).setValues([J_BASE]).setFontWeight('bold').setBackground('#e8eefc');
    sh.setFrozenRows(1);
  }
  if (String(sh.getRange(1, 15).getValue()) !== CHECK_HEAD[0]) setupChecklist_(sh);
  return sh;
}
// adds the TRENDS checklist columns, GO / NO-GO verdict and the report block (runs once by itself)
function setupChecklist_(sh) {
  if (sh.getMaxColumns() < 30) sh.insertColumnsAfter(sh.getMaxColumns(), 30 - sh.getMaxColumns());
  sh.getRange(1, 15, 1, 6).setValues([CHECK_HEAD]).setFontWeight('bold').setBackground('#fff4d6').setWrap(true);
  sh.getRange('U1').setFormula('={"Checklist (of 6)";ARRAYFORMULA(IF(A2:A="",,MMULT((O2:T="✓")*1,SEQUENCE(6,1,1,0))))}');
  sh.getRange('V1').setFormula('={"Verdict";ARRAYFORMULA(IF(A2:A="",,IF(MMULT((O2:T<>"")*1,SEQUENCE(6,1,1,0))=0,"—",IF(U2:U=6,"GO","NO-GO"))))}');
  sh.getRange('U1:V1').setFontWeight('bold').setBackground('#fff4d6');
  sh.getRange('O2:T2000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['✓', '✗'], true).build())
    .setHorizontalAlignment('center');
  sh.setColumnWidths(15, 6, 95);
  sh.getRange('B2:B').setNumberFormat('yyyy-mm-dd');
  const v = sh.getRange('V2:V2000'), rules = sh.getConditionalFormatRules();
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('GO').setBackground('#c9f2d6').setFontColor('#11683a').setBold(true).setRanges([v]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('NO-GO').setBackground('#fbd5d2').setFontColor('#9b1c14').setBold(true).setRanges([v]).build());
  sh.setConditionalFormatRules(rules);
  writeReport_(sh);
}
function writeReport_(sh) {
  const per = ',$B$2:$B,">="&$Y$3,$B$2:$B,"<="&$AA$3';
  const cnt = x => 'COUNTIFS($A$2:$A,"<>"' + per + x + ')';
  const win = x => { const c = cnt(x + ',$K$2:$K,"Correct*"'), w = cnt(x + ',$K$2:$K,"Wrong*"');
    return '=IFERROR(TEXT(' + c + '/(' + c + '+' + w + '),"0%"),"–")'; };
  sh.getRange('X1:AA1').merge().setValue('“' + QUOTE + '”').setFontSize(15).setFontWeight('bold').setFontColor('#ffffff')
    .setBackground('#14213d').setHorizontalAlignment('center');
  sh.getRange('X2:AA2').merge().setValue(KEY_LINE).setFontStyle('italic').setFontWeight('bold').setFontColor('#14213d')
    .setBackground('#fcd34d').setHorizontalAlignment('center');
  sh.getRange('X3:AA3').setValues([['Report from', '', 'to', '']]).setFontWeight('bold');
  sh.getRange('Y3').setFormula('=EOMONTH(TODAY(),-1)+1').setNumberFormat('yyyy-mm-dd').setBackground('#fff9c4');
  sh.getRange('AA3').setFormula('=TODAY()').setNumberFormat('yyyy-mm-dd').setBackground('#fff9c4');
  const rows = [
    ['Decision report', 'Count', 'Win rate', ''],
    ['Decisions logged', '=' + cnt(''), win(''), ''],
    ['GO (all 6 ✓)', '=' + cnt(',$V$2:$V,"GO"'), win(',$V$2:$V,"GO"'), ''],
    ['NO-GO (any ✗)', '=' + cnt(',$V$2:$V,"NO-GO"'), win(',$V$2:$V,"NO-GO"'), ''],
    ['Traded on NO-GO (rule broken)', '=' + cnt(',$V$2:$V,"NO-GO",$E$2:$E,"<>No trade",$K$2:$K,"<>Not taken"'), '', ''],
    ['Correct', '=' + cnt(',$K$2:$K,"Correct*"'), '', ''],
    ['Wrong', '=' + cnt(',$K$2:$K,"Wrong*"'), '', ''],
    ['Still open', '=' + cnt(',$K$2:$K,"Open"'), '', ''],
    ['Average checklist score (of 6)', '=IFERROR(ROUND(AVERAGEIFS($U$2:$U,$A$2:$A,"<>",$V$2:$V,"<>—"' + per + '),1),"–")', '', ''],
    ['', '', '', ''],
    ['Checklist item', 'Times ✓', 'Win rate when ✓', 'Win rate when ✗']
  ];
  CHECK.forEach((c, i) => { const col = String.fromCharCode(79 + i), r = '$' + col + '$2:$' + col;
    rows.push([CHECK_HEAD[i], '=' + cnt(',' + r + ',"✓"'), win(',' + r + ',"✓"'), win(',' + r + ',"✗"')]); });
  const rg = sh.getRange(5, 24, rows.length, 4);
  rg.setValues(rows.map(r => r.map(x => String(x).charAt(0) === '=' ? '' : x)));
  rows.forEach((r, i) => r.forEach((x, j) => { if (String(x).charAt(0) === '=') sh.getRange(5 + i, 24 + j).setFormula(x); }));
  [5, 15].forEach(r => sh.getRange(r, 24, 1, 4).setFontWeight('bold').setBackground('#e8eefc'));
  sh.getRange(5, 25, rows.length, 3).setHorizontalAlignment('center');
  sh.setColumnWidth(24, 250); sh.setColumnWidths(25, 3, 110);
}
// run this from the editor if you ever want to rebuild the checklist columns and the report
function setupChecklist() { setupChecklist_(journalSheet_()); Logger.log('Checklist and report ready in ' + JOURNAL_TAB); }
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
    clip(t.points, 1500), clip(t.confidence, 20), 'Open', '', '', ''].concat(
    CHECK.map((c, i) => { const m = String(t.check || '').charAt(i); return m === '✓' || m === '✗' ? m : ''; })));
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

/* ---------------- PIs with big grants (refreshed once a month by the GitHub Action) ---------------- */
const PI_TAB = 'PI_Grants';
const PI_HEAD = ['Area', 'PI', 'Email', 'Website', 'Institution', 'Country', 'Grant / funder', 'Amount (approx)', 'In ₹ (approx)',
                 'Ends', 'Remaining', 'Hiring permanent staff?', 'Hiring note / link', 'Source', 'My note'];
const PI_KEYS = ['area', 'pi', 'email', 'website', 'institution', 'country', 'grant', 'amount', 'inr', 'ends', 'remaining', 'hiring', 'hiring_note', 'source'];
function piSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(PI_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(PI_TAB);
  sh.getRange(1, 1, 1, PI_HEAD.length).setValues([PI_HEAD]).setFontWeight('bold').setBackground('#e8eefc');
  sh.setFrozenRows(1); sh.setColumnWidth(2, 180); sh.setColumnWidth(7, 260); sh.setColumnWidth(13, 240); sh.setColumnWidth(15, 220);
  sh.getRange('A2:A500').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Magnetism & Spintronics', 'AI / ML', 'Quantum computation'], true).build());
  sh.getRange('L2:L500').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Yes', 'Postdoc/PhD only', 'Not stated'], true).build());
  sh.getRange('J1').setNote('End of the grant, e.g. 2029 or 2029-06. Leave "Remaining" empty: the page works it out.');
  return sh;
}
function readPis_() {
  const sh = piSheet_(), last = sh.getLastRow();
  const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, PI_HEAD.length).getDisplayValues()
    .filter(r => String(r[1]).trim()).map(r => { const o = {}; PI_KEYS.forEach((k, i) => o[k] = r[i]); o.note = r[14]; return o; });
  let gov = [];
  const g = govSheet_();
  if (g.getLastRow() >= 2) gov = g.getRange(2, 1, g.getLastRow() - 1, GOV_KEYS.length).getDisplayValues()
    .filter(r => String(r[1]).trim()).map(r => { const o = {}; GOV_KEYS.forEach((k, i) => o[k] = r[i]); return o; });
  const url = ss_().getUrl();
  return { rows: rows, gov: gov, piUrl: url + '#gid=' + sh.getSheetId(), govUrl: url + '#gid=' + g.getSheetId(),
           updated: props_().getProperty('PI_EDITED') || '' };
}
const GOV_TAB = 'Gov_Funds';
const GOV_HEAD = ['Country', 'Programme', 'Field', 'Budget (approx)', 'In ₹ (approx)', 'Period', 'Ends', 'Remaining',
                  'Main institutions / hubs', 'Jobs advertised?', 'Jobs page', 'Official link'];
const GOV_KEYS = ['country', 'programme', 'field', 'amount', 'inr', 'period', 'ends', 'remaining', 'institutions', 'jobs', 'jobs_link', 'link'];
function govSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(GOV_TAB);
  if (!sh) { sh = ss.insertSheet(GOV_TAB);
    sh.getRange(1, 1, 1, GOV_HEAD.length).setValues([GOV_HEAD]).setFontWeight('bold').setBackground('#e8eefc');
    sh.setFrozenRows(1); sh.setColumnWidth(2, 260); sh.setColumnWidth(9, 320);
    sh.getRange('C2:C500').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['Magnetism & Spintronics', 'AI / ML', 'Quantum', 'Several'], true).build());
    sh.getRange('H2').setNote('Remaining is worked out by the page from "Ends" (e.g. 2031 or 2031-03) if you leave it empty.'); }
  return sh;
}
function writeGov_(rows) {
  const sh = govSheet_();
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, GOV_HEAD.length).clearContent();
  const safe = v => { v = String(v == null ? '' : v).slice(0, 600); return /^[=+\-@]/.test(v) ? "'" + v : v; };
  const vals = rows.slice(0, 60).map(o => GOV_KEYS.map(k => safe(o[k])));
  if (vals.length) sh.getRange(2, 1, vals.length, GOV_HEAD.length).setValues(vals);
  return vals.length;
}
// run once: creates the PI_Grants and Gov_Funds tabs (you fill them in) and the 1st-of-month email reminder
function setupGrants() {
  piSheet_(); govSheet_();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'monthlyGrantReminder').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('monthlyGrantReminder').timeBased().onMonthDay(1).atHour(8).inTimezone('Asia/Kolkata').create();
  Logger.log('PI_Grants and Gov_Funds ready; reminder set for 8 AM on the 1st of every month');
}
function monthlyGrantReminder() {
  const p = readPis_(), me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, '🔔 Monthly update: PI grants & government funding',
    'It is the 1st of the month: time to update your lists.\n\n' +
    'PI_Grants (' + p.rows.length + ' PIs): ' + p.piUrl + '\n' +
    'Gov_Funds (' + p.gov.length + ' programmes): ' + p.govUrl + '\n\n' +
    'Add new PIs, update amounts / end dates, and remove grants that have ended. The Morning Brief shows them on the Science & career page.');
}
// replaces the list; keeps what you typed in "My note" for PIs that are still on it
function writePis_(rows, date, gov) {
  const sh = piSheet_(), last = sh.getLastRow(), notes = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, PI_HEAD.length).getDisplayValues().forEach(r => { if (r[14]) notes[String(r[1]).toLowerCase()] = r[14]; });
  if (last >= 2) sh.getRange(2, 1, last - 1, PI_HEAD.length).clearContent();
  const safe = v => { v = String(v == null ? '' : v).slice(0, 500); return /^[=+\-@]/.test(v) ? "'" + v : v; };
  const vals = rows.slice(0, 80).map(o => PI_KEYS.map(k => safe(o[k])).concat([notes[String(o.pi || '').toLowerCase()] || '']));
  if (vals.length) sh.getRange(2, 1, vals.length, PI_HEAD.length).setValues(vals);
  props_().setProperty('PI_SCANNED', String(date).slice(0, 10));
  const g = gov && gov.length ? writeGov_(gov) : 0;
  return { ok: true, written: vals.length, gov: g };
}

/* ---------------- daily writing ritual (Google Doc tab) ---------------- */
const R_DATE = /^\s*(\d{1,2})\s*([A-Za-z]{3})[A-Za-z]*\s*,?\s*(\d{4})\s*(\([A-Za-z]+\))?\s*:?/;
function ritualBody_() {
  if (!RITUAL_DOC) throw new Error('RITUAL_DOC is empty: paste your Evening_Rituals doc link at the top of the script');
  const id = (RITUAL_DOC.match(/[-\w]{25,}/) || [RITUAL_DOC])[0];
  const doc = DocumentApp.openById(id);
  const all = [], walk = tabs => tabs.forEach(t => { all.push(t); walk(t.getChildTabs()); });
  walk(doc.getTabs());
  const tab = all.filter(t => t.getTitle().toLowerCase().indexOf(RITUAL_TAB.toLowerCase()) >= 0)[0];
  if (!tab) throw new Error('No tab with "' + RITUAL_TAB + '" in its name');
  return { doc: doc, body: tab.asDocumentTab().getBody(), title: tab.getTitle() };
}
function ritualLabel_(d) {
  const tz = 'Asia/Kolkata';
  return Utilities.formatDate(d, tz, 'ddMMMyyyy') + '(' + Utilities.formatDate(d, tz, 'EEEE') + ')';
}
// entries = a dated line ("25Nov2026(Wednesday): ...") and the lines under it
function ritualEntries_(body) {
  const out = []; let cur = null;
  for (let i = 0; i < body.getNumChildren(); i++) {
    const el = body.getChild(i);
    const t = paraText_(el); if (t === null) continue;
    const m = t.match(R_DATE);
    if (m) {
      cur = { label: t.slice(0, m[0].length).replace(/:\s*$/, '').trim(), key: (m[1].length < 2 ? '0' : '') + m[1] + m[2].toLowerCase() + m[3],
              start: i, end: i, lines: [] };
      const rest = t.slice(m[0].length).trim(); if (rest) cur.lines.push(rest);
      out.push(cur);
    } else if (cur && t.trim()) { cur.end = i; cur.lines.push(t); }
  }
  return out;
}
function paraEl_(el) {
  const T = DocumentApp.ElementType;
  return el.getType() === T.PARAGRAPH ? el.asParagraph() : el.getType() === T.LIST_ITEM ? el.asListItem() : null;
}
function paraText_(el) { const p = paraEl_(el); return p ? p.getText() : null; }
function readRitual_(n) {
  const r = ritualBody_(), e = ritualEntries_(r.body);
  const keyOf = x => { const d = new Date(x.key.replace(/^(\d\d)([a-z]{3})(\d{4})$/, '$1 $2 $3')); return isNaN(d) ? 0 : d.getTime(); };
  const list = e.slice().sort((a, b) => keyOf(b) - keyOf(a)).slice(0, n)
    .map(x => ({ label: x.label, text: x.lines.join('\n'), words: x.lines.join(' ').split(/\s+/).filter(Boolean).length }));
  return { tab: r.title, url: r.doc.getUrl(), today: ritualLabel_(new Date()), entries: list };
}
function writeRitual_(b) {
  const text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 20000);
  if (!text) return { ok: false, error: 'nothing to save' };
  const r = ritualBody_(), body = r.body, now = new Date(), label = ritualLabel_(now);
  const key = Utilities.formatDate(now, 'Asia/Kolkata', 'ddMMMyyyy').toLowerCase();
  const entries = ritualEntries_(body), today = entries.filter(x => x.key === key)[0];
  const ref = entries.length ? paraEl_(body.getChild(entries[0].start)).editAsText() : null;
  const font = (ref && ref.getFontFamily(0)) || 'Calibri', size = (ref && ref.getFontSize(0)) || 15;
  const ins = (i, t) => i >= body.getNumChildren() ? body.appendParagraph(t) : body.insertParagraph(i, t);
  const style = p => { p.setHeading(DocumentApp.ParagraphHeading.NORMAL);
    p.editAsText().setFontFamily(font).setFontSize(size).setBold(false); return p; };
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  let at;
  if (today) at = today.end + 1;                                          // add to today's entry
  else {
    at = RITUAL_NEWEST_FIRST && entries.length ? Math.min.apply(null, entries.map(x => x.start)) : body.getNumChildren();
    const h = style(ins(at, label + ':'));
    h.editAsText().setBold(0, label.length - 1, true); at++;
  }
  lines.forEach(l => { style(ins(at++, l)); });
  if (!today && at < body.getNumChildren()) style(ins(at, ''));   // blank line between days
  r.doc.saveAndClose();
  const words = (today ? today.lines.join(' ') + ' ' : '') + text;
  const n = words.split(/\s+/).filter(Boolean).length;
  if (n >= 200) { try { tickHabit_(Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd'), 0); } catch (e) {} }
  return { ok: true, words: n, ticked: n >= 200 };
}
// sets one habit mark (0 = W) to ✓ for a day, leaving the others as they are
function tickHabit_(date, k) {
  const sh = habitSheet_(), last = sh.getLastRow();
  let row = 0;
  if (last >= 2) { const d = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    for (let i = 0; i < d.length; i++) if (d[i][0] === date) { row = i + 2; break; } }
  if (!row) { row = Math.max(2, last + 1); const [y, m, dd] = date.split('-').map(Number); sh.getRange(row, 1).setValue(new Date(y, m - 1, dd)); }
  sh.getRange(row, 2 + k).setValue('✓');
}
// run once after pasting the doc link: asks for Google Docs permission and checks the tab is found
function testRitual() { Logger.log(JSON.stringify(readRitual_(3)).slice(0, 3000)); }

/* ---------------- projects & small tasks (with progress bars) ---------------- */
const PROJ_TAB = 'Projects', PLOG_TAB = 'Project_Log';
const P_HEAD = ['Project / task', 'Type', 'Status', 'Progress %', 'Progress', 'Status on', 'Due date', 'Related files', 'Notes', 'Last update'];
const P_STATUS = ['Not started', 'In progress', 'On hold', 'Completed', 'Failed-Rejected'];
const P_TYPES = ['Project', 'Small task'];
function projectSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(PROJ_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(PROJ_TAB);
  sh.getRange(1, 1, 1, P_HEAD.length).setValues([P_HEAD]).setFontWeight('bold').setBackground('#e8eefc');
  sh.setFrozenRows(1);
  sh.getRange('E1').setFormula('={"Progress";ARRAYFORMULA(IF(A2:A="",,IF(D2:D="","",REPT("█",ROUND(D2:D/10))&REPT("░",10-ROUND(D2:D/10))&"  "&D2:D&"%")))}');
  sh.getRange('B2:B1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(P_TYPES, true).build());
  sh.getRange('C2:C1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(P_STATUS, true).build());
  sh.getRange('D2:D1000').setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(0, 100).setAllowInvalid(false).build());
  sh.getRange('F2:G1000').setNumberFormat('dd mmm yyyy');
  sh.getRange('E2:E1000').setFontFamily('Roboto Mono');
  const col = (rg, f, bg, fc) => SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f).setBackground(bg).setFontColor(fc).setRanges([sh.getRange(rg)]).build();
  sh.setConditionalFormatRules([
    col('C2:C1000', '=$C2="Completed"', '#1e6b3a', '#ffffff'), col('C2:C1000', '=$C2="In progress"', '#d4f5c9', '#1e6b3a'),
    col('C2:C1000', '=$C2="Failed-Rejected"', '#b3261e', '#ffffff'), col('C2:C1000', '=$C2="On hold"', '#fff1c2', '#7a5b00'),
    col('C2:C1000', '=$C2="Not started"', '#eceff1', '#455a64'),
    col('E2:E1000', '=$C2="Completed"', '#ffffff', '#2e7d32'), col('E2:E1000', '=$C2="Failed-Rejected"', '#ffffff', '#c62828'),
    col('E2:E1000', '=$D2<>""', '#ffffff', '#e69500'),
    col('G2:G1000', '=AND($G2<>"",$G2<TODAY(),$C2<>"Completed",$C2<>"Failed-Rejected")', '#fde2e1', '#b3261e')]);
  sh.setColumnWidth(1, 260); sh.setColumnWidth(5, 170); sh.setColumnWidth(8, 180); sh.setColumnWidth(9, 260);
  // summary block
  sh.getRange('L1:M1').setValues([['Summary', '']]).setFontWeight('bold').setBackground('#e8eefc');
  const sum = [['Total', '=COUNTA(A2:A)']].concat(P_STATUS.map(st => [st, '=COUNTIF(C2:C,"' + st + '")']),
    [['Average progress (in progress)', '=IFERROR(ROUND(AVERAGEIFS(D2:D,C2:C,"In progress"),0)&"%","–")'],
     ['Overdue', '=COUNTIFS(G2:G,"<"&TODAY(),C2:C,"<>Completed",C2:C,"<>Failed-Rejected")'],
     ['Updated in last 7 days', '=COUNTIF(J2:J,">="&TODAY()-7)']]);
  sum.forEach((r, i) => { sh.getRange(2 + i, 12).setValue(r[0]); sh.getRange(2 + i, 13).setFormula(r[1]); });
  sh.setColumnWidth(12, 210);
  // starter rows from your old tracker (add links in "Related files" yourself)
  const d = (y, m, dd) => new Date(y, m - 1, dd);
  const seed = [
    ['Daily Diabetes/Money care/Reversal', 'Project', 'In progress', '', '', d(2025, 6, 27), '', 'Food for Diabetes', 'Finance_BKM'],
    ['Addiction Control', 'Project', 'In progress', '', '', d(2025, 12, 1), '', '', ''],
    ['2-D Material Simu', 'Project', 'In progress', '', '', '', '', '', 'Codes are ready'],
    ['Job Security: Neutron data analysis: Real time', 'Project', 'Completed', 100, '', d(2025, 6, 1), '', 'Update PPT file', 'Task Updates'],
    ['My Strength my CV & Interview Preparation', 'Project', 'Completed', 100, '', d(2025, 3, 25), '', 'Personal_…', ''],
    ['Writing Code Labview for CRP', 'Project', 'Completed', 100, '', d(2025, 2, 5), '', '', 'SHNO_11_07_2023_Onwards.pptx'],
    ['CRP final report', 'Project', 'Completed', 100, '', '', '', '', 'Done All'],
    ['Perovskite Dev NITP', 'Project', 'Completed', 100, '', d(2024, 11, 8), '', 'Dev Kumar…', 'Done all.'],
    ['Travel Plans', 'Project', 'Completed', 100, '', '', '', 'Travel Plans', 'Bali trip done'],
    ['2-D Materials for THz-X', 'Project', 'Failed-Rejected', '', '', d(2024, 10, 29), '', '', 'Sent to Piyush.'],
    ['STFMR device Fabrication - X', 'Project', 'Failed-Rejected', '', '', d(2024, 10, 29), '', 'For men m…', '']];
  seed.forEach(r => sh.appendRow(r.concat(['']).map((x, j) => j === 4 ? '' : x)));
  sh.getRange(2, 5, seed.length, 1).clearContent();
  return sh;
}
function plogSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(PLOG_TAB);
  if (sh) return sh;
  sh = ss.insertSheet(PLOG_TAB);
  sh.getRange(1, 1, 1, 6).setValues([['Date', 'Time', 'Project / task', 'Status', 'Progress %', 'Update']]).setFontWeight('bold').setBackground('#e8eefc');
  sh.setFrozenRows(1); sh.setColumnWidth(3, 260); sh.setColumnWidth(6, 360);
  sh.getRange('A2:A5000').setNumberFormat('yyyy-mm-dd');
  return sh;
}
function readProjects_() {
  const sh = projectSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const rg = sh.getRange(2, 1, last - 1, P_HEAD.length), v = rg.getDisplayValues(), rt = rg.getRichTextValues(), raw = rg.getValues();
  const link = c => { try { const u = c.getLinkUrl() || (c.getRuns().map(x => x.getLinkUrl()).filter(Boolean)[0]); return u || ''; } catch (e) { return ''; } };
  const out = [];
  v.forEach((r, i) => { if (!String(r[0]).trim()) return;
    out.push({ row: i + 2, name: r[0], type: r[1] || 'Project', status: r[2], progress: r[3], on: r[5], due: r[6],
      dueIso: raw[i][6] instanceof Date ? Utilities.formatDate(raw[i][6], 'Asia/Kolkata', 'yyyy-MM-dd') : '', files: r[7], filesUrl: link(rt[i][7]), notes: r[8], notesUrl: link(rt[i][8]), updated: r[9] }); });
  return out;
}
// one daily update (from the web page): sets status / progress / note and writes a line in Project_Log
function updateProject_(b) {
  const sh = projectSheet_(), tz = 'Asia/Kolkata', now = new Date();
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'project name is required' };
  const status = P_STATUS.indexOf(b.status) >= 0 ? b.status : 'In progress';
  let prog = b.progress === '' || b.progress == null ? '' : Math.max(0, Math.min(100, Math.round(Number(b.progress))));
  if (status === 'Completed') prog = 100;
  const note = String(b.note || '').slice(0, 500), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const stamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm');
  let row = Number(b.row) || 0;
  if (row > 1 && String(sh.getRange(row, 1).getValue()).trim() !== name) row = 0;   // sheet changed: find by name
  if (!row) { const names = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
    for (let i = 1; i < names.length; i++) if (String(names[i][0]).trim().toLowerCase() === name.toLowerCase()) { row = i + 1; break; } }
  if (!row) {
    sh.appendRow([name, P_TYPES.indexOf(b.type) >= 0 ? b.type : 'Project', status, prog, '', today, b.due ? new Date(b.due + 'T00:00:00') : '', '', note, stamp]);
    row = sh.getLastRow(); sh.getRange(row, 5).clearContent();
  } else {
    sh.getRange(row, 3, 1, 2).setValues([[status, prog]]);
    sh.getRange(row, 6).setValue(today);
    if (b.due) sh.getRange(row, 7).setValue(new Date(b.due + 'T00:00:00'));
    if (P_TYPES.indexOf(b.type) >= 0) sh.getRange(row, 2).setValue(b.type);
    if (note) sh.getRange(row, 9).setValue(note);
    sh.getRange(row, 10).setValue(stamp);
  }
  plogSheet_().appendRow([today, Utilities.formatDate(now, tz, 'HH:mm'), name, status, prog, note]);
  return { ok: true, row: row };
}
// edits typed straight into the Projects tab: stamp the date, 100% on Completed, and log it
function onProjectEdit(e) {
  try {
    const sh = e.range.getSheet(); if (sh.getName() !== PROJ_TAB) return;
    const r = e.range.getRow(), c = e.range.getColumn(); if (r < 2 || (c !== 3 && c !== 4) || e.range.getNumRows() > 1) return;
    const name = String(sh.getRange(r, 1).getValue()).trim(); if (!name) return;
    const now = new Date(), status = String(sh.getRange(r, 3).getValue());
    if (status === 'Completed') sh.getRange(r, 4).setValue(100);
    sh.getRange(r, 6).setValue(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    sh.getRange(r, 10).setValue(Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm'));
    plogSheet_().appendRow([new Date(now.getFullYear(), now.getMonth(), now.getDate()), Utilities.formatDate(now, 'Asia/Kolkata', 'HH:mm'),
      name, status, sh.getRange(r, 4).getValue(), '(edited in sheet)']);
  } catch (err) { console.warn(err); }
}
// run once: creates the Projects + Project_Log tabs and the edit trigger
function setupProjects() {
  projectSheet_(); plogSheet_();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onProjectEdit').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onProjectEdit').forSpreadsheet(SHEET_ID).onEdit().create();
  Logger.log('Projects tab ready');
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
