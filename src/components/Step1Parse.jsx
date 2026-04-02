import { useState, useEffect, useRef } from "react";

const ALL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MONTH_ABBR_MAP = {
  january: "Jan", february: "Feb", march: "Mar", april: "Apr",
  may: "May", june: "Jun", july: "Jul", august: "Aug",
  september: "Sep", october: "Oct", november: "Nov", december: "Dec",
  jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr",
  jun: "Jun", jul: "Jul", aug: "Aug", sep: "Sep",
  oct: "Oct", nov: "Nov", dec: "Dec",
};

/**
 * Parse tab names into { abbr, year } objects.
 * Handles: "January", "Jan", "January 2026", "Feb 2025", "March2026"
 */
function parseMonthTabs(tabs) {
  const results = [];
  const currentYear = new Date().getFullYear();
  for (const tab of tabs) {
    const t = tab.trim();
    // Try to extract a month name and optional year
    const m = t.match(/^([A-Za-z]+)\s*(20\d{2})?$/);
    if (!m) continue;
    const monthWord = m[1].toLowerCase();
    const abbr = MONTH_ABBR_MAP[monthWord];
    if (!abbr) continue; // not a month tab (e.g. "Contact Info", "Stat Holidays")
    const year = m[2] ? parseInt(m[2]) : currentYear;
    results.push({ abbr, year, tabName: tab });
  }
  return results;
}

export default function Step1Parse({ config, onChange, onNext, loading }) {
  const [urlError, setUrlError] = useState("");
  const [tabsLoading, setTabsLoading] = useState(false);
  const [tabsError, setTabsError] = useState("");
  const [detectedMonths, setDetectedMonths] = useState(null); // null = not fetched yet
  const lastFetchedUrl = useRef("");

  const update = (key, val) => onChange((prev) => ({ ...prev, [key]: val }));

  // Fetch tabs when sourceUrl changes and looks valid
  useEffect(() => {
    const url = config.sourceUrl || "";
    if (!url.includes("docs.google.com/spreadsheets/d/")) {
      // Not a valid URL yet — clear detected months
      if (detectedMonths !== null) setDetectedMonths(null);
      return;
    }
    // Don't re-fetch the same URL
    if (url === lastFetchedUrl.current) return;
    lastFetchedUrl.current = url;

    let cancelled = false;
    setTabsLoading(true);
    setTabsError("");

    fetch("/api/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        setTabsLoading(false);
        if (data.error) {
          setTabsError(data.error);
          setDetectedMonths(null);
          return;
        }
        const parsed = parseMonthTabs(data.tabs || []);
        setDetectedMonths(parsed);
        // Clear any months that are no longer in the detected set
        // (in case user changed the URL)
        update("months", []);
      })
      .catch(err => {
        if (cancelled) return;
        setTabsLoading(false);
        setTabsError(err.message || "Failed to fetch tabs");
        setDetectedMonths(null);
      });

    return () => { cancelled = true; };
  }, [config.sourceUrl]);

  // Group detected months by year
  const yearGroups = {};
  if (detectedMonths) {
    for (const dm of detectedMonths) {
      if (!yearGroups[dm.year]) yearGroups[dm.year] = new Set();
      yearGroups[dm.year].add(dm.abbr);
    }
  }
  const sortedYears = Object.keys(yearGroups).map(Number).sort();

  const toggleMonth = (abbr, year) => {
    const key = `${abbr} ${year}`;
    const months = config.months.includes(key)
      ? config.months.filter((x) => x !== key)
      : [...config.months, key];
    update("months", months);
  };

  const isMonthSelected = (abbr, year) => config.months.includes(`${abbr} ${year}`);

  const isMonthAvailable = (abbr, year) => {
    return yearGroups[year]?.has(abbr) || false;
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

        {tabsLoading && (
          <p className="section-desc"><span className="spinner" /> Detecting months from spreadsheet…</p>
        )}

        {tabsError && (
          <p className="section-desc" style={{ color: "var(--danger)" }}>
            Could not read tabs: {tabsError}
          </p>
        )}

        {!tabsLoading && !detectedMonths && !tabsError && (
          <p className="section-desc">Enter a schedule URL above to detect available months.</p>
        )}

        {!tabsLoading && detectedMonths && sortedYears.length === 0 && (
          <p className="section-desc" style={{ color: "var(--warning)" }}>
            No month tabs detected in the spreadsheet. Make sure tabs are named like "January", "Feb 2026", etc.
          </p>
        )}

        {!tabsLoading && sortedYears.length > 0 && (
          <>
            <p className="section-desc">Select the months you want to parse.</p>
            {sortedYears.map(year => (
              <div key={year} className="month-year-row">
                <span className="month-year-label">{year}</span>
                <div className="month-grid">
                  {ALL_MONTHS.map((m) => {
                    const available = isMonthAvailable(m, year);
                    return (
                      <button
                        key={`${m}-${year}`}
                        className={`month-btn ${isMonthSelected(m, year) ? "selected" : ""} ${!available ? "disabled" : ""}`}
                        onClick={() => available && toggleMonth(m, year)}
                        disabled={!available}
                        title={available ? `${m} ${year}` : `No "${m}" tab found for ${year}`}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}

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
