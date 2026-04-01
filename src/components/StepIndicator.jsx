// StepIndicator.jsx
export default function StepIndicator({ currentStep }) {
  const steps = [
    { n: 1, label: "Parse Schedule" },
    { n: 2, label: "Review Names" },
    { n: 3, label: "Financial Config" },
    { n: 4, label: "Results" },
  ];

  return (
    <div className="step-indicator">
      {steps.map((s, i) => (
        <div key={s.n} className="step-item">
          <div className={`step-dot ${currentStep === s.n ? "active" : currentStep > s.n ? "done" : ""}`}>
            {currentStep > s.n ? "✓" : s.n}
          </div>
          <span className={`step-label ${currentStep === s.n ? "active" : ""}`}>{s.label}</span>
          {i < steps.length - 1 && <div className={`step-line ${currentStep > s.n ? "done" : ""}`} />}
        </div>
      ))}
    </div>
  );
}
