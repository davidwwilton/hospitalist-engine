/**
 * api/financial.js
 * Vercel serverless function — runs the financial engine using the service account.
 * POST body: { parsedUrl, periodType, month, biweeklyStart, biweeklyIndex, dateFrom, dateTo,
 *              baseRate, eveningRate, overnightRate,
 *              costSharePerHour, opHoldbackPerHour, outputUrl }
 * Returns: { kpi, physicianResults, overlapCount, periodLabel, outputUrl }
 */

import { google } from "googleapis";

const YEAR = 2026;
const MONTH_ABBR = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

// Shift definitions are now read dynamically from the parsed schedule.
// No hardcoded SHIFT_DEF_MAP needed.

function extractSheetId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error(`Invalid Google Sheets URL: ${url}`);
  return m[1];
}

function dateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function addDays(d, n) { const r=new Date(d); r.setDate(r.getDate()+n); return r; }

function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

function monthPeriod(monthName) {
  const mn = monthName.trim().toLowerCase().slice(0,3);
  const m = MONTH_ABBR[mn];
  if (!m) throw new Error(`Unknown month: ${monthName}`);
  return [new Date(YEAR,m-1,1), new Date(YEAR,m-1,daysInMonth(YEAR,m)), `${monthName} ${YEAR} (Full Month)`];
}

function biweeklyPeriods(anchorStr) {
  const anchor = new Date(anchorStr);
  const yearStart = new Date(YEAR,0,1), yearEnd = new Date(YEAR,11,31);
  let start = new Date(anchor);
  while (start > yearStart) start = addDays(start,-14);
  if (addDays(start,13) < yearStart) start = addDays(start,14);
  const periods = [];
  while (start <= yearEnd) { periods.push([new Date(start), addDays(start,13)]); start=addDays(start,14); }
  return periods;
}

function biweeklyForMonth(anchorStr, monthName) {
  const mn = monthName.trim().toLowerCase().slice(0,3);
  const m = MONTH_ABBR[mn];
  if (!m) throw new Error(`Unknown month: ${monthName}`);
  const mStart = new Date(YEAR,m-1,1), mEnd = new Date(YEAR,m-1,daysInMonth(YEAR,m));
  return biweeklyPeriods(anchorStr).filter(([s,e]) => s<=mEnd && e>=mStart);
}

function parseDateSimple(s) {
  const str = s.trim();
  // ISO format: YYYY-MM-DD (preferred — produced by the date picker in Step 3)
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return new Date(parseInt(iso[1]), parseInt(iso[2])-1, parseInt(iso[3]));
  }
  // Legacy format: D-Mon (e.g. "1-Mar") — kept for backward compatibility.
  const dm = str.match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (dm) {
    const mon = MONTH_ABBR[dm[2].toLowerCase()];
    if (!mon) return null;
    return new Date(YEAR, mon-1, parseInt(dm[1]));
  }
  return null;
}

/**
 * Detect overlapping hours between consecutive shifts for the same physician.
 * Uses Start_Hr / End_Hr from parsed schedule (extended-24 convention: if end <= start, end += 24).
 *
 * Overlap deduction rules:
 * - Overlap hours are deducted from INVOICEABLE hours of the SECOND shift only.
 * - PAYABLE hours are never affected — physicians are paid as though all hours were worked.
 * - This prevents double-invoicing the health authority for the same hour.
 */
function detectOverlaps(sorted) {
  const invoiceDeductions = {}, overlapLog = [];
  for (let i=0; i<sorted.length-1; i++) {
    const a=sorted[i], b=sorted[i+1];
    // Use extended-24 values (raw integers) for accurate overlap calculation.
    // Start_Ext24/End_Ext24 preserve the original convention (e.g. 24 = midnight, 32 = 8am next day).
    // Fall back to Start_Hr/End_Hr (clock-time strings like "00:00") for older parsed schedules.
    const aStart = a.Start_Ext24 != null && a.Start_Ext24 !== "" ? parseFloat(a.Start_Ext24) : parseFloat(a.Start_Hr);
    const aEnd   = a.End_Ext24   != null && a.End_Ext24   !== "" ? parseFloat(a.End_Ext24)   : parseFloat(a.End_Hr);
    const bStart = b.Start_Ext24 != null && b.Start_Ext24 !== "" ? parseFloat(b.Start_Ext24) : parseFloat(b.Start_Hr);
    const bEnd   = b.End_Ext24   != null && b.End_Ext24   !== "" ? parseFloat(b.End_Ext24)   : parseFloat(b.End_Hr);
    if (isNaN(aStart)||isNaN(aEnd)||isNaN(bStart)||isNaN(bEnd)) continue;

    const dateA=new Date(a.Date_ISO+"T12:00:00"), dateB=new Date(b.Date_ISO+"T12:00:00");
    const dayGap = (dateB-dateA)/(86400000);

    // Convert to absolute hours from a common reference to handle all cases:
    // A shift with start_time=24 on day N actually begins at midnight of day N+1.
    // So absolute start = dayIndex * 24 + start_time, absolute end = dayIndex * 24 + end_time.
    const aAbsEnd   = 0 + aEnd;
    const bAbsStart = dayGap * 24 + bStart;

    // Overlap exists only when shift A ends after shift B starts
    let ov = Math.max(0, aAbsEnd - bAbsStart);

    if (ov > 0) {
      // Deduct from SECOND shift's invoiceable hours only
      const kB=`${b.Date_ISO}__${b.Shift_ID}`;
      invoiceDeductions[kB] = (invoiceDeductions[kB]||0) + ov;
      overlapLog.push({ physician:a.Physician, date_a:a.Date_ISO, shift_a:a.Shift_ID, date_b:b.Date_ISO, shift_b:b.Shift_ID, overlap_hours:ov });
    }
  }
  return { invoiceDeductions, overlapLog };
}

function runPipeline(parsedRows, periodStart, periodEnd, baseRate, eveningRate, overnightRate, costSharePerHour, opHoldbackPerHour) {
  const startISO=dateISO(periodStart), endISO=dateISO(periodEnd);
  const inPeriod = parsedRows.filter(r => r.Date_ISO >= startISO && r.Date_ISO <= endISO);
  if (!inPeriod.length) return { physicianResults:{}, overlapLog:[], kpi:{} };

  const byPhysician = {};
  for (const row of inPeriod) {
    if (!byPhysician[row.Physician]) byPhysician[row.Physician]=[];
    byPhysician[row.Physician].push(row);
  }

  const physicianResults={}, allOverlapLog=[];
  for (const [phys, shifts] of Object.entries(byPhysician)) {
    // Sort by date then by shift start time.
    // IMPORTANT: use Start_Ext24 (extended-24 convention) for the tiebreaker, not
    // Start_Hr. Start_Hr is a clock-time string ("00:00", "17:00") with % 24 applied,
    // so an overnight shift whose true start is hour 24 (midnight-of-next-day) wraps
    // to "00:00" and gets sorted BEFORE a same-date day shift — which flips the
    // order the overlap detector expects and produces phantom 24-hour overlaps.
    // Extended-24 keeps the real chronological order (8 < 17 < 24 < 32).
    const startSortKey = (r) => {
      if (r.Start_Ext24 != null && r.Start_Ext24 !== "") return parseFloat(r.Start_Ext24);
      return parseFloat(r.Start_Hr) || 0;
    };
    const sorted = [...shifts].sort((a,b) => {
      if (a.Date_ISO!==b.Date_ISO) return a.Date_ISO<b.Date_ISO?-1:1;
      return startSortKey(a) - startSortKey(b);
    });

    // Detect overlapping back-to-back shifts — deduction applies to invoiceable hours only
    const { invoiceDeductions, overlapLog } = detectOverlaps(sorted);
    allOverlapLog.push(...overlapLog);

    let totPayable=0, totInvoiceable=0, totReg=0, totEve=0, totOn=0, totGross=0, totBasePay=0, totAfterHours=0, totEveBonus=0, totOnBonus=0, totWkndBonus=0, totStatBonus=0, totBasePlusAfter=0;
    let totCostShare=0, totOpHoldback=0, totTotalHoldback=0;
    let totShifts8h=0, totShifts9h=0, totShiftsOther=0, totWeekendDayHrs=0, totInvoiceableBasePay=0;
    const shiftDetails=[];
    for (const shift of sorted) {
      // Row 5 = total shift hours (paid at base rate) = payable/invoiceable hours
      // Rows 6-7 = subsets of those hours that earn additional bonus rates
      const regHrs    = parseFloat(shift.Regular_Hrs)   || 0;
      const eveHrs    = parseFloat(shift.Evening_Hrs)   || 0;
      const onHrs     = parseFloat(shift.Overnight_Hrs) || 0;
      const payableHrs = regHrs;

      // Invoiceable hours = regular hrs, minus any overlap deduction on this shift
      const ovKey = `${shift.Date_ISO}__${shift.Shift_ID}`;
      const ovDeduction = invoiceDeductions[ovKey] || 0;
      const invoiceableHrs = Math.max(0, regHrs - ovDeduction);

      const isWeekend = shift.Is_Weekend === "Y";
      const isStatHoliday = shift.Is_Stat_Holiday === "Y";

      // Base pay: regular hours × base rate (all shift hours get base rate)
      const basePay = regHrs * baseRate;

      // After-hours bonuses (evening/overnight are JUST the bonus rate, not base + bonus)
      const eveBonus = eveHrs * eveningRate;
      const onBonus  = onHrs  * overnightRate;

      // Weekend bonus: applies ONLY to pure daytime shifts on Sat/Sun/stat.
      // If a shift has any evening or overnight hours, it already earns an
      // after-hours bonus (eveBonus / onBonus), so no weekend premium is added.
      const isDaytimeShift = eveHrs === 0 && onHrs === 0;
      const weekendBonus = ((isWeekend || isStatHoliday) && isDaytimeShift) ? regHrs * eveningRate : 0;

      // Weekend Day Premium hours — the regular hours on a shift that qualify for
      // the Weekend Day Premium (daytime-only on Sat/Sun/stat). Used by the After
      // Hours Payroll tab. Variable `weekendBonus` above stays named as-is for
      // backward compatibility; only the display label is "Weekend Day Premium".
      const weekendDayHrs = ((isWeekend || isStatHoliday) && isDaytimeShift) ? regHrs : 0;

      // Invoiceable base pay — what the HA reimburses for base hours on this shift.
      // Uses invoiceableHrs (overlap-adjusted), not regHrs, so back-to-back overlap
      // isn't double-billed. The practice absorbs the overlap on physician pay.
      const shiftInvoiceableBasePay = invoiceableHrs * baseRate;

      // Stat holiday bonus: 0.5 × baseRate on all shift hours
      const statBonus = isStatHoliday ? regHrs * (0.5 * baseRate) : 0;

      // After hours = evening + overnight + weekend bonuses (stat bonus tracked separately)
      const afterHours = eveBonus + onBonus + weekendBonus;
      // Base + after hours = physician base pay plus all premium bonuses, EXCLUDING stat holiday bonus
      const basePlusAfter = basePay + afterHours;
      const gross = basePlusAfter + statBonus;

      // Per-shift holdback allocation: $/hr rates × regular (payable) hours only.
      // Applied to every shift regardless of day/evening/overnight/stat — the rule
      // is that after-hours premium pay and stat holiday bonus pay are not subject
      // to holdback, but the regular hours that earned those premiums still are.
      const shiftCostShare     = regHrs * costSharePerHour;
      const shiftOpHoldback    = regHrs * opHoldbackPerHour;
      const shiftTotalHoldback = shiftCostShare + shiftOpHoldback;

      totPayable += payableHrs; totInvoiceable += invoiceableHrs;
      totReg += regHrs; totEve += eveHrs; totOn += onHrs;
      totBasePay += basePay; totAfterHours += afterHours;
      totEveBonus += eveBonus; totOnBonus += onBonus;
      totBasePlusAfter += basePlusAfter;
      totGross += gross; totWkndBonus += weekendBonus; totStatBonus += statBonus;
      totCostShare += shiftCostShare; totOpHoldback += shiftOpHoldback; totTotalHoldback += shiftTotalHoldback;
      totWeekendDayHrs += weekendDayHrs; totInvoiceableBasePay += shiftInvoiceableBasePay;
      // 8h/9h shift bucketing for the Interim Payroll shift-count columns.
      // Any shift with regular hours other than exactly 8 or 9 goes to "other"
      // (e.g. UCC/Ward = 15, some overnight shifts, etc.).
      if (regHrs === 8) totShifts8h++;
      else if (regHrs === 9) totShifts9h++;
      else totShiftsOther++;

      shiftDetails.push({
        date: shift.Date, date_iso: shift.Date_ISO,
        shift: shift.Shift_ID, column_header: shift.Column_Header || "",
        is_weekend: isWeekend, is_stat_holiday: isStatHoliday,
        payable_hrs: payableHrs, invoiceable_hrs: invoiceableHrs,
        regular_hrs: regHrs, evening_hrs: eveHrs, overnight_hrs: onHrs,
        weekend_day_hrs: weekendDayHrs,
        base_pay: basePay, invoiceable_base_pay: shiftInvoiceableBasePay,
        eve_bonus: eveBonus, on_bonus: onBonus,
        weekend_bonus: weekendBonus, stat_bonus: statBonus,
        after_hours: afterHours, base_plus_after_hours: basePlusAfter, gross,
        cost_share: shiftCostShare, op_holdback: shiftOpHoldback, total_holdback: shiftTotalHoldback,
        overlap_deducted: ovDeduction,
      });
    }
    // Holdback is calculated as TWO per-hour deductions on REGULAR (payable) hours
    // only — Cost Share and Operational Holdback. After-hours premiums (evening,
    // overnight, weekend) and stat holiday bonus pay are not subject to either
    // deduction. Premium pay reaches the physician in full; only the regular-hours
    // portion of total compensation is reduced by holdback.
    const net = totGross - totTotalHoldback;

    // Interim and After Hours views. The practice pays physicians on two cadences:
    //   Interim (biweekly)  = base pay + stat premium − holdback  (paid by practice)
    //   After Hours (quarterly) = eve + overnight + weekend day premium  (lump sum)
    // Stat premium is NOT invoiced to the HA — it is internally redistributed from
    // the holdback pool. So the HA invoice = base pay + after hours, split into
    // two tabs by cadence. ha_interim_invoice uses invoiceable (overlap-adjusted)
    // base pay so back-to-back overlap isn't double-billed to the HA.
    const interimGross   = totBasePay + totStatBonus;
    const interimNet     = interimGross - totTotalHoldback;
    const afterHoursPay  = totAfterHours;
    const haInterimInv   = totInvoiceableBasePay;
    const haAfterHrsInv  = totAfterHours;
    const haTotalInv     = haInterimInv + haAfterHrsInv;

    physicianResults[phys] = {
      physician: phys, shift_count: shifts.length,
      shifts_8h: totShifts8h, shifts_9h: totShifts9h, shifts_other: totShiftsOther,
      payable_hrs: totPayable, invoiceable_hrs: totInvoiceable,
      regular_hrs: totReg, evening_hrs: totEve, overnight_hrs: totOn, weekend_day_hrs: totWeekendDayHrs,
      base_pay: totBasePay, invoiceable_base_pay: totInvoiceableBasePay,
      eve_bonus: totEveBonus, on_bonus: totOnBonus, weekend_bonus: totWkndBonus,
      after_hours: totAfterHours, base_plus_after_hours: totBasePlusAfter,
      stat_bonus: totStatBonus,
      gross: totGross,
      cost_share: totCostShare, op_holdback: totOpHoldback, total_holdback: totTotalHoldback,
      interim_gross: interimGross, interim_net: interimNet, after_hours_pay: afterHoursPay,
      ha_interim_invoice: haInterimInv, ha_after_hours_invoice: haAfterHrsInv, ha_total_invoice: haTotalInv,
      net, shift_details: shiftDetails,
    };
  }

  const vals = Object.values(physicianResults);
  const kpi = {
    physician_count: vals.length,
    total_regular_hrs: vals.reduce((s,p)=>s+p.regular_hrs,0),
    total_evening_hrs: vals.reduce((s,p)=>s+p.evening_hrs,0),
    total_overnight_hrs: vals.reduce((s,p)=>s+p.overnight_hrs,0),
    total_payable_hrs: vals.reduce((s,p)=>s+p.payable_hrs,0),
    total_invoiceable_hrs: vals.reduce((s,p)=>s+p.invoiceable_hrs,0),
    total_base_pay: vals.reduce((s,p)=>s+p.base_pay,0),
    total_eve_bonus: vals.reduce((s,p)=>s+p.eve_bonus,0),
    total_on_bonus: vals.reduce((s,p)=>s+p.on_bonus,0),
    total_weekend_bonus: vals.reduce((s,p)=>s+p.weekend_bonus,0),
    total_after_hours: vals.reduce((s,p)=>s+p.after_hours,0),
    total_base_plus_after_hours: vals.reduce((s,p)=>s+p.base_plus_after_hours,0),
    total_stat_bonus: vals.reduce((s,p)=>s+p.stat_bonus,0),
    total_gross: vals.reduce((s,p)=>s+p.gross,0),
    total_cost_share: vals.reduce((s,p)=>s+p.cost_share,0),
    total_op_holdback: vals.reduce((s,p)=>s+p.op_holdback,0),
    total_holdback: vals.reduce((s,p)=>s+p.total_holdback,0),
    total_net: vals.reduce((s,p)=>s+p.net,0),
    total_weekend_day_hrs: vals.reduce((s,p)=>s+p.weekend_day_hrs,0),
    total_invoiceable_base_pay: vals.reduce((s,p)=>s+p.invoiceable_base_pay,0),
    total_interim_gross: vals.reduce((s,p)=>s+p.interim_gross,0),
    total_interim_net: vals.reduce((s,p)=>s+p.interim_net,0),
    total_after_hours_pay: vals.reduce((s,p)=>s+p.after_hours_pay,0),
    total_ha_interim_invoice: vals.reduce((s,p)=>s+p.ha_interim_invoice,0),
    total_ha_after_hours_invoice: vals.reduce((s,p)=>s+p.ha_after_hours_invoice,0),
    total_ha_total_invoice: vals.reduce((s,p)=>s+p.ha_total_invoice,0),
  };
  return { physicianResults, overlapLog: allOverlapLog, kpi };
}

const fh = n => Number(n).toFixed(2);
const fm = n => `$${Number(n).toFixed(2)}`;

function getAuthClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function ensureSheet(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields:"sheets.properties.title" });
  if (!meta.data.sheets.some(s=>s.properties.title===title)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{ requests:[{ addSheet:{ properties:{ title } } }] } });
  }
}

async function writeSheet(sheets, spreadsheetId, title, headers, rows) {
  await ensureSheet(sheets, spreadsheetId, title);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range:title });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range:title, valueInputOption:"RAW",
    requestBody:{ values:[headers, ...rows.map(r=>headers.map(h=>String(r[h]??"")))]}
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error:"Method not allowed" });

  try {
    const { parsedUrl, periodType, month, biweeklyStart, biweeklyIndex=0,
            dateFrom, dateTo, baseRate=200.10, eveningRate=25, overnightRate=35,
            costSharePerHour=1.40, opHoldbackPerHour=7.45,
            outputUrl } = req.body;

    if (!parsedUrl) return res.status(400).json({ error:"parsedUrl is required" });

    // Resolve period
    let periodStart, periodEnd, periodLabel;
    if (periodType==="month") {
      if (!month) return res.status(400).json({ error:"month required" });
      [periodStart, periodEnd, periodLabel] = monthPeriod(month);
    } else if (periodType==="biweekly") {
      if (!month||!biweeklyStart) return res.status(400).json({ error:"month and biweeklyStart required" });
      const periods = biweeklyForMonth(biweeklyStart, month);
      if (!periods.length) return res.status(400).json({ error:`No biweekly periods overlap ${month}` });
      const idx = Math.min(biweeklyIndex, periods.length-1);
      [periodStart, periodEnd] = periods[idx];
      const fmt = d => d.toLocaleDateString("en-CA",{month:"short",day:"numeric"});
      periodLabel = `Biweekly ${fmt(periodStart)}–${fmt(periodEnd)} ${YEAR}`;
    } else {
      if (!dateFrom||!dateTo) return res.status(400).json({ error:"dateFrom and dateTo required" });
      periodStart = parseDateSimple(dateFrom);
      periodEnd   = parseDateSimple(dateTo);
      if (!periodStart||!periodEnd) return res.status(400).json({ error:"Could not parse date range" });
      if (periodStart > periodEnd) return res.status(400).json({ error:"'From' date must be on or before 'To' date" });
      const fmtCustom = d => d.toLocaleDateString("en-CA",{month:"short",day:"numeric"});
      periodLabel = `Custom ${fmtCustom(periodStart)}–${fmtCustom(periodEnd)} ${periodStart.getFullYear()}`;
    }

    // Load parsed schedule
    const auth = getAuthClient();
    const sheets = google.sheets({ version:"v4", auth });
    // Drive API no longer needed — output spreadsheet is always user-provided
    const sheetId = extractSheetId(parsedUrl);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId:sheetId, range:"Parsed Schedule" });
    const values = resp.data.values||[];
    if (values.length < 2) return res.status(400).json({ error:"Parsed Schedule sheet is empty." });
    const headers = values[0];
    const parsedRows = values.slice(1).filter(r=>r.some(v=>v)).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||""])));

    // Run pipeline
    const { physicianResults, overlapLog, kpi } = runPipeline(parsedRows, periodStart, periodEnd, baseRate, eveningRate, overnightRate, costSharePerHour, opHoldbackPerHour);
    if (!Object.keys(physicianResults).length) return res.status(400).json({ error:`No shifts found in period ${dateISO(periodStart)}–${dateISO(periodEnd)}. Check the parsed schedule covers this date range.` });

    // Open output sheet
    if (!outputUrl) return res.status(400).json({ error: "Output spreadsheet URL is required." });
    const outputSheetId = extractSheetId(outputUrl);

    const rates = { base:baseRate, eve:eveningRate, on:overnightRate, costShare:costSharePerHour, opHoldback:opHoldbackPerHour };

    // Reconciliation check: Interim Gross + After Hours Pay should equal Total Gross.
    // True by construction (interim = base + stat, after = eve + on + weekend day premium;
    // gross = all four) — shown on KPI Summary as a sanity audit line.
    const reconDelta = Math.abs((kpi.total_interim_gross + kpi.total_after_hours_pay) - kpi.total_gross);
    const reconCheck = reconDelta < 0.01 ? "✓ Matches" : `✗ Delta ${fm(reconDelta)}`;

    // KPI
    await writeSheet(sheets, outputSheetId, "KPI Summary", ["KPI","Value"], [
      {KPI:"Pay Period",Value:periodLabel},
      {KPI:"---",Value:""},
      {KPI:"— Rates —",Value:""},
      {KPI:"Base Rate",Value:fm(rates.base)},
      {KPI:"Evening Premium Rate",Value:fm(rates.eve)},
      {KPI:"Overnight Premium Rate",Value:fm(rates.on)},
      {KPI:"Cost Share Rate",Value:`${fm(rates.costShare)}/hr`},
      {KPI:"Op Holdback Rate",Value:`${fm(rates.opHoldback)}/hr`},
      {KPI:"---",Value:""},
      {KPI:"— Hour Counts —",Value:""},
      {KPI:"Physician Count",Value:String(kpi.physician_count)},
      {KPI:"Total Regular Hours",Value:fh(kpi.total_regular_hrs)},
      {KPI:"Total Evening Premium Hours",Value:fh(kpi.total_evening_hrs)},
      {KPI:"Total Overnight Premium Hours",Value:fh(kpi.total_overnight_hrs)},
      {KPI:"Total Weekend Day Premium Hours",Value:fh(kpi.total_weekend_day_hrs)},
      {KPI:"Total Payable Hours",Value:fh(kpi.total_payable_hrs)},
      {KPI:"Total Invoiceable Hours",Value:fh(kpi.total_invoiceable_hrs)},
      {KPI:"---",Value:""},
      {KPI:"— Pay Components —",Value:""},
      {KPI:"Total Base Pay",Value:fm(kpi.total_base_pay)},
      {KPI:"Total Evening Premium Pay",Value:fm(kpi.total_eve_bonus)},
      {KPI:"Total Overnight Premium Pay",Value:fm(kpi.total_on_bonus)},
      {KPI:"Total Weekend Day Premium",Value:fm(kpi.total_weekend_bonus)},
      {KPI:"Total After Hours Pay",Value:fm(kpi.total_after_hours)},
      {KPI:"Total Stat Holiday Premium",Value:fm(kpi.total_stat_bonus)},
      {KPI:"Total Gross Pay",Value:fm(kpi.total_gross)},
      {KPI:"---",Value:""},
      {KPI:"— Interim Payroll —",Value:""},
      {KPI:"Total Interim Gross (Base + Stat Premium)",Value:fm(kpi.total_interim_gross)},
      {KPI:"Total Cost Share",Value:fm(kpi.total_cost_share)},
      {KPI:"Total Op Holdback",Value:fm(kpi.total_op_holdback)},
      {KPI:"Total Holdback",Value:fm(kpi.total_holdback)},
      {KPI:"Total Interim Net",Value:fm(kpi.total_interim_net)},
      {KPI:"---",Value:""},
      {KPI:"— After Hours Payroll —",Value:""},
      {KPI:"Total After Hours Payout",Value:fm(kpi.total_after_hours_pay)},
      {KPI:"---",Value:""},
      {KPI:"— HA Invoice (excludes Stat Premium) —",Value:""},
      {KPI:"HA Invoice – Interim (Base only)",Value:fm(kpi.total_ha_interim_invoice)},
      {KPI:"HA Invoice – After Hours",Value:fm(kpi.total_ha_after_hours_invoice)},
      {KPI:"HA Invoice – Total",Value:fm(kpi.total_ha_total_invoice)},
      {KPI:"Stat Premium (funded internally, not invoiced to HA)",Value:fm(kpi.total_stat_bonus)},
      {KPI:"---",Value:""},
      {KPI:"— Physician Net Payout —",Value:""},
      {KPI:"Total Net Payout (Interim Net + After Hours)",Value:fm(kpi.total_net)},
      {KPI:"---",Value:""},
      {KPI:"— Reconciliation —",Value:""},
      {KPI:"Interim Gross + After Hours = Gross?",Value:reconCheck},
    ]);

    // Sorted list of physicians — reused by every writeSheet below.
    const sortedPhys = Object.values(physicianResults).sort((a,b)=>a.physician.localeCompare(b.physician));

    // Interim Payroll — biweekly pay run. Pays physicians for base hours + stat
    // premium less the two holdbacks. After-hours premiums are NOT in this tab.
    const interimRows = sortedPhys.map(p=>({
      Physician:p.physician,
      "8h_Shifts":String(p.shifts_8h), "9h_Shifts":String(p.shifts_9h), Other_Shifts:String(p.shifts_other),
      Regular_Hrs:fh(p.regular_hrs),
      Base_Pay:fm(p.base_pay), Stat_Premium:fm(p.stat_bonus), Interim_Gross:fm(p.interim_gross),
      Cost_Share:fm(p.cost_share), Op_Holdback:fm(p.op_holdback), Total_Holdback:fm(p.total_holdback),
      Interim_Net:fm(p.interim_net),
    }));
    await writeSheet(sheets, outputSheetId, "Interim Payroll",
      ["Physician","8h_Shifts","9h_Shifts","Other_Shifts","Regular_Hrs","Base_Pay","Stat_Premium","Interim_Gross","Cost_Share","Op_Holdback","Total_Holdback","Interim_Net"], interimRows);

    // HA Invoice – Interim — base pay only, overlap-adjusted. Excludes stat premium
    // (internally redistributed from holdback pool, not billable to the HA).
    const haInterimRows = sortedPhys.map(p=>({
      Physician:p.physician,
      Invoiceable_Hrs:fh(p.invoiceable_hrs),
      Base_Invoice_Amount:fm(p.ha_interim_invoice),
    }));
    await writeSheet(sheets, outputSheetId, "HA Invoice – Interim",
      ["Physician","Invoiceable_Hrs","Base_Invoice_Amount"], haInterimRows);

    // After Hours Payroll — quarterly premium lump-sum pay. Paid to physicians
    // once HA funds clear. No holdback applies to these amounts.
    const afterHoursRows = sortedPhys.map(p=>({
      Physician:p.physician,
      Evening_Hrs:fh(p.evening_hrs), Overnight_Hrs:fh(p.overnight_hrs), Weekend_Day_Hrs:fh(p.weekend_day_hrs),
      Total_After_Hrs:fh(p.evening_hrs + p.overnight_hrs + p.weekend_day_hrs),
      Eve_Premium:fm(p.eve_bonus), ON_Premium:fm(p.on_bonus), Weekend_Day_Premium:fm(p.weekend_bonus),
      After_Hours_Total:fm(p.after_hours_pay),
    }));
    await writeSheet(sheets, outputSheetId, "After Hours Payroll",
      ["Physician","Evening_Hrs","Overnight_Hrs","Weekend_Day_Hrs","Total_After_Hrs","Eve_Premium","ON_Premium","Weekend_Day_Premium","After_Hours_Total"], afterHoursRows);

    // HA Invoice – After Hours — premium pay invoiced to HA quarterly.
    const haAfterHoursRows = sortedPhys.map(p=>({
      Physician:p.physician,
      Evening_Hrs:fh(p.evening_hrs), Overnight_Hrs:fh(p.overnight_hrs), Weekend_Day_Hrs:fh(p.weekend_day_hrs),
      Eve_Premium:fm(p.eve_bonus), ON_Premium:fm(p.on_bonus), Weekend_Day_Premium:fm(p.weekend_bonus),
      After_Hours_Invoice_Amount:fm(p.ha_after_hours_invoice),
    }));
    await writeSheet(sheets, outputSheetId, "HA Invoice – After Hours",
      ["Physician","Evening_Hrs","Overnight_Hrs","Weekend_Day_Hrs","Eve_Premium","ON_Premium","Weekend_Day_Premium","After_Hours_Invoice_Amount"], haAfterHoursRows);

    // Payroll Summary — comprehensive per-physician view with every pay component
    // in one place. Kept as the audit/reference tab; the new Interim Payroll and
    // After Hours Payroll tabs are the cleaner day-to-day views.
    const payRows = sortedPhys.map(p=>({ Physician:p.physician, Shift_Count:p.shift_count, Payable_Hrs:fh(p.payable_hrs), Invoiceable_Hrs:fh(p.invoiceable_hrs), Evening_Premium_Hrs:fh(p.evening_hrs), Overnight_Premium_Hrs:fh(p.overnight_hrs), Base_Pay:fm(p.base_pay), Eve_Premium:fm(p.eve_bonus), ON_Premium:fm(p.on_bonus), Weekend_Day_Premium:fm(p.weekend_bonus), After_Hours:fm(p.after_hours), Base_Plus_After_Hrs:fm(p.base_plus_after_hours), Stat_Premium:fm(p.stat_bonus), Gross_Pay:fm(p.gross), Cost_Share:fm(p.cost_share), Op_Holdback:fm(p.op_holdback), Total_Holdback:fm(p.total_holdback), Net_Pay:fm(p.net) }));
    await writeSheet(sheets, outputSheetId, "Payroll Summary", ["Physician","Shift_Count","Payable_Hrs","Invoiceable_Hrs","Evening_Premium_Hrs","Overnight_Premium_Hrs","Base_Pay","Eve_Premium","ON_Premium","Weekend_Day_Premium","After_Hours","Base_Plus_After_Hrs","Stat_Premium","Gross_Pay","Cost_Share","Op_Holdback","Total_Holdback","Net_Pay"], payRows);

    // Physician Detail
    const detRows = [];
    for (const phys of Object.keys(physicianResults).sort()) {
      const p=physicianResults[phys];
      for (const sd of p.shift_details) detRows.push({ Physician:p.physician, Date:sd.date, Shift:sd.shift, Column:sd.column_header, Weekend:sd.is_weekend?"Y":"", Stat_Holiday:sd.is_stat_holiday?"Y":"", Payable_Hrs:fh(sd.payable_hrs), Invoiceable_Hrs:fh(sd.invoiceable_hrs), Eve_Premium_Hrs:fh(sd.evening_hrs), ON_Premium_Hrs:fh(sd.overnight_hrs), Base_Pay:fm(sd.base_pay), Eve_Premium:fm(sd.eve_bonus), ON_Premium:fm(sd.on_bonus), Weekend_Day_Premium:fm(sd.weekend_bonus), After_Hours:fm(sd.after_hours), Base_Plus_After_Hrs:fm(sd.base_plus_after_hours), Stat_Premium:fm(sd.stat_bonus), Gross:fm(sd.gross), Cost_Share:fm(sd.cost_share), Op_Holdback:fm(sd.op_holdback), Total_Holdback:fm(sd.total_holdback), Overlap_Deducted:fh(sd.overlap_deducted) });
    }
    await writeSheet(sheets, outputSheetId, "Physician Detail", ["Physician","Date","Shift","Column","Weekend","Stat_Holiday","Payable_Hrs","Invoiceable_Hrs","Eve_Premium_Hrs","ON_Premium_Hrs","Base_Pay","Eve_Premium","ON_Premium","Weekend_Day_Premium","After_Hours","Base_Plus_After_Hrs","Stat_Premium","Gross","Cost_Share","Op_Holdback","Total_Holdback","Overlap_Deducted"], detRows);

    // Overlap Log
    if (overlapLog.length) await writeSheet(sheets, outputSheetId, "Overlap Log", ["physician","date_a","shift_a","date_b","shift_b","overlap_hours"], overlapLog);

    const finalUrl = `https://docs.google.com/spreadsheets/d/${outputSheetId}`;

    res.status(200).json({
      kpi, physicianResults,
      overlapCount: overlapLog.length,
      periodLabel,
      periodStart: dateISO(periodStart),
      periodEnd:   dateISO(periodEnd),
      outputUrl: finalUrl,
    });

  } catch (e) {
    console.error("Financial error:", e);
    res.status(500).json({ error: e.message });
  }
}
