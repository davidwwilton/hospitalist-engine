import { useState } from "react";

export default function Step2NameReview({
  nameLog, canonicalNames, corrections, onChange, onConfirm, onBack, loading
}) {
  const needsReview = nameLog.filter((e) => e.status === "REVIEW" || e.status === "UNRESOLVED");

  // Track which rows are in "manual entry" mode
  const [manualMode, setManualMode] = useState({});
  const [manualText, setManualText] = useState({});

  const setCorrection = (raw, value) => {
    onChange((prev) => ({ ...prev, [raw]: value }));
  };

  const handleUseAsIs = (raw) => {
    setCorrection(raw, raw);
    setManualMode((prev) => ({ ...prev, [raw]: false }));
  };

  const handleManualToggle = (raw) => {
    setManualMode((prev) => ({ ...prev, [raw]: true }));
    setManualText((prev) => ({ ...prev, [raw]: corrections[raw] || "" }));
  };

  const handleManualSubmit = (raw) => {
    const name = (manualText[raw] || "").trim();
    if (name) {
      setCorrection(raw, name);
      setManualMode((prev) => ({ ...prev, [raw]: false }));
    }
  };

  const handleManualKeyDown = (e, raw) => {
    if (e.key === "Enter") handleManualSubmit(raw);
    if (e.key === "Escape") setManualMode((prev) => ({ ...prev, [raw]: false }));
  };

  const allResolved = needsReview.every(
    (e) => corrections[e.original] || e.status === "REVIEW"
  );

  return (
    <div className="step-panel">
      <div className="step-header">
        <h2>Step 2 — Review Physician Names</h2>
        <p>
          {needsReview.length} physician name{needsReview.length !== 1 ? "s" : ""} need your review
          before the output is written.
        </p>
      </div>

      <div className="name-review-table">
        <div className="name-review-header">
          <span>Raw Name (in schedule)</span>
          <span>Best Match</span>
          <span>Confidence</span>
          <span>Correction</span>
        </div>

        {needsReview.map((entry) => {
          const raw = entry.original;
          const corrected = corrections[raw];
          const isManual = manualMode[raw];

          return (
            <div
              key={raw}
              className={`name-review-row ${entry.status === "UNRESOLVED" ? "unresolved" : "review"}`}
            >
              <span className="raw-name">{raw}</span>
              <span className="matched-name">
                {entry.resolved === "UNRESOLVED" ? (
                  <em className="no-match">No match found</em>
                ) : (
                  <>{entry.resolved} <span className="method-tag">{entry.method}</span></>
                )}
              </span>
              <span className={`confidence-badge ${entry.status.toLowerCase()}`}>
                {entry.confidence_pct}
              </span>
              <span className="correction-cell">
                {corrected && !isManual ? (
                  <div className="correction-confirmed">
                    <span className="confirmed-name">{corrected}</span>
                    <button
                      className="btn-change"
                      onClick={() => { setCorrection(raw, ""); }}
                    >
                      Change
                    </button>
                  </div>
                ) : isManual ? (
                  <div className="manual-entry">
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Type correct name..."
                      value={manualText[raw] || ""}
                      onChange={(e) => setManualText((prev) => ({ ...prev, [raw]: e.target.value }))}
                      onKeyDown={(e) => handleManualKeyDown(e, raw)}
                      autoFocus
                    />
                    <button className="btn-small" onClick={() => handleManualSubmit(raw)}>Save</button>
                    <button className="btn-small btn-ghost" onClick={() => setManualMode((prev) => ({ ...prev, [raw]: false }))}>Cancel</button>
                  </div>
                ) : (
                  <div className="correction-options">
                    {entry.status === "REVIEW" && (
                      <button
                        className="btn-confirm-match"
                        onClick={() => setCorrection(raw, entry.resolved)}
                      >
                        Confirm "{entry.resolved}"
                      </button>
                    )}
                    <button
                      className="btn-use-as-is"
                      onClick={() => handleUseAsIs(raw)}
                    >
                      Use as-is
                    </button>
                    <select
                      className="form-select"
                      value=""
                      onChange={(e) => { if (e.target.value) setCorrection(raw, e.target.value); }}
                    >
                      <option value="">Select from list...</option>
                      {canonicalNames.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <button
                      className="btn-small btn-ghost"
                      onClick={() => handleManualToggle(raw)}
                    >
                      Enter name...
                    </button>
                  </div>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="name-review-note">
        <strong>Note:</strong> Names with confidence ≥90% are auto-resolved and not shown here.
        For new physicians not yet on the Contact Info list, use "Use as-is" to keep the name from the schedule
        or "Enter name" to type the correct full name.
      </div>

      <div className="step-actions">
        <button className="btn-ghost" onClick={onBack} disabled={loading}>← Back</button>
        <button
          className="btn-primary"
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? <><span className="spinner" /> Writing parsed schedule…</> : "Confirm & Write Schedule →"}
        </button>
      </div>
    </div>
  );
}
