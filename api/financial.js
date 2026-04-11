/**
 * api/financial.js
 * Vercel serverless function — runs the financial engine using the service account.
 * POST body: { parsedUrl, periodType, month, biweeklyStart, biweeklyIndex, dateFrom, dateTo,
 *              baseRate, eveningRate, overnightRate, holdbackPct, outputUrl }
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
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const mon = MONTH_ABBR[m[2].toLowerCase()];
  if (!mon) return null;
  return new Date(YEAR, mon-1, parseInt(m[1]));
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

function runPipeline(parsedRows, periodStart, periodEnd, baseRate, eveningRate, overnightRate, holdbackPct) {
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

      // Stat holiday bonus: 0.5 × baseRate on all shift hours
      const statBonus = isStatHoliday ? regHrs * (0.5 * baseRate) : 0;

      // After hours = evening + overnight + weekend bonuses (stat bonus tracked separately)
      const afterHours = eveBonus + onBonus + weekendBonus;
      // Base + after hours = physician base pay plus all premium bonuses, EXCLUDING stat holiday bonus
      const basePlusAfter = basePay + afterHours;
      const gross = basePlusAfter + statBonus;

      totPayable += payableHrs; totInvoiceable += invoiceableHrs;
      totReg += regHrs; totEve += eveHrs; totOn += onHrs;
      totBasePay += basePay; totAfterHours += afterHours;
      totEveBonus += eveBonus; totOnBonus += onBonus;
      totBasePlusAfter += basePlusAfter;
      totGross += gross; totWkndBonus += weekendBonus; totStatBonus += statBonus;

      shiftDetails.push({
        date: shift.Date, date_iso: shift.Date_ISO,
        shift: shift.Shift_ID, column_header: shift.Column_Header || "",
        is_weekend: isWeekend, is_stat_holiday: isStatHoliday,
        payable_hrs: payableHrs, invoiceable_hrs: invoiceableHrs,
        regular_hrs: regHrs, evening_hrs: eveHrs, overnight_hrs: onHrs,
        base_pay: basePay, eve_bonus: eveBonus, on_bonus: onBonus,
        weekend_bonus: weekendBonus, stat_bonus: statBonus,
        after_hours: afterHours, base_plus_after_hours: basePlusAfter, gross,
        overlap_deducted: ovDeduction,
      });
    }
    // Holdback is calculated on BASE PAY only — not on after-hours bonuses
    // (evening/overnight/weekend) and not on stat holiday bonus. This reflects
    // the policy that premium pay should reach the physician in full, and only
    // the regular-hours portion of compensation is subject to holdback.
    const holdback = totBasePay * (holdbackPct/100), net = totGross - holdback;
    physicianResults[phys] = {
      physician: phys, shift_count: shifts.length,
      payable_hrs: totPayable, invoiceable_hrs: totInvoiceable,
      regular_hrs: totReg, evening_hrs: totEve, overnight_hrs: totOn,
      base_pay: totBasePay,
      eve_bonus: totEveBonus, on_bonus: totOnBonus, weekend_bonus: totWkndBonus,
      after_hours: totAfterHours, base_plus_after_hours: totBasePlusAfter,
      stat_bonus: totStatBonus,
      gross: totGross, holdback, net, shift_details: shiftDetails,
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
    total_holdback: vals.reduce((s,p)=>s+p.holdback,0),
    total_net: vals.reduce((s,p)=>s+p.net,0),
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
            dateFrom, dateTo, baseRate=200.10, eveningRate=25, overnightRate=35, holdbackPct=2,
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
      periodLabel = `Custom ${dateFrom}–${dateTo}`;
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
    const { physicianResults, overlapLog, kpi } = runPipeline(parsedRows, periodStart, periodEnd, baseRate, eveningRate, overnightRate, holdbackPct);
    if (!Object.keys(physicianResults).length) return res.status(400).json({ error:`No shifts found in period ${dateISO(periodStart)}–${dateISO(periodEnd)}. Check the parsed schedule covers this date range.` });

    // Open output sheet
    if (!outputUrl) return res.status(400).json({ error: "Output spreadsheet URL is required." });
    const outputSheetId = extractSheetId(outputUrl);

    const rates = { base:baseRate, eve:eveningRate, on:overnightRate, holdback:holdbackPct };

    // KPI
    await writeSheet(sheets, outputSheetId, "KPI Summary", ["KPI","Value"], [
      {KPI:"Pay Period",Value:periodLabel}, {KPI:"Base Rate",Value:fm(rates.base)},
      {KPI:"Evening Bonus Rate",Value:fm(rates.eve)}, {KPI:"Overnight Bonus Rate",Value:fm(rates.on)},
      {KPI:"Holdback %",Value:`${rates.holdback}%`}, {KPI:"---",Value:""},
      {KPI:"Physician Count",Value:String(kpi.physician_count)},
      {KPI:"Total Regular Hours",Value:fh(kpi.total_regular_hrs)},
      {KPI:"Total Evening Hours",Value:fh(kpi.total_evening_hrs)},
      {KPI:"Total Overnight Hours",Value:fh(kpi.total_overnight_hrs)},
      {KPI:"Total Payable Hours",Value:fh(kpi.total_payable_hrs)},
      {KPI:"Total Invoiceable Hours",Value:fh(kpi.total_invoiceable_hrs)},
      {KPI:"---",Value:""},
      {KPI:"Total Base Pay",Value:fm(kpi.total_base_pay)},
      {KPI:"Total Evening Bonus Pay",Value:fm(kpi.total_eve_bonus)},
      {KPI:"Total Overnight Bonus Pay",Value:fm(kpi.total_on_bonus)},
      {KPI:"Total Weekend Bonus Pay",Value:fm(kpi.total_weekend_bonus)},
      {KPI:"Total After Hours Pay",Value:fm(kpi.total_after_hours)},
      {KPI:"Total Base + After Hours",Value:fm(kpi.total_base_plus_after_hours)},
      {KPI:"Total Stat Holiday Bonus",Value:fm(kpi.total_stat_bonus)},
      {KPI:"Total Gross Pay",Value:fm(kpi.total_gross)},
      {KPI:"Total Holdback",Value:fm(kpi.total_holdback)},
      {KPI:"Total Net Payout",Value:fm(kpi.total_net)},
    ]);

    // Payroll Summary
    const payRows = Object.values(physicianResults).sort((a,b)=>a.physician.localeCompare(b.physician)).map(p=>({ Physician:p.physician, Shift_Count:p.shift_count, Payable_Hrs:fh(p.payable_hrs), Invoiceable_Hrs:fh(p.invoiceable_hrs), Evening_Bonus_Hrs:fh(p.evening_hrs), Overnight_Bonus_Hrs:fh(p.overnight_hrs), Base_Pay:fm(p.base_pay), Eve_Bonus:fm(p.eve_bonus), ON_Bonus:fm(p.on_bonus), Weekend_Bonus:fm(p.weekend_bonus), After_Hours:fm(p.after_hours), Base_Plus_After_Hrs:fm(p.base_plus_after_hours), Stat_Bonus:fm(p.stat_bonus), Gross_Pay:fm(p.gross), Holdback:fm(p.holdback), Net_Pay:fm(p.net) }));
    await writeSheet(sheets, outputSheetId, "Payroll Summary", ["Physician","Shift_Count","Payable_Hrs","Invoiceable_Hrs","Evening_Bonus_Hrs","Overnight_Bonus_Hrs","Base_Pay","Eve_Bonus","ON_Bonus","Weekend_Bonus","After_Hours","Base_Plus_After_Hrs","Stat_Bonus","Gross_Pay","Holdback","Net_Pay"], payRows);

    // HA Invoice
    const invRows = Object.values(physicianResults).sort((a,b)=>a.physician.localeCompare(b.physician)).map(p=>({ Physician:p.physician, Invoiceable_Hrs:fh(p.invoiceable_hrs), Base_Pay:fm(p.base_pay), Eve_Bonus:fm(p.eve_bonus), ON_Bonus:fm(p.on_bonus), Weekend_Bonus:fm(p.weekend_bonus), After_Hours:fm(p.after_hours), Base_Plus_After_Hrs:fm(p.base_plus_after_hours), Stat_Bonus:fm(p.stat_bonus), Invoice_Amount:fm(p.gross) }));
    await writeSheet(sheets, outputSheetId, "HA Invoice", ["Physician","Invoiceable_Hrs","Base_Pay","Eve_Bonus","ON_Bonus","Weekend_Bonus","After_Hours","Base_Plus_After_Hrs","Stat_Bonus","Invoice_Amount"], invRows);

    // Physician Detail
    const detRows = [];
    for (const phys of Object.keys(physicianResults).sort()) {
      const p=physicianResults[phys];
      for (const sd of p.shift_details) detRows.push({ Physician:p.physician, Date:sd.date, Shift:sd.shift, Column:sd.column_header, Weekend:sd.is_weekend?"Y":"", Stat_Holiday:sd.is_stat_holiday?"Y":"", Payable_Hrs:fh(sd.payable_hrs), Invoiceable_Hrs:fh(sd.invoiceable_hrs), Eve_Bonus_Hrs:fh(sd.evening_hrs), ON_Bonus_Hrs:fh(sd.overnight_hrs), Base_Pay:fm(sd.base_pay), Eve_Bonus:fm(sd.eve_bonus), ON_Bonus:fm(sd.on_bonus), Weekend_Bonus:fm(sd.weekend_bonus), After_Hours:fm(sd.after_hours), Base_Plus_After_Hrs:fm(sd.base_plus_after_hours), Stat_Bonus:fm(sd.stat_bonus), Gross:fm(sd.gross), Overlap_Deducted:fh(sd.overlap_deducted) });
    }
    await writeSheet(sheets, outputSheetId, "Physician Detail", ["Physician","Date","Shift","Column","Weekend","Stat_Holiday","Payable_Hrs","Invoiceable_Hrs","Eve_Bonus_Hrs","ON_Bonus_Hrs","Base_Pay","Eve_Bonus","ON_Bonus","Weekend_Bonus","After_Hours","Base_Plus_After_Hrs","Stat_Bonus","Gross","Overlap_Deducted"], detRows);

    // Overlap Log
    if (overlapLog.length) await writeSheet(sheets, outputSheetId, "Overlap Log", ["physician","date_a","shift_a","date_b","shift_b","overlap_hours"], overlapLog);

    const finalUrl = `https://docs.google.com/spreadsheets/d/${outputSheetId}`;

    res.status(200).json({ kpi, physicianResults, overlapCount:overlapLog.length, periodLabel, outputUrl:finalUrl });

  } catch (e) {
    console.error("Financial error:", e);
    res.status(500).json({ error: e.message });
  }
}
