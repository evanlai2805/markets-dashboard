# v5 runbook — deploy, cut over, roll back

The public sheet (`1xaAF9PcQm51QEUD-6nGWGHNSrRzK3AVyA1PN_Rk4YY4`) becomes the running engine.
The private original keeps running until step 8. Nothing here is a one-way door until step 9.

## 0. One-time on the Mac (already done by Claude, listed for completeness)

- `~/Desktop/markets-dashboard` is the canonical clone. The old copy under
  `MultiBot Trading System/Google Sheet Dashboard/Apps Script/` is frozen (see its README).
- clasp is installed (`clasp --version` → 3.x). Config files: `apps-script/.clasp.json`
  (git-ignored, holds the script id), `apps-script/appsscript.json`, `apps-script/.claspignore`.

## 1. Link clasp to the public sheet's script (you, once)

```
cd ~/Desktop/markets-dashboard/apps-script
clasp login                      # opens a browser; use the Google account that owns the sheet
```

Open the public sheet → Extensions → Apps Script. If the project is empty, that is fine.
Project Settings (gear) → copy the **Script ID**. Paste it into `apps-script/.clasp.json`
replacing `PASTE_SCRIPT_ID_HERE`. Then:

```
clasp push                       # uploads code.gs, dashboard.gs, live.gs, appsscript.json
```

Every later iteration is the same one command. Fallback if clasp ever fails: open the
Apps Script editor, and for each of the three files select-all, paste the file from
`apps-script/`, save.

## 2. Keys (Script Properties, never the sheet)

Apps Script editor → Project Settings → Script Properties → add:
`FRED_API_KEY`, `OANDA_API_KEY`, `OANDA_ACCOUNT_ID`, `MAS_API_KEY` (plus any `MAS_KEY_*` you use),
`OANDA_ENV` (`practice` or `live`). Copy the values from the private sheet's Script Properties.

## 3. Provision the tabs and backfill the 33 new series

In the editor, run in this order (each from the function dropdown; authorise when asked):

1. `setupSheets()` — creates Config (no secret rows), Series (seeded with all 90 series),
   Log, Diagnostics, Notes, Meta; syncs the MacroHistory header. Existing data is untouched.
2. Open the Config tab, set `BACKFILL_ONLY` to exactly:
   ```
   DGS1MO,DGS6MO,DGS1,DGS3,DGS7,DGS20,DFII7,DFII20,DFII30,T5YIE,CPILFESL,BAMLC0A1CAAA,BAMLC0A2CAA,BAMLC0A3CA,BAMLC0A4CBBB,BAMLC1A0C13Y,BAMLH0A1HYBB,BAMLH0A2HYB,BAMLH0A3HYC,BAMLHE00EHYIOAS,BAMLEMCBPIOAS,BAMLH0A0HYM2EY,BAMLC0A0CMEY,G10Y_US,G10Y_DE,G10Y_GB,G10Y_JP,G10Y_AU,G10Y_CA,G10Y_IT,G10Y_FR,G10Y_CH,G10Y_ZA
   ```
   and `BACKFILL_DONE` to `FALSE`.
3. `backfill()` — run it again each time the Log says "paused … run again", until it says
   **backfill complete**. (It finalises: sort → computed → rolling → latest → ratios → dashboard.)
4. `probeGoogleFinance()` → `rebuildRatios()` → wait ~2 minutes for GOOGLEFINANCE to fill →
   `finalizeNow()`.
5. `healthCheck()` — read the Log; expect 0 stale beyond the known MAS `SGS_*` TODO rows.
6. `selfTest()` → Log must say `selfTest: PASS`.
7. `scrubConfigKeys()` → `privacyAudit()` → Log must say `privacyAudit: PASS`.
   If it lists a tab not on the whitelist (e.g. `Runs`, `IBKR Log`, `Book`), delete that tab and re-run.

## 4. Triggers

`installTriggers()` (05:00 + 06:00 fetch, 06:30 presentation, SGT) and `installLiveTriggers()`
(on-open + every 10 min). Check Triggers (clock icon) shows them.

## 5. Publish the page

GitHub → repo Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/docs`.
(Claude enables this via the API if the token allows; verify.) The page is
`https://evanlai2805.github.io/markets-dashboard/`. The sheet's sharing stays
"Anyone with the link: Viewer". Hidden helper tabs are still readable by the page — that is expected.

## 6. Verify from the Mac

```
cd ~/Desktop/markets-dashboard
node --test tests/contract.test.mjs        # against the live public sheet — all green
```

Open the page: header reads "all N series within cadence" (or names the late ones), every tab
renders, the Board's live board timestamp is within 10 minutes, no yellow "v5 not deployed" banner.

## 7. Monitor 24 hours

Next morning after 06:30 SGT: Log shows `dailyUpdate done`, Meta `last_complete` is today,
`node --test` is green, the page header date advanced.

## 8. Retire the private engine

Only after step 7: in the **private** sheet's Apps Script → Triggers, delete every trigger.
Keep the workbook as an archive.

## 9. Notes tab

`Notes` is yours. `key | text | date` — `regime` (Board), `board`, `rates`, `rates.10Y` (any tenor),
`rates.sg`, `rates.global`, `credit`, `fx`, `commodities`, `equities`, `equities.sg`, `macro`.
Blank text = hidden. Date as `yyyy-mm-dd` text. The page shows it with the date so a stale
read is visibly stale.

## Rollback

| Symptom | Action |
|---|---|
| `selfTest` / `privacyAudit` FAIL, quota errors, Dashboard tab looks wrong | Delete the public sheet's triggers; `git revert` the offending commit in `apps-script/`; `clasp push`. The private engine is still running until step 8. |
| Something personal is visible on the public sheet | Share → restrict to yourself **immediately**, then fix, re-run `privacyAudit()`, re-share. |
| Page shows the schema banner | The page and sheet disagree on `schema_version`; deploy the matching `docs/index.html` + `apps-script/` pair. |
