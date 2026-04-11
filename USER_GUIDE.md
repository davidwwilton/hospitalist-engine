# Hospitalist Financial Engine — User Guide

## What This App Does

The Hospitalist Financial Engine reads a physician schedule from Google Sheets, normalises physician names, and generates financial reports including payroll summaries, health authority invoices, and per-physician shift breakdowns. It runs entirely in your browser at **hospitalist-engine.vercel.app**.

---

## Before You Start

### 1. Know the Service Account Email

The app uses a Google service account to read and write spreadsheets. You'll need to share your Google Sheets with this email:

```
hospitalist-engine@hospitalist-engine.iam.gserviceaccount.com
```

### 2. Prepare Your Spreadsheets

You'll need **three** Google Sheets total (you can reuse the output sheets each time you run reports):

| Sheet | Purpose | Who Creates It |
|-------|---------|---------------|
| **Source Schedule** | The raw physician schedule with month tabs and a Contact Info tab | Already exists |
| **Parsed Output** | Where the parsed/normalised schedule will be written | You create a blank one |
| **Financial Output** | Where the financial report will be written | You create a blank one |

**For each spreadsheet**, click **Share**, paste the service account email above, and give it **Editor** access. You can uncheck "Notify people" — it's a service account, not a person.

---

## Step-by-Step Walkthrough

### Step 1 — Parse Schedule

This step reads your raw schedule and normalises physician names.

1. Open **hospitalist-engine.vercel.app**
2. **Schedule Google Sheets URL** — Paste the URL of your source schedule spreadsheet
3. **Contact Info Tab Name** — Leave as "Contact Info" unless your canonical name list is on a differently named tab
4. **Months to Parse** — Once you enter a valid schedule URL, the app automatically reads the spreadsheet tabs and detects which months (and years) are available. Each year gets its own row of month buttons. Click the months you want to parse — you can select across multiple years in one run. Months that don't have a corresponding tab in the spreadsheet are greyed out
5. **Output Spreadsheet URL** — Paste the URL of the blank Google Sheet you created for parsed output
6. Click **Parse Schedule →**

The app will read your schedule, match physician names against the Contact Info list, and write the cleaned data to your output spreadsheet. The parser supports dates in several formats: "1-Mar" (day-abbreviated month), "1/3/2026" (d/m/y), and "2026-03-01" (ISO). The year is determined automatically — first from a full date in the data rows, then from the tab name if it contains a year (e.g. "January 2026"), and finally from your year selection in the UI.

**What can go wrong here:**
- "Please enter a valid Google Sheets URL" — Make sure the URL looks like `https://docs.google.com/spreadsheets/d/...`
- Permission errors — Make sure the source schedule AND the output spreadsheet are both shared with the service account email
- "Please select at least one month" — Click at least one month button before parsing

### Step 2 — Name Review (if needed)

If the parser finds physician names it can't confidently match, you'll land here.

1. Review each flagged name — the app shows what it found in the schedule vs. what's in the Contact Info tab
2. For each name, you have several options:
   - **Confirm** the suggested match (if one was found)
   - **Select from list** — pick the correct name from the canonical Contact Info list
   - **Use as-is** — keep the name exactly as it appears in the schedule (useful for new physicians not yet added to the Contact Info tab)
   - **Enter name** — type in the correct full name manually
3. Click **Confirm & Write Schedule →**

If all names matched automatically, this step is skipped entirely.

### Step 3 — Financial Configuration

This step calculates compensation based on the parsed schedule.

1. **Parsed Schedule Spreadsheet URL** — This is auto-filled from Step 1. If you're running financials on a previously parsed schedule, paste its URL here manually
2. **Pay Period** — Choose one:
   - **Full Month** — Select a month
   - **Bi-Weekly** — Select a month, enter a cycle anchor date (the start of any known pay period), then pick the specific two-week window
   - **Custom Range** — Enter a from/to date (e.g. "1-Mar" to "14-Mar")
3. **Financial Parameters** — Set your rates:
   - Base Hourly Rate (default $200.10) — paid for all hours
   - Evening Bonus for 18:00–23:00 (default $25) — added on top of base rate for evening hours
   - Overnight Bonus for 23:00–08:00 (default $35) — added on top of base rate for overnight hours
   - Overhead Holdback percentage (default 2%)
4. **Output Spreadsheet URL** — Paste the URL of the blank Google Sheet you created for financial output
5. Click **Generate Report →**

**How hours and pay work:**
- The number of regular, evening, and overnight hours per shift type are read from the schedule itself (rows 5–7 of each month tab). This means you can adjust hours dynamically by editing the schedule — no code changes needed.
- Evening and overnight bonus rates are **added on top of** the base rate. For example, an evening hour pays $150 + $25 = $175.
- **Weekend bonus:** Regular hours worked on Saturday or Sunday receive the evening bonus rate on top of base rate — but **only for pure daytime shifts** (shifts with zero evening hours and zero overnight hours). Evening and overnight shifts on a weekend continue to earn their normal evening/overnight after-hours bonus and do **not** also receive the weekend premium. The weekend bonus is included in the After Hours total.
- **Stat holiday bonus:** All hours worked on a stat holiday receive an additional 0.5 × base hourly rate. Stat holidays also receive the weekend bonus on the same daytime-only basis as above (pure daytime stat shifts get the evening rate on regular hours; evening/overnight stat shifts do not). The stat holiday bonus itself (the 0.5 × base piece) is tracked as its own category in all reports — it is **not** included in the After Hours total.
- **Overlap detection** handles two cases: (1) same-day overlaps, where a daytime shift ends after the next shift starts (e.g. 08–17 followed by 16–01 on the same day = 1 hour overlap), and (2) cross-midnight overlaps, where an evening shift runs past midnight into a next-day shift (e.g. ER EVE 16–01 on Day 1 followed by HOME CALL 00–08 on Day 2 = 1 hour overlap). In both cases the overlapping hours are deducted from the **second** shift's invoiceable hours only. Physicians are still paid in full for all hours worked — the deduction only prevents double-invoicing the health authority.

### Parsed Output Tabs

After parsing completes (Step 1 + Step 2), the parsed output spreadsheet will contain these tabs:

- **Parsed Schedule** — One row per physician-shift-date with all hours and metadata. Invoiceable hours already reflect any overlap deductions (so if a shift has a 1-hour overlap, its Invoiceable_Hrs will show the reduced amount)
- **Clean — January**, **Clean — February**, etc. — One tab per parsed month, mirroring the original schedule layout exactly — all columns (ER/Intake, OC, Off Service, Surge, Stroke, LB variants, UBC 1–5, UCC/ward, ER eve, Ward eve, Home Call, etc.), all reference rows (times, regular hours, evening hours, overnight hours), and all date rows. The only changes from the original are corrected physician names and removal of duplicate weekend daytime shifts
- **Back to Back Shifts** — Identifies overlapping consecutive shifts for the same physician. Always created, even if no overlaps are found (in which case it shows "No overlapping back-to-back shifts detected")
- **Name Log** — Details on how each physician name was matched or resolved
- **Duplicate Log** — Any duplicate shifts that were collapsed during parsing
- **Summary** — Quick stats: total shift assignments, physician count, and the full physician list

### Step 4 — Results

You'll see KPI summary cards showing totals for the period, plus a link to open the financial report spreadsheet. The report contains these tabs:

- **KPI Summary** — Period parameters and aggregate totals. Each premium is broken out on its own line: Total Base Pay, Total Evening Bonus Pay, Total Overnight Bonus Pay, Total Weekend Bonus Pay, Total After Hours Pay (the sum of those three premiums), Total Base + After Hours (base pay plus the after-hours total, excluding stat), Total Stat Holiday Bonus, Total Gross Pay, Total Holdback, and Total Net Payout.
- **Payroll Summary** — Per-physician compensation broken out into separate columns: Base_Pay, Eve_Bonus, ON_Bonus, Weekend_Bonus, After_Hours (sum of the three premiums), Base_Plus_After_Hrs (Base_Pay + After_Hours, excludes stat), Stat_Bonus, Gross_Pay (everything including stat), Holdback, and Net_Pay.
- **HA Invoice** — Health authority invoice with the same premium breakdown as Payroll Summary: Invoiceable_Hrs, Base_Pay, Eve_Bonus, ON_Bonus, Weekend_Bonus, After_Hours, Base_Plus_After_Hrs, Stat_Bonus, and Invoice_Amount (the grand total billed to the HA).
- **Physician Detail** — Every shift for every physician with the full hour and pay breakdown. Money columns read left-to-right as: Base_Pay → Eve_Bonus → ON_Bonus → Weekend_Bonus → After_Hours → Base_Plus_After_Hrs → Stat_Bonus → Gross, so you can follow exactly how a single shift's pay was built up.
- **Overlap Log** — Back-to-back shifts with overlapping hours, showing which shift had invoiceable hours deducted

Click **Open Report ↗** to view the spreadsheet in Google Sheets.

---

## Schedule Format Requirements

The source schedule spreadsheet must follow this row structure in each month tab:

| Row | Content | Example |
|-----|---------|---------|
| **Row 1** | Column headers — shift type names | Date, Day, LB 8A, SURGE, ER EVE, HOME CALL, etc. |
| **Row 2–3** | (Other info — skipped by parser) | |
| **Row 4** | Start–end times per shift column | `08 - 17`, `16 - 01`, `24 - 08` |
| **Row 5** | Regular hours to pay per shift | `9`, `8`, `0` |
| **Row 6** | Evening bonus hours to pay per shift | `0`, `5`, `0` |
| **Row 7** | Overnight bonus hours to pay per shift | `0`, `0`, `8` |
| **Row 8+** | Date rows with physician names | `1-Mar`, `Mon`, `Dr. Smith`, `Dr. Jones`, etc. |

**Important:** Rows 4–7 control how many hours of each type are paid and invoiced per shift. If you need to change compensation for a shift type (e.g., give UCC/Ward fewer evening hours), just update the value in row 6 of that column — no code changes needed.

**Time format:** Use 2-digit hours separated by a dash, e.g. `08 - 17`. For shifts crossing midnight, use the next-day hour: `16 - 01` means 4pm to 1am. Use `24` for midnight: `24 - 08` means midnight to 8am.

### Stat Holidays Tab

Add a tab called **"Stat Holidays"** to your source schedule spreadsheet. List one date per row in column A using the format **"Month Day"**, for example:

```
January 1
February 16
April 3
April 6
May 18
July 1
August 3
September 7
September 30
October 12
November 11
December 25
December 26
```

The parser will automatically detect this tab and apply weekend/stat holiday bonuses when generating financial reports. If no "Stat Holidays" tab is found, stat holiday bonuses are simply skipped.

---

## Adding a New Shift Type

The engine detects shift columns dynamically from the column headers in your schedule — there is no hardcoded list of shift names. To add a new shift type:

1. **Add a new column** to each month tab in your source schedule. Give it a header in Row 1 (e.g. "Float", "Psych Eve", "Rapid Assess"). The header can be any text.
2. **Fill in rows 4–7** for that column, just like the existing shifts:
   - **Row 4** — Shift start and end time (e.g. `08 - 17`, `16 - 01`)
   - **Row 5** — Total regular/payable hours for the shift (e.g. `9`)
   - **Row 6** — How many of those hours earn the evening bonus (e.g. `5`, or `0` if none)
   - **Row 7** — How many of those hours earn the overnight bonus (e.g. `0`)
3. **Fill in physician names** in the date rows (Row 8+) as usual.
4. **Run the parser** — the new column will be picked up automatically and appear in the parsed output and financial reports.

That's it. No code changes are needed. The shift ID shown in reports is derived from the header text (uppercased, spaces become underscores), so "Psych Eve" becomes `PSYCH_EVE`.

If you only need the new shift in certain months, just add the column to those month tabs. Months without the column won't be affected.

## Tips

- **Reuse output spreadsheets.** You don't need a new blank sheet every time — the app overwrites the tabs. Just use the same output URLs for each run.
- **Check the Physician Detail tab** if numbers look off. It shows every shift individually so you can trace how hours and pay were calculated.
- **The Back to Back Shifts tab** in the parsed output is always created so you can confirm overlap detection ran. If there are no overlapping shifts, the tab will say "No overlapping back-to-back shifts detected."
- **Rows 4–7 must be filled** for every shift column in every month tab. If a column is missing its reference rows, the parser will try to calculate hours from the time range, but evening and overnight bonus hours will default to zero.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "The caller does not have permission" | Share the spreadsheet with the service account email as Editor |
| Parse button is greyed out | Make sure you've entered a source URL, selected at least one month, and entered an output URL |
| Generate Report button is greyed out | Make sure you've entered both a parsed schedule URL and an output URL |
| No shifts found in period | The date range doesn't overlap with any shifts in the parsed schedule — check that you parsed the right months |
| Name shows as UNRESOLVED | The physician name in the schedule doesn't match anything in the Contact Info tab — correct it in Step 2 |

---

## How the Year Is Determined

The parser determines which year to assign to dates (like "1-Mar" that have no year) using this priority:

1. **Full date in the data** — If row 8 (the first date row) contains a date with a 4-digit year (e.g. "3/1/2026"), that year is used for the entire tab.
2. **Tab name** — If the tab is named something like "January 2026" or "Feb 2025", the year is extracted from the name.
3. **Current year** — Falls back to the current calendar year if none of the above provide a year.

This means your schedule will parse correctly as long as either the dates include the year or the tabs are named with the year.

*Last updated: April 2, 2026*
