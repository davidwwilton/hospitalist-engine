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
| `api/parse.js` | Parses physician schedule from Google Sheets; contains `collapseDuplicates`, `parseShiftTime`, `isDaytime`, shift-ID normalization |
| `api/write-parsed.js` | Writes parsed entries to "Parsed Schedule" tab and generates Clean tab |
| `api/financial.js` | Computes payroll, HA invoices, overlap detection (`detectOverlaps`), and per-physician detail |
| `USER_GUIDE.md` | Authoritative user guide (source of truth); regenerate `.docx` from this |
| `USER_GUIDE.docx` | Distributed copy of the guide; regenerate via: `pandoc USER_GUIDE.md -o /tmp/USER_GUIDE_raw.docx --from markdown --to docx --toc --toc-depth=2` then LibreOffice headless round-trip for schema normalization |

## Financial Constants

- Base rate: $200.10/hr
- Evening bonus: $25/hr
- Overnight bonus: $35/hr
- Holdback: 2% (on base pay only)

## Notable Business Rules

- **UCC/Ward + Home Call concurrent override** (added Apr 2026): When a physician works UCC/Ward (17-08) and Home Call (24-08) on the same schedule row, the engine forces 15 regular + 5 evening + 0 overnight hours onto UCC/Ward and suppresses Home Call entirely. Hard-coded in `collapseDuplicates` Pass 1. See USER_GUIDE.md Appendix A8.1.
- **Overlap detection** deducts from invoiceable hours only, never payable hours.
- **Extended-24 convention**: overnight shifts use end + 24 when end ≤ start (e.g., 17-08 → {start:17, end:32}).
- **Weekend pair-ward dedup** (collapseDuplicates Pass 2): collapses duplicate daytime entries on same physician/date.

## Git Workflow

From the Windows path above:

```
git add <files>
git commit -m "message"
git push
```

Vercel auto-redeploys after push (~1 minute).
