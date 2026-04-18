# Hospitalist Financial Engine

A web app that reads a physician schedule from Google Sheets, normalises physician names, and generates financial reports — payroll summaries, health authority invoices, and per-physician shift breakdowns. Deployed at [hospitalist-engine.vercel.app](https://hospitalist-engine.vercel.app).

## For users

The authoritative user guide is [`USER_GUIDE.md`](./USER_GUIDE.md) (also distributed as `USER_GUIDE.docx`). It covers:

- Setting up Google Sheets and the service account
- Walking through the 4-step workflow: Parse → Name Review → Financial Configuration → Results
- Schedule format requirements
- The financial rules in detail (Appendix A — base pay, premiums, overlap detection, holdback formula, HA invoice math)
- Troubleshooting common issues

## For developers

**Stack:** React + Vite front-end, Vercel serverless functions (Node.js) back-end, Google Sheets API via a service account.

**Project memory for AI-assisted development:** see [`CLAUDE.md`](./CLAUDE.md) for financial constants, business rules, file structure, and conventions.

### Local development

```bash
npm install
npm run dev
```

Requires a `.env` with `GOOGLE_SERVICE_ACCOUNT` set to the JSON credentials of a Google service account that has Editor access to the source schedule, parsed output, and financial output spreadsheets.

### Build

```bash
npm run build
```

### Deployment

Pushes to `main` auto-deploy to Vercel. Build takes roughly one minute.

## Key financial rules (summary — full detail in USER_GUIDE.md)

- **Base pay** at $200.10/hr for all regular hours (default, configurable per run).
- **Premium pay** on top of base rate: Evening Premium $25/hr, Overnight Premium $35/hr, Weekend Day Premium at evening rate (daytime-only on Sat/Sun/stat), Stat Holiday Premium at 0.5 × base rate on all stat holiday hours.
- **Payment cadence**: biweekly interim (base + stat premium − holdback) and quarterly after-hours (premiums). The two sum to gross pay; a reconciliation check on KPI Summary verifies every run.
- **Holdback** (as of April 2026): two per-hour deductions on regular hours — Cost Share $1.40/hr and Operational Holdback $7.45/hr. Applied to regular hours only; premium pay is never held back.
- **HA Invoice** excludes Stat Holiday Premium — stat premium is funded internally from the holdback pool.
- **Overlap detection** deducts back-to-back overlap from the second shift's invoiceable (billable) hours only. Physicians are always paid in full for every hour worked.
- **UCC/Ward + Home Call concurrent override**: when a single physician works both on the same date (home call falls inside the UCC/Ward window), the engine forces UCC/Ward to 15 regular + 4 evening premium hours and suppresses the Home Call entry.

## License

Private, internal use only.
