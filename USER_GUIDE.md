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
4. **Months to Parse** — Click the month buttons for the months you want (e.g. "Mar" for March). You must select at least one
5. **Output Spreadsheet URL** — Paste the URL of the blank Google Sheet you created for parsed output
6. Click **Parse Schedule →**

The app will read your schedule, match physician names against the Contact Info list, and write the cleaned data to your output spreadsheet.

**What can go wrong here:**
- "Please enter a valid Google Sheets URL" — Make sure the URL looks like `https://docs.google.com/spreadsheets/d/...`
- Permission errors — Make sure the source schedule AND the output spreadsheet are both shared with the service account email
- "Please select at least one month" — Click at least one month button before parsing

### Step 2 — Name Review (if needed)

If the parser finds physician names it can't confidently match, you'll land here.

1. Review each flagged name — the app shows what it found in the schedule vs. what's in the Contact Info tab
2. Use the dropdowns to correct any mismatches
3. Click **Confirm Names →**

If all names matched automatically, this step is skipped entirely.

### Step 3 — Financial Configuration

This step calculates compensation based on the parsed schedule.

1. **Parsed Schedule Spreadsheet URL** — This is auto-filled from Step 1. If you're running financials on a previously parsed schedule, paste its URL here manually
2. **Pay Period** — Choose one:
   - **Full Month** — Select a month
   - **Bi-Weekly** — Select a month, enter a cycle anchor date (the start of any known pay period), then pick the specific two-week window
   - **Custom Range** — Enter a from/to date (e.g. "1-Mar" to "14-Mar")
3. **Financial Parameters** — Set your rates:
   - Base Hourly Rate (default $150) — paid for all hours
   - Evening Bonus for 18:00–23:00 (default $25) — added on top of base rate for evening hours
   - Overnight Bonus for 23:00–08:00 (default $35) — added on top of base rate for overnight hours
   - Overhead Holdback percentage (default 15%)
4. **Output Spreadsheet URL** — Paste the URL of the blank Google Sheet you created for financial output
5. Click **Generate Report →**

**How hours and pay work:**
- The number of regular, evening, and overnight hours per shift type are read from the schedule itself (rows 5–7 of each month tab). This means you can adjust hours dynamically by editing the schedule — no code changes needed.
- Evening and overnight bonus rates are **added on top of** the base rate. For example, an evening hour pays $150 + $25 = $175.
- **Weekend bonus:** All regular hours (08:00–18:00) worked on Saturday or Sunday receive the evening bonus rate on top of base rate.
- **Stat holiday bonus:** All regular hours receive the evening bonus rate (same as weekends), PLUS all hours worked that day (regular, evening, and overnight) receive an additional 0.5 × base hourly rate.
- When two shifts overlap (e.g. an evening shift runs past midnight into a next-day shift), the overlapping hours are deducted from the **second** shift's invoiceable hours only. Physicians are still paid in full for all hours worked — the deduction only prevents double-invoicing the health authority.

### Step 4 — Results

You'll see KPI summary cards showing totals for the period, plus a link to open the financial report spreadsheet. The report contains four tabs:

- **KPI Summary** — Period parameters and aggregate totals
- **Payroll Summary** — Per-physician compensation breakdown
- **HA Invoice** — Health authority invoiceable hours and amounts
- **Physician Detail** — Every shift for every physician with hour and pay breakdowns
- **Overlap Log** — (if any) Back-to-back shifts with overlapping hours, showing which shift had invoiceable hours deducted

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

## Tips

- **Reuse output spreadsheets.** You don't need a new blank sheet every time — the app overwrites the tabs. Just use the same output URLs for each run.
- **Check the Physician Detail tab** if numbers look off. It shows every shift individually so you can trace how hours and pay were calculated.
- **The Overlap Log tab** only appears if there were back-to-back shifts with overlapping hours in the period.

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

*Last updated: April 2, 2026*
