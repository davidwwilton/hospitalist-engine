import { useState, useEffect } from "react";

const MONTH_ABBR = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function biweeklyPeriodsForMonth(anchorStr, monthName) {
  const mn = monthName.trim().toLowerCase().slice(0,3);
  const m = MONTH_ABBR[mn];
  if (!m) return [];
  const YEAR = 2026;
  const mStart = new Date(YEAR, m-1, 1);
  const mEnd = new Date(YEAR, m-1, new Date(YEAR, m, 0).getDate());
  const anchor = new Date(anchorStr);
  let start = new Date(anchor);
  const yearStart = new Date(YEAR, 0, 1);
  while (start > yearStart) start = addDays(start, -14);
  if (addDays(start, 13) < yearStart) start = addDays(start, 14);
  const periods = [];
  const yearEnd = new Date(YEAR, 11, 31);
  while (start <= yearEnd) { periods.push([new Date(start), addDays(start, 13)]); start = addDays(start, 14); }
  return periods.filter(([s,e]) => s <= mEnd && e >= mStart);
}

const ALL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function Step3Financial({ config, onChange, onRun, onBack, loading, parsedUrl }) {
  const [biweeklyPeriods, setBiweeklyPeriods] = useState([]);

  const update = (key, val) => onChange((prev) => ({ ...prev, [key]: val }));

  useEffect(() => {
    if (config.periodType === "biweekly" && config.month && config.biweeklyStart) {
      try {
        const periods = biweeklyPeriodsForMonth(config.biweeklyStart, config.month);
        setBiweeklyPeriods(periods);
      } catch {
        setBiweeklyPeriods([]);
      }
    }
  }, [config.periodType, config.month, config.biweeklyStart]);

  const formatDate = (d) =>
    d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });

  return (
    <div className="step-panel">
      <div className="step-header">
        <h2>Step 3 — Financial Configuration</h2>
        <p>Configure the pay period and financial parameters, then generate your reports.</p>
      </div>

      {/* Parsed schedule URL */}
      <div className="form-section">
        <h3>Parsed Schedule</h3>
        <div className="form-group">
          <label>Parsed Schedule Spreadsheet URL <span className="required">*</span></label>
          <input
            type="url"
            className="form-input"
            placeholder="https://docs.google.com/spreadsheets/d/..."
            value={config.parsedUrl}
            onChange={(e) => update("parsedUrl", e.target.value)}
          />
          {parsedUrl && config.parsedUrl === parsedUrl && (
            <span className="field-hint success">✓ Auto-filled from the parsed schedule you just created</span>
          )}
          {config.parsedUrl && (
            <a href={config.parsedUrl} target="_blank" rel="noreferrer" className="sheet-link">
              Open parsed schedule ↗
            </a>
          )}
        </div>
      </div>

      {/* Pay period */}
      <div className="form-section">
        <h3>Pay Period</h3>

        <div className="form-group">
          <label>Period Type</label>
          <div className="radio-group horizontal">
            {["month", "biweekly", "custom"].map((type) => (
              <label key={type} className="radio-label">
                <input
                  type="radio"
                  checked={config.periodType === type}
                  onChange={() => update("periodType", type)}
                />
                <span>{type === "month" ? "Full Month" : type === "biweekly" ? "Bi-Weekly" : "Custom Range"}</span>
              </label>
            ))}
          </div>
        </div>

        {config.periodType === "month" && (
          <div className="form-group">
            <label>Month</label>
            <div className="month-grid">
              {ALL_MONTHS.map((m) => (
                <button
                  key={m}
                  className={`month-btn ${config.month === m ? "selected" : ""}`}
                  onClick={() => update("month", m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}

        {config.periodType === "biweekly" && (
          <>
            <div className="form-group">
              <label>Month</label>
              <div className="month-grid">
                {ALL_MONTHS.map((m) => (
                  <button
                    key={m}
                    className={`month-btn ${config.month === m ? "selected" : ""}`}
                    onClick={() => update("month", m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label>Cycle Anchor Date <span className="required">*</span></label>
              <input
                type="date"
                className="form-input"
                value={config.biweeklyStart}
                onChange={(e) => update("biweeklyStart", e.target.value)}
              />
              <span className="field-hint">The start date of any known pay period (YYYY-MM-DD)</span>
            </div>
            {biweeklyPeriods.length > 0 && (
              <div className="form-group">
                <label>Select Period</label>
                <div className="period-options">
                  {biweeklyPeriods.map(([s, e], i) => (
                    <label key={i} className="radio-label">
                      <input
                        type="radio"
                        checked={config.biweeklyIndex === i}
                        onChange={() => update("biweeklyIndex", i)}
                      />
                      <span>{formatDate(s)} – {formatDate(e)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {config.periodType === "custom" && (
          <div className="form-row">
            <div className="form-group">
              <label>From (D-Mon)</label>
              <input
                type="text"
                className="form-input"
                placeholder="1-Mar"
                value={config.dateFrom}
                onChange={(e) => update("dateFrom", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>To (D-Mon)</label>
              <input
                type="text"
                className="form-input"
                placeholder="14-Mar"
                value={config.dateTo}
                onChange={(e) => update("dateTo", e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Financial parameters */}
      <div className="form-section">
        <h3>Financial Parameters</h3>
        <div className="rates-grid">
          <div className="form-group">
            <label>Base Hourly Rate</label>
            <div className="input-prefix">
              <span>$</span>
              <input
                type="number"
                className="form-input"
                value={config.baseRate}
                min={0}
                step={0.01}
                onChange={(e) => update("baseRate", parseFloat(e.target.value))}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Evening Bonus (18:00–23:00)</label>
            <div className="input-prefix">
              <span>$</span>
              <input
                type="number"
                className="form-input"
                value={config.eveningRate}
                min={0}
                step={0.01}
                onChange={(e) => update("eveningRate", parseFloat(e.target.value))}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Overnight Bonus (23:00–08:00)</label>
            <div className="input-prefix">
              <span>$</span>
              <input
                type="number"
                className="form-input"
                value={config.overnightRate}
                min={0}
                step={0.01}
                onChange={(e) => update("overnightRate", parseFloat(e.target.value))}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Overhead Holdback</label>
            <div className="input-suffix">
              <input
                type="number"
                className="form-input"
                value={config.holdbackPct}
                min={0}
                max={100}
                step={0.1}
                onChange={(e) => update("holdbackPct", parseFloat(e.target.value))}
              />
              <span>%</span>
            </div>
          </div>
        </div>
        <div className="rates-note">
          <strong>How it works:</strong> Regular, evening, and overnight hours per shift are read from the schedule (rows 5–7).
          Evening/overnight bonus rates are added on top of the base rate. Back-to-back shifts with overlapping hours:
          overlap is deducted from the second shift's invoiceable hours only (physicians are still paid in full).
        </div>
      </div>

      {/* Output */}
      <div className="form-section">
        <h3>Output Spreadsheet</h3>
        <div className="form-group">
          <label>Output Spreadsheet URL <span className="required">*</span></label>
          <input
            type="url"
            className="form-input"
            placeholder="https://docs.google.com/spreadsheets/d/..."
            value={config.outputUrl}
            onChange={(e) => update("outputUrl", e.target.value)}
          />
          <span className="field-hint">Create a blank Google Sheet, share it with the service account, and paste the URL here. The financial report will be written to this spreadsheet.</span>
        </div>
      </div>

      <div className="step-actions">
        <button className="btn-ghost" onClick={onBack} disabled={loading}>← Back</button>
        <button
          className="btn-primary"
          onClick={onRun}
          disabled={loading || !config.parsedUrl || !config.outputUrl}
        >
          {loading ? <><span className="spinner" /> Running financial calculations…</> : "Generate Report →"}
        </button>
      </div>
    </div>
  );
}
