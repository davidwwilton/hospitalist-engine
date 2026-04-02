import { useState, useCallback } from "react";
import StepIndicator from "./components/StepIndicator";
import Step1Parse from "./components/Step1Parse";
import Step2NameReview from "./components/Step2NameReview";
import Step3Financial from "./components/Step3Financial";
import Step4Results from "./components/Step4Results";

export default function App() {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [parseConfig, setParseConfig] = useState({
    sourceUrl: "", contactSheet: "Contact Info", months: [],
    outputUrl: "",
  });

  const [parsedData, setParsedData] = useState(null);
  const [corrections, setCorrections] = useState({});

  const [financialConfig, setFinancialConfig] = useState({
    parsedUrl: "", periodType: "month", month: "",
    biweeklyStart: "", biweeklyIndex: 0,
    dateFrom: "", dateTo: "",
    baseRate: 200.10, eveningRate: 25, overnightRate: 35, holdbackPct: 2,
    outputUrl: "",
  });

  const [results, setResults] = useState(null);

  const apiPost = async (endpoint, body) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  };

  // Step 1 → parse
  const handleParse = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await apiPost("/api/parse", {
        sourceUrl: parseConfig.sourceUrl,
        contactSheet: parseConfig.contactSheet,
        months: parseConfig.months,
      });
      setParsedData(result);
      const needsReview = result.nameLog.filter(e => e.status === "REVIEW" || e.status === "UNRESOLVED");
      if (needsReview.length === 0) {
        const written = await apiPost("/api/write-parsed", { entries: result.entries, nameLog: result.nameLog, dupLog: result.dupLog, tabStructures: result.tabStructures, config: parseConfig });
        setFinancialConfig(prev => ({ ...prev, parsedUrl: written.outputUrl }));
        setStep(3);
      } else {
        setStep(2);
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [parseConfig]);

  // Step 2 → confirm names
  const handleNamesConfirmed = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // Re-apply corrections to entries
      const correctedEntries = parsedData.entries.map(e => {
        const c = corrections[e.physician_raw];
        return c ? { ...e, physician: c, name_status: "AUTO" } : e;
      });
      const written = await apiPost("/api/write-parsed", {
        entries: correctedEntries,
        nameLog: parsedData.nameLog,
        dupLog: parsedData.dupLog,
        tabStructures: parsedData.tabStructures,
        config: parseConfig,
      });
      setFinancialConfig(prev => ({ ...prev, parsedUrl: written.outputUrl }));
      setStep(3);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [parsedData, corrections, parseConfig]);

  // Step 3 → run financial engine
  const handleRunFinancials = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await apiPost("/api/financial", financialConfig);
      setResults(result);
      setStep(4);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [financialConfig]);

  const handleReset = useCallback(() => {
    setStep(1); setParsedData(null); setResults(null); setCorrections({}); setError(null);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="logo-mark">H</div>
          <div className="header-titles">
            <h1>Hospitalist Financial Engine</h1>
            <p className="header-sub">Schedule Parser + Financial Reporter</p>
          </div>
        </div>
      </header>

      <main className="app-main">
        <StepIndicator currentStep={step} />

        {error && (
          <div className="error-banner">
            <span className="error-icon">✕</span>
            <span>{error}</span>
            <button className="error-dismiss" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {step === 1 && (
          <Step1Parse config={parseConfig} onChange={setParseConfig} onNext={handleParse} loading={loading} />
        )}
        {step === 2 && parsedData && (
          <Step2NameReview
            nameLog={parsedData.nameLog} canonicalNames={parsedData.canonicalNames}
            corrections={corrections} onChange={setCorrections}
            onConfirm={handleNamesConfirmed} onBack={() => setStep(1)} loading={loading}
          />
        )}
        {step === 3 && (
          <Step3Financial
            config={financialConfig} onChange={setFinancialConfig}
            onRun={handleRunFinancials} onBack={() => setStep(parsedData ? 2 : 1)}
            loading={loading} parsedUrl={financialConfig.parsedUrl}
          />
        )}
        {step === 4 && results && (
          <Step4Results results={results} onReset={handleReset} onNewReport={() => setStep(3)} />
        )}
      </main>
    </div>
  );
}
