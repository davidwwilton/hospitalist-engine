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
   - Overhead Holdback percentage (default 2%) — applied to **base pay only**, not to after-hours premiums or the stat holiday bonus (see Appendix A11 for the exact formula)
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
| "Tab was read successfully but no shift entries were extracted" | The month tab's row layout doesn't match the template. Rows 1–7 must be: header, (row 2–3 any content), time range, regular hours, evening hours, overnight hours. Most common cause: an extra row inserted at the top of the month. See "Keep Every Month Tab Consistent" above. |
| "Fewer than 5 entries parsed" | Either the schedule URL is wrong, no months were selected, or every selected month tab had a structural problem. Check the tab-specific error details included in the message. |
| No shifts found in period | The date range doesn't overlap with any shifts in the parsed schedule — check that you parsed the right months |
| Name shows as UNRESOLVED | The physician name in the schedule doesn't match anything in the Contact Info tab — correct it in Step 2 |

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

The rate parameters default to base $200.10/hr, evening bonus $25/hr, overnight bonus $35/hr, and holdback 2%, but you can override any of these in the UI before generating the report. Every rule below uses whatever values you set for that specific run.

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

### A4. Evening Bonus

Hours marked as "evening" in row 6 of the schedule earn an additional evening bonus rate on top of the base rate. This is **not** the total pay for those hours — it's a premium added to the base pay the physician already earned for the same hours.

```
eve_bonus = evening_hrs × evening_rate
```

Example: an ER eve shift labelled `16 - 01` might have 9 regular hours and 5 evening hours. At $200.10 base + $25 evening bonus, the physician earns `9 × $200.10 = $1,800.90` in base pay plus `5 × $25 = $125.00` in evening bonus, for a total of $1,925.90 on that shift.

The engine does not look at the actual clock times to decide which hours are evening — it trusts the evening hour count you set in row 6 of the schedule. If you need to change what counts as an evening hour for a particular shift type, edit row 6 of that column in the schedule and re-parse.

### A5. Overnight Bonus

Hours marked as "overnight" in row 7 of the schedule earn an additional overnight bonus rate on top of the base rate. Same structure as the evening bonus.

```
on_bonus = overnight_hrs × overnight_rate
```

Example: a home call shift `24 - 08` might have 8 regular hours and 8 overnight hours. At $200.10 base + $35 overnight bonus, the physician earns `8 × $200.10 = $1,600.80` in base plus `8 × $35 = $280.00` in overnight bonus, for $1,880.80 on that shift.

Evening and overnight bonuses can both apply to the same shift if rows 6 and 7 both have non-zero values (e.g. a shift with 4 evening hours and 4 overnight hours).

### A6. Weekend Bonus

Saturdays and Sundays attract an additional premium — but only on **pure daytime shifts**. A shift is considered a pure daytime shift when its evening hours **and** overnight hours are both zero. The weekend bonus is calculated at the evening bonus rate (not a separate weekend rate):

```
if (is_weekend AND evening_hrs == 0 AND overnight_hrs == 0):
    weekend_bonus = regular_hrs × evening_rate
else:
    weekend_bonus = 0
```

Example: a physician working an LB8A day shift on Saturday (9 regular hours, 0 evening, 0 overnight) earns `9 × $200.10 = $1,800.90` in base plus `9 × $25 = $225.00` in weekend bonus, for $2,025.90 on that shift.

Counter-example: the same physician working ER eve on a Saturday already has evening hours attached to the shift, so the weekend bonus does **not** apply on top. They earn base + evening bonus as usual. The reasoning is that the evening/overnight premium already compensates them for working after-hours, and stacking a weekend premium on top would double-count.

The weekend bonus is included in the "After Hours" total (see A9) even though the hours are daytime. This is intentional — "After Hours" is the engine's label for all premiums above base pay, not a statement about when the work was done.

### A7. Stat Holiday Bonus

If a shift's date matches a date in the "Stat Holidays" tab of your source schedule, every hour on that shift earns an extra 0.5 × base rate on top of everything else. This applies to the full regular hours of the shift, regardless of whether it's a day, evening, or overnight shift.

```
stat_bonus = regular_hrs × (0.5 × base_rate)
```

Example: a physician working an LB8A day shift on a stat holiday (9 regular hours) with a base rate of $200.10 earns a stat bonus of `9 × (0.5 × $200.10) = 9 × $100.05 = $900.45` on top of their base pay and any other applicable bonuses.

Stat holiday dates also receive the weekend bonus on the same daytime-only rule as Saturday/Sunday. So a pure daytime stat shift earns **both** the stat bonus and the weekend bonus. An evening or overnight stat shift earns the stat bonus but not the weekend bonus (same reasoning as A6).

The stat bonus is **tracked separately** from the After Hours total. On reports you'll see it as its own line ("Stat_Bonus" column, "Total Stat Holiday Bonus" KPI). The "Base + After Hours" total excludes it. The "Gross Pay" total includes it.

### A8. Overlap Detection and Invoiceable Deduction

When the same physician has two shifts whose times touch, the engine detects the overlap and reduces the **invoiceable** hours on the second shift by the overlap amount. Payable hours are never touched — only invoiceable.

The engine sorts all of a physician's shifts in the period chronologically (date first, then start hour) and walks the sorted list comparing each shift to the next. For each pair, it calculates how many hours shift A's end time runs past shift B's start time, using an **extended-24** convention where overnight shifts have end times like 32 (meaning 8 AM the next day) so the math stays linear across midnight.

If the overlap is greater than zero, that many hours are deducted from shift B's invoiceable hours. Shift A is never touched — the deduction is always on the "later" shift.

Two cases are common:

**Same-day overlap.** A physician works a day shift 08–17 and an evening shift 16–01 on the same date. The day shift ends at 17, the evening shift starts at 16 — so the evening shift's first hour (16–17) overlaps the day shift's last hour. The engine deducts 1 hour from the evening shift's invoiceable hours. The physician is still paid for both full shifts; the health authority is billed for 1 hour less than the total hours worked.

**Cross-midnight overlap.** A physician works ER eve 16–01 on Monday (end time = 25 in extended-24 form) followed by home call 00–08 on Tuesday (start time = 0 on Tuesday = 24 in extended-24 form from Monday's reference point). Monday's end is 25, Tuesday's start is 24 — so the overlap is 1 hour. That hour is deducted from Tuesday's home call invoiceable hours.

You'll always see every overlap that was detected logged in the **Overlap Log** tab of the financial output, with both shift IDs and the exact number of hours deducted. If the log is empty, no overlaps were found in the period.

Edge case to be aware of: overlaps are only detected between **consecutive** shifts in the sorted list, not between arbitrary pairs. In practice this is never a problem because a physician's real shifts don't triple-stack, but if you ever see a value in the reports you can't reconcile, the Overlap Log is the first place to check.

### A9. Putting It All Together: The Per-Shift Pay Formula

For a single shift, the engine computes these values in this order:

```
base_pay        = regular_hrs × base_rate
eve_bonus       = evening_hrs × evening_rate
on_bonus        = overnight_hrs × overnight_rate
weekend_bonus   = (is_weekend_or_stat AND daytime_only) ? regular_hrs × evening_rate : 0
stat_bonus      = is_stat_holiday ? regular_hrs × (0.5 × base_rate) : 0

after_hours     = eve_bonus + on_bonus + weekend_bonus
base_plus_after = base_pay + after_hours
gross           = base_plus_after + stat_bonus
```

Note carefully: the stat bonus is added **after** `base_plus_after`, so it does not contribute to the "After Hours" line on any report. This is intentional — "After Hours" is a category that tracks premium pay for inconvenient work times (evening/overnight/weekend), while the stat bonus is a separate holiday premium that sits in its own column.

### A10. Weekend Daytime Shift Dedup (Parser-Level)

This rule runs at parse time, not at financial time — but it directly affects what the financial engine sees, so it belongs in this reference.

On weekend days, physicians often cover multiple wards during a single daytime shift. The raw schedule records each ward assignment in its own column, producing apparent duplicates like "Dr. Jara Villarroel: LB8A Saturday" and "Dr. Jara Villarroel: LB7A Saturday" — same physician, same date, same daytime window, two different wards.

The parser detects these and **keeps only the first** daytime entry for each physician-date pair, logging the rest to the Duplicate Log. "Daytime" for the purposes of this rule means a shift whose start and end times fall entirely within 07:00–18:00 and don't cross midnight.

The retained shift's hours are used by the financial engine as-is. The physician is paid once for the daytime window, which is the intended outcome — they only worked the daytime once, even if it's labelled under multiple ward columns on paper.

This rule does **not** apply to evening or overnight shifts. If a physician has a day shift and an evening shift on the same date, both are kept and the overlap rule (A8) handles any time-band conflict between them.

Example of what gets suppressed: weekend pair-ward coverage where the schedule has two columns both labelled "LB8A" with the same physician in both. The first is kept (goes to both Payroll and Clean tab), the second is logged as a duplicate and blanked from the Clean tab so the visible weekend row matches what was actually worked.

### A11. Physician Totals and the KPI Roll-Up

After every shift has been priced, the engine sums each physician's shifts into a per-physician total and then sums all physicians into period totals.

Per-physician totals are written to the **Payroll Summary** tab. The columns are: `Base_Pay`, `Eve_Bonus`, `ON_Bonus`, `Weekend_Bonus`, `After_Hours` (sum of the three premiums), `Base_Plus_After_Hrs`, `Stat_Bonus`, `Gross_Pay` (everything including stat), `Holdback`, and `Net_Pay`.

The holdback is a flat percentage applied to **base pay only** — not to after-hours bonuses and not to the stat holiday bonus. Premium pay (evening, overnight, weekend, and stat holiday) reaches the physician in full; only the regular-hours portion of compensation is subject to the holdback.

```
holdback = base_pay × (holdback_pct / 100)
net_pay  = gross − holdback
```

Example: a physician with `base_pay = $16,000`, `after_hours = $1,800`, `stat_bonus = $200` and a 2% holdback has `gross = $18,000`, `holdback = $16,000 × 0.02 = $320.00`, and `net_pay = $18,000 − $320 = $17,680.00`. Compare this to the older policy of holdback on gross, which would have produced a holdback of $360 and a net of $17,640 — the difference ($40 in this example) represents the holdback that is no longer taken from premium pay.

The **KPI Summary** tab is a roll-up of all physicians combined — same line items, same math, just summed across the whole period.

### A12. Health Authority Invoice

The **HA Invoice** tab uses a subset of the per-physician totals formatted as an invoice line per physician. The crucial difference from Payroll Summary is that the HA Invoice uses **Invoiceable Hours** (post-overlap-deduction), not Payable Hours (pre-deduction).

Per-physician invoice amounts still equal Gross Pay, because the overlap deduction only affects the Invoiceable Hours column — not the dollar amounts. The dollar amounts on the HA Invoice are identical to Payroll Summary. The hours column is what differs, and it's that column that matters when reconciling hours billed against hours paid to physicians.

If you ever need to reconcile total hours paid vs. total hours billed, the difference between `Total Payable Hours` and `Total Invoiceable Hours` on the KPI tab equals the total hours deducted by overlap detection — which should also equal the sum of the `overlap_hours` column on the Overlap Log tab.

### A13. What the Engine Does Not Do

A few common expectations that the engine deliberately doesn't implement, so you don't have to wonder:

The engine does not infer evening or overnight hours from shift start/end times. It reads the counts you set in rows 6 and 7 of the schedule. If a new shift type needs different premium hours, edit the schedule, not the code.

The engine does not apply a separate "call" bonus or on-call stipend. Home call earns the overnight bonus via its row 7 value, the same way any other shift earns its premiums.

The engine does not cap total daily or weekly hours. It trusts the schedule. If the schedule has a physician working 30 hours in a day, they'll be paid for 30 hours.

The engine does not round. All calculations carry full precision. The two-decimal display in reports is cosmetic — internally everything is floating point.

The engine does not apply different base rates by physician, shift type, or day of week. There is exactly one base rate per run. If you need to pay different physicians differently, you'd either need to run the financial stage twice with different rate parameters (filtering the parsed schedule between runs) or extend the engine with per-physician rates — a change that would require code modification.

---

*Last updated: April 11, 2026*
