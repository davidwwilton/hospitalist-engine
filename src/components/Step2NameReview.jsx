export default function Step2NameReview({
  nameLog, canonicalNames, corrections, onChange, onConfirm, onBack, loading
}) {
  const needsReview = nameLog.filter((e) => e.status === "REVIEW" || e.status === "UNRESOLVED");

  const setCorrection = (raw, value) => {
    onChange((prev) => ({ ...prev, [raw]: value }));
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
          <span>Correction (if needed)</span>
        </div>

        {needsReview.map((entry) => (
          <div
            key={entry.original}
            className={`name-review-row ${entry.status === "UNRESOLVED" ? "unresolved" : "review"}`}
          >
            <span className="raw-name">{entry.original}</span>
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
            <span>
              {entry.status === "REVIEW" && !corrections[entry.original] ? (
                <button
                  className="btn-confirm-match"
                  onClick={() => setCorrection(entry.original, entry.resolved)}
                >
                  ✓ Confirm "{entry.resolved}"
                </button>
              ) : (
                <select
                  className="form-select"
                  value={corrections[entry.original] || entry.resolved || ""}
                  onChange={(e) => setCorrection(entry.original, e.target.value)}
                >
                  <option value="">— select correct name —</option>
                  {canonicalNames.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="name-review-note">
        <strong>Note:</strong> Names with confidence ≥90% are auto-resolved and not shown here.
        Once you confirm or correct all names above, the parsed schedule will be written to Google Sheets.
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
