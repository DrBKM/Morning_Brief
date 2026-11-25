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
  BRIEF_MODEL         model for summaries      (default claude-sonnet-5-5)
  BRIEF_SEARCH_MODEL  model for web search     (default claude-sonnet-5-5)
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
MODEL = os.environ.get("BRIEF_MODEL") or "claude-sonnet-5-5"
SEARCH_MODEL = os.environ.get("BRIEF_SEARCH_MODEL") or "claude-sonnet-5-5"
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
def claude(prompt, model, max_tokens=1500, search=False, system=None):
    """Returns (text, urls_seen_in_search_results)."""
    tools = []
    if search:
        tools = [{"type": "web_search_20250305", "name": "web_search", "max_uses": MAX_SEARCHES,
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
    text, _ = claude(prompt, MODEL, 900)
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

A) JOBS: currently open Assistant Professor posts in PHYSICS anywhere in India (IITs, IISERs, NITs,
IIITs, central and state universities, NISER, IISc, reputed private universities). Only posts whose
application deadline has not passed. Include only posts paying at least INR 1,00,000 per month:
advertised pay of 1 lakh or more, or 7th CPC Academic Pay Level 10 or higher (Level 12 at IITs/IISERs
is clearly above 1 lakh; for Level 10 say "about ₹1 L with DA/HRA"). Up to 10 posts, newest first.

B) LOCAL EVENTS: worthwhile public events in or near {LOCAL_AREA} in the next 7 days: science, education,
culture, music, fairs, festivals, talks, family outings. Up to 6.

Use only facts from your search results; give the page URL where you found each item. Do not invent
deadlines, salaries or dates: write "see advert" if unknown.

{JSON_ONLY} Schema:
{{"jobs": [{{"post": "...", "institution": "...", "location": "...", "pay": "...", "deadline": "...", "url": "..."}}],
  "events": [{{"name": "...", "when": "...", "where": "...", "why": "one short line", "url": "..."}}]}}"""
    text, urls = claude(prompt, SEARCH_MODEL, 3000, search=True)
    d = parse_json(text)
    for k in ("jobs", "events"):         # drop any link that did not come from the search results
        for it in d.get(k, []):
            if it.get("url") and it["url"] not in urls:
                it["url"] = ""
    return d


def private_digest(p):
    tasks, emails = p.get("tasks") or {}, p.get("emails") or []
    task_block = json.dumps(tasks, ensure_ascii=False)[:30000]
    mail_block = "\n".join(f"[{i}] {m.get('date','')} | {m.get('from','')} | {m.get('subject','')} :: {m.get('snippet','')}"
                           for i, m in enumerate(emails)) or "(none)"
    prompt = f"""Today is {TODAY}. You are a personal assistant preparing a morning reminder.

1) TASKS. This is a tab from the user's task Google Sheet (header + rows, JSON):
{task_block}
List the tasks that are for today, overdue, or still in progress / not done (continued from earlier days).
Skip finished ones. Most urgent first, at most 12.

2) EMAILS from the last 24 hours marked important or starred:
{mail_block}
Pick those that need the user's attention or a reply (at most 8), most important first. Ignore newsletters
and automated notices unless they contain a deadline.

{JSON_ONLY} Schema:
{{"tasks": [{{"task": "...", "status": "today" | "overdue" | "continuing", "due": "date or ''", "note": "short"}}],
  "emails": [{{"i": <email number>, "why": "one line", "action": "reply" | "read" | "note deadline" | "none"}}]}}"""
    text, _ = claude(prompt, MODEL, 1800)
    d = parse_json(text)
    mails = []
    for e in d.get("emails", []):
        i = e.get("i")
        if isinstance(i, int) and 0 <= i < len(emails):
            m = emails[i]
            mails.append({"from": m.get("from", ""), "subject": m.get("subject", ""), "date": m.get("date", ""),
                          "link": m.get("link", ""), "why": e.get("why", ""), "action": e.get("action", "")})
    return {"tasks": d.get("tasks", []), "emails": mails, "sheet": tasks.get("sheet", "")}


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

    headlines = fetch_headlines()
    log(f"[info] {len(headlines)} market headlines")
    out["headlines"] = headlines[:20]
    out.update(step("market summary", market_summary, headlines, default={
        "global_events": "Auto-summary unavailable this run — check sources manually.",
        "central_banks": "Auto-summary unavailable this run — check sources manually.",
        "policy_sentiment": "Auto-summary unavailable this run — check sources manually.",
        "stocks_to_watch": [], "regime_hint": "range"}))

    cands = fetch_research()
    log(f"[info] {len(cands)} research candidates")
    out["research"] = step("research", research_pick, cands, default=[]) or []

    je = step("jobs/events", jobs_and_events, default={}) or {}
    out["jobs"], out["events"] = je.get("jobs", []), je.get("events", [])

    p = fetch_private()
    if p:
        digest = step("tasks/emails", private_digest, p)
        if digest is not None:
            if PASSPHRASE:
                out["private"] = encrypt(digest, PASSPHRASE)
            else:
                log("[warn] BRIEF_PASSPHRASE not set: tasks/emails NOT published (the page is public)")

    os.makedirs("data", exist_ok=True)
    with open("data/briefing.json", "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    log("[info] wrote data/briefing.json")


if __name__ == "__main__":
    main()
