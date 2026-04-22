import { useState } from "react";

export default function Step4Results({ results, onReset, onNewReport, onPushPayAdvice, sourceUrl }) {
  const { kpi, periodLabel, periodStart, periodEnd, overlapCount, physicianCount, outputUrl, physicianResults } = results;

  const fmtMoney = (n) => `$${Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtHrs = (n) => Number(n).toFixed(2);

  // Pay advice push state. Batches the push into groups of PUSH_BATCH_SIZE
  // physicians per request so each server call stays under Vercel Hobby's
  // 10-second function timeout. The browser orchestrates the batches
  // sequentially and accumulates the pushed/skipped lists live as each batch
  // completes — so you can watch progress in real time and aren't waiting
  // blind for the whole 25-physician push to finish.
  const PUSH_BATCH_SIZE = 4;
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState(null); // { pushed: [...], skipped: [...], tabName }
  const [pushError, setPushError] = useState(null);
  const [pushProgress, setPushProgress] = useState(null); // { batch, totalBatches, processed, total }

  const handlePushClick = async () => {
    if (!sourceUrl) {
      setPushError("Source schedule URL is missing. Run the parser from Step 1 in this session before pushing pay advice.");
      return;
    }
    const allKeys = Object.keys(physicianResults).sort();
    const totalBatches = Math.max(1, Math.ceil(allKeys.length / PUSH_BATCH_SIZE));

    const ok = window.confirm(
      `Push pay advice tabs to physicians?\n\n` +
      `${allKeys.length} physicians will be processed in ${totalBatches} batch(es) of up to ${PUSH_BATCH_SIZE}. ` +
      `Each physician with a URL in Contact Info column Q will receive a new tab. ` +
      `Physicians without a URL will be skipped.\n\n` +
      `Re-pushing for the same period overwrites that period's tab.`
    );
    if (!ok) return;

    setPushing(true);
    setPushError(null);
    setPushResult({ pushed: [], skipped: [], tabName: null });
    setPushProgress({ batch: 0, totalBatches, processed: 0, total: allKeys.length });

    const accumulated = { pushed: [], skipped: [], tabName: null };

    try {
      for (let i = 0; i < totalBatches; i++) {
        const batchKeys = allKeys.slice(i * PUSH_BATCH_SIZE, (i + 1) * PUSH_BATCH_SIZE);
        const subset = {};
        for (const k of batchKeys) subset[k] = physicianResults[k];

        setPushProgress({
          batch: i + 1,
          totalBatches,
          processed: i * PUSH_BATCH_SIZE,
          total: allKeys.length,
        });

        const res = await onPushPayAdvice(subset);
        accumulated.pushed.push(...(res.pushed || []));
        accumulated.skipped.push(...(res.skipped || []));
        accumulated.tabName = res.tabName || accumulated.tabName;
        // Spread to a new object so React re-renders the result panel.
        setPushResult({ ...accumulated, pushed: [...accumulated.pushed], skipped: [...accumulated.skipped] });
      }
    } catch (e) {
      setPushError(`Stopped partway through (after batch ${pushProgress?.batch || 0}): ${e.message}. Already-pushed physicians are still listed below; you can click Push Pay Advice again to retry the rest.`);
    } finally {
      setPushing(false);
      setPushProgress(null);
    }
  };

  // Escape a single CSV field per RFC 4180: wrap in quotes if the value contains
  // a comma, double-quote, or newline; double any embedded quotes.
  const csvEscape = (val) => {
    const s = String(val ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // Build the QuickBooks-bound CSV for the accountant. This represents the
  // INTERIM (biweekly) pay run only — base pay + stat premium, less holdback.
  // Premiums (evening / overnight / weekend day) are paid quarterly from a
  // separate lump-sum flow and are NOT in this file.
  const buildQBCsv = () => {
    const headers = [
      "Physician","Pay Period","Period Start Date","Period End Date",
      "8h Shifts","9h Shifts","Other Shifts","Payable Hours",
      "Base Pay","Stat Pay","Gross Pay","Total Holdback","Net Pay",
    ];
    const rows = Object.values(physicianResults)
      .sort((a,b) => a.physician.localeCompare(b.physician))
      .map(pr => [
        pr.physician,
        periodLabel,
        periodStart || "",
        periodEnd   || "",
        pr.shifts_8h,
        pr.shifts_9h,
        pr.shifts_other,
        Number(pr.payable_hrs).toFixed(2),
        Number(pr.base_pay).toFixed(2),
        Number(pr.stat_bonus).toFixed(2),
        Number(pr.interim_gross).toFixed(2),
        Number(pr.total_holdback).toFixed(2),
        Number(pr.interim_net).toFixed(2),
      ]);
    const lines = [headers, ...rows].map(r => r.map(csvEscape).join(","));
    return lines.join("\r\n");
  };

  const downloadQBCsv = () => {
    const csv = buildQBCsv();
    // Prepend UTF-8 BOM so Excel correctly renders accented physician names.
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const fname = `VHA Hospitalist Payroll ${periodStart || "start"} to ${periodEnd || "end"}.csv`;
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="step-panel">
      <div className="step-header success-header">
        <div className="success-icon">✓</div>
        <h2>Report Complete</h2>
        <p className="period-label">{periodLabel}</p>
      </div>

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card highlight">
          <span className="kpi-label">Physicians</span>
          <span className="kpi-value">{physicianCount}</span>
        </div>
        <div className="kpi-card highlight">
          <span className="kpi-label">Total Payable Hours</span>
          <span className="kpi-value">{fmtHrs(kpi.total_payable_hrs)}</span>
        </div>
        <div className="kpi-card highlight">
          <span className="kpi-label">Total Gross Pay</span>
          <span className="kpi-value">{fmtMoney(kpi.total_gross)}</span>
        </div>
        <div className="kpi-card highlight">
          <span className="kpi-label">Total Net Payout</span>
          <span className="kpi-value">{fmtMoney(kpi.total_net)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Regular Hours</span>
          <span className="kpi-value">{fmtHrs(kpi.total_regular_hrs)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Evening Premium Hours</span>
          <span className="kpi-value">{fmtHrs(kpi.total_evening_hrs)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Overnight Premium Hours</span>
          <span className="kpi-value">{fmtHrs(kpi.total_overnight_hrs)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Total Cost Share</span>
          <span className="kpi-value">{fmtMoney(kpi.total_cost_share)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Total Op Holdback</span>
          <span className="kpi-value">{fmtMoney(kpi.total_op_holdback)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Total Holdback</span>
          <span className="kpi-value">{fmtMoney(kpi.total_holdback)}</span>
        </div>
      </div>

      {/* Overlap warning */}
      {overlapCount > 0 && (
        <div className="overlap-notice">
          <span className="notice-icon">⚠</span>
          <div>
            <strong>{overlapCount} overlap deduction{overlapCount !== 1 ? "s" : ""} applied.</strong>
            <p>When two back-to-back shifts overlap (for example, an ER eve running past midnight into a home call, or a day shift ending after an evening shift begins), the overlap hours are deducted from the <strong>second</strong> shift&apos;s invoiceable hours only. Physicians are still paid in full for every hour worked — the deduction only prevents double-billing the health authority. See the Overlap Log tab in your report for the specific shifts affected.</p>
          </div>
        </div>
      )}

      {/* Physician summary table */}
      <div className="form-section">
        <h3>Physician Payroll Summary</h3>
        <div className="physician-table">
          <div className="phys-table-header">
            <span>Physician</span>
            <span>Shifts</span>
            <span>Payable Hrs</span>
            <span>Stat Pay</span>
            <span>Gross Pay</span>
            <span>Holdback</span>
            <span>Net Pay</span>
          </div>
          {Object.values(physicianResults)
            .sort((a, b) => a.physician.localeCompare(b.physician))
            .map((pr) => (
              <div key={pr.physician} className="phys-table-row">
                <span className="phys-name">{pr.physician}</span>
                <span>{pr.shift_count}</span>
                <span>{fmtHrs(pr.payable_hrs)}</span>
                <span>{fmtMoney(pr.stat_bonus)}</span>
                <span>{fmtMoney(pr.gross)}</span>
                <span className="holdback">{fmtMoney(pr.total_holdback)}</span>
                <span className="net">{fmtMoney(pr.net)}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Output link */}
      <div className="output-link-box">
        <div className="output-link-info">
          <span className="sheets-icon">📊</span>
          <div>
            <strong>Your report is ready</strong>
            <p>Spreadsheet includes: KPI Summary · Interim Payroll · After Hours Payroll · HA Invoices · Payroll Summary · Physician Detail{overlapCount > 0 ? " · Overlap Log" : ""}</p>
          </div>
        </div>
        <div className="output-link-actions">
          <button type="button" onClick={downloadQBCsv} className="btn-secondary">
            Download QuickBooks CSV ↓
          </button>
          <a href={outputUrl} target="_blank" rel="noreferrer" className="btn-primary">
            Open Report ↗
          </a>
        </div>
      </div>

      {/* Push Pay Advice — sends per-physician pay advice tabs to each physician's
          personal Google Sheet. Only physicians with a URL in Contact Info column Q
          will receive a push; others are skipped. Re-pushing the same period
          overwrites that period's tab. */}
      <div className="form-section">
        <h3>Push Pay Advice to Physicians</h3>
        <p className="field-hint">
          Sends a new tab to each physician's personal sheet listing the shifts in this pay
          period. Physicians without a URL in Contact Info column Q are skipped — useful for
          rolling this out one or two physicians at a time.
        </p>

        <div className="output-link-actions" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            onClick={handlePushClick}
            disabled={pushing || !sourceUrl}
            className="btn-primary"
          >
            {pushing ? <><span className="spinner" /> Pushing pay advice…</> : "Push Pay Advice →"}
          </button>
        </div>

        {pushing && pushProgress && (
          <div style={{ marginTop: "0.75rem" }} className="field-hint">
            Batch {pushProgress.batch} of {pushProgress.totalBatches} ({pushProgress.processed} of {pushProgress.total} physicians processed)
          </div>
        )}

        {!sourceUrl && (
          <span className="field-hint" style={{ color: "#c00", display: "block", marginTop: "0.5rem" }}>
            Source schedule URL is missing. Re-run the parser from Step 1 in this session to enable push.
          </span>
        )}

        {pushError && (
          <div className="error-banner" style={{ marginTop: "1rem" }}>
            <span className="error-icon">✕</span>
            <span>{pushError}</span>
          </div>
        )}

        {pushResult && (
          <div style={{ marginTop: "1rem" }}>
            <div style={{ marginBottom: "0.75rem" }}>
              <strong>Pushed:</strong> {pushResult.pushed.length} &nbsp;·&nbsp;
              <strong>Skipped:</strong> {pushResult.skipped.length}
              {pushResult.tabName && <> &nbsp;·&nbsp; Tab: <code>{pushResult.tabName}</code></>}
            </div>

            {pushResult.pushed.length > 0 && (
              <details open style={{ marginBottom: "0.75rem" }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  ✓ Pushed ({pushResult.pushed.length})
                </summary>
                <ul style={{ marginTop: "0.5rem" }}>
                  {pushResult.pushed.map((p) => (
                    <li key={p.physician}>
                      {p.physician} — <a href={p.sheetUrl} target="_blank" rel="noreferrer">open sheet ↗</a>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {pushResult.skipped.length > 0 && (
              <details open>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  ⚠ Skipped ({pushResult.skipped.length})
                </summary>
                <ul style={{ marginTop: "0.5rem" }}>
                  {pushResult.skipped.map((s) => (
                    <li key={s.physician}>
                      <strong>{s.physician}</strong> — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      <div className="step-actions">
        <button className="btn-ghost" onClick={onReset}>← Start Over</button>
        <button className="btn-secondary" onClick={onNewReport}>Run Another Report</button>
      </div>
    </div>
  );
}
