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
   - Evening Premium for 18:00–23:00 (default $25) — added on top of base rate for evening hours
   - Overnight Premium for 23:00–08:00 (default $35) — added on top of base rate for overnight hours
   - Cost Share (default $1.40/hr) — per-hour holdback deducted from physician pay, charged only on regular (payable) hours
   - Operational Holdback (default $7.45/hr) — per-hour holdback, same basis. Together with Cost Share, these two replace the previous flat-percentage overhead holdback (see Appendix A11 for the exact formula)
4. **Output Spreadsheet URL** — Paste the URL of the blank Google Sheet you created for financial output
5. Click **Generate Report →**

**How hours and pay work:**
- The number of regular, evening, and overnight hours per shift type are read from the schedule itself (rows 5–7 of each month tab). This means you can adjust hours dynamically by editing the schedule — no code changes needed.
- Evening and overnight premium rates are **added on top of** the base rate. For example, an evening hour pays $150 + $25 = $175.
- **Weekend Day Premium:** Regular hours worked on Saturday or Sunday receive the evening premium rate on top of base rate — but **only for pure daytime shifts** (shifts with zero evening hours and zero overnight hours). Evening and overnight shifts on a weekend continue to earn their normal evening/overnight after-hours premium and do **not** also receive the Weekend Day Premium. The Weekend Day Premium is included in the After Hours total (paid quarterly — see Step 4 tab descriptions below).
- **Stat Holiday Premium:** All hours worked on a stat holiday receive an additional 0.5 × base hourly rate. Stat holidays also receive the Weekend Day Premium on the same daytime-only basis as above (pure daytime stat shifts get the evening rate on regular hours; evening/overnight stat shifts do not). The Stat Holiday Premium itself (the 0.5 × base piece) is tracked as its own category in all reports — it is **not** included in the After Hours total, and it is paid to physicians biweekly alongside base pay rather than with the quarterly after-hours lump sum.
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

You'll see KPI summary cards showing totals for the period, a simple per-physician payroll sanity-check table (Physician, Shifts, Payable Hrs, Stat Pay, Gross Pay, Holdback, Net Pay), and two action buttons:

- **Download QuickBooks CSV ↓** — Generates a CSV file locally with one row per physician and 13 columns (Physician, Pay Period, Period Start Date, Period End Date, 8h Shifts, 9h Shifts, Other Shifts, Payable Hours, Base Pay, Stat Pay, Gross Pay, Total Holdback, Net Pay). Filename follows the pattern `VHA Hospitalist Payroll 2026-04-15 to 2026-04-28.csv`. Forward this file to the accountant so they can enter biweekly interim payments in QuickBooks.
- **Open Report ↗** — Opens the financial report Google Sheet with the detailed tabs below.
- **Push Pay Advice →** — Sends a per-physician pay advice tab to each physician's personal Google Sheet. See A14 for full details.

The financial report spreadsheet contains these tabs, in the order the finance lead will want to use them:

1. **KPI Summary** — Period parameters and aggregate totals, organized into clearly marked sections: Rates, Hour Counts, Pay Components, Interim Payroll, After Hours Payroll, HA Invoice, Physician Net Payout, and Reconciliation. Look for the `✓ Matches` reconciliation line at the bottom — it confirms that `Total Interim Gross + Total After Hours Pay = Total Gross Pay`. If you ever see a Delta there, the math is broken and I need to know.
2. **Interim Payroll** — Biweekly pay run. Columns: Physician, 8h_Shifts, 9h_Shifts, Other_Shifts, Regular_Hrs, Base_Pay, Stat_Premium, Interim_Gross (Base + Stat), Cost_Share, Op_Holdback, Total_Holdback, Interim_Net. This is what the financial manager uses to run each biweekly cycle.
3. **HA Invoice – Interim** — What the health authority reimburses the practice for base hours, overlap-adjusted. Columns: Physician, Invoiceable_Hrs, Base_Invoice_Amount. Stat premium is NOT invoiced here (see A12).
4. **After Hours Payroll** — Quarterly premium lump-sum pay. Columns: Physician, Evening_Hrs, Overnight_Hrs, Weekend_Day_Hrs, Total_After_Hrs, Eve_Premium, ON_Premium, Weekend_Day_Premium, After_Hours_Total. Used once per quarter when HA funds arrive.
5. **HA Invoice – After Hours** — Premium pay invoiced to HA quarterly. Columns: Physician, Evening_Hrs, Overnight_Hrs, Weekend_Day_Hrs, Eve_Premium, ON_Premium, Weekend_Day_Premium, After_Hours_Invoice_Amount.
6. **Payroll Summary** — Comprehensive audit view with every pay component in one place: Base_Pay, Eve_Premium, ON_Premium, Weekend_Day_Premium, After_Hours, Base_Plus_After_Hrs, Stat_Premium, Gross_Pay, Cost_Share, Op_Holdback, Total_Holdback, Net_Pay. Useful for reconciliation.
7. **Physician Detail** — Every shift for every physician with full hour and pay breakdown, including per-shift holdback allocation.
8. **Overlap Log** — Back-to-back shifts with overlapping hours (appears only when overlaps exist).

**Payment cadence at a glance.** The Interim Payroll tab drives the biweekly pay run (base + stat premium, less holdback). The After Hours Payroll tab drives the quarterly lump-sum premium pay. They sum back to Total Gross Pay — the reconciliation line on KPI Summary verifies this every run.

**Re-running on an old output spreadsheet?** If you're re-using a spreadsheet that was produced by pre-April-2026 code, it will still have an old "HA Invoice" tab from before the split. That tab will have stale data (it used to include stat premium, which isn't correct anymore). Right-click it in Google Sheets → Delete. New tabs from this code version won't touch it.

---

## Schedule Format Requirements

The source schedule spreadsheet must follow this row structure in each month tab:

| Row | Content | Example |
|-----|---------|---------|
| **Row 1** | Column headers — shift type names | Date, Day, LB 8A, SURGE, ER EVE, HOME CALL, etc. |
| **Row 2–3** | (Other info — skipped by parser) | |
| **Row 4** | Start–end times per shift column | `08 - 17`, `16 - 01`, `24 - 08` |
| **Row 5** | Regular hours to pay per shift | `9`, `8`, `0` |
| **Row 6** | Evening premium hours to pay per shift | `0`, `5`, `0` |
| **Row 7** | Overnight premium hours to pay per shift | `0`, `0`, `8` |
| **Row 8+** | Date rows with physician names | `1-Mar`, `Mon`, `Dr. Smith`, `Dr. Jones`, etc. |

**Important:** Rows 4–7 control how many hours of each type are paid and invoiced per shift. If you need to change compensation for a shift type (e.g., give UCC/Ward fewer evening hours), just update the value in row 6 of that column — no code changes needed.

**Time format:** Use 2-digit hours separated by a dash, e.g. `08 - 17`. For shifts crossing midnight, use the next-day hour: `16 - 01` means 4pm to 1am. Use `24` for midnight: `24 - 08` means midnight to 8am.

### Keep Every Month Tab Consistent — Use a Template

**This is the single most important rule for a smooth parse.** The parser reads the reference rows (shift times, regular hours, evening hours, overnight hours) from **hardcoded row positions** — row 4, row 5, row 6, and row 7. It does not search for them by label. If a month tab has an extra row inserted at the top, a missing reference row, or a shifted column layout, the parser will either produce wrong hours or return zero entries for that tab entirely.

**Recommended workflow for creating a new month tab:**

1. Create a tab in your source schedule called **"Template"** (or duplicate an existing month that you know parses correctly).
2. Make sure the Template tab has the exact row structure described in the table above — header in row 1, time range in row 4, regular/evening/overnight hours in rows 5–7, and the first date row in row 8. Rows 2, 3 can contain display-only info (notes, sub-headers) but must not shift the other rows.
3. When a new month starts, **right-click the Template tab → Duplicate**, rename the copy to the month name (e.g. "March 2026"), then fill in the date column and physician names. Do not add, remove, or reorder rows 1–7.
4. If you need to add a new shift type, add the column following the "Adding a New Shift Type" section below — this is safe because it doesn't change the row structure.

**What happens if you don't follow this:** You'll get a parse error like "Tab was read successfully but no shift entries were extracted" or, worse, a silently wrong financial report where shift hours don't match reality. We hit this exact issue in April 2026 when the February tab had an extra "Shift Hours" row inserted between row 2 and row 3, pushing everything down by one and breaking the parser. Fixing it required copying the first 8 rows from January over February's top rows. Avoid the headache — use a template.

**Quick self-check before running a parse on a new month:**

- Row 1 — does it have shift column headers starting from column C (after Date and Day)?
- Row 4 — does it have time ranges like `08 - 17` under each shift column?
- Rows 5, 6, 7 — do they have single-digit hour values (`9`, `5`, `0`, etc.) under each shift column?
- Row 8 — is this the first date row (e.g. `1-Mar`, `Mon`, then physician names)?

If any of those are off, fix them before parsing.

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

The parser will automatically detect this tab and apply weekend/stat holiday premiumes when generating financial reports. If no "Stat Holidays" tab is found, stat holiday premiumes are simply skipped.

---

## Adding a New Shift Type

The engine detects shift columns dynamically from the column headers in your schedule — there is no hardcoded list of shift names. To add a new shift type:

1. **Add a new column** to each month tab in your source schedule. Give it a header in Row 1 (e.g. "Float", "Psych Eve", "Rapid Assess"). The header can be any text.
2. **Fill in rows 4–7** for that column, just like the existing shifts:
   - **Row 4** — Shift start and end time (e.g. `08 - 17`, `16 - 01`)
   - **Row 5** — Total regular/payable hours for the shift (e.g. `9`)
   - **Row 6** — How many of those hours earn the evening premium (e.g. `5`, or `0` if none)
   - **Row 7** — How many of those hours earn the overnight premium (e.g. `0`)
3. **Fill in physician names** in the date rows (Row 8+) as usual.
4. **Run the parser** — the new column will be picked up automatically and appear in the parsed output and financial reports.

That's it. No code changes are needed. The shift ID shown in reports is derived from the header text (uppercased, spaces become underscores), so "Psych Eve" becomes `PSYCH_EVE`.

If you only need the new shift in certain months, just add the column to those month tabs. Months without the column won't be affected.

## Tips

- **Reuse output spreadsheets.** You don't need a new blank sheet every time — the app overwrites the tabs. Just use the same output URLs for each run.
- **Check the Physician Detail tab** if numbers look off. It shows every shift individually so you can trace how hours and pay were calculated.
- **The Back to Back Shifts tab** in the parsed output is always created so you can confirm overlap detection ran. If there are no overlapping shifts, the tab will say "No overlapping back-to-back shifts detected."
- **Rows 4–7 must be filled** for every shift column in every month tab. If a column is missing its reference rows, the parser will try to calculate hours from the time range, but evening and overnight premium hours will default to zero.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "The caller does not have permission" | Share the spreadsheet with the service account email as Editor |
| Parse button is greyed out | Make sure you've entered a source URL, selected at least one month, and entered an output URL |
| Generate Report button is greyed out | Make sure you've entered both a parsed schedule URL and an output URL |
| "Tab was read successfully but no shift entries were extracted" | The month tab's row layout doesn't match the template. Rows 1–7 must be: header, (row 2–3 any content), time range, regular hours, evening hours, overnight hours. Most common cause: an extra row inserted at the top of the month. See "Keep Every Month Tab Consistent" above. |
| "Fewer than 5 entries parsed" | Either the schedule URL is wrong, no months were selected, or every selected month tab had a structural problem. Check the tab-specific error details included in the message. |
| No shifts found in period | The date range doesn't overlap with any shifts in the parsed schedule — check that you parsed the right months |
| Name shows as UNRESOLVED | The physician name in the schedule doesn't match anything in the Contact Info tab — correct it in Step 2 |
| Physician worked UCC/Ward + Home Call on the same row — pay looks wrong | This is a hard-coded exception (see Appendix A8.1). The engine forces UCC/Ward to 15 regular + 4 evening premium hours and drops Home Call from the Parsed Schedule / financial engine. On the Clean — `<Month>` tab the Home Call cell is **kept with the physician's name and highlighted light green** so the concurrent scenario is visible at a glance. Confirm the override fired by: (1) the green cell on the Clean tab, (2) a row in the Duplicate Log with `is_concurrent_override = true`, and (3) 15 Regular_Hrs / 4 Evening_Hrs on the UCC/Ward row in Parsed Schedule (which will also be highlighted green). Note the Clean tab still shows the original schedule reference rows (including UCC/Ward's `9` in row 5) — those are copied verbatim from the source. |

---

## How the Year Is Determined

The parser determines which year to assign to dates (like "1-Mar" that have no year) using this priority:

1. **Full date in the data** — If row 8 (the first date row) contains a date with a 4-digit year (e.g. "3/1/2026"), that year is used for the entire tab.
2. **Tab name** — If the tab is named something like "January 2026" or "Feb 2025", the year is extracted from the name.
3. **Current year** — Falls back to the current calendar year if none of the above provide a year.

This means your schedule will parse correctly as long as either the dates include the year or the tabs are named with the year.

---

## Appendix A — Financial Rules in Detail

This appendix is the authoritative reference for how every dollar in a report is calculated. It describes the rules the engine applies when you click **Generate Report**, in the exact order the engine applies them. If you ever need to verify a specific line item in a payroll run or explain a number to a physician, this section should let you trace any value back to its source.

The live rules are implemented in `api/financial.js`. If this appendix ever disagrees with the code, the code is correct — please open an issue so the doc can be fixed.

### A1. Inputs to Every Run

Each financial run takes three categories of input: **parsed schedule data**, **pay period selection**, and **rate parameters**.

The parsed schedule is read from the "Parsed Schedule" tab of the parsed output spreadsheet produced in Step 1. Every row represents one physician on one shift on one date, with that shift's regular, evening, and overnight hour counts already computed by the parser. The engine does not re-read the raw schedule during a financial run — everything flows from the parsed schedule.

The pay period is one of three forms. **Full Month** uses the first through the last day of a selected calendar month. **Bi-Weekly** takes a known start date of any two-week cycle and picks the fortnight that falls within your chosen month. **Custom Range** takes two dates in `DD-Mon` form (e.g. `1-Mar` to `14-Mar`). Only shifts whose date falls within the selected period are included.

The rate parameters default to base $200.10/hr, evening premium $25/hr, overnight premium $35/hr, cost share $1.40/hr, and operational holdback $7.45/hr, but you can override any of these in the UI before generating the report. Every rule below uses whatever values you set for that specific run.

### A2. The Two Kinds of Hours

Every shift has two hour counts that track separately: **payable hours** and **invoiceable hours**.

**Payable hours** are what the physician is paid for. They equal the shift's "Regular Hours" value from row 5 of the schedule. Payable hours are never reduced by overlap detection or any other rule — physicians are always paid for every hour they worked.

**Invoiceable hours** are what the health authority is billed for. They start equal to payable hours but can be reduced by overlap deductions (see A8) when two of the same physician's shifts bump into each other. This protects the health authority from being billed twice for the same hour while still paying the physician in full.

Example: a physician works an ER eve shift 16–01 on Monday and a home call 00–08 on Tuesday. The Monday evening shift runs one hour past midnight into Tuesday's home call. Both shifts show their full "Regular Hours" value under Payable Hours, but Tuesday's home call will show one hour less under Invoiceable Hours.

### A3. Base Pay

Every hour on every shift earns the base rate. The formula is:

```
base_pay = regular_hrs × base_rate
```

Example: a day shift with 9 regular hours at a base rate of $200.10 earns `9 × $200.10 = $1,800.90` in base pay. This is the same for every shift regardless of time of day, day of week, or stat holiday status.

### A4. Evening Premium (formerly Evening Bonus)

Hours marked as "evening" in row 6 of the schedule earn an additional evening premium rate on top of the base rate. This is **not** the total pay for those hours — it's a premium added to the base pay the physician already earned for the same hours.

```
eve_premium = evening_hrs × evening_rate
```

Example: an ER eve shift labelled `16 - 01` might have 9 regular hours and 5 evening hours. At $200.10 base + $25 evening premium, the physician earns `9 × $200.10 = $1,800.90` in base pay plus `5 × $25 = $125.00` in evening premium, for a total of $1,925.90 on that shift.

The engine does not look at the actual clock times to decide which hours are evening — it trusts the evening hour count you set in row 6 of the schedule. If you need to change what counts as an evening hour for a particular shift type, edit row 6 of that column in the schedule and re-parse.

### A5. Overnight Premium (formerly Overnight Bonus)

Hours marked as "overnight" in row 7 of the schedule earn an additional overnight premium rate on top of the base rate. Same structure as the evening premium.

```
on_premium = overnight_hrs × overnight_rate
```

Example: a home call shift `24 - 08` might have 8 regular hours and 8 overnight hours. At $200.10 base + $35 overnight premium, the physician earns `8 × $200.10 = $1,600.80` in base plus `8 × $35 = $280.00` in overnight premium, for $1,880.80 on that shift.

Evening and overnight premiumes can both apply to the same shift if rows 6 and 7 both have non-zero values (e.g. a shift with 4 evening hours and 4 overnight hours).

### A6. Weekend Day Premium (formerly Weekend Bonus)

Saturdays and Sundays attract an additional premium — but only on **pure daytime shifts**. A shift is considered a pure daytime shift when its evening hours **and** overnight hours are both zero. The Weekend Day Premium is calculated at the evening premium rate (not a separate weekend rate):

```
if (is_weekend AND evening_hrs == 0 AND overnight_hrs == 0):
    weekend_premium = regular_hrs × evening_rate
else:
    weekend_premium = 0
```

Example: a physician working an LB8A day shift on Saturday (9 regular hours, 0 evening, 0 overnight) earns `9 × $200.10 = $1,800.90` in base plus `9 × $25 = $225.00` in Weekend Day Premium, for $2,025.90 on that shift.

Counter-example: the same physician working ER eve on a Saturday already has evening hours attached to the shift, so the Weekend Day Premium does **not** apply on top. They earn base + evening premium as usual. The reasoning is that the evening/overnight premium already compensates them for working after-hours, and stacking a weekend premium on top would double-count.

The Weekend Day Premium is included in the "After Hours" total (see A9) even though the hours are daytime. This is intentional — "After Hours" is the engine's label for all premiums above base pay, not a statement about when the work was done.

### A7. Stat Holiday Premium (formerly Stat Holiday Bonus)

If a shift's date matches a date in the "Stat Holidays" tab of your source schedule, every regular hour on that shift earns an extra 0.5 × **net** base rate (i.e. base rate after Cost Share and Operational Holdback are deducted) on top of everything else. This applies to the full regular hours of the shift, regardless of whether it's a day, evening, or overnight shift.

```
stat_premium = regular_hrs × 0.5 × (base_rate − cost_share_per_hour − op_holdback_per_hour)
```

Example: a physician working an LB8A day shift on a stat holiday (9 regular hours) with a base rate of $200.10, Cost Share of $1.40/hr, and Operational Holdback of $7.45/hr earns a stat premium of `9 × 0.5 × ($200.10 − $1.40 − $7.45) = 9 × 0.5 × $191.25 = 9 × $95.625 = $860.625` on top of their base pay and any other applicable premiums.

**Historical note.** Before April 2026, the stat premium formula used the gross base rate (`0.5 × base_rate = $100.05/hr`), which produced a 9-hour shift premium of $900.45. The change to the net rate reduces stat premium payouts by approximately 4.4% per hour, leaving more of the holdback pool available for operational use.

Stat holiday dates also receive the Weekend Day Premium on the same daytime-only rule as Saturday/Sunday. So a pure daytime stat shift earns **both** the stat premium and the Weekend Day Premium. An evening or overnight stat shift earns the stat premium but not the Weekend Day Premium (same reasoning as A6).

The stat premium is **tracked separately** from the After Hours total. On reports you'll see it as its own line ("Stat_Premium" column, "Total Stat Holiday Premium" KPI). The "Base + After Hours" total excludes it. The "Gross Pay" total includes it.

### A8. Overlap Detection and Invoiceable Deduction

When the same physician has two shifts whose times touch, the engine detects the overlap and reduces the **invoiceable** hours on the second shift by the overlap amount. Payable hours are never touched — only invoiceable.

The engine sorts all of a physician's shifts in the period chronologically (date first, then start hour) and walks the sorted list comparing each shift to the next. For each pair, it calculates how many hours shift A's end time runs past shift B's start time, using an **extended-24** convention where overnight shifts have end times like 32 (meaning 8 AM the next day) so the math stays linear across midnight.

If the overlap is greater than zero, that many hours are deducted from shift B's invoiceable hours. Shift A is never touched — the deduction is always on the "later" shift.

Two cases are common:

**Same-day overlap.** A physician works a day shift 08–17 and an evening shift 16–01 on the same date. The day shift ends at 17, the evening shift starts at 16 — so the evening shift's first hour (16–17) overlaps the day shift's last hour. The engine deducts 1 hour from the evening shift's invoiceable hours. The physician is still paid for both full shifts; the health authority is billed for 1 hour less than the total hours worked.

**Cross-midnight overlap.** A physician works ER eve 16–01 on Monday (end time = 25 in extended-24 form) followed by home call 00–08 on Tuesday (start time = 0 on Tuesday = 24 in extended-24 form from Monday's reference point). Monday's end is 25, Tuesday's start is 24 — so the overlap is 1 hour. That hour is deducted from Tuesday's home call invoiceable hours.

You'll always see every overlap that was detected logged in the **Overlap Log** tab of the financial output, with both shift IDs and the exact number of hours deducted. If the log is empty, no overlaps were found in the period.

Edge case to be aware of: overlaps are only detected between **consecutive** shifts in the sorted list, not between arbitrary pairs. In practice this is never a problem because a physician's real shifts don't triple-stack, but if you ever see a value in the reports you can't reconcile, the Overlap Log is the first place to check.

### A8.1. Hard-Coded Exception: UCC/Ward + Home Call Concurrent Override

There is exactly one hard-coded override baked into the parser that deliberately breaks the normal "pay in full for every hour worked" rule. It fires in one specific rare scenario and nowhere else.

**The scenario.** A single physician is scheduled to *both* the UCC/Ward column (shift time 17–08, overnight into the next morning) *and* the Home Call column (shift time 24–08, the overnight-only portion) on the same row of the schedule. This happens occasionally when the same person is asked to cover the ward from 17:00 through the entire night until 08:00 the next morning. In the schedule layout, Home Call 24–08 is listed as a separate column but it falls entirely inside the UCC/Ward 17–08 window — the physician is really working one continuous 15-hour shift, not two overlapping shifts.

**Why a hard override is needed.** UCC/Ward is a special case where the paid hours in the reference row (row 5) don't match the actual clock hours of the shift. The sheet currently pays 9 regular hours + 5 evening hours for UCC/Ward in isolation, even though the shift spans 15 clock-hours from 17:00 to 08:00. That discrepancy is fine for the normal case, but when Home Call is also assigned to the same physician, the physician is actually working the full 15 hours and needs to be compensated for all of them — and we can't just keep both the UCC/Ward and Home Call reference values because that would over-pay.

**What the override does.** When the parser detects the same physician appearing in both `UCC_WARD` and `HOME_CALL` columns on the same date, it:

- Stamps the UCC/Ward entry with **regular_hrs = 15, evening_hrs = 4, overnight_hrs = 0** — replacing whatever the reference row says. In the Parsed Schedule tab the resulting row is highlighted **light green**.
- Marks the Home Call entry as suppressed so the financial engine never sees it. It is removed from the Parsed Schedule tab and logged in the Duplicate Log tab with `is_concurrent_override = true` and the reason "UCC/Ward + Home Call concurrent override — physician paid 15h base + 4h evening only".
- On the Clean — Month tab, the Home Call cell for that physician/date is **kept with the physician's name visible and highlighted light green**. This is a deliberate change from earlier versions that blanked the cell. The concurrent scenario is now self-evident at a glance when reviewing the Clean tab.

**Worked example (March 17, Dr. Yu).** The schedule has Yu in column 19 (UCC/Ward, 17–08) and column 22 (Home Call, 24–08) on the same row. Without the override, Yu would be credited with 9 + 8 = 17 base hours plus whatever overnight premium Home Call pays — an over-payment because Yu is really only working 15 clock-hours. With the override in place, Yu's UCC/Ward entry is stamped to `Regular_Hrs=15, Evening_Hrs=4, Overnight_Hrs=0` (green row in Parsed Schedule), the Home Call entry is removed from Parsed Schedule but Yu's name is retained in the Home Call cell on the Clean — March tab with a green background, and the financial report shows exactly **$3,101.50** gross pay (15 × $200.10 base + 4 × $25 evening premium) and **15** invoiceable hours billed to the health authority.

**Important gotcha — the Clean tab reference rows are unchanged.** The Clean — Month tab is a faithful mirror of your original schedule layout, including the reference rows at the top. It will still show `9` in row 5 under the UCC/Ward column, even after the override fires. Only the *data cells* for the physician(s) affected get the green highlight. The Parsed Schedule tab (and everything downstream of it — Payroll Summary, HA Invoice, KPI Summary) reflects the overridden values. If you ever need to verify what actually got paid, look at Parsed Schedule, not the Clean tab reference rows.

**How to tell if the override fired.** Three independent signals:

1. The Clean — Month tab has a **light green cell** containing the physician's name in the Home Call column (and another green cell in the UCC/Ward column for the same physician/date).
2. The Parsed Schedule tab has a **light green row** for that physician on that date with UCC/Ward showing 15/4/0.
3. The Duplicate Log tab has a row with `is_concurrent_override = true` for that physician/date.

See also the **Legend** tab in the parsed output for a quick reference to the three highlight colours used (green, orange, purple).

**When this override does NOT fire.** UCC/Ward worked in isolation → unchanged (still pays whatever the reference row says). Home Call worked in isolation → unchanged. UCC/Ward + some other shift (not Home Call) → unchanged. Home Call + some other shift (not UCC/Ward) → unchanged. Only the exact `UCC_WARD + HOME_CALL` pairing on the same physician/date triggers it. If in the future a new scenario needs similar treatment, it will require a code change in `api/parse.js` — search for `UCC_WARD_HOMECALL_OVERRIDE`.

### A8.2. Highlight Colour Scheme (Clean Tab + Parsed Schedule)

The parsed output spreadsheet uses three background colours to flag shifts that need human attention or that have been handled by a non-standard rule. The same three colours appear on the Clean — `<Month>` tabs (per-cell) and the Parsed Schedule tab (per-row). A **Legend** tab is written at the end of every parsed output with coloured swatches for quick reference.

| Colour | Meaning | Where it appears | What to do |
|--------|---------|------------------|------------|
| **Light green** | Concurrent override — UCC/Ward + Home Call on the same physician/date. Hours forced to 15 regular + 4 evening premium (see A8.1). | Clean tab: UCC/Ward *and* Home Call cells for that physician/date. Parsed Schedule: the UCC/Ward row (the Home Call row is removed). | Nothing — the override is automatic. The colour is an audit marker. |
| **Orange** | Back-to-back overlap — the second of two consecutive shifts whose times overlap. Invoiceable hours on the second shift are auto-reduced; the physician is still paid in full. | Clean tab: the cell for the *second* (later) shift. Parsed Schedule: the second shift's row. | Nothing — the deduction is automatic. Cross-reference the **Back to Back Shifts** tab for the numeric detail. |
| **Purple** | Stat holiday shift — the shift falls on a statutory holiday as defined in the source schedule's Stat Holidays tab. | Clean tab: every data cell on that date. Parsed Schedule: every row on that date. | Nothing — stat premium is applied by the financial engine. The colour confirms the date was recognised as a stat holiday. |

**Priority when a cell qualifies for more than one.** A concurrent-override cell wins over a back-to-back overlap, which wins over a stat holiday. In practice overlaps between these are rare, but the rule keeps each cell a single clean colour rather than a muddy blend.

**Re-running the parser clears old highlights.** Before painting new colours, `write-parsed.js` resets the used range on each tab to a white background, so you never see ghost colours from a previous run. This is cosmetic only — it does not affect any values.

### A9. Putting It All Together: The Per-Shift Pay Formula

For a single shift, the engine computes these values in this order:

```
base_pay        = regular_hrs × base_rate
eve_premium       = evening_hrs × evening_rate
on_premium        = overnight_hrs × overnight_rate
weekend_premium   = (is_weekend_or_stat AND daytime_only) ? regular_hrs × evening_rate : 0
stat_premium      = is_stat_holiday ? regular_hrs × 0.5 × (base_rate − cost_share_per_hour − op_holdback_per_hour) : 0

after_hours     = eve_premium + on_premium + weekend_premium
base_plus_after = base_pay + after_hours
gross           = base_plus_after + stat_premium
```

Note carefully: the stat premium is added **after** `base_plus_after`, so it does not contribute to the "After Hours" line on any report. This is intentional — "After Hours" is a category that tracks premium pay for inconvenient work times (evening/overnight/weekend), while the stat premium is a separate holiday premium that sits in its own column.

### A10. Weekend Daytime Shift Dedup (Parser-Level)

This rule runs at parse time, not at financial time — but it directly affects what the financial engine sees, so it belongs in this reference.

On weekend days, physicians often cover multiple wards during a single daytime shift. The raw schedule records each ward assignment in its own column, producing apparent duplicates like "Dr. Jara Villarroel: LB8A Saturday" and "Dr. Jara Villarroel: LB7A Saturday" — same physician, same date, same daytime window, two different wards.

The parser detects these and **keeps only the first** daytime entry for each physician-date pair, logging the rest to the Duplicate Log. "Daytime" for the purposes of this rule means a shift whose start and end times fall entirely within 07:00–18:00 and don't cross midnight.

The retained shift's hours are used by the financial engine as-is. The physician is paid once for the daytime window, which is the intended outcome — they only worked the daytime once, even if it's labelled under multiple ward columns on paper.

This rule does **not** apply to evening or overnight shifts. If a physician has a day shift and an evening shift on the same date, both are kept and the overlap rule (A8) handles any time-band conflict between them.

Example of what gets suppressed: weekend pair-ward coverage where the schedule has two columns both labelled "LB8A" with the same physician in both. The first is kept (goes to both Payroll and Clean tab), the second is logged as a duplicate and blanked from the Clean tab so the visible weekend row matches what was actually worked.

### A11. Physician Totals, Holdback, and the KPI Roll-Up

After every shift has been priced, the engine sums each physician's shifts into a per-physician total and then sums all physicians into period totals.

**Payment cadence.** The practice pays physicians on two schedules:

- **Interim (biweekly)** — the practice pays each physician `base_pay + stat_premium − total_holdback` on the regular biweekly cycle.
- **After Hours (quarterly)** — once the HA remits the after-hours reimbursement each quarter, the practice pays each physician `eve_premium + on_premium + weekend_day_premium` as a lump sum. No holdback applies to this.

Both amounts together sum to the physician's total compensation for the period (`Gross Pay = Interim Gross + After Hours Pay`). The KPI Summary tab has a reconciliation line that verifies this equality on every run.

**Holdback formula.** Holdback is computed as two per-hour deductions on regular (payable) hours — Cost Share ($/hr) and Operational Holdback ($/hr) — applied to every shift regardless of day/evening/overnight/stat. The premiums themselves (evening, overnight, weekend day, stat holiday) are not subject to holdback.

```
cost_share      = regular_hrs × cost_share_per_hour
op_holdback     = regular_hrs × op_holdback_per_hour
total_holdback  = cost_share + op_holdback

interim_gross   = base_pay + stat_premium
interim_net     = interim_gross − total_holdback
after_hours_pay = eve_premium + on_premium + weekend_day_premium

gross           = interim_gross + after_hours_pay
net_pay         = gross − total_holdback
```

Example: a physician with 160 regular hours, `base_pay = $32,016`, `stat_premium = $900`, `after_hours_pay = $1,800`, at default rates ($1.40 cost share + $7.45 op holdback = $8.85/hr total) has `cost_share = 160 × $1.40 = $224.00`, `op_holdback = 160 × $7.45 = $1,192.00`, `total_holdback = $1,416.00`. Their `interim_gross = $32,016 + $900 = $32,916`, `interim_net = $32,916 − $1,416 = $31,500` (biweekly pay). Separately, they receive `$1,800` after-hours pay quarterly. Grand total net = `$31,500 + $1,800 = $33,300`.

**Internal funding of Stat Holiday Premium.** The Stat Holiday Premium is paid to physicians in their biweekly interim but is NOT invoiced to the health authority (see A12). It is funded internally from the holdback pool. This means the holdback dollars the practice deducts from physicians are partially used to pay stat holiday premiums across the group.

**Where these appear in the output.** The per-physician totals are written to the **Interim Payroll** tab (biweekly view), **After Hours Payroll** tab (quarterly view), and **Payroll Summary** tab (comprehensive view). The **KPI Summary** tab aggregates all physicians into period totals, organized into the sections listed in Step 4 above.

### A12. Health Authority Invoice

Under the biweekly + quarterly payment structure, the HA invoice is split into **two** separate tabs in the output, aligned with the payment cadence. Both exclude Stat Holiday Premium — that amount is internally redistributed from the holdback pool, not billable to the HA.

- **HA Invoice – Interim** — Columns: Physician, Invoiceable_Hrs, Base_Invoice_Amount. Represents what the HA reimburses for base hours. `Base_Invoice_Amount = invoiceable_hrs × base_rate`, using overlap-adjusted hours so back-to-back overlap isn't double-billed.
- **HA Invoice – After Hours** — Columns: Physician, Evening_Hrs, Overnight_Hrs, Weekend_Day_Hrs, Eve_Premium, ON_Premium, Weekend_Day_Premium, After_Hours_Invoice_Amount. Represents what the HA pays for premium hours quarterly.

**What the HA total invoice equals.** `Total HA Invoice = Total Base Pay (overlap-adjusted) + Total After Hours Pay`. Compare to total compensation: `Total Gross Pay = Total Base Pay + Total Stat Premium + Total After Hours Pay`. The difference is the Stat Premium — funded from the holdback pool, not from HA funds.

**Reconciliation for hours.** If you ever need to reconcile total hours paid vs. total hours billed, the difference between `Total Payable Hours` and `Total Invoiceable Hours` on the KPI tab equals the total hours deducted by overlap detection — which should also equal the sum of the `overlap_hours` column on the Overlap Log tab.

**Historical note.** Before April 2026, the engine invoiced the HA for Gross Pay (including Stat Premium), which was a bug — stat premium had to be paid from HA funds that the HA had never provided. The fix excludes stat premium from the HA invoice; it is now funded internally from the cost share + operational holdback pool. Existing pre-April-2026 output spreadsheets that were re-run with the new code will show a `HA Invoice` tab with stale data — delete it manually.

### A13. Push Pay Advice to Physicians

Step 4 has a **Push Pay Advice →** button that sends a per-physician pay advice tab to each physician's personal Google Sheet.

**Setup — one-time per physician.**

1. Each physician has their own pay advice Google Sheet living in the `admin.vha` Google Drive.
2. The URL of each physician's sheet must be entered in **column Q of the Contact Info tab** in the source schedule, in the row that matches the physician's canonical name.
3. Each pay advice sheet must be **shared with the service account email as Editor** (the service account email is in `hospitalist-engine-e80aedcf7cc2.json`). If the sheet isn't shared, the push will fail for that physician with a "Permission denied" message.

**Test workflow.** Populate column Q for one or two physicians first, push, verify the tab looks right in their sheet, then fill in URLs for the remaining physicians. The button automatically skips any physician whose column Q is blank, so a partial rollout is safe.

**What gets written.** A new tab is added to each physician's sheet, named `Pay Advice {start}-{end} {year}` (for example `Pay Advice Apr 1-14 2026`). The tab contains:

- A header row showing the period label and a "Generated" timestamp
- A note explaining that the figures are interim cycle (after-hours premiums paid quarterly)
- One row per shift the physician worked in the period, with these columns:

| Column | Meaning |
|--------|---------|
| Date | Shift date as it appears in the source schedule |
| Shift | Shift code (e.g. LB8A, UCC/Ward, HOME) |
| Regular Hours | Regular hours on this shift |
| Evening Premium Hours | Hours that earn the evening premium (paid quarterly) |
| Overnight Premium Hours | Hours that earn the overnight premium (paid quarterly) |
| Weekend/Stat Day Premium Hours | Hours that earn the Weekend Day Premium — applies to daytime shifts on Sat/Sun and stat holidays (paid quarterly) |
| Base Pay | Regular hours × base rate |
| Stat Pay Bonus | Stat holiday premium for this shift (interim — paid alongside base) |
| Cost Share | Per-shift Cost Share holdback |
| Operational Holdback | Per-shift Operational Holdback |
| Total Holdback | Cost Share + Operational Holdback |
| Net Pay | Base + Stat − Total Holdback |

A final **TOTAL** row sums the Net Pay column.

**Why after-hours premiums show only as hours, not dollars.** The pay advice represents the **interim** pay cycle (biweekly run). After-hours premium dollars (evening, overnight, weekend day) are paid in a separate quarterly lump sum when HA reimbursement arrives, so they're not in the Net Pay column. The hours columns remain visible so physicians can see what after-hours work they did during the period — they'll receive those dollars at the next quarterly run.

**Re-pushing the same period.** If you re-run the financial engine and re-push, the existing tab for that period (matched by tab name) is overwritten with the new numbers. Earlier periods' tabs are not touched.

**Why it takes a minute.** The push is broken into batches of 4 physicians per server request to stay under Vercel's serverless function timeout (free tier limit is 10 seconds). With 25 physicians, that's about 7 sequential batches, totalling roughly 50-60 seconds in your browser. While it runs, you'll see "Batch 3 of 7 (12 of 25 physicians processed)" updating in real time, and the Pushed/Skipped lists below will fill in batch by batch — so you're never waiting blind for the whole push to finish. If a batch fails midway, the already-pushed physicians are saved in the result panel and you can click Push Pay Advice again to retry.

**Result panel.** After pushing, the UI shows:

- **Pushed:** count + per-physician list with a link to each sheet
- **Skipped:** count + per-physician list with the reason (no URL configured, sheet not shared, invalid URL, etc.)

If a physician is in the "Skipped" list with "Permission denied", add the service account email as Editor on their sheet and click Push Pay Advice again.

### A14. What the Engine Does Not Do

A few common expectations that the engine deliberately doesn't implement, so you don't have to wonder:

The engine does not infer evening or overnight hours from shift start/end times. It reads the counts you set in rows 6 and 7 of the schedule. If a new shift type needs different premium hours, edit the schedule, not the code.

The engine does not apply a separate "call" premium or on-call stipend. Home call earns the overnight premium via its row 7 value, the same way any other shift earns its premiums.

The engine does not cap total daily or weekly hours. It trusts the schedule. If the schedule has a physician working 30 hours in a day, they'll be paid for 30 hours.

The engine does not round. All calculations carry full precision. The two-decimal display in reports is cosmetic — internally everything is floating point.

The engine does not apply different base rates by physician, shift type, or day of week. There is exactly one base rate per run. If you need to pay different physicians differently, you'd either need to run the financial stage twice with different rate parameters (filtering the parsed schedule between runs) or extend the engine with per-physician rates — a change that would require code modification.

---

*Last updated: April 18, 2026*

**Change log for this revision:**

- UCC/Ward + Home Call concurrent override now credits 4 evening premium hours (was 5). Dr. Yu worked example gross pay recalculated from $3,126.50 to $3,101.50.
- Overhead holdback changed from a flat percentage of base pay to two per-hour deductions on regular hours: Cost Share (default $1.40/hr) and Operational Holdback (default $7.45/hr).
- Output tabs restructured to reflect the biweekly + quarterly payment cadence: added Interim Payroll, HA Invoice – Interim, After Hours Payroll, and HA Invoice – After Hours. Old comprehensive tabs (Payroll Summary, Physician Detail) retained for audit. KPI Summary reorganized into sections with a reconciliation check line.
- Stat Holiday Premium is no longer invoiced to the health authority — it is funded internally from the holdback pool and paid to physicians in their biweekly interim alongside base pay.
- Terminology change throughout: "Bonus" renamed to "Premium" (Evening Premium, Overnight Premium, Weekend Day Premium, Stat Holiday Premium). Internal JavaScript variable names retain the legacy "bonus" labels for code stability.
- New QuickBooks CSV download button on Step 4. Generates `VHA Hospitalist Payroll YYYY-MM-DD to YYYY-MM-DD.csv` with 13 columns for the accountant's biweekly payment workflow.
- New **Push Pay Advice** button on Step 4. Sends a per-physician pay advice tab to each physician's personal Google Sheet. URLs come from Contact Info column Q. See Appendix A13 for setup and rollout workflow.
