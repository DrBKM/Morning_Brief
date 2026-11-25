/**
 * Morning Brief helper: gives the GitHub Action today's tasks (from your Google Sheet)
 * and important Gmail messages. It runs under YOUR Google account, so nothing else
 * needs Gmail or Sheets permission.
 *
 * Setup (once):
 *  1. script.google.com -> New project -> paste this file -> Save.
 *  2. Run setToken() once, allow the permissions, copy the token from the log.
 *  3. Deploy -> New deployment -> Web app: Execute as "Me", Who has access "Anyone".
 *     Copy the /exec URL.  (Later edits: Manage deployments -> Edit -> Version: New version.)
 *  4. In GitHub add secrets GAS_URL (the /exec URL) and GAS_TOKEN (the token).
 */
const SHEET_ID = '1zbibhAo405h4YtCEoxrr2ztyeoaUlgnv4Ip3jRdAGPQ';
const TAB_GID = 1149256767;          // the tab in your link (#gid=...)
const MAX_ROWS = 150;                // newest rows sent to Claude
const MAIL_QUERY = 'in:inbox newer_than:1d (is:important OR is:starred) -category:promotions -category:social';

function doGet(e) {
  const token = PropertiesService.getScriptProperties().getProperty('BRIEF_TOKEN');
  if (!token || !e || !e.parameter || e.parameter.token !== token) return json_({ ok: false, error: 'unauthorised' });
  const res = { ok: true, tz: Session.getScriptTimeZone() };
  try { res.tasks = readTasks_(); } catch (err) { res.tasks = { error: String(err) }; }
  try { res.emails = readEmails_(); } catch (err) { res.emails = []; res.mailError = String(err); }
  return json_(res);
}

function readTasks_() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheets().filter(s => s.getSheetId() === TAB_GID)[0];
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

/** Run once from the editor: creates the secret token and shows it in the log. */
function setToken() {
  const t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('BRIEF_TOKEN', t);
  readTasks_(); readEmails_();            // triggers the Sheets + Gmail permission prompts now
  Logger.log('GAS_TOKEN = ' + t);
}

/** Run from the editor to check what the Action will receive. */
function testOutput() {
  Logger.log(JSON.stringify({ tasks: readTasks_(), emails: readEmails_() }).slice(0, 4000));
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
