"""
Builds data/briefing.json for the 8:30 Desk page. Runs daily from GitHub Actions.

Sections
  1. Market briefing        RSS headlines  -> Claude summary            (public)
  2. Research radar         journal RSS + arXiv -> Claude picks top papers (public)
  3. Physics jobs + events  Claude with web search                    (public)
  4. Tasks + emails         Apps Script (your Google Sheet + Gmail)
                            -> Claude digest -> ENCRYPTED with your passphrase (private)

Secrets (GitHub repo -> Settings -> Secrets and variables -> Actions):
  ANTHROPIC_API_KEY   Claude Console API key (starts sk-ant-api03-)
  GAS_URL             Apps Script web-app URL (ends /exec)
  GAS_TOKEN           the token printed by setToken() in the Apps Script
  BRIEF_PASSPHRASE    passphrase that locks the private section on the page
Optional repository variables (same page, "Variables" tab):
  BRIEF_LOCAL_AREA    e.g. "Purulia, West Bengal"
  BRIEF_MODEL         model for summaries      (default claude-haiku-5-5, the cheapest)
  BRIEF_SEARCH_MODEL  model for web search     (default claude-haiku-5-5)
"""
import base64
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import feedparser
import requests

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime.now(IST)
TODAY = NOW.strftime("%A, %d %B %Y")

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MODEL = os.environ.get("BRIEF_MODEL") or "claude-haiku-5-5"
SEARCH_MODEL = os.environ.get("BRIEF_SEARCH_MODEL") or "claude-haiku-5-5"
LOCAL_AREA = os.environ.get("BRIEF_LOCAL_AREA") or "Purulia, West Bengal"
GAS_URL = os.environ.get("GAS_URL", "").strip()
GAS_TOKEN = os.environ.get("GAS_TOKEN", "").strip()
PASSPHRASE = os.environ.get("BRIEF_PASSPHRASE", "")
MAX_SEARCHES = 6          # each web search costs $0.01; this caps the daily search bill
UA = {"User-Agent": "Mozilla/5.0 (Morning_Brief bot)"}


def log(*a):
    print(*a, file=sys.stderr)


# ---------------------------------------------------------------- feeds
MARKET_FEEDS = [
    ("Economic Times — Markets", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"),
    ("Economic Times — Top News", "https://economictimes.indiatimes.com/rssfeedstopstories.cms"),
    ("Moneycontrol — Markets", "https://www.moneycontrol.com/rss/marketreports.xml"),
    ("Moneycontrol — Business", "https://www.moneycontrol.com/rss/business.xml"),
    ("CNBC — Finance", "https://www.cnbc.com/id/20910258/device/rss/rss.html"),
]
RESEARCH_FEEDS = [
    ("Nature", "https://www.nature.com/nature.rss"),
    ("Science", "https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science"),
    ("Nature Physics", "https://www.nature.com/nphys.rss"),
    ("Nature Nanotechnology", "https://www.nature.com/nnano.rss"),
    ("Nature Materials", "https://www.nature.com/nmat.rss"),
    ("Nature Electronics", "https://www.nature.com/natelectron.rss"),
    ("Nature Machine Intelligence", "https://www.nature.com/natmachintell.rss"),
    ("Nature Communications", "https://www.nature.com/ncomms.rss"),
    ("npj Spintronics", "https://www.nature.com/npjspintronics.rss"),
    ("npj Quantum Information", "https://www.nature.com/npjqi.rss"),
    ("Physical Review Letters", "http://feeds.aps.org/rss/recent/prl.xml"),
    ("PRX Quantum", "http://feeds.aps.org/rss/recent/prxquantum.xml"),
]
ARXIV_QUERY = ("(cat:cond-mat.mes-hall OR cat:cond-mat.mtrl-sci OR cat:quant-ph) AND "
               "(abs:magnon OR abs:spintronic OR abs:skyrmion OR abs:%22spin wave%22 OR "
               "abs:%22spin-orbit torque%22 OR abs:altermagnet OR abs:nanomagnet OR "
               "abs:%22quantum computing%22 OR abs:qubit)")
KEYWORDS = ["magnon", "spin wave", "spintron", "spin-orbit torque", "spin orbit torque", "skyrmion",
            "nanomagnet", "magnetic", "magnetism", "antiferromagnet", "altermagnet", "ferromagnet",
            "spin current", "spin hall", "spin-hall", "qubit", "quantum comput", "quantum error",
            "quantum processor", "quantum advantage", "artificial intelligence", "machine learning",
            "neural network", "deep learning", "language model"]


def get_feed(url):
    r = requests.get(url, timeout=20, headers=UA)
    r.raise_for_status()
    return feedparser.parse(r.content)


def fetch_headlines():
    items = []
    for name, url in MARKET_FEEDS:
        try:
            for e in get_feed(url).entries[:8]:
                items.append({"source": name, "title": e.get("title", "").strip(), "link": e.get("link", "")})
        except Exception as ex:
            log(f"[warn] market feed {name}: {ex}")
    return items


def clean(s, n=320):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", s).strip()[:n]


def fetch_research():
    out, seen = [], set()
    cutoff = NOW - timedelta(days=8)
    for name, url in RESEARCH_FEEDS:
        try:
            for e in get_feed(url).entries[:60]:
                title, summ = clean(e.get("title", ""), 220), clean(e.get("summary", ""))
                text = (title + " " + summ).lower()
                if not any(k in text for k in KEYWORDS):
                    continue
                t = e.get("published_parsed") or e.get("updated_parsed")
                if t and datetime(*t[:6], tzinfo=timezone.utc) < cutoff:
                    continue
                link = e.get("link", "")
                if link and link not in seen:
                    seen.add(link)
                    out.append({"source": name, "title": title, "summary": summ, "link": link})
        except Exception as ex:
            log(f"[warn] research feed {name}: {ex}")
    try:
        url = ("http://export.arxiv.org/api/query?search_query=" + ARXIV_QUERY.replace(" ", "+") +
               "&sortBy=submittedDate&sortOrder=descending&max_results=25")
        for e in get_feed(url).entries:
            link = e.get("link", "")
            if link not in seen:
                seen.add(link)
                out.append({"source": "arXiv (preprint)", "title": clean(e.get("title", ""), 220),
                            "summary": clean(e.get("summary", "")), "link": link})
    except Exception as ex:
        log(f"[warn] arXiv: {ex}")
    return out[:70]


def fetch_private():
    if not (GAS_URL and GAS_TOKEN):
        log("[info] GAS_URL / GAS_TOKEN not set: skipping tasks and emails")
        return None
    try:
        r = requests.get(GAS_URL, params={"token": GAS_TOKEN}, timeout=60)
        r.raise_for_status()
        d = r.json()
        if not d.get("ok"):
            log(f"[warn] Apps Script said: {d.get('error')}")
            return None
        return d
    except Exception as ex:
        log(f"[warn] Apps Script call failed: {ex}")
        return None


# ---------------------------------------------------------------- Claude
def claude(prompt, model, max_tokens=1500, search=False, system=None, max_uses=None):
    """Returns (text, urls_seen_in_search_results)."""
    tools = []
    if search:
        tools = [{"type": "web_search_20250305", "name": "web_search", "max_uses": max_uses or MAX_SEARCHES,
                  "user_location": {"type": "approximate", "country": "IN", "timezone": "Asia/Kolkata"}}]
    messages = [{"role": "user", "content": prompt}]
    urls, text = set(), ""
    for _ in range(4):                      # continue if the API pauses a long search turn
        body = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if tools:
            body["tools"] = tools
        if system:
            body["system"] = system
        hdr = {"Authorization": "Bearer " + API_KEY, "anthropic-version": "2023-06-01",
              "content-type": "application/json"}
        if os.environ.get("ANTHROPIC_WORKSPACE_ID"):
            hdr["anthropic-workspace-id"] = os.environ["ANTHROPIC_WORKSPACE_ID"]
        r = requests.post("https://api.anthropic.com/v1/messages", timeout=240, json=body, headers=hdr)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:400]}")
        data = r.json()
        for b in data.get("content", []):
            if b.get("type") == "web_search_tool_result" and isinstance(b.get("content"), list):
                urls.update(x.get("url") for x in b["content"] if x.get("url"))
            if b.get("type") == "text":
                text += b.get("text", "")
                for c in b.get("citations") or []:
                    if c.get("url"):
                        urls.add(c["url"])
        u = data.get("usage", {})
        log(f"[info] {model}: in {u.get('input_tokens')} out {u.get('output_tokens')} "
            f"searches {u.get('server_tool_use', {}).get('web_search_requests', 0)}")
        if data.get("stop_reason") != "pause_turn":
            break
        messages = [messages[0], {"role": "assistant", "content": data["content"]}]
    return text, urls


def parse_json(text):
    t = text.strip()
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b < 0:
        raise ValueError("no JSON object in reply")
    return json.loads(t[a:b + 1])


JSON_ONLY = "Reply with ONLY one raw JSON object: no markdown fences, no text before or after it."


def market_summary(headlines):
    block = "\n".join(f"- [{h['source']}] {h['title']}" for h in headlines) or "(no headlines retrieved)"
    prompt = f"""Today is {TODAY}. Write a concise pre-market briefing for an Indian equity/options
trader reading at 8:30 AM IST, from these overnight headlines. Paraphrase; never copy headline wording.

Headlines:
{block}

{JSON_ONLY} Schema:
{{"global_events": "2-3 sentences on overnight global events and risk sentiment",
  "central_banks": "2-3 sentences on central bank / rate news",
  "policy_sentiment": "1-2 sentences on Indian policy/regulatory news, or 'No major policy news overnight.'",
  "stocks_to_watch": ["Company — one short reason", "... at most 6, only names in the headlines"],
  "regime_hint": "range" | "trend-up" | "trend-down" | "volatile"}}"""
    text, _ = claude(prompt, MODEL, 2000)
    return parse_json(text)


def research_pick(cands):
    if not cands:
        return []
    block = "\n".join(f"[{i}] ({c['source']}) {c['title']} :: {c['summary']}" for i, c in enumerate(cands))
    prompt = f"""You are a research assistant for a physicist working on nanomagnetism, magnonics and
spintronics, who also follows artificial intelligence and quantum computing.
From the candidates below (published in the last week), choose the 8 most important. Prefer
high-impact journals (Nature, Science, Nature Physics/Nanotechnology/Materials/Electronics, PRL) over
preprints; include at most 3 arXiv preprints. Cover all five topics if candidates exist.

{block}

{JSON_ONLY} Schema:
{{"papers": [{{"i": <candidate number>, "topic": "Nanomagnetism" | "Magnonics" | "Spintronics" |
  "Artificial intelligence" | "Quantum computing", "why": "one sentence: the finding and why it matters"}}]}}"""
    text, _ = claude(prompt, MODEL, 1500)
    out = []
    for p in parse_json(text).get("papers", []):
        i = p.get("i")
        if isinstance(i, int) and 0 <= i < len(cands):
            c = cands[i]
            out.append({"topic": p.get("topic", ""), "why": p.get("why", ""), "title": c["title"],
                        "source": c["source"], "link": c["link"]})
    return out


def jobs_and_events():
    prompt = f"""Today is {TODAY}. Use web search to find two things. Keep searches focused.

A) JOBS for a physicist with a Ph.D. and postdocs in EXPERIMENTAL nanomagnetism, magnonics and spintronics,
who is also building skills in AI / machine learning and quantum computing. Find currently open posts
(deadline not passed), newest first, up to 15 in total, across these kinds:
  1. Faculty: Assistant Professor in Physics in India (IITs, IISERs, NITs, NISER, IISc, central/state universities,
     and reputed PRIVATE universities/institutes).
  2. Postdoc / research scientist positions in nanomagnetism, magnonics, spintronics, AI/ML or quantum computing,
     in India or abroad.
  3. Industry / company R&D jobs matching these fields: magnetic memory (MRAM), spintronic sensors, hard disk /
     storage, semiconductor and thin-film R&D, quantum computing hardware or software, AI/ML research or engineering
     roles open to physicists.
Pay rule: in India at least INR 1,00,000 per month (or 7th CPC Academic Level 10 or higher; say "about ₹1 L with
DA/HRA" for Level 10); abroad at least INR 5,00,000 per month equivalent (about USD 6,000 / EUR 5,500 / GBP 4,700 /
SGD 8,000 / JPY 900,000 per month). Give the advertised pay with an INR per-month estimate. Skip posts that clearly
pay less; if pay is not stated, include it only for well-known employers and write "not stated".

B) LOCAL EVENTS: worthwhile public events in or near {LOCAL_AREA} in the next 7 days: science, education,
culture, music, fairs, festivals, talks, family outings. Up to 6.

Use only facts from your search results; give the page URL where you found each item. Do not invent
deadlines, salaries or dates: write "see advert" if unknown.

{JSON_ONLY} Schema:
{{"jobs": [{{"type": "Faculty" | "Postdoc" | "Industry", "region": "India" | "Abroad", "post": "...",
            "institution": "...", "location": "...", "pay": "...", "deadline": "...", "url": "..."}}],
  "events": [{{"name": "...", "when": "...", "where": "...", "why": "one short line", "url": "..."}}]}}"""
    text, urls = claude(prompt, SEARCH_MODEL, 5000, search=True)
    d = parse_json(text)
    for k in ("jobs", "events"):         # drop any link that did not come from the search results
        for it in d.get(k, []):
            if it.get("url") and it["url"] not in urls:
                it["url"] = ""
    return d


def private_digest(p):
    tasks, emails = p.get("tasks") or {}, p.get("emails") or []
    mail_block = "\n".join(f"[{i}] {m.get('date','')} | {m.get('from','')} | {m.get('subject','')} :: {m.get('snippet','')}"
                           for i, m in enumerate(emails)) or "(none)"
    if not emails:                                          # nothing to sort: skip the Claude call
        return {"tasks": [], "emails": [], "sheet": tasks.get("sheet", "")}
    prompt = f"""Today is {TODAY}. You are a personal assistant preparing a morning reminder.

EMAILS from the last 24 hours marked important or starred:
{mail_block}
Pick those that need the user's attention or a reply (at most 8), most important first. Ignore newsletters
and automated notices unless they contain a deadline.

{JSON_ONLY} Schema:
{{"emails": [{{"i": <email number>, "why": "one line", "action": "reply" | "read" | "note deadline" | "none"}}]}}"""
    text, _ = claude(prompt, MODEL, 1800)
    d = parse_json(text)
    mails = []
    for e in d.get("emails", []):
        i = e.get("i")
        if isinstance(i, int) and 0 <= i < len(emails):
            m = emails[i]
            mails.append({"from": m.get("from", ""), "subject": m.get("subject", ""), "date": m.get("date", ""),
                          "link": m.get("link", ""), "why": e.get("why", ""), "action": e.get("action", "")})
    return {"tasks": [], "emails": mails, "sheet": tasks.get("sheet", "")}


def decrypt(blob, passphrase):
    """Opens the previous run's private section (used to reuse the weekend watchlist)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    d = lambda x: base64.b64decode(x)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=d(blob["salt"]),
                     iterations=blob.get("iter", 250000)).derive(passphrase.encode())
    return json.loads(AESGCM(key).decrypt(d(blob["iv"]), d(blob["ct"]), None))


def encrypt(obj, passphrase):
    """AES-256-GCM, key from PBKDF2-SHA256 (250k rounds). The page decrypts it with WebCrypto."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=250000).derive(passphrase.encode())
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode(), None)
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "iter": 250000, "salt": b(salt), "iv": b(iv), "ct": b(ct)}


# ---------------------------------------------------------------- prices (Yahoo Finance chart API)
def yahoo(sym, hist=False):
    """Last close and change for a Yahoo symbol, e.g. ^NSEI, ^BSESN, SBIN.NS (hist=True adds 3 months of closes)."""
    try:
        r = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(sym)}",
                         params={"range": "3mo" if hist else "5d", "interval": "1d"}, timeout=20, headers=UA)
        r.raise_for_status()
        res = r.json()["chart"]["result"][0]
        closes = [c for c in res["indicators"]["quote"][0]["close"] if c]
        ts = [t for t, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]) if c]
        if not closes:
            return None
        last = closes[-1]
        prev = closes[-2] if len(closes) > 1 else res["meta"].get("chartPreviousClose")
        out = {"close": round(last, 2), "date": datetime.fromtimestamp(ts[-1], IST).strftime("%a %d %b")}
        if prev:
            out["chg"] = round(last - prev, 2)
            out["pct"] = round((last - prev) / prev * 100, 2)
        if hist:
            out["hist"] = [round(c, 2) for c in closes]
            out["dates"] = [datetime.fromtimestamp(t, IST).strftime("%d %b") for t in ts]
        return out
    except Exception as ex:
        log(f"[warn] price {sym}: {ex}")
        return None


def fetch_indices():
    return {"sensex": yahoo("^BSESN", True), "nifty": yahoo("^NSEI", True), "banknifty": yahoo("^NSEBANK")}


# ---------------------------------------------------------------- stock watchlist (FFA_TIE tab)
def clean_stock(name):
    s = re.sub(r"\bISIN\b|\|", " ", str(name), flags=re.I)
    s = re.sub(r"\bIN[EF][0-9A-Z]{9}\b", " ", s)      # drop ISIN codes
    return re.sub(r"\s+", " ", s).strip()


def stock_news(name):
    url = ("https://news.google.com/rss/search?q=" + requests.utils.quote(f"{name} share when:3d") +
           "&hl=en-IN&gl=IN&ceid=IN:en")
    try:
        return [clean(e.get("title", ""), 160) for e in get_feed(url).entries[:4]]
    except Exception as ex:
        log(f"[warn] news {name}: {ex}")
        return []


def watchlist_update(watch):
    rows = (watch or {}).get("rows") or []
    if not rows:
        return []
    items = []
    for r in rows:
        name = clean_stock(r.get("stock", ""))
        if name:
            items.append({"row": r.get("row"), "stock": name, "why": r.get("why", ""), "heads": stock_news(name),
                          "fund": r.get("fund", ""), "checked": r.get("checked", "")})
    block = "\n".join(f"[{i}] {it['stock']} | thesis: {it['why'] or '-'} | headlines: " +
                      (" || ".join(it["heads"]) or "none") for i, it in enumerate(items))
    prompt = f"""Today is {TODAY}. These are stocks on an Indian investor's watchlist, each with the last
3 days of news headlines. For each stock:
- nse: its NSE trading symbol (e.g. SBIN, BHARTIARTL, BAJFINANCE, TORNTPHARM); "" if you are not sure
- news: one short paraphrased line (max 22 words) on what the news says; "No notable news." if none
- tone: "good", "bad", "mixed" or "none"
- lean: "Buy on dips", "Hold", "Watch", "Reduce" or "Avoid", judged ONLY from this news and the thesis
- why: max 12 words
Be conservative: with no clear news, use "Hold" for long-term theses and "Watch" otherwise.

{block}

{JSON_ONLY} Schema: {{"stocks": [{{"i": 0, "nse": "", "news": "", "tone": "", "lean": "", "why": ""}}]}}"""
    text, _ = claude(prompt, MODEL, 9000)
    out = []
    for s in parse_json(text).get("stocks", []):
        i = s.get("i")
        if not (isinstance(i, int) and 0 <= i < len(items)):
            continue
        it = items[i]
        sym = re.sub(r"[^A-Z0-9&\-]", "", str(s.get("nse", "")).upper())
        q = yahoo(sym + ".NS") if sym else None
        out.append({"row": it["row"], "stock": it["stock"], "why_sheet": it["why"], "nse": sym if q else "",
                    "quote": q, "news": s.get("news", ""), "tone": s.get("tone", "none"),
                    "lean": s.get("lean", ""), "lean_why": s.get("why", ""),
                    "fund": it["fund"], "checked": it["checked"], "fund_new": False})
    return out


# ---------------------------------------------------------------- fundamentals (Screener.in, every 15 days)
FUND_DAYS = 15        # re-check each stock after this many days
NEW_MAX = 40          # new stocks analysed per run (first run fills the whole sheet)
STALE_MAX = 8         # stale stocks refreshed per run, so the work is spread over the fortnight


def screener_text(sym):
    """Key sections of the stock's Screener.in page as plain text (consolidated first, then standalone)."""
    from bs4 import BeautifulSoup
    for path in (f"{sym}/consolidated/", f"{sym}/"):
        try:
            r = requests.get("https://www.screener.in/company/" + path, timeout=25, headers=UA)
            if r.status_code != 200:
                continue
            soup = BeautifulSoup(r.text, "html.parser")
            parts = []
            for sel, label in (("#top-ratios", "RATIOS"), (".ranges-table", "GROWTH"), ("#quarters table", "QUARTERS"),
                               ("#balance-sheet table", "BALANCE SHEET"), ("#shareholding table", "SHAREHOLDING")):
                for el in soup.select(sel)[:4]:
                    parts.append(label + ": " + re.sub(r"\s+", " ", el.get_text(" ", strip=True)))
            txt = "\n".join(parts)
            if "Net Profit" in txt and ("ROE" in txt or "ROCE" in txt):
                return txt[:9000], "https://www.screener.in/company/" + path
        except Exception as ex:
            log(f"[warn] screener {sym}: {ex}")
    return None, None


def fund_due(s):
    if not s.get("fund", "").strip():
        return "new"
    try:
        d = datetime.strptime(s.get("checked", "").strip()[:10], "%Y-%m-%d").replace(tzinfo=IST)
        return "stale" if (NOW - d).days >= FUND_DAYS else ""
    except ValueError:
        s["fund_stamp"] = True          # your own analysis without a date: just record today's date
        return ""


def fundamentals_update(stocks):
    new = [s for s in stocks if fund_due(s) == "new"][:NEW_MAX]
    stale = [s for s in stocks if fund_due(s) == "stale"][:STALE_MAX]
    todo = new + stale
    if not todo:
        return
    log(f"[info] fundamentals: {len(new)} new, {len(stale)} due for the 15-day refresh")
    day = NOW.strftime("%d %b %Y")
    ready = []
    for s in todo:
        txt, url = screener_text(s["nse"]) if s.get("nse") else (None, None)
        if txt:
            ready.append((s, txt))
        else:
            s["fund"] = f"⚪ Not checked ({day}): no Screener.in data found. Check the stock name or NSE symbol."
            s["fund_new"] = True
    for k in range(0, len(ready), 6):
        batch = ready[k:k + 6]
        block = "\n\n".join(f"=== [{i}] {s['stock']} (NSE: {s['nse']}) ===\n{txt}" for i, (s, txt) in enumerate(batch))
        prompt = f"""Below are Screener.in figures for Indian listed companies (consolidated where available; amounts in Rs crore).
For each company judge the business fundamentals:
- Non-financial companies: ROCE and ROE (above 15% is good), borrowings vs reserves (debt),
  3-year compounded sales and profit growth, latest quarter sales and net profit vs the same quarter a year earlier
  (compute from the QUARTERS table: last column vs the column 4 places earlier), P/E, promoter holding trend.
- Banks / NBFCs / insurers: use ROE, price to book (price / book value), profit growth and latest quarter; ignore ROCE and debt.
verdict: "Strong", "Good, caution" or "Weak".
summary: max 30 words, numbers first, e.g. "ROCE 30% / ROE 24%, low debt, 3y sales 9% / profit 6%, Q sales +12% / profit +21%, P/E 20. Cheap, steady."
Use only the figures given. If a figure is missing, leave it out.

{block}

{JSON_ONLY} Schema: {{"stocks": [{{"i": 0, "verdict": "", "summary": ""}}]}}"""
        try:
            text, _ = claude(prompt, MODEL, 2500)
            for r in parse_json(text).get("stocks", []):
                i = r.get("i")
                if isinstance(i, int) and 0 <= i < len(batch):
                    v = str(r.get("verdict", ""))
                    mark = "✅" if v.lower().startswith("strong") else "🔴" if v.lower().startswith("weak") else "🟡"
                    batch[i][0]["fund"] = f"{mark} {v} ({day}): {r.get('summary', '')}"
                    batch[i][0]["fund_new"] = True
        except Exception as ex:
            log(f"[error] fundamentals batch: {ex}")


PI_DAYS = 30           # the PI / grants list is searched again after this many days
PI_SEARCHES = 10       # web searches allowed for that monthly scan
WEEKEND = NOW.weekday() >= 5               # Saturday / Sunday: markets shut, reuse Friday's market analysis
JOB_DAYS = (0, 2, 4)                       # job & event search on Mon, Wed, Fri only (other days reuse the last list)


def pi_due(p):
    if os.environ.get("BRIEF_FORCE_PI") == "1":
        return True
    last = ((p or {}).get("pis") or {}).get("scanned", "")
    try:
        return (NOW.date() - datetime.strptime(last[:10], "%Y-%m-%d").date()).days >= PI_DAYS
    except Exception:
        return True


def remaining(ends):
    """'2029-06' or '2029' -> '2 yr 7 mo left' (or 'ended')."""
    m = re.match(r"(\d{4})(?:-(\d{1,2}))?", str(ends or ""))
    if not m:
        return ""
    y, mo = int(m.group(1)), int(m.group(2) or 12)
    left = (y - NOW.year) * 12 + (mo - NOW.month)
    if left < 0:
        return "ended"
    if left == 0:
        return "ends this month"
    parts = ([f"{left // 12} yr"] if left >= 12 else []) + ([f"{left % 12} mo"] if left % 12 else [])
    return " ".join(parts) + " left"


def pi_scan():
    prompt = f"""Today is {TODAY}. Use web search to build a list of principal investigators (PIs) anywhere in the world
who currently hold LARGE research grants, for a physicist (Ph.D., experimental nanomagnetism, magnonics, spintronics;
also building AI/ML and quantum-computing skills) who wants to approach them for positions.

Areas (aim for about 6 PIs in each, 18 in total):
  1. "Magnetism & Spintronics": EXPERIMENTAL groups only (magnetism, spintronics, magnonics, 2-D magnets, MRAM devices).
     Skip purely theoretical or computational PIs.
  2. "AI / ML": theory or experiment, preferably AI for science / physics / materials.
  3. "Quantum computation": theory or experiment (hardware, algorithms, error correction, quantum materials for qubits).
"Large" means a single active grant of roughly USD 2 million or more, or a centre / programme the PI leads, e.g. ERC
Advanced, Synergy or Consolidator, Leibniz Prize, DFG CRC/SFB speaker, UKRI programme grant or Future Leaders,
NSF/DOE/DARPA/AFOSR MURI or centre awards, ARC Laureate, JST CREST/ERATO, Singapore NRF Investigatorship/CRP,
Moore / Simons / Wellcome Leap awards, India ANRF / DST / National Quantum Mission hubs.
The grant must still be running (end date after today).

For each PI give only facts found in your search results:
- email: ONLY if it is written on an official university / institute page you found; otherwise "".
- website: the group or official profile page URL.
- grant: name of grant / funder; amount: as stated, with currency; inr: rough INR equivalent (e.g. "₹21 Cr").
- ends: end year-month like "2029-06" (or just "2029"); "" if unknown.
- hiring: "Yes" if the group or grant page currently advertises a PERMANENT or long-term staff post
  (staff scientist, research engineer, lab manager, permanent researcher), "Postdoc/PhD only" if only temporary posts
  are advertised, otherwise "Not stated". hiring_note: one short line or the jobs page URL.
- source: the URL where the grant facts were found.
Do not invent names, emails, amounts or dates.

{JSON_ONLY} Schema:
{{"pis": [{{"area": "Magnetism & Spintronics" | "AI / ML" | "Quantum computation", "pi": "...", "email": "...",
           "website": "...", "institution": "...", "country": "...", "grant": "...", "amount": "...", "inr": "...",
           "ends": "...", "hiring": "...", "hiring_note": "...", "source": "..."}}]}}"""
    text, urls = claude(prompt, SEARCH_MODEL, 8000, search=True, max_uses=PI_SEARCHES)
    rows = parse_json(text).get("pis", [])
    for r in rows:
        for k in ("website", "source"):
            if r.get(k) and r[k] not in urls:
                r[k] = ""
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", str(r.get("email", "")), re.I):
            r["email"] = ""
        r["remaining"] = remaining(r.get("ends"))
    rows = [r for r in rows if r.get("pi") and r.get("remaining") != "ended"]
    log(f"[info] PI scan: {len(rows)} PIs")
    return rows


GOV_SEARCHES = 5       # web searches for the monthly government-funding scan


def gov_scan():
    prompt = f"""Today is {TODAY}. Use web search to list CURRENT government funding initiatives (national missions,
programmes, flagship centres) worldwide for these fields: (a) magnetism / spintronics / quantum materials,
(b) artificial intelligence / machine learning, (c) quantum computing and quantum technologies.
Cover India first (e.g. National Quantum Mission and its hubs, IndiaAI Mission, ANRF / DST programmes), then
Singapore, USA, EU / Europe, UK, Germany, Japan, South Korea, China, Australia, Canada and others with large budgets.
About 12 rows. Only initiatives that are still running (end after today) or newly announced.

For each give only facts from your search results:
- country; programme; field: "Magnetism & Spintronics" | "AI / ML" | "Quantum" | "Several";
- amount: total budget as stated with currency; inr: rough INR equivalent (e.g. "₹6,003 Cr");
- period: e.g. "2023–2031"; ends: end year like "2031" ("" if unknown);
- institutions: the main host institutions / hubs / centres funded (short, comma-separated);
- jobs: "Yes" if the programme or its hubs advertise positions now (give the page in jobs_link), else "Not stated";
- link: official page URL. Do not invent numbers.

{JSON_ONLY} Schema:
{{"gov": [{{"country": "...", "programme": "...", "field": "...", "amount": "...", "inr": "...", "period": "...",
           "ends": "...", "institutions": "...", "jobs": "...", "jobs_link": "...", "link": "..."}}]}}"""
    text, urls = claude(prompt, SEARCH_MODEL, 5000, search=True, max_uses=GOV_SEARCHES)
    rows = parse_json(text).get("gov", [])
    for r in rows:
        for k in ("link", "jobs_link"):
            if r.get(k) and r[k] not in urls:
                r[k] = ""
        r["remaining"] = remaining(r.get("ends"))
    rows = [r for r in rows if r.get("programme") and r.get("remaining") != "ended"]
    log(f"[info] government funding scan: {len(rows)} programmes")
    return rows


def pi_update(p):
    """Returns the PI list: a fresh monthly scan when due, otherwise what is stored in the PI_Grants tab."""
    stored = (p or {}).get("pis") or {}
    keep = {"scanned": stored.get("scanned", ""), "rows": stored.get("rows", []), "gov": stored.get("gov", [])}
    if not pi_due(p):
        log(f"[info] PI list: last scanned {stored.get('scanned')}, next scan after {PI_DAYS} days")
        return keep
    rows = step("PI scan", pi_scan, default=[]) or []
    gov = step("government funding", gov_scan, default=[]) or []
    if not rows and not gov:
        return keep
    rows, gov = rows or keep["rows"], gov or keep["gov"]
    try:
        r = requests.post(GAS_URL, data=json.dumps({"token": GAS_TOKEN, "action": "pis", "rows": rows, "gov": gov,
                                                     "date": NOW.strftime("%Y-%m-%d")}), timeout=60,
                          headers={"Content-Type": "text/plain"})
        log(f"[info] PI_Grants write: {r.text[:120]}")
    except Exception as ex:
        log(f"[warn] PI_Grants write failed: {ex}")
    return {"scanned": NOW.strftime("%Y-%m-%d"), "rows": rows, "gov": gov}


def write_watch_back(stocks):
    """Puts today's news / lean into FFA_TIE columns C and D (only cells you left empty or that hold old 🤖 notes)."""
    if not (GAS_URL and GAS_TOKEN and stocks):
        return
    items = [{"row": s["row"], "news": s["news"], "lean": (s["lean"] + (" — " + s["lean_why"] if s["lean_why"] else "")),
              "fund": s["fund"] if s.get("fund_new") else "", "stamp": bool(s.get("fund_stamp"))}
             for s in stocks]
    try:
        r = requests.post(GAS_URL, data=json.dumps({"token": GAS_TOKEN, "action": "watch", "items": items,
                                                     "date": NOW.strftime("%d %b")}), timeout=60,
                          headers={"Content-Type": "text/plain"})
        log(f"[info] sheet write-back: {r.text[:120]}")
    except Exception as ex:
        log(f"[warn] sheet write-back failed: {ex}")


# ---------------------------------------------------------------- NSE derivatives: option chain, participant OI, FII/DII cash
NSE_HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
           "Accept": "application/json, text/plain, */*", "Accept-Language": "en-IN,en;q=0.9",
           "Referer": "https://www.nseindia.com/option-chain"}
_NSE = None


def nse_get(path):
    """Text of an NSE address. Tries NSE directly, then through the Apps Script relay (NSE often blocks cloud servers)."""
    global _NSE
    archive = path.startswith("/content/")
    try:
        if archive:
            for host in ("https://nsearchives.nseindia.com", "https://archives.nseindia.com"):
                r = requests.get(host + path, headers=NSE_HDR, timeout=20)
                if r.status_code == 200 and len(r.text) > 50:
                    return r.text
        else:
            if _NSE is None:
                _NSE = requests.Session(); _NSE.headers.update(NSE_HDR)
                _NSE.get("https://www.nseindia.com/option-chain", timeout=20)
            r = _NSE.get("https://www.nseindia.com" + path, timeout=25)
            if r.status_code == 200 and r.text.strip()[:1] in "[{":
                return r.text
            log(f"[warn] NSE direct {path[:60]}: HTTP {r.status_code}")
    except Exception as ex:
        log(f"[warn] NSE direct {path[:60]}: {ex}")
    if GAS_URL and GAS_TOKEN:
        try:
            d = requests.get(GAS_URL, params={"token": GAS_TOKEN, "what": "nse", "path": path}, timeout=90).json()
            if d.get("ok") and (archive or d.get("body", "").strip()[:1] in "[{"):
                return d["body"]
            log(f"[warn] NSE via Apps Script {path[:60]}: {d.get('status') or d.get('error')}")
        except Exception as ex:
            log(f"[warn] NSE via Apps Script {path[:60]}: {ex}")
    return None


def option_chain(sym):
    rows, exp, under, stamp = [], "", None, ""
    ci = nse_get(f"/api/option-chain-contract-info?symbol={sym}")
    if ci:
        try:
            exps = json.loads(ci).get("expiryDates") or []
            if exps:
                exp = exps[0]
                oc = nse_get(f"/api/option-chain-v3?type=Indices&symbol={sym}&expiry={requests.utils.quote(exp)}")
                if oc:
                    rec = json.loads(oc).get("records", {})
                    rows, under, stamp = rec.get("data", []), rec.get("underlyingValue"), rec.get("timestamp", "")
        except Exception as ex:
            log(f"[warn] option chain v3 {sym}: {ex}")
    if not rows:                                            # older NSE address
        oc = nse_get(f"/api/option-chain-indices?symbol={sym}")
        if oc:
            d = json.loads(oc); rec = d.get("records", {})
            exp = (rec.get("expiryDates") or [""])[0]
            rows = (d.get("filtered") or {}).get("data") or [x for x in rec.get("data", []) if x.get("expiryDate") == exp]
            under, stamp = rec.get("underlyingValue"), rec.get("timestamp", "")
    if not rows:
        return None
    chain = {}
    for x in rows:
        k = x.get("strikePrice")
        if k is None:
            continue
        ce, pe = x.get("CE") or {}, x.get("PE") or {}
        under = under or ce.get("underlyingValue") or pe.get("underlyingValue")
        c = chain.setdefault(float(k), {"k": float(k), "coi": 0, "cchg": 0, "poi": 0, "pchg": 0})
        c["coi"] += ce.get("openInterest") or 0; c["cchg"] += ce.get("changeinOpenInterest") or 0
        c["poi"] += pe.get("openInterest") or 0; c["pchg"] += pe.get("changeinOpenInterest") or 0
    ks = sorted(chain)
    if not ks or not under:
        return None
    tc, tp = sum(chain[k]["coi"] for k in ks), sum(chain[k]["poi"] for k in ks)
    pain = min(ks, key=lambda K: sum(chain[s]["coi"] * max(0, K - s) + chain[s]["poi"] * max(0, s - K) for s in ks))
    atm = min(ks, key=lambda k: abs(k - under)); i = ks.index(atm)
    win = [chain[k] for k in ks[max(0, i - 12): i + 13]]
    return {"symbol": sym, "expiry": exp, "spot": round(float(under), 2), "time": stamp, "atm": atm,
            "pcr": round(tp / tc, 2) if tc else None, "max_pain": pain,
            "res": max(ks, key=lambda k: chain[k]["coi"]), "sup": max(ks, key=lambda k: chain[k]["poi"]),
            "chg_call": sum(chain[k]["cchg"] for k in ks), "chg_put": sum(chain[k]["pchg"] for k in ks), "strikes": win}


def oi_label(bull, bear):
    r = bull / (bull + bear) if bull + bear else 0.5
    for cut, lab in ((0.65, "Strong Bullish"), (0.58, "Medium Bullish"), (0.53, "Mild Bullish"), (0.47, "Indecisive"),
                     (0.42, "Mild Bearish"), (0.35, "Medium Bearish")):
        if r >= cut if cut >= 0.53 else r > cut:
            return lab, round(r, 3)
    return "Strong Bearish", round(r, 3)


def participant_oi():
    import csv, io
    found = []
    for i in range(0, 12):
        d = NOW - timedelta(days=i)
        if d.weekday() >= 5:
            continue
        txt = nse_get(f"/content/nsccl/fao_participant_oi_{d:%d%m%Y}.csv")
        if not txt or "Client Type" not in txt:
            continue
        lines = txt.splitlines(); h = next(j for j, l in enumerate(lines) if "Client Type" in l)
        tab = {}
        for row in csv.DictReader(io.StringIO("\n".join(lines[h:]))):
            row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
            who = row.get("Client Type", "").upper()
            if who:
                tab[who] = {k: float(v.replace(",", "") or 0) for k, v in row.items() if k != "Client Type" and re.match(r"^-?[\d,.]+$", v or "")}
        found.append((d, tab))
        if len(found) == 2:
            break
    if not found:
        return None
    (d1, t1), prev = found[0], (found[1] if len(found) > 1 else (None, {}))
    def seg(t, who):
        r = t.get(who) or {}
        g = lambda n: r.get(n, 0)
        return {"fut": (g("Future Index Long"), g("Future Index Short")),
                "opt": (g("Option Index Call Long") + g("Option Index Put Short"), g("Option Index Put Long") + g("Option Index Call Short"))}
    out = []
    for who, name in (("FII", "FII"), ("DII", "DII"), ("PRO", "Pro"), ("CLIENT", "Client")):
        a, b = seg(t1, who), seg(prev[1], who)
        for key, segname in (("fut", "Index Futures"), ("opt", "Index Options")):
            bull, bear = a[key]; lab, ratio = oi_label(bull, bear)
            net = bull - bear; pnet = b[key][0] - b[key][1]
            out.append({"who": name, "seg": segname, "bull": bull, "bear": bear, "net": net,
                        "chg": (net - pnet) if prev[0] else None, "label": lab, "ratio": ratio})
    return {"date": d1.strftime("%a %d %b %Y"), "prev": prev[0].strftime("%a %d %b") if prev[0] else "", "rows": out}


def fii_dii_cash():
    t = nse_get("/api/fiidiiTradeReact")
    if not t:
        return None
    out = []
    for x in json.loads(t):
        cat = "DII" if "DII" in x.get("category", "") else "FII/FPI" if "FII" in x.get("category", "") else x.get("category", "")
        num = lambda v: float(str(v).replace(",", "") or 0)
        out.append({"who": cat, "date": x.get("date", ""), "buy": num(x.get("buyValue")), "sell": num(x.get("sellValue")), "net": num(x.get("netValue"))})
    return out


def fetch_derivatives():
    d = {}
    for sym in ("NIFTY", "BANKNIFTY"):
        d[sym.lower()] = step(f"option chain {sym}", option_chain, sym)
    d["participants"] = step("participant OI", participant_oi)
    d["cash"] = step("FII/DII cash", fii_dii_cash)
    log(f"[info] derivatives: nifty={'ok' if d['nifty'] else 'none'} banknifty={'ok' if d['banknifty'] else 'none'} "
        f"participants={'ok' if d['participants'] else 'none'} cash={'ok' if d['cash'] else 'none'}")
    return d


# ---------------------------------------------------------------- main
def step(name, fn, *a, default=None):
    try:
        return fn(*a)
    except Exception as ex:
        log(f"[error] {name}: {ex}")
        return default


def main():
    if not API_KEY:
        log("[error] ANTHROPIC_API_KEY is not set"); sys.exit(1)
    

    out = {"generated_at": datetime.now(timezone.utc).isoformat(), "local_area": LOCAL_AREA}
    try:
        with open("data/briefing.json") as f:
            prev = json.load(f)
    except Exception:
        prev = {}
    prev_priv = {}
    if prev.get("private") and PASSPHRASE:
        try:
            prev_priv = decrypt(prev["private"], PASSPHRASE)
        except Exception as ex:
            log(f"[warn] could not open the previous private section: {ex}")
    market_keys = ("global_events", "central_banks", "policy_sentiment", "stocks_to_watch", "regime_hint")
    out["indices"] = fetch_indices()
    out["derivs"] = fetch_derivatives()
    log(f"[info] indices: {out['indices']}")

    headlines = fetch_headlines()
    log(f"[info] {len(headlines)} market headlines")
    out["headlines"] = headlines[:20]
    if WEEKEND and prev.get("global_events"):
        log("[info] weekend: market summary reused from the last weekday (saves a Claude call)")
        out.update({k: prev.get(k) for k in market_keys})
    else:
      out.update(step("market summary", market_summary, headlines, default={
        "global_events": "Auto-summary unavailable this run — check sources manually.",
        "central_banks": "Auto-summary unavailable this run — check sources manually.",
        "policy_sentiment": "Auto-summary unavailable this run — check sources manually.",
        "stocks_to_watch": [], "regime_hint": "range"}))

    cands = fetch_research()
    log(f"[info] {len(cands)} research candidates")
    out["research"] = step("research", research_pick, cands, default=[]) or []

    if NOW.weekday() in JOB_DAYS or not prev.get("jobs"):
        je = step("jobs/events", jobs_and_events, default={}) or {}
    else:
        log("[info] jobs/events: reusing the last search (searched on Mon, Wed and Fri)")
        je = {}
    out["jobs"] = je.get("jobs") or prev.get("jobs", [])
    out["events"] = je.get("events") or prev.get("events", [])
    out["jobs_checked"] = prev.get("jobs_checked", "") if not je else NOW.strftime("%Y-%m-%d")

    p = fetch_private()
    if p:
        digest = step("tasks/emails", private_digest, p, default=None) or {"tasks": [], "emails": []}
        if p.get("watch", {}).get("error"):
            log(f"[warn] watchlist: {p['watch']['error']}")
        if WEEKEND and prev_priv.get("watch"):
            stocks = prev_priv["watch"]
            log("[info] weekend: watchlist news reused from the last weekday")
        else:
            stocks = step("watchlist", watchlist_update, p.get("watch"), default=[]) or []
            log(f"[info] watchlist: {len(stocks)} stocks updated")
            step("fundamentals", fundamentals_update, stocks)
            write_watch_back(stocks)
        digest["watch"] = stocks
        digest["pis"] = p.get("pis") or {}          # PI_Grants + Gov_Funds tabs, filled in by you
        digest["journal"] = {"url": GAS_URL, "key": p.get("journalKey", "")}
        if PASSPHRASE:
            out["private"] = encrypt(digest, PASSPHRASE)
        else:
            log("[warn] BRIEF_PASSPHRASE not set: private sections NOT published (the page is public)")

    os.makedirs("data", exist_ok=True)
    with open("data/briefing.json", "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    log("[info] wrote data/briefing.json")


if __name__ == "__main__":
    main()
