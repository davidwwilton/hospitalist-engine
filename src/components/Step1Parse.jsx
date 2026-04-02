import { useState } from "react";

const ALL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function Step1Parse({ config, onChange, onNext, loading }) {
  const [urlError, setUrlError] = useState("");

  const update = (key, val) => onChange((prev) => ({ ...prev, [key]: val }));

  const toggleMonth = (m) => {
    const months = config.months.includes(m)
      ? config.months.filter((x) => x !== m)
      : [...config.months, m];
    update("months", months);
  };

  const validate = () => {
    if (!config.sourceUrl.includes("docs.google.com/spreadsheets")) {
      setUrlError("Please enter a valid Google Sheets URL");
      return false;
    }
    setUrlError("");
    return true;
  };

  const handleNext = () => {
    if (validate()) onNext();
  };

  return (
    <div className="step-panel">
      <div className="step-header">
        <h2>Step 1 — Parse Schedule</h2>
        <p>Read your Google Sheets schedule, normalise physician names, and collapse duplicate shifts.</p>
      </div>

      <div className="form-section">
        <h3>Source Spreadsheet</h3>

        <div className="form-group">
          <label>Schedule Google Sheets URL <span className="required">*</span></label>
          <input
            type="url"
            className={`form-input ${urlError ? "error" : ""}`}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            value={config.sourceUrl}
            onChange={(e) => { update("sourceUrl", e.target.value); setUrlError(""); }}
          />
          {urlError && <span className="field-error">{urlError}</span>}
        </div>

        <div className="form-group">
          <label>Contact Info Tab Name</label>
          <input
            type="text"
            className="form-input"
            value={config.contactSheet}
            onChange={(e) => update("contactSheet", e.target.value)}
          />
          <span className="field-hint">The tab containing the canonical physician name list</span>
        </div>
      </div>

      <div className="form-section">
        <h3>Months to Parse</h3>
        <p className="section-desc">Select the months you want to parse. If no months are selected, all month tabs in the spreadsheet will be parsed.</p>
        <div className="month-grid">
          {ALL_MONTHS.map((m) => (
            <button
              key={m}
              className={`month-btn ${config.months.includes(m) ? "selected" : ""}`}
              onClick={() => toggleMonth(m)}
            >
              {m}
            </button>
          ))}
        </div>
        {config.months.length > 0 && (
          <p className="selection-summary">Selected: {config.months.join(", ")}</p>
        )}
      </div>

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
          <span className="field-hint">Create a blank Google Sheet, share it with the service account, and paste the URL here. The parsed schedule will be written to this spreadsheet.</span>
        </div>
      </div>

      <div className="step-actions">
        <button
          className="btn-primary"
          onClick={handleNext}
          disabled={loading || !config.sourceUrl || config.months.length === 0 || !config.outputUrl}
        >
          {loading ? <><span className="spinner" /> Parsing schedule…</> : "Parse Schedule →"}
        </button>
      </div>
    </div>
  );
}
