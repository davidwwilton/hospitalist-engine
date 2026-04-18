export default function Step4Results({ results, onReset, onNewReport }) {
  const { kpi, periodLabel, overlapCount, physicianCount, outputUrl, physicianResults } = results;

  const fmtMoney = (n) => `$${Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtHrs = (n) => Number(n).toFixed(2);

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
          <span className="kpi-label">Evening Hours</span>
          <span className="kpi-value">{fmtHrs(kpi.total_evening_hrs)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Overnight Hours</span>
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
            <span>Gross Pay</span>
            <span>Cost Share</span>
            <span>Op Holdback</span>
            <span>Total Holdback</span>
            <span>Net Pay</span>
          </div>
          {Object.values(physicianResults)
            .sort((a, b) => a.physician.localeCompare(b.physician))
            .map((pr) => (
              <div key={pr.physician} className="phys-table-row">
                <span className="phys-name">{pr.physician}</span>
                <span>{pr.shift_count}</span>
                <span>{fmtHrs(pr.payable_hrs)}</span>
                <span>{fmtMoney(pr.gross)}</span>
                <span className="holdback">{fmtMoney(pr.cost_share)}</span>
                <span className="holdback">{fmtMoney(pr.op_holdback)}</span>
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
            <strong>Your report is ready in Google Sheets</strong>
            <p>Includes: KPI Summary · Payroll Summary · HA Invoice · Physician Detail{overlapCount > 0 ? " · Overlap Log" : ""}</p>
          </div>
        </div>
        <a href={outputUrl} target="_blank" rel="noreferrer" className="btn-primary">
          Open Report ↗
        </a>
      </div>

      <div className="step-actions">
        <button className="btn-ghost" onClick={onReset}>← Start Over</button>
        <button className="btn-secondary" onClick={onNewReport}>Run Another Report</button>
      </div>
    </div>
  );
}
