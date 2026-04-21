# Hospitalist Engine — Project Memory

## Local Development Path (Windows)

```
C:\Users\rtwem\Documents\Claude\Projects\Hospitalist Management\hospitalist-engine
```

Git repo: `davidwwilton/hospitalist-engine`

## Stack

- **Front-end:** React + Vite
- **Back-end:** Vercel serverless functions (`api/parse.js`, `api/write-parsed.js`, `api/financial.js`)
- **Data source:** Google Sheets API via service account
- **Deployment:** Vercel (auto-deploys on push)

## Key Files

| File | Purpose |
|------|---------|
| `api/parse.js` | Parses physician schedule from Google Sheets; contains `collapseDuplicates`, `parseShiftTime`, `isDaytime`, shift-ID normalization, and the `UCC_WARD_HOMECALL_OVERRIDE` constant |
| `api/write-parsed.js` | Writes parsed entries to "Parsed Schedule" tab and generates Clean tabs |
| `api/financial.js` | Computes payroll, HA invoices, overlap detection (`detectOverlaps`), and per-physician detail. Writes KPI Summary + Interim Payroll + HA Invoice – Interim + After Hours Payroll + HA Invoice – After Hours + Payroll Summary + Physician Detail tabs |
| `src/components/Step3Financial.jsx` | Step 3 UI with the rate inputs (base, evening, overnight, cost share, op holdback) |
| `src/components/Step4Results.jsx` | Step 4 UI with KPI cards, per-physician sanity table, Download QuickBooks CSV button, Open Report link |
| `USER_GUIDE.md` | Authoritative user guide (source of truth); regenerate `.docx` from this |
| `USER_GUIDE.docx` | Distributed copy of the guide; regenerate via: `pandoc USER_GUIDE.md -o /tmp/USER_GUIDE_raw.docx --from markdown --to docx --toc --toc-depth=2` then LibreOffice headless round-trip for schema normalization |

## Financial Constants (defaults — can be overridden per run in UI)

- Base rate: $200.10/hr
- Evening Premium: $25/hr
- Overnight Premium: $35/hr
- Cost Share (holdback): $1.40/hr on regular hours
- Operational Holdback: $7.45/hr on regular hours

Terminology: user-facing labels use "Premium" (Evening Premium, Overnight Premium, Weekend Day Premium, Stat Holiday Premium). Internal JavaScript variable names and data field keys still use `bonus` for backward compatibility (`eveBonus`, `eve_bonus`, `weekend_bonus`, `stat_bonus`, etc.) — do not rename without a dedicated refactor session.

## Notable Business Rules

- **Payment cadence**: Interim Payroll (biweekly) = base + stat premium − holdback. After Hours Payroll (quarterly) = eve + overnight + weekend day premium. Sum of the two = gross pay. KPI Summary has a reconciliation line verifying this each run.
- **UCC/Ward + Home Call concurrent override** (added Apr 2026, evening hours changed 5→4 in Apr 18, 2026): When a physician works UCC/Ward (17-08) and Home Call (24-08) on the same schedule row, the engine forces 15 regular + 4 evening + 0 overnight hours onto UCC/Ward and suppresses Home Call entirely. Hard-coded in `collapseDuplicates` Pass 1 as `UCC_WARD_HOMECALL_OVERRIDE`. See USER_GUIDE.md Appendix A8.1.
- **Holdback model** (changed Apr 2026): Was a flat percentage of base pay. Now two per-hour deductions on regular hours — Cost Share and Operational Holdback. Does not apply to premium pay or stat holiday premium.
- **Stat Holiday Premium NOT invoiced to HA** (fixed Apr 2026): Stat premium is paid to physicians in biweekly interim but is funded internally from the holdback pool, not billed to the health authority. Before this fix, the HA Invoice included stat premium, which was a bug.
- **Overlap detection** deducts from invoiceable hours only, never payable hours. Second shift in each overlap pair is the one that gets deducted.
- **Extended-24 convention**: overnight shifts use end + 24 when end ≤ start (e.g., 17-08 → {start:17, end:32}).
- **Weekend pair-ward dedup** (collapseDuplicates Pass 2): collapses duplicate daytime entries on same physician/date.
- **Weekend Day Premium** (renamed from Weekend Bonus): applies at evening rate to regular hours on pure daytime Sat/Sun/stat shifts only. Shifts with any evening or overnight hours do not receive it (they already earn after-hours premiums).

## Output Tabs (order they appear in the financial output spreadsheet)

1. KPI Summary — period totals, rates, reconciliation check
2. Interim Payroll — biweekly per-physician pay
3. HA Invoice – Interim — base pay billable to HA
4. After Hours Payroll — quarterly per-physician premium pay
5. HA Invoice – After Hours — premium pay billable to HA
6. Payroll Summary — comprehensive audit view
7. Physician Detail — per-shift audit trail
8. Overlap Log (conditional)

## QuickBooks CSV Export

Step 4 has a "Download QuickBooks CSV" button that generates a client-side CSV of the interim (biweekly) payroll data. One row per physician, 13 columns (Physician, Pay Period, Period Start Date, Period End Date, 8h Shifts, 9h Shifts, Other Shifts, Payable Hours, Base Pay, Stat Pay, Gross Pay, Total Holdback, Net Pay). Filename: `VHA Hospitalist Payroll YYYY-MM-DD to YYYY-MM-DD.csv`. UTF-8 with BOM for Excel compatibility.

## UI History / Hidden Features

- **Bi-Weekly period type hidden from UI (2026-04-20)**: The "Bi-Weekly" radio option was removed from Step 3 because the association moved to monthly (and occasional custom-range) pay cycles. The backend logic in `api/financial.js` is still intact — only `src/components/Step3Financial.jsx` was changed (radio array + conditional block removed, dead state/helper/useEffect left in place for reversibility). To restore the UI: add `"biweekly"` back to the radio array in `Step3Financial.jsx` line 82 and re-add the biweekly conditional block from git history.

## Git Workflow

From the Windows path above:

```
git add <files>
git commit -m "message"
git push
```

Vercel auto-redeploys after push (~1 minute).
