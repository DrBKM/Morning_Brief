# Morning Brief: Claude setup (about 20 minutes, once)

## 1. Claude API key
1. Delete the key you pasted in chat (Console → API keys → delete). Anyone who saw it could use your credits.
2. platform.claude.com → API keys → Create key. It must start with `sk-ant-api03-`.
3. Billing → buy credits (the smallest top-up lasts weeks: see "Cost" below).

## 2. Apps Script (reads your task sheet and Gmail)
1. script.google.com → New project → paste `apps-script/MorningBrief.gs` → Save.
2. Choose `setToken` in the function list → Run → allow access. Copy the `GAS_TOKEN = …` value from the log.
3. Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone** → Deploy. Copy the `/exec` URL.
4. Optional: run `testOutput` to see exactly what will be sent.

## 3. GitHub secrets (repo → Settings → Secrets and variables → Actions)
| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the new `sk-ant-api03-…` key |
| `GAS_URL` | the Apps Script `/exec` URL |
| `GAS_TOKEN` | the token from `setToken` |
| `BRIEF_PASSPHRASE` | a long passphrase you choose (unlocks tasks and emails on the page) |

Optional, under the **Variables** tab: `BRIEF_LOCAL_AREA` (default "Purulia, West Bengal"),
`BRIEF_MODEL`, `BRIEF_SEARCH_MODEL` (default `claude-sonnet-5-5`; `claude-haiku-5-5` is cheaper).

## 4. Test
Actions → Morning Market Briefing → Run workflow. After about 3 minutes open the page, enter the
passphrase once (tick "remember on this device").

## Privacy
Your repo and page are public. Jobs, research and events are public. Tasks and emails are encrypted
(AES-256) with your passphrase before they are committed, so only someone with the passphrase can read them.

## Schedule and cost
Runs daily at 8:05 AM IST so the page is ready by 8:30 (GitHub often starts late).
Approximate cost per day with Sonnet 5.5: about $0.15–0.20 (≈ ₹13–17), mostly the 6 web searches
($0.01 each) and the search results Claude reads. About $5 a month.
