/**
 * api/financial.js
 * Vercel serverless function — runs the financial engine using the service account.
 * POST body: { parsedUrl, periodType, month, biweeklyStart, biweeklyIndex, dateFrom, dateTo,
 *              baseRate, eveningRate, overnightRate, holdbackPct, outputUrl, shareEmail, createNew }
 * Returns: { kpi, physicianResults, overlapCount, periodLabel, outputUrl }
 */

import { google } from "googleapis";

const YEAR = 2026;
const MONTH_ABBR = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

const SHIFT_DEF_MAP = {
  LB8A:      { start:8,  end:17, payable:9, invoiceable:9 },
  SURGE:     { start:8,  end:17, payable:9, invoiceable:9 },
  INTAKE1:   { start:8,  end:17, payable:9, invoiceable:9 },
  INTAKE2:   { start:8,  end:17, payable:9, invoiceable:9 },
  WARD:      { start:8,  end:17, payable:9, invoiceable:9 },
  ER_EVE:    { start:16, end:25, payable:9, invoiceable:9 },
  WARD_EVE:  { start:17, end:25, payable:8, invoiceable:8 },
  HOME_CALL: { start:24, end:32, payable:8, invoiceable:8, afterHoursOverride:{eveningHours:0,overnightHours:0} },
  UCC_WARD:  { start:17, end:32, payable:9, invoiceable:9, afterHoursOverride:{eveningHours:4,overnightHours:0} },
};

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

function overlapHrs(s1,e1,s2,e2) { return Math.max(0, Math.min(e1,e2)-Math.max(s1,s2)); }

function computeAfterHours(shiftId, payableHrs, overlapDeduction=0) {
  const defn = SHIFT_DEF_MAP[shiftId];
  if (!defn) return { eveHrs:0, onHrs:0, regHrs:payableHrs, adjPayable:payableHrs };
  const adjPayable = Math.max(0, payableHrs - overlapDeduction);
  let eveHrsFull, onHrsFull;
  if (defn.afterHoursOverride) {
    eveHrsFull = defn.afterHoursOverride.eveningHours;
    onHrsFull  = defn.afterHoursOverride.overnightHours;
  } else {
    eveHrsFull = overlapHrs(defn.start, defn.end, 18, 24);
    onHrsFull  = overlapHrs(defn.start, defn.end, 24, 32);
  }
  const scale = defn.payable > 0 ? adjPayable/defn.payable : 1;
  const eveHrs = eveHrsFull*scale, onHrs = onHrsFull*scale;
  return { eveHrs, onHrs, regHrs: adjPayable-eveHrs-onHrs, adjPayable };
}

function detectOverlaps(sorted) {
  const deductions = {}, overlapLog = [];
  for (let i=0; i<sorted.length-1; i++) {
    const a=sorted[i], b=sorted[i+1];
    const da=SHIFT_DEF_MAP[a.Shift_ID]||{}, db=SHIFT_DEF_MAP[b.Shift_ID]||{};
    if ((da.end||0)<=24) continue;
    const dateA=new Date(a.Date_ISO+"T12:00:00"), dateB=new Date(b.Date_ISO+"T12:00:00");
    if ((dateB-dateA)/(86400000)!==1) continue;
    const aRunsUntil=da.end-24;
    const bStarts=Math.max(0, (db.start||0)>=24 ? db.start-24 : db.start||0);
    const ov=Math.max(0, aRunsUntil-bStarts);
    if (ov>0) {
      const kA=`${a.Date_ISO}__${a.Shift_ID}`, kB=`${b.Date_ISO}__${b.Shift_ID}`;
      deductions[kA]=(deductions[kA]||0)+ov;
      deductions[kB]=(deductions[kB]||0)+ov;
      overlapLog.push({ physician:a.Physician, date_a:a.Date_ISO, shift_a:a.Shift_ID, date_b:b.Date_ISO, shift_b:b.Shift_ID, overlap_hours:ov });
    }
  }
  return { deductions, overlapLog };
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
    const sorted = [...shifts].sort((a,b) => {
      if (a.Date_ISO!==b.Date_ISO) return a.Date_ISO<b.Date_ISO?-1:1;
      return (SHIFT_DEF_MAP[a.Shift_ID]?.start||0)-(SHIFT_DEF_MAP[b.Shift_ID]?.start||0);
    });
    const { deductions, overlapLog } = detectOverlaps(sorted);
    allOverlapLog.push(...overlapLog);

    let totPayable=0, totInvoiceable=0, totReg=0, totEve=0, totOn=0, totGross=0;
    const shiftDetails=[];
    for (const shift of sorted) {
      const defn=SHIFT_DEF_MAP[shift.Shift_ID]||{};
      const payableHrs=parseFloat(shift.Payable_Hrs)||(defn.payable||0);
      const invoiceableHrs=parseFloat(shift.Invoiceable_Hrs)||(defn.invoiceable||0);
      const ovKey=`${shift.Date_ISO}__${shift.Shift_ID}`;
      const ovDeduction=deductions[ovKey]||0;
      const { eveHrs, onHrs, regHrs, adjPayable } = computeAfterHours(shift.Shift_ID, payableHrs, ovDeduction);
      const basePay=regHrs*baseRate, evePay=eveHrs*eveningRate, onPay=onHrs*overnightRate, gross=basePay+evePay+onPay;
      totPayable+=adjPayable; totInvoiceable+=invoiceableHrs; totReg+=regHrs; totEve+=eveHrs; totOn+=onHrs; totGross+=gross;
      shiftDetails.push({ date:shift.Date, date_iso:shift.Date_ISO, shift:shift.Shift_ID, column_header:shift.Column_Header||"", payable_hrs:adjPayable, invoiceable_hrs:invoiceableHrs, regular_hrs:regHrs, evening_hrs:eveHrs, overnight_hrs:onHrs, base_pay:basePay, eve_pay:evePay, on_pay:onPay, gross, overlap_deducted:ovDeduction });
    }
    const holdback=totGross*(holdbackPct/100), net=totGross-holdback;
    physicianResults[phys]={ physician:phys, shift_count:shifts.length, payable_hrs:totPayable, invoiceable_hrs:totInvoiceable, regular_hrs:totReg, evening_hrs:totEve, overnight_hrs:totOn, gross:totGross, holdback, net, shift_details:shiftDetails };
  }

  const vals = Object.values(physicianResults);
  const kpi = {
    physician_count: vals.length,
    total_regular_hrs: vals.reduce((s,p)=>s+p.regular_hrs,0),
    total_evening_hrs: vals.reduce((s,p)=>s+p.evening_hrs,0),
    total_overnight_hrs: vals.reduce((s,p)=>s+p.overnight_hrs,0),
    total_payable_hrs: vals.reduce((s,p)=>s+p.payable_hrs,0),
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
    scopes: ["https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/drive"],
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
            dateFrom, dateTo, baseRate=150, eveningRate=25, overnightRate=35, holdbackPct=15,
            outputUrl, shareEmail, createNew=true } = req.body;

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
    const drive  = google.drive({ version:"v3", auth });
    const sheetId = extractSheetId(parsedUrl);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId:sheetId, range:"Parsed Schedule" });
    const values = resp.data.values||[];
    if (values.length < 2) return res.status(400).json({ error:"Parsed Schedule sheet is empty." });
    const headers = values[0];
    const parsedRows = values.slice(1).filter(r=>r.some(v=>v)).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||""])));

    // Run pipeline
    const { physicianResults, overlapLog, kpi } = runPipeline(parsedRows, periodStart, periodEnd, baseRate, eveningRate, overnightRate, holdbackPct);
    if (!Object.keys(physicianResults).length) return res.status(400).json({ error:`No shifts found in period ${dateISO(periodStart)}–${dateISO(periodEnd)}. Check the parsed schedule covers this date range.` });

    // Create/open output sheet
    let outputSheetId;
    if (!createNew && outputUrl) {
      outputSheetId = extractSheetId(outputUrl);
    } else {
      const created = await sheets.spreadsheets.create({ requestBody:{ properties:{ title:`Hospitalist Financial Report — ${periodLabel}` } } });
      outputSheetId = created.data.spreadsheetId;
      if (shareEmail) { try { await drive.permissions.create({ fileId:outputSheetId, requestBody:{ type:"user",role:"writer",emailAddress:shareEmail } }); } catch {} }
    }

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
      {KPI:"Total Gross Pay",Value:fm(kpi.total_gross)},
      {KPI:"Total Holdback",Value:fm(kpi.total_holdback)},
      {KPI:"Total Net Payout",Value:fm(kpi.total_net)},
    ]);

    // Payroll Summary
    const payRows = Object.values(physicianResults).sort((a,b)=>a.physician.localeCompare(b.physician)).map(p=>({ Physician:p.physician, Shift_Count:p.shift_count, Payable_Hrs:fh(p.payable_hrs), Invoiceable_Hrs:fh(p.invoiceable_hrs), Regular_Hrs:fh(p.regular_hrs), Evening_Hrs:fh(p.evening_hrs), Overnight_Hrs:fh(p.overnight_hrs), Gross_Pay:fm(p.gross), Holdback:fm(p.holdback), Net_Pay:fm(p.net) }));
    await writeSheet(sheets, outputSheetId, "Payroll Summary", ["Physician","Shift_Count","Payable_Hrs","Invoiceable_Hrs","Regular_Hrs","Evening_Hrs","Overnight_Hrs","Gross_Pay","Holdback","Net_Pay"], payRows);

    // HA Invoice
    const invRows = Object.values(physicianResults).sort((a,b)=>a.physician.localeCompare(b.physician)).map(p=>({ Physician:p.physician, Invoiceable_Hrs:fh(p.invoiceable_hrs), Regular_Hrs:fh(p.regular_hrs), Evening_Hrs:fh(p.evening_hrs), Overnight_Hrs:fh(p.overnight_hrs), Invoice_Amount:fm(p.gross) }));
    await writeSheet(sheets, outputSheetId, "HA Invoice", ["Physician","Invoiceable_Hrs","Regular_Hrs","Evening_Hrs","Overnight_Hrs","Invoice_Amount"], invRows);

    // Physician Detail
    const detRows = [];
    for (const phys of Object.keys(physicianResults).sort()) {
      const p=physicianResults[phys];
      for (const sd of p.shift_details) detRows.push({ Physician:p.physician, Date:sd.date, Shift:sd.shift, Column:sd.column_header, Payable_Hrs:fh(sd.payable_hrs), Invoiceable_Hrs:fh(sd.invoiceable_hrs), Regular_Hrs:fh(sd.regular_hrs), Evening_Hrs:fh(sd.evening_hrs), Overnight_Hrs:fh(sd.overnight_hrs), Base_Pay:fm(sd.base_pay), Evening_Pay:fm(sd.eve_pay), Overnight_Pay:fm(sd.on_pay), Gross:fm(sd.gross), Overlap_Deducted:fh(sd.overlap_deducted) });
    }
    await writeSheet(sheets, outputSheetId, "Physician Detail", ["Physician","Date","Shift","Column","Payable_Hrs","Invoiceable_Hrs","Regular_Hrs","Evening_Hrs","Overnight_Hrs","Base_Pay","Evening_Pay","Overnight_Pay","Gross","Overlap_Deducted"], detRows);

    // Overlap Log
    if (overlapLog.length) await writeSheet(sheets, outputSheetId, "Overlap Log", ["physician","date_a","shift_a","date_b","shift_b","overlap_hours"], overlapLog);

    const finalUrl = `https://docs.google.com/spreadsheets/d/${outputSheetId}`;
    res.status(200).json({ kpi, physicianResults, overlapCount:overlapLog.length, periodLabel, outputUrl:finalUrl });

  } catch (e) {
    console.error("Financial error:", e);
    res.status(500).json({ error: e.message });
  }
}
