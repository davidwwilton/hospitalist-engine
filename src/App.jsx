import { useState, useCallback, useMemo, useEffect } from "react";

// ─── GOOGLE SHEETS API ────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
const SPREADSHEET_ID   = import.meta.env.VITE_SPREADSHEET_ID ?? "1x66lXt_H69w_MZcK7z2CrlcX2DpR1j8GqogvYLMgaCc";
const SHEETS_SCOPE     = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_API_BASE  = "https://sheets.googleapis.com/v4/spreadsheets";

function loadGISScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function fetchSheetNames(accessToken) {
  const url = `${SHEETS_API_BASE}/${SPREADSHEET_ID}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.sheets ?? []).map(s => s.properties.title);
}

async function fetchSheetRange(accessToken, sheetName) {
  const url = `${SHEETS_API_BASE}/${SPREADSHEET_ID}/values/${encodeURIComponent(sheetName + "!A1:Z200")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.values ?? []).map(row => row.join("\t")).join("\n");
}


// ─── SHIFT DEFINITIONS ────────────────────────────────────────────────────────
const SHIFT_DEFS = [
  { id:"er_intake",   name:"ER/Intake",   start:8,  end:17, payable:9, invoiceable:9 },
  { id:"oc",          name:"OC",          start:8,  end:17, payable:9, invoiceable:9 },
  { id:"off_service", name:"Off Service", start:8,  end:17, payable:9, invoiceable:9 },
  { id:"intake2",     name:"Intake 2",    start:8,  end:17, payable:9, invoiceable:9 },
  { id:"surge",       name:"Surge",       start:8,  end:17, payable:9, invoiceable:9 },
  { id:"stroke",      name:"Stroke",      start:8,  end:17, payable:9, invoiceable:9 },
  { id:"lb10",        name:"LB10",        start:8,  end:17, payable:9, invoiceable:9 },
  { id:"lb8a",        name:"LB8A",        start:8,  end:17, payable:9, invoiceable:9 },
  { id:"lb7a",        name:"LB7A",        start:8,  end:17, payable:9, invoiceable:9 },
  { id:"lb7c",        name:"LB7C",        start:8,  end:17, payable:9, invoiceable:9 },
  { id:"ubc1",        name:"UBC 1",       start:8,  end:17, payable:9, invoiceable:9 },
  { id:"ubc2",        name:"UBC 2",       start:8,  end:17, payable:9, invoiceable:9 },
  { id:"ubc3",        name:"UBC 3",       start:8,  end:17, payable:9, invoiceable:9 },
  { id:"ubc4",        name:"UBC 4",       start:8,  end:17, payable:9, invoiceable:9 },
  { id:"ubc5",        name:"UBC 5",       start:8,  end:17, payable:9, invoiceable:9 },
  { id:"er_eve", name:"ER Eve", start:16, end:25, payable:9, invoiceable:9 }, // time-based: 2h regular + 6h evening + 1h overnight
  { id:"ward_eve", name:"Ward Eve", start:17, end:25, payable:8, invoiceable:8 }, // time-based: 1h regular + 6h evening + 1h overnight
  { id:"home_call", name:"Home Call", start:24, end:32, payable:8, invoiceable:8, afterHoursOverride:{ eveningHours:0, overnightHours:0 } }, // no bonus — base rate only
  { id:"ucc_ward",  name:"UCC/Ward",  start:17, end:32, payable:9, invoiceable:9,
    afterHoursOverride:{ eveningHours:4, overnightHours:0 } },
];

const IS_DAYTIME = s => s && s.start === 8 && s.end === 17;

// ─── FUZZY NAME MATCHING ──────────────────────────────────────────────────────
// Levenshtein edit distance
function editDistance(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1}, (_,i) => Array.from({length:n+1}, (_,j) => i===0?j:j===0?i:0));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

// Similarity score 0–1 (1 = identical)
function similarity(a, b) {
  const dist = editDistance(a.trim(), b.trim());
  const maxLen = Math.max(a.trim().length, b.trim().length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// Normalise a name for comparison: lowercase, remove punctuation/extra spaces
function normName(n) { return n.toLowerCase().replace(/[^a-z\s]/g,"").replace(/\s+/g," ").trim(); }

// Extract initials pattern e.g. "H Chao" → "h chao", "Hsin Chao" → "hsin chao"
// Check if one name could be an abbreviated form of the other
function initialsMatch(raw, canonical) {
  const rp = normName(raw).split(" ");
  const cp = normName(canonical).split(" ");
  if (rp.length !== cp.length) return false;
  return rp.every((rw, i) => cp[i].startsWith(rw) || rw.startsWith(cp[i]));
}

// Returns { canonical, confidence, method } or null
function bestMatch(rawName, canonicalList) {
  if (!canonicalList || canonicalList.length === 0) return null;
  const raw = rawName.trim();
  if (!raw) return null;

  let best = null, bestScore = 0;

  for (const canon of canonicalList) {
    const canon_t = canon.trim();
    // Exact match
    if (normName(raw) === normName(canon_t)) return { canonical: canon_t, confidence: 1.0, method: "exact" };

    // Initials / prefix match
    if (initialsMatch(raw, canon_t) || initialsMatch(canon_t, raw)) {
      const score = 0.88;
      if (score > bestScore) { bestScore = score; best = { canonical: canon_t, confidence: score, method: "initials" }; }
    }

    // Edit distance similarity
    const sim = similarity(raw, canon_t);
    if (sim > bestScore) { bestScore = sim; best = { canonical: canon_t, confidence: sim, method: "edit-distance" }; }

    // Last-name only match (if single token matches last token of canonical)
    const rawParts = normName(raw).split(" ");
    const canParts = normName(canon_t).split(" ");
    if (rawParts.length === 1 && canParts.length > 1 && canParts[canParts.length-1] === rawParts[0]) {
      const score = 0.75;
      if (score > bestScore) { bestScore = score; best = { canonical: canon_t, confidence: score, method: "last-name" }; }
    }
  }
  return best;
}

// Confidence thresholds
const CONF_AUTO   = 0.85; // auto-correct silently → logged green
const CONF_GUESS  = 0.50; // apply best guess → logged yellow
// below CONF_GUESS → keep original → logged red

function resolveNames(entries, canonicalList) {
  if (!canonicalList || canonicalList.length === 0) return { resolved: entries, log: [] };

  const cache = {};
  const log = [];

  const resolved = entries.map(entry => {
    const raw = entry.physician;
    if (cache[raw] !== undefined) return { ...entry, physician: cache[raw] };

    const match = bestMatch(raw, canonicalList);

    if (!match || match.confidence < 0.3) {
      cache[raw] = raw;
      log.push({ raw, resolved: raw, confidence: 0, method: "no-match", status: "unresolved" });
      return entry;
    }

    // Exact — no change needed, no log entry
    if (match.method === "exact") {
      cache[raw] = match.canonical;
      return { ...entry, physician: match.canonical };
    }

    const status = match.confidence >= CONF_AUTO ? "auto" : match.confidence >= CONF_GUESS ? "guessed" : "unresolved";
    const resolved_name = match.confidence >= CONF_GUESS ? match.canonical : raw;

    cache[raw] = resolved_name;
    if (resolved_name !== raw) {
      log.push({ raw, resolved: resolved_name, confidence: match.confidence, method: match.method, status });
    }
    return { ...entry, physician: resolved_name };
  });

  // Deduplicate log by raw name
  const seen = new Set();
  const dedupLog = log.filter(l => { if (seen.has(l.raw)) return false; seen.add(l.raw); return true; });

  return { resolved, log: dedupLog };
}

// ─── WEEKEND DUPLICATE COLLAPSE ──────────────────────────────────────────────
// Per physician per day: if they have >1 daytime shift (start=8,end=17),
// collapse to one payable/invoiceable daytime unit. Log each collapse.
function collapseWeekendDuplicates(entries) {
  const collapseLog = [];

  // Group by physician + date
  const groups = {};
  entries.forEach((e, idx) => {
    const key = `${e.physician}||${e.dateStr}`;
    (groups[key] = groups[key] || []).push({ ...e, _idx: idx });
  });

  const suppressed = new Set();

  Object.values(groups).forEach(group => {
    const daytimes = group.filter(e => IS_DAYTIME(e.def));
    if (daytimes.length > 1) {
      // Keep first, suppress rest
      const keep = daytimes[0];
      const dups  = daytimes.slice(1);
      dups.forEach(d => {
        suppressed.add(d._idx);
        collapseLog.push({
          physician: d.physician,
          date:      d.dateStr,
          kept:      keep.def?.name ?? keep.shiftRaw,
          suppressed: d.def?.name ?? d.shiftRaw,
          reason:    "Same-day daytime overlap (weekend duplicate)",
        });
      });
    }
  });

  const filtered = entries.filter((_, i) => !suppressed.has(i));
  return { filtered, collapseLog };
}

// ─── AFTER-HOURS BREAKDOWN ────────────────────────────────────────────────────
function ahBreakdown(shift) {
  if (shift.afterHoursOverride) return { ...shift.afterHoursOverride };
  const ov = (s1,e1,s2,e2) => Math.max(0,Math.min(e1,e2)-Math.max(s1,s2));
  return { eveningHours:ov(shift.start,shift.end,18,24), overnightHours:ov(shift.start,shift.end,24,32) };
}

// ─── OVERLAP DETECTION ───────────────────────────────────────────────────────
function calcOverlap(shiftA, shiftB) {
  if (!shiftA || shiftA.end <= 24) return 0;
  const aRunsUntil = shiftA.end - 24;
  const bStarts = shiftB.start >= 24 ? shiftB.start - 24 : shiftB.start;
  return Math.max(0, aRunsUntil - bStarts);
}

// ─── SHIFT PAY ────────────────────────────────────────────────────────────────
function calcShiftPay(shift, rates, deduct=0) {
  const adj    = Math.max(0, shift.payable    - deduct);
  const adjInv = Math.max(0, shift.invoiceable - deduct);
  const { eveningHours, overnightHours } = ahBreakdown(shift);
  const scale  = shift.payable > 0 ? adj/shift.payable : 1;
  const eveH   = eveningHours   * scale;
  const onH    = overnightHours * scale;
  const regH   = adj - eveH - onH;
  return {
    payableHours:adj, invoiceableHours:adjInv, regularHours:regH, eveningHours:eveH, overnightHours:onH,
    basePay:adj*rates.base, evePay:eveH*rates.evening, onPay:onH*rates.overnight,
    gross:adj*rates.base+eveH*rates.evening+onH*rates.overnight,
  };
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function parseDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{1,2})-([A-Za-z]+)$/);
  if (m) { const d=new Date(`${m[2]} ${m[1]} 2026`); return isNaN(d)?null:d; }
  const d=new Date(str); return isNaN(d)?null:d;
}
function fmtDate(d) { return d?`${d.getDate()}-${MONTHS[d.getMonth()]}`:""; }
function addDays(d,n) { const r=new Date(d); r.setDate(r.getDate()+n); return r; }

function getBiweeklyPeriods(anchor) {
  let cur = new Date(anchor||new Date("Jan 1 2026"));
  const jan1=new Date("Jan 1 2026");
  while(cur>jan1) cur=addDays(cur,-14);
  while(addDays(cur,14)<=jan1) cur=addDays(cur,14);
  const periods=[];
  for(let i=0;i<27;i++){
    const s=new Date(cur),e=addDays(cur,13);
    if(s.getFullYear()>2026) break;
    periods.push({label:`${fmtDate(s)} – ${fmtDate(e)}`,from:fmtDate(s),to:fmtDate(e),start:s,end:e});
    cur=addDays(cur,14);
  }
  return periods;
}
function getMonthPeriods() {
  return MONTHS.map((m,i)=>{const s=new Date(2026,i,1),e=new Date(2026,i+1,0);return{label:`${m} 2026`,from:fmtDate(s),to:fmtDate(e),start:s,end:e,monthIdx:i};});
}

// ─── SCHEDULE PARSER ─────────────────────────────────────────────────────────
function findDef(raw) {
  if(!raw) return null;
  const r=raw.toLowerCase().trim();
  return SHIFT_DEFS.find(s=>s.name.toLowerCase()===r)??SHIFT_DEFS.find(s=>r.startsWith(s.name.toLowerCase().split(" ")[0]))??null;
}

function parseSchedule(text) {
  const rows=text.trim().split("\n").map(r=>r.split("\t").map(c=>c.trim()));
  if(rows.length<5) throw new Error("Need at least 5 rows.");
  const payRow=rows[0],shiftRow=rows[2],dataRows=rows.slice(4);
  console.log("parseSchedule: payRow[3]=", payRow[3], "shiftRow[3]=", shiftRow[3], "shiftRow[20]=", shiftRow[20], "shiftRow[21]=", shiftRow[21]);
  const cols=[];
  for(let c=3;c<shiftRow.length;c++){ if(!shiftRow[c]) continue; cols.push({col:c,raw:shiftRow[c],def:findDef(shiftRow[c]),payH:parseInt(payRow[c])||9}); }
  const entries=[];
  dataRows.forEach(row=>{
    const dateStr=row[0]; if(!dateStr) return;
    const dateObj=parseDate(dateStr); if(!dateObj) return;
    cols.forEach(({col,def,raw})=>{
      const physician=row[col];
      if(!physician||physician.toUpperCase()==="TBA"||!physician.trim()) return;
      entries.push({dateStr,dateObj,physician,def,shiftRaw:raw});
    });
  });
  return entries;
}

// Parse contact list tab — expects tab-separated rows, finds a column
// that looks like a name column (header contains "name")
function parseContactList(text) {
  if(!text||!text.trim()) return [];
  const rows=text.trim().split("\n").map(r=>r.split("\t").map(c=>c.trim()));
  if(rows.length<2) return [];
  const header=rows[0].map(h=>h.toLowerCase());
  // find "name" or "schedule name" or "physician" column
  let nameCol = header.findIndex(h=>h.includes("schedule")||h.includes("name on"));
  if(nameCol<0) nameCol=header.findIndex(h=>h.includes("name")||h.includes("physician")||h.includes("doctor"));
  if(nameCol<0) nameCol=0; // fallback: first column
  const names=rows.slice(1).map(r=>r[nameCol]).filter(n=>n&&n.trim());
  return [...new Set(names)];
}

// ─── AGGREGATE ───────────────────────────────────────────────────────────────
function computeResults(entries,rates,fromStr,toStr) {
  const fromD=parseDate(fromStr),toD=parseDate(toStr);
  if(!fromD||!toD) throw new Error("Invalid date range.");
  toD.setHours(23,59,59);
  const filtered=entries.filter(e=>e.dateObj>=fromD&&e.dateObj<=toD);
  const byDoc={};
  filtered.forEach(e=>{(byDoc[e.physician]=byDoc[e.physician]||[]).push(e);});
  Object.values(byDoc).forEach(arr=>arr.sort((a,b)=>a.dateObj-b.dateObj));
  const results={};
  Object.entries(byDoc).forEach(([physician,shifts])=>{
    let totPayable=0,totInvoiceable=0,totRegular=0,totEveH=0,totOnH=0,totBase=0,totEve=0,totOn=0,totOverlap=0;
    const details=[];
    shifts.forEach((s,i)=>{
      const def=s.def??SHIFT_DEFS[0];
      let deduct=0;
      if(i>0){
        const prev=shifts[i-1],prevDef=prev.def??SHIFT_DEFS[0];
        const dayDiff=Math.round((s.dateObj-prev.dateObj)/86400000);
        if(dayDiff===1){deduct=calcOverlap(prevDef,def);totOverlap+=deduct;}
      }
      const r=calcShiftPay(def,rates,deduct);
      totPayable+=r.payableHours;totInvoiceable+=r.invoiceableHours;totRegular+=r.regularHours;
      totEveH+=r.eveningHours;totOnH+=r.overnightHours;totBase+=r.basePay;totEve+=r.evePay;totOn+=r.onPay;
      details.push({date:s.dateStr,shift:def.name,overlapDeducted:deduct,...r});
    });
    const gross=totBase+totEve+totOn,holdback=gross*(rates.holdback/100);
    results[physician]={shiftCount:shifts.length,payableHours:totPayable,invoiceableHours:totInvoiceable,
      regularHours:totRegular,eveningHours:totEveH,overnightHours:totOnH,
      basePay:totBase,evePay:totEve,onPay:totOn,gross,holdback,net:gross-holdback,
      overlapHours:totOverlap,shiftDetails:details};
  });
  return results;
}

function sumResults(results) {
  return Object.values(results).reduce((a,r)=>({
    shifts:a.shifts+r.shiftCount,payableHours:a.payableHours+r.payableHours,
    invoiceableHours:a.invoiceableHours+r.invoiceableHours,regularHours:a.regularHours+r.regularHours,
    eveningHours:a.eveningHours+r.eveningHours,overnightHours:a.overnightHours+r.overnightHours,
    basePay:a.basePay+r.basePay,evePay:a.evePay+r.evePay,onPay:a.onPay+r.onPay,
    gross:a.gross+r.gross,holdback:a.holdback+r.holdback,net:a.net+r.net,overlapHours:a.overlapHours+r.overlapHours,
  }),{shifts:0,payableHours:0,invoiceableHours:0,regularHours:0,eveningHours:0,overnightHours:0,basePay:0,evePay:0,onPay:0,gross:0,holdback:0,net:0,overlapHours:0});
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function toCSV(rows){return rows.map(r=>r.map(c=>{const s=String(c??"");return s.includes(",")||s.includes('"')?`"${s.replace(/"/g,'""')}"`:s;}).join(",")).join("\n");}
function downloadCSV(filename,rows){const blob=new Blob([toCSV(rows)],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);}

function buildPayrollCSV(results,rates,label){
  const hdr=["Pay Period","Physician","Shifts","Regular Hrs","Evening Hrs","Overnight Hrs","Total Payable Hrs","Base Pay","Evening Bonus","Overnight Bonus","Gross Pay",`Holdback ${rates.holdback}%`,"Net Payout","Overlap Hrs"];
  const rows=Object.entries(results).sort((a,b)=>a[0].localeCompare(b[0])).map(([doc,r])=>[label,doc,r.shiftCount,r.regularHours.toFixed(1),r.eveningHours.toFixed(1),r.overnightHours.toFixed(1),r.payableHours.toFixed(1),r.basePay.toFixed(2),r.evePay.toFixed(2),r.onPay.toFixed(2),r.gross.toFixed(2),r.holdback.toFixed(2),r.net.toFixed(2),r.overlapHours.toFixed(1)]);
  const t=sumResults(results);
  rows.push([label,"TOTALS",t.shifts,t.regularHours.toFixed(1),t.eveningHours.toFixed(1),t.overnightHours.toFixed(1),t.payableHours.toFixed(1),t.basePay.toFixed(2),t.evePay.toFixed(2),t.onPay.toFixed(2),t.gross.toFixed(2),t.holdback.toFixed(2),t.net.toFixed(2),t.overlapHours.toFixed(1)]);
  return [hdr,...rows];
}
function buildInvoiceCSV(results,rates,label){
  const hdr=["Pay Period","Physician","Invoiceable Hrs","Regular Compensation","Evening Premium","Overnight Premium","Overlap Deducted","Total Invoiced"];
  const rows=Object.entries(results).sort((a,b)=>a[0].localeCompare(b[0])).map(([doc,r])=>{const inv=r.invoiceableHours*rates.base+r.evePay+r.onPay;return[label,doc,r.invoiceableHours.toFixed(1),(r.invoiceableHours*rates.base).toFixed(2),r.evePay.toFixed(2),r.onPay.toFixed(2),r.overlapHours.toFixed(1),inv.toFixed(2)];});
  const t=sumResults(results);const ti=t.invoiceableHours*rates.base+t.evePay+t.onPay;
  rows.push([label,"TOTALS",t.invoiceableHours.toFixed(1),(t.invoiceableHours*rates.base).toFixed(2),t.evePay.toFixed(2),t.onPay.toFixed(2),t.overlapHours.toFixed(1),ti.toFixed(2)]);
  return [hdr,...rows];
}
function buildNameLogCSV(log){
  return [["Original Name","Resolved To","Confidence","Method","Status"],...log.map(l=>[l.raw,l.resolved,(l.confidence*100).toFixed(0)+"%",l.method,l.status])];
}
function buildCollapseLogCSV(log){
  return [["Physician","Date","Shift Kept","Shift Suppressed","Reason"],...log.map(l=>[l.physician,l.date,l.kept,l.suppressed,l.reason])];
}

const C=n=>`$${Number(n).toLocaleString("en-CA",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const H=n=>`${Number(n).toFixed(1)}h`;
const PCT=n=>`${(n*100).toFixed(0)}%`;

// ─── THEME ────────────────────────────────────────────────────────────────────
const T={bg:"#07090f",surface:"#0d1117",surface2:"#111827",border:"#1a2640",muted:"#3a5070",dim:"#7a92b0",text:"#dde4f0",accent:"#4f9eff",green:"#34d399",amber:"#fbbf24",violet:"#a78bfa",red:"#f87171",yellow:"#fde68a"};

// ─── UI PRIMITIVES ────────────────────────────────────────────────────────────
function Card({children,title,action,style}){return(<div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:18,...style}}>{(title||action)&&(<div style={{display:"flex",alignItems:"center",marginBottom:14}}>{title&&<div style={{fontFamily:"'Syne',sans-serif",fontSize:10,letterSpacing:"0.14em",color:T.muted,textTransform:"uppercase"}}>{title}</div>}{action&&<div style={{marginLeft:"auto"}}>{action}</div>}</div>)}{children}</div>);}
function Btn({children,onClick,secondary,small,style,disabled}){return(<button onClick={onClick} disabled={disabled} style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:small?10:11,letterSpacing:"0.1em",textTransform:"uppercase",padding:small?"5px 10px":"8px 16px",borderRadius:4,cursor:disabled?"not-allowed":"pointer",border:secondary?`1px solid ${T.border}`:"none",background:secondary?"transparent":T.accent,color:secondary?T.dim:"#fff",opacity:disabled?0.4:1,transition:"all .15s",...style}}>{children}</button>);}
function NI({label,value,onChange,pre,suf,col}){return(<div style={{marginBottom:12}}><div style={{fontSize:10,color:T.muted,marginBottom:4,letterSpacing:"0.1em"}}>{label.toUpperCase()}</div><div style={{display:"flex",alignItems:"center",gap:6}}>{pre&&<span style={{color:col||T.accent,fontWeight:700}}>{pre}</span>}<input type="number" value={value} onChange={e=>onChange(parseFloat(e.target.value)||0)} style={{width:86,background:T.bg,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:"6px 9px",fontFamily:"inherit",fontSize:13,outline:"none"}}/>{suf&&<span style={{color:T.dim,fontSize:11}}>{suf}</span>}</div></div>);}
function TH({ch,right}){return<th style={{padding:"7px 10px",textAlign:right?"right":"left",fontSize:10,color:T.muted,fontWeight:400,letterSpacing:"0.08em",whiteSpace:"nowrap",borderBottom:`1px solid ${T.border}`}}>{ch}</th>;}
function TD({ch,color,bold,right,sm}){return<td style={{padding:"6px 10px",color:color||T.text,fontWeight:bold?700:400,fontSize:sm?10:12,textAlign:right?"right":"left",whiteSpace:"nowrap"}}>{ch}</td>;}
function TF({ch,color,bold,right}){return<td style={{padding:"8px 10px",color:color||T.dim,fontWeight:bold?700:500,fontSize:12,textAlign:right?"right":"left",borderTop:`2px solid ${T.border}`,whiteSpace:"nowrap"}}>{ch}</td>;}
function OBadge(){return<span style={{background:"#3d1010",color:T.red,fontSize:9,padding:"1px 5px",borderRadius:8,marginLeft:5}}>⚠ overlap</span>;}

// Status badge for name log
function StatusBadge({status}){
  const map={auto:{bg:"#0f2d1a",color:T.green,label:"AUTO"},guessed:{bg:"#2d2200",color:T.yellow,label:"REVIEW"},unresolved:{bg:"#2d0f0f",color:T.red,label:"UNRESOLVED"}};
  const s=map[status]||map.unresolved;
  return<span style={{background:s.bg,color:s.color,fontSize:9,padding:"2px 6px",borderRadius:8,fontFamily:"'Syne',sans-serif",fontWeight:600,letterSpacing:"0.08em"}}>{s.label}</span>;
}

// ─── SAMPLE DATA ─────────────────────────────────────────────────────────────
const SAMPLE_SCHEDULE=`9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t9\t8\t8
March\tDay\tER/Intake\tOC\tOff Service\tIntake 2\tSurge\tStroke\tLB10\tLB8A\tLB7A\tLB7C\tUBC 1\tUBC 2\tUBC 3\tUBC 4\tUBC 5\tUCC/Ward\tER Eve\tWard Eve\tHome Call
2026\t\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t08-17\t17-08\t17-01\t17-24\t00-08
1-Mar\tSun\tS Ahmed\tEvans\tEvans\tLange\tLange\tKonkin\tKonkin\tBarbour\tP Chan\tH Chao\tVaghadia\tBenedek\tBenedek\tVaghadia\tVaghadia\tMikha\tRembez\tHwang\tHwang
2-Mar\tMon\tH Chao\tJavidanbardan\tYoon\tLange\tMemar\tVastardis\tChong\tAl-Araji\tYousefi\tSegal\tMarch\tSakiyama\tWilton\tMusgrave\tRoll\tWilton\tVaghadia\tS Ahmed\tHwang
3-Mar\tTue\tH Chao\tJavidanbardan\tYoon\tLange\tMemar\tVastardis\tChong\tAl-Araji\tYousefi\tRegan\tMarch\tSakiyama\tWilton\tMusgrave\tRoll\tRoll\tVaghadia\tS Ahmed\tAl-Araji
4-Mar\tWed\tH Chao\tJavidanbardan\tYoon\tLange\tMemar\tVastardis\tChong\tYu\tYousefi\tF Chow\tMarch\tSakiyama\tWilton\tMusgrave\tRoll\tMarch\tVaghadia\tS Ahmed\tHwang
5-Mar\tThu\tH Chao\tJavidanbardan\tYoon\tLange\tMemar\tVastardis\tChong\tYu\tYousefi\tF Chow\tMarch\tSakiyama\tWilton\tMusgrave\tRoll\tMusgrave\tVaghadia\tS Ahmed\tYoon
6-Mar\tFri\tH Chao\tJavidanbardan\tYoon\tLange\tMemar\tVastardis\tChong\tYu\tYousefi\tF Chow\tMarch\tSakiyama\tWilton\tMusgrave\tRoll\tJara\tVaghadia\tS Ahmed\tHwang
7-Mar\tSat\tSoares\tEvans\tEvans\tLange\tLange\tBakonyi\tBakonyi\tYu\tYousefi\tBarbour\tRoll\tRoll\tWilton\tWilton\tRoll\tWilton\tBakonyi\tHwang\tHwang
8-Mar\tSun\tSoares\tEvans\tEvans\tLange\tLange\tBakonyi\tBakonyi\tYu\tYousefi\tBarbour\tRoll\tRoll\tWilton\tWilton\tRoll\tRoll\tLange\tHwang\tHwang
9-Mar\tMon\tSong\tBenedek\tYoon\tYousefi\tJain\tVastardis\tTukker\tH Chao\tS Ahmed\tF Chow\tHwang\tJara\tMusgrave\tYu\tMarch\tSkuridina\tSoares\tGill\tGill
10-Mar\tTue\tRegan\tBenedek\tYoon\tYousefi\tJain\tVastardis\tTukker\tH Chao\tS Ahmed\tF Chow\tHwang\tJara\tMusgrave\tYu\tMusgrave\tSkuridina\tSoares\tVaghadia\tVaghadia
11-Mar\tWed\tRegan\tBenedek\tYoon\tYousefi\tJacobson\tVastardis\tTukker\tH Chao\tS Ahmed\tF Chow\tHwang\tJara\tMusgrave\tYu\tRidley\tLange\tSoares\tYoon\tYoon
12-Mar\tThu\tWilton\tBenedek\tYoon\tYousefi\tJacobson\tVastardis\tTukker\tH Chao\tS Ahmed\tF Chow\tHwang\tJara\tYeung\tYu\tYu\tRembez\tSoares\tRidley\tRidley
13-Mar\tFri\tWilton\tBenedek\tYoon\tYousefi\tJacobson\tVastardis\tTukker\tH Chao\tS Ahmed\tF Chow\tHwang\tJara\tMusgrave\tYu\tJara\tLange\tSoares\tS Ahmed\tS Ahmed
14-Mar\tSat\tRegan\tVaghadia\tVaghadia\tTBA\t\tMcCaffrey\tMcCaffrey\tTognotti\tGill\tRidley\tMarch\tMarch\tYu\tMarch\tYu\tMarch\tVaghadia\tLange\tLange
15-Mar\tSun\tRegan\tVaghadia\tVaghadia\tTBA\t\tMcCaffrey\tMcCaffrey\tTognotti\tGill\tRidley\tMarch\tMarch\tYu\tMarch\tYu\tYu\tTognotti\tHwang\tGill
16-Mar\tMon\tVaghadia\tHaddad\tYoon\tLange\tTBA\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tHwang\tMusgrave\tRegan\tHwang\tHwang\tHwang
17-Mar\tTue\tVaghadia\tHaddad\tYoon\tTukker\tMcCaffrey\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tHwang\tYu\tMccAffrey\tRegan\tYu\tYu
18-Mar\tWed\tVaghadia\tHaddad\tYoon\tTukker\tMcCaffrey\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tHwang\tRidley\tMcCaffrey\tRegan\tYu\tYu
19-Mar\tThu\tVaghadia\tHaddad\tYoon\tBarbour\tMcCaffrey\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tHwang\tJara\tRembez\tRegan\tS Ahmed\tS Ahmed
20-Mar\tFri\tVaghadia\tHaddad\tYoon\tBarbour\tTBA\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tHwang\tHwang\tSong\tRegan\tVaghadia\tVaghadia
21-Mar\tSat\tVaghadia\tHwang\tHwang\tSong\tSong\tJacobson\tJacobson\tSkuridina\tKonkin\tStevens\tTukker\tMikha\tMikha\tTukker\tMikha\tJacobson\tYoon\tYoon\tYoon
22-Mar\tSun\tVaghadia\tJavidanbardan\tJavidanbardan\tSong\tSong\tJacobson\tJacobson\tSkuridina\tKonkin\tStevens\tTukker\tMikha\tMikha\tTukker\tTukker\tRembez\tKonkin\tVaghadia\tVaghadia
23-Mar\tMon\tJacobson\tMikha\tJavidanbardan\tMcCaffrey\tKonkin\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tTukker\tMusgrave\tGropper\tVaghadia\tVaghadia\tVaghadia
24-Mar\tTue\tJacobson\tMikha\tJavidanbardan\tJain\tMcCaffrey\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tTukker\tMikha\tRembez\tVaghadia\tVaghadia\tVaghadia
25-Mar\tWed\tSong\tMikha\tJavidanbardan\tJain\tMcCaffrey\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tTukker\tJara\tGropper\tVaghadia\tS Ahmed\tS Ahmed
26-Mar\tThu\tJacobson\tMikha\tJavidanbardan\tJain\tKonkin\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tYeung\tJara\tMusgrave\tTukker\tMikha\tRembez\tVaghadia\tSoares\tSoares
27-Mar\tFri\tJacobson\tMikha\tJavidanbardan\tJain\tKonkin\tSoares\tBakonyi\tH Chao\tS Ahmed\tStevens\tSakiyama\tJara\tMusgrave\tTukker\tRegan\tAl-Araji\tVaghadia\tJavidanbardan\tJavidanbardan
28-Mar\tSat\tSong\tJavidanbardan\tJavidanbardan\tEngland\tEngland\tYousefi\tYousefi\tSkuridina\tLange\tRidley\tSakiyama\tMusgrave\tMusgrave\t\tMusgrave\tYousefi\tP. Chan\tEngland\tEngland
29-Mar\tSun\tSong\tJavidanbardan\tJavidanbardan\tEngland\tEngland\tYousefi\tYousefi\tSkuridina\tLange\tRidley\tSakiyama\tMusgrave\tMusgrave\t\tMikha\tRembez\tKonkin\tRidley\tRidley
30-Mar\tMon\tYousefi\tYu\tThielmann\tMarch\tKonkin\tSoares\tBakonyi\tH Chao\tS Ahmed\tJain\tSakiyama\tJara\tF Chow\tTukker\tJara\tWilton\tKonkin\tAl-Araji\tAl-Araji
31-Mar\tTue\tYousefi\tYu\tThielmann\tMarch\tRoll\tSoares\tBakonyi\tH Chao\tS Ahmed\tJain\tSakiyama\tJara\tF Chow\tTukker\tTukker\tWilton\tHwang\tHwang\tHwang`;

// Sample contact list (mimics the Contact Info tab)
const SAMPLE_CONTACTS=`Last Name\tFirst Name\tName on Schedule\tEmail\tPhone
Ahmed\tSaleem\tS Ahmed\t\t
Al-Araji\tAhmed\tAl-Araji\t\t
Bakonyi\tPeter\tBakonyi\t\t
Barbour\tJames\tBarbour\t\t
Benedek\tIvan\tBenedek\t\t
Chan\tPhilip\tP Chan\t\t
Chao\tHsin\tH Chao\t\t
Chong\tDavid\tChong\t\t
Chow\tFrank\tF Chow\t\t
England\tRobert\tEngland\t\t
Evans\tMark\tEvans\t\t
Gill\tRanjit\tGill\t\t
Gropper\tAdam\tGropper\t\t
Haddad\tSamir\tHaddad\t\t
Hwang\tJennifer\tHwang\t\t
Jacobson\tMark\tJacobson\t\t
Jain\tRohit\tJain\t\t
Jara Villarroel\tCarlos\tJara\t\t
Javidanbardan\tKamran\tJavidanbardan\t\t
Konkin\tJohn\tKonkin\t\t
Lange\tMichael\tLange\t\t
March\tElizabeth\tMarch\t\t
McCaffrey\tPatrick\tMcCaffrey\t\t
Memar\tAli\tMemar\t\t
Mikha\tMina\tMikha\t\t
Musgrave\tStuart\tMusgrave\t\t
Regan\tMichael\tRegan\t\t
Rembez\tPaul\tRembez\t\t
Ridley\tJohn\tRidley\t\t
Roll\tDavid\tRoll\t\t
Sakiyama\tTom\tSakiyama\t\t
Segal\tNaomi\tSegal\t\t
Skuridina\tNatasha\tSkuridina\t\t
Soares\tJose\tSoares\t\t
Song\tDavid\tSong\t\t
Stevens\tMark\tStevens\t\t
Thielmann\tKlaus\tThielmann\t\t
Tognotti\tFrank\tTognotti\t\t
Tukker\tHendrik\tTukker\t\t
Vaghadia\tHirsch\tVaghadia\t\t
Vastardis\tSteve\tVastardis\t\t
Wilton\tBrent\tWilton\t\t
Yeung\tJoyce\tYeung\t\t
Yoon\tJennifer\tYoon\t\t
Yousefi\tAli\tYousefi\t\t
Yu\tMichael\tYu\t\t`;

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]             = useState("setup");
  // Google Sheets API state
  const [gToken, setGToken]           = useState(null);
  const [gUser, setGUser]             = useState("");
  const [gSheets, setGSheets]         = useState([]);
  const [gSelSheet, setGSelSheet]     = useState("");
  const [gSelContacts, setGSelContacts] = useState("");
  const [gLoading, setGLoading]       = useState(false);
  const [gError, setGError]           = useState("");

  const [rates, setRates]         = useState({ base:150, evening:25, overnight:35, holdback:15 });

  // Schedule
  const [rawSchedule, setRawSchedule] = useState("");
  const [rawContacts, setRawContacts] = useState("");
  const [entries, setEntries]         = useState(null);
  const [parseMsg, setParseMsg]       = useState("");

  // Processing logs
  const [nameLog, setNameLog]         = useState([]);
  const [collapseLog, setCollapseLog] = useState([]);
  const [logTab, setLogTab]           = useState("names");

  // Period
  const [periodMode, setPeriodMode]   = useState("biweekly");
  const [cycleStart, setCycleStart]   = useState("1-Jan");
  const [customFrom, setCustomFrom]   = useState("1-Mar");
  const [customTo, setCustomTo]       = useState("31-Mar");
  const [selMonth, setSelMonth]       = useState(2);
  const [selPeriodIdx, setSelPeriodIdx] = useState(0);

  // Results
  const [results, setResults]         = useState(null);
  const [calcErr, setCalcErr]         = useState("");
  const [reportView, setReport]       = useState("payroll");
  const [detail, setDetail]           = useState(null);

  // ── Parse ──
  // ── Google Connect ──
  const handleGoogleConnect = useCallback(async () => {
    setGError(""); setGLoading(true);
    try {
      await loadGISScript();
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SHEETS_SCOPE,
        callback: async (resp) => {
          if (resp.error) { setGError(resp.error); setGLoading(false); return; }
          setGToken(resp.access_token);
          setGUser(resp.scope ? "Connected" : "Connected");
          try {
            const names = await fetchSheetNames(resp.access_token);
            setGSheets(names);
            const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
            const firstMonth = names.find(n => monthNames.some(m => n.toLowerCase().includes(m.toLowerCase()))) || names[0];
            setGSelSheet(firstMonth || "");
            const contactsSheet = names.find(n => n.toLowerCase().includes("contact")) || "";
            setGSelContacts(contactsSheet);
          } catch(e) { setGError("Connected but could not read sheets: " + e.message); }
          setGLoading(false);
        },
      });
      tokenClient.requestAccessToken();
    } catch(e) { setGError("Failed to connect: " + e.message); setGLoading(false); }
  }, []);

  const handleGoogleDisconnect = useCallback(() => {
    setGToken(null); setGUser(""); setGSheets([]); setGSelSheet(""); setGSelContacts(""); setGError("");
  }, []);

  const handleLoadFromGoogle = useCallback(async () => {
    if (!gToken || !gSelSheet) { setGError("Select a schedule sheet first."); return; }
    setGError(""); setGLoading(true);
    try {
      const schedText = await fetchSheetRange(gToken, gSelSheet);
      setRawSchedule(schedText);
      if (gSelContacts) {
        const contactsText = await fetchSheetRange(gToken, gSelContacts);
        setRawContacts(contactsText);
      }
      setGLoading(false);
    } catch(e) { setGError("Error loading: " + e.message); setGLoading(false); }
  }, [gToken, gSelSheet, gSelContacts]);

  const handleParse = useCallback(() => {
    setParseMsg(""); setEntries(null); setResults(null); setDetail(null);
    setNameLog([]); setCollapseLog([]);
    if (!rawSchedule.trim()) { setParseMsg("⚠ Paste schedule data first."); return; }
    try {
      // 1. Parse raw entries
      let parsed = parseSchedule(rawSchedule);

      // 2. Name resolution
      const canonicalList = parseContactList(rawContacts);
      const { resolved, log: nLog } = resolveNames(parsed, canonicalList);
      setNameLog(nLog);

      // 3. Weekend duplicate collapse
      const { filtered, collapseLog: cLog } = collapseWeekendDuplicates(resolved);
      setCollapseLog(cLog);

      const docs = [...new Set(filtered.map(x => x.physician))];
      setEntries(filtered);

      const parts = [`✓ ${filtered.length} shift assignments · ${docs.length} physicians`];
      if (nLog.length)   parts.push(`${nLog.length} name substitution(s)`);
      if (cLog.length)   parts.push(`${cLog.length} weekend duplicate(s) collapsed`);
      setParseMsg(parts.join(" · "));
    } catch(err) { setParseMsg("⚠ " + err.message); }
  }, [rawSchedule, rawContacts]);

  // ── Periods ──
  const biweeklyAll  = useMemo(() => getBiweeklyPeriods(parseDate(cycleStart)||new Date("Jan 1 2026")), [cycleStart]);
  const monthPeriods = useMemo(() => getMonthPeriods(), []);
  const periodsInMonth = useMemo(() => {
    if (periodMode==="biweekly") return biweeklyAll.filter(p=>p.start.getMonth()===selMonth||p.end.getMonth()===selMonth);
    if (periodMode==="month")    return [monthPeriods[selMonth]];
    return [];
  }, [periodMode, biweeklyAll, monthPeriods, selMonth]);

  const activePeriod = useMemo(() => {
    if (periodMode==="custom") return {from:customFrom,to:customTo,label:`${customFrom} – ${customTo}`};
    if (periodMode==="month")  return {...monthPeriods[selMonth]};
    const p = periodsInMonth[Math.min(selPeriodIdx, periodsInMonth.length-1)];
    return p ? {from:p.from,to:p.to,label:p.label} : null;
  }, [periodMode,customFrom,customTo,monthPeriods,selMonth,periodsInMonth,selPeriodIdx]);

  // ── Calculate ──
  const handleCalc = useCallback(() => {
    setCalcErr(""); setDetail(null);
    if (!entries) { setCalcErr("Parse schedule first."); return; }
    if (!activePeriod) { setCalcErr("Select a period."); return; }
    try {
      const res = computeResults(entries, rates, activePeriod.from, activePeriod.to);
      if (!Object.keys(res).length) { setCalcErr(`No shifts found in: ${activePeriod.label}`); return; }
      setResults(res); setTab("reports"); setReport("payroll");
    } catch(err) { setCalcErr("⚠ " + err.message); }
  }, [entries, rates, activePeriod]);

  const totals = results ? sumResults(results) : null;
  const periodLabel = activePeriod?.label ?? "";

  // Log counts for badges
  const autoCount       = nameLog.filter(l=>l.status==="auto").length;
  const guessedCount    = nameLog.filter(l=>l.status==="guessed").length;
  const unresolvedCount = nameLog.filter(l=>l.status==="unresolved").length;

  return (
    <div style={{fontFamily:"'DM Mono','Fira Mono',monospace",background:T.bg,minHeight:"100vh",color:T.text}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        input,textarea,select{outline:none;font-family:inherit;}
        ::-webkit-scrollbar{width:4px;height:4px;}
        ::-webkit-scrollbar-track{background:${T.bg};}
        ::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:2px;}
        .dr:hover td{background:#0f1825!important;cursor:pointer;}
        .fade{animation:fi .2s ease;}
        @keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        input[type=number]{-moz-appearance:textfield;}
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;}
        select option{background:#0d1117;}
      `}</style>

      {/* HEADER */}
      <div style={{borderBottom:`1px solid ${T.border}`,background:T.surface,padding:"14px 24px",display:"flex",alignItems:"center",gap:14}}>
        <div>
          <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:17,color:T.accent,letterSpacing:"0.08em"}}>OPEN CLAW</div>
          <div style={{fontSize:9,color:T.muted,letterSpacing:"0.2em",marginTop:1}}>HOSPITALIST · FINANCIAL ENGINE · v3.0</div>
        </div>
        <div style={{display:"flex",gap:6,marginLeft:20}}>
          {[["setup","⚙  Setup"],["logs","📋 Processing Logs"],["reports","▤  Reports"]].map(([id,lbl])=>(
            <button key={id} onClick={()=>setTab(id)} style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase",padding:"6px 14px",borderRadius:4,cursor:"pointer",border:tab===id?"none":`1px solid ${T.border}`,background:tab===id?T.accent:"transparent",color:tab===id?"#fff":T.muted,position:"relative"}}>
              {lbl}
              {id==="logs" && (guessedCount+unresolvedCount+collapseLog.length)>0 && (
                <span style={{position:"absolute",top:-4,right:-4,background:T.red,color:"#fff",fontSize:8,width:14,height:14,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Syne',sans-serif"}}>
                  {guessedCount+unresolvedCount+collapseLog.length}
                </span>
              )}
            </button>
          ))}
        </div>
        {results && <div style={{marginLeft:"auto",fontSize:11,color:T.green}}>✓ {Object.keys(results).length} physicians · {periodLabel}</div>}
      </div>

      <div style={{padding:24,maxWidth:1240,margin:"0 auto"}}>

        {/* ══════════ SETUP ══════════ */}
        {tab==="setup" && (
          <div className="fade">
            <div style={{display:"grid",gridTemplateColumns:"260px 1fr",gap:18,marginBottom:18}}>

              {/* Rates */}
              <Card title="Pay Rates">
                <NI label="Base Hourly Rate" pre="$" value={rates.base} onChange={v=>setRates(r=>({...r,base:v}))}/>
                <div style={{height:1,background:T.border,margin:"2px 0 10px"}}/>
                <div style={{fontSize:10,color:T.muted,letterSpacing:"0.1em",marginBottom:8}}>AFTER-HOURS BONUS</div>
                <NI label="Evening 18:00–24:00" pre="+" suf="/hr" col={T.amber} value={rates.evening} onChange={v=>setRates(r=>({...r,evening:v}))}/>
                <NI label="Overnight 00:00–08:00 (eve/ON shifts only)" pre="+" suf="/hr" col={T.violet} value={rates.overnight} onChange={v=>setRates(r=>({...r,overnight:v}))}/>
                <div style={{height:1,background:T.border,margin:"2px 0 10px"}}/>
                <NI label="Overhead Holdback" suf="% of gross" col={T.red} value={rates.holdback} onChange={v=>setRates(r=>({...r,holdback:v}))}/>
                <div style={{background:T.bg,borderRadius:5,padding:10,marginTop:4}}>
                  <div style={{fontSize:9,color:T.muted,marginBottom:6,letterSpacing:"0.1em"}}>SHIFT PREVIEW</div>
                  {[{n:"Daytime",p:9,e:0,o:0},{n:"ER Eve",p:9,e:6,o:1},{n:"Ward Eve",p:8,e:6,o:1},{n:"Home Call",p:8,e:0,o:0},{n:"UCC/Ward★",p:9,e:4,o:0}].map(s=>{
                    const g=s.p*rates.base+s.e*rates.evening+s.o*rates.overnight;
                    return(<div key={s.n} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:`1px solid ${T.border}`,fontSize:10}}><span style={{color:T.dim}}>{s.n}</span><span style={{color:T.accent}}>{C(g)}</span><span style={{color:T.green}}>{C(g*(1-rates.holdback/100))}</span></div>);
                  })}
                </div>
              </Card>

              {/* Schedule + Contacts */}
                {/* ── GOOGLE CONNECTION PANEL ── */}
                <Card title="Google Sheets — Direct Connection">
                  {!gToken ? (
                    <div style={{display:"flex",flexDirection:"column",gap:10}}>
                      <div style={{fontSize:11,color:T.dim,lineHeight:1.6}}>Connect your Google account to load the schedule directly — no pasting needed.</div>
                      {gError && <div style={{color:T.red,fontSize:11,padding:"6px 10px",background:"#1a0a0a",borderRadius:4}}>{gError}</div>}
                      <Btn onClick={handleGoogleConnect} disabled={gLoading || !GOOGLE_CLIENT_ID} style={{alignSelf:"flex-start"}}>
                        {gLoading ? "Connecting..." : "🔗 Connect to Google Sheets"}
                      </Btn>
                      {!GOOGLE_CLIENT_ID && <div style={{fontSize:10,color:T.red}}>⚠ VITE_GOOGLE_CLIENT_ID not set in .env file</div>}
                    </div>
                  ) : (
                    <div style={{display:"flex",flexDirection:"column",gap:12}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:T.bg,borderRadius:6}}>
                        <span style={{color:T.green,fontSize:12}}>✓ Connected to Google Sheets</span>
                        <Btn small secondary onClick={handleGoogleDisconnect} style={{marginLeft:"auto"}}>Disconnect</Btn>
                      </div>
                      {gError && <div style={{color:T.red,fontSize:11,padding:"6px 10px",background:"#1a0a0a",borderRadius:4}}>{gError}</div>}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                        <div>
                          <div style={{fontSize:10,color:T.muted,marginBottom:5,letterSpacing:"0.1em"}}>SCHEDULE MONTH</div>
                          <select value={gSelSheet} onChange={e=>setGSelSheet(e.target.value)}
                            style={{width:"100%",background:T.surface2,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:"6px 9px",fontSize:12,outline:"none"}}>
                            <option value="">— select month —</option>
                            {gSheets.map(s=><option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div>
                          <div style={{fontSize:10,color:T.muted,marginBottom:5,letterSpacing:"0.1em"}}>CONTACT INFO TAB</div>
                          <select value={gSelContacts} onChange={e=>setGSelContacts(e.target.value)}
                            style={{width:"100%",background:T.surface2,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:"6px 9px",fontSize:12,outline:"none"}}>
                            <option value="">— none —</option>
                            {gSheets.map(s=><option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                      </div>
                      <Btn onClick={handleLoadFromGoogle} disabled={gLoading || !gSelSheet}>
                        {gLoading ? "Loading from Google Sheets..." : "📥 Load Schedule from Google Sheets"}
                      </Btn>
                      {rawSchedule && <div style={{fontSize:10,color:T.green}}>✓ Schedule loaded — {rawSchedule.split("\n").length} rows</div>}
                    </div>
                  )}
                </Card>

              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <Card title="Schedule Data — Paste from Google Sheets (Monthly tab)">
                  <textarea value={rawSchedule} onChange={e=>setRawSchedule(e.target.value)} placeholder="Paste schedule tab here..."
                    style={{width:"100%",height:160,resize:"vertical",background:T.bg,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:10,fontSize:11,lineHeight:1.5}}/>
                  <div style={{display:"flex",gap:8,marginTop:8}}>
                    <Btn secondary small onClick={()=>setRawSchedule(SAMPLE_SCHEDULE)}>Load Sample Schedule</Btn>
                    <Btn secondary small onClick={()=>{setRawSchedule("");setEntries(null);setParseMsg("");}}>Clear</Btn>
                  </div>
                </Card>

                <Card title="Contact List — Paste from Contact Info Tab (optional but recommended)">
                  <div style={{fontSize:11,color:T.dim,marginBottom:8,lineHeight:1.6}}>
                    Paste the Contact Info tab to enable name normalization. The app will look for a column containing "name on schedule" or similar.
                  </div>
                  <textarea value={rawContacts} onChange={e=>setRawContacts(e.target.value)} placeholder="Paste Contact Info tab here..."
                    style={{width:"100%",height:100,resize:"vertical",background:T.bg,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:10,fontSize:11,lineHeight:1.5}}/>
                  <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center"}}>
                    <Btn secondary small onClick={()=>setRawContacts(SAMPLE_CONTACTS)}>Load Sample Contacts</Btn>
                    <Btn secondary small onClick={()=>setRawContacts("")}>Clear</Btn>
                    {rawContacts && <span style={{fontSize:10,color:T.green}}>✓ {parseContactList(rawContacts).length} canonical names loaded</span>}
                  </div>
                </Card>

                {/* Parse button + message */}
                <div style={{display:"flex",gap:12,alignItems:"center"}}>
                  <Btn onClick={handleParse} disabled={!rawSchedule.trim()}>Parse &amp; Process Schedule →</Btn>
                  {parseMsg && <span style={{fontSize:11,color:parseMsg.startsWith("✓")?T.green:T.red}}>{parseMsg}</span>}
                </div>
              </div>
            </div>

            {/* Pay period */}
            <Card title="Pay Period">
              <div style={{display:"grid",gridTemplateColumns:"180px 1fr",gap:24}}>
                <div>
                  <div style={{fontSize:10,color:T.muted,letterSpacing:"0.1em",marginBottom:10}}>PERIOD TYPE</div>
                  {[["biweekly","Bi-Weekly"],["month","Full Month"],["custom","Custom Range"]].map(([id,lbl])=>(
                    <div key={id} onClick={()=>{setPeriodMode(id);setSelPeriodIdx(0);}}
                      style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",marginBottom:4,cursor:"pointer",
                        background:periodMode===id?T.surface2:"transparent",borderRadius:4,border:`1px solid ${periodMode===id?T.border:"transparent"}`}}>
                      <div style={{width:8,height:8,borderRadius:"50%",background:periodMode===id?T.accent:T.muted,flexShrink:0}}/>
                      <span style={{fontSize:12,color:periodMode===id?T.text:T.dim}}>{lbl}</span>
                    </div>
                  ))}
                </div>
                <div>
                  {periodMode==="biweekly"&&(<div>
                    <div style={{display:"flex",gap:16,marginBottom:14,flexWrap:"wrap",alignItems:"flex-end"}}>
                      <div>
                        <div style={{fontSize:10,color:T.muted,marginBottom:4,letterSpacing:"0.1em"}}>CYCLE START DATE</div>
                        <input value={cycleStart} onChange={e=>setCycleStart(e.target.value)} placeholder="1-Jan"
                          style={{background:T.bg,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:"6px 10px",fontSize:12,width:120}}/>
                      </div>
                      <div>
                        <div style={{fontSize:10,color:T.muted,marginBottom:4,letterSpacing:"0.1em"}}>MONTH</div>
                        <select value={selMonth} onChange={e=>{setSelMonth(parseInt(e.target.value));setSelPeriodIdx(0);}}
                          style={{background:T.surface2,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:"6px 10px",fontSize:12}}>
                          {MONTHS.map((m,i)=><option key={i} value={i}>{m} 2026</option>)}
                        </select>
                      </div>
                    </div>
                    <div style={{fontSize:10,color:T.muted,marginBottom:8,letterSpacing:"0.1em"}}>SELECT PERIOD</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                      {periodsInMonth.map((p,i)=>(
                        <div key={i} onClick={()=>setSelPeriodIdx(i)}
                          style={{padding:"5px 12px",borderRadius:4,cursor:"pointer",fontSize:11,
                            background:selPeriodIdx===i?T.accent:T.surface2,color:selPeriodIdx===i?"#fff":T.dim,
                            border:`1px solid ${selPeriodIdx===i?T.accent:T.border}`}}>{p.label}</div>
                      ))}
                    </div>
                  </div>)}
                  {periodMode==="month"&&(<div>
                    <div style={{fontSize:10,color:T.muted,marginBottom:8,letterSpacing:"0.1em"}}>SELECT MONTH</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                      {MONTHS.map((m,i)=>(
                        <div key={i} onClick={()=>setSelMonth(i)}
                          style={{padding:"5px 14px",borderRadius:4,cursor:"pointer",fontSize:11,
                            background:selMonth===i?T.accent:T.surface2,color:selMonth===i?"#fff":T.dim,
                            border:`1px solid ${selMonth===i?T.accent:T.border}`}}>{m}</div>
                      ))}
                    </div>
                  </div>)}
                  {periodMode==="custom"&&(<div style={{display:"flex",gap:16,alignItems:"flex-end",flexWrap:"wrap"}}>
                    {[["From",customFrom,setCustomFrom],["To",customTo,setCustomTo]].map(([lbl,val,set])=>(
                      <div key={lbl}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:4,letterSpacing:"0.1em"}}>{lbl.toUpperCase()}</div>
                        <input value={val} onChange={e=>set(e.target.value)} placeholder="e.g. 1-Mar"
                          style={{background:T.bg,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:"6px 10px",fontSize:12,width:130}}/>
                      </div>
                    ))}
                  </div>)}
                  {activePeriod&&(
                    <div style={{display:"flex",alignItems:"center",gap:14,marginTop:18,padding:12,background:T.bg,borderRadius:6}}>
                      <div>
                        <div style={{fontSize:10,color:T.muted,letterSpacing:"0.1em"}}>ACTIVE PERIOD</div>
                        <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15,color:T.accent,marginTop:2}}>{activePeriod.label}</div>
                      </div>
                      <Btn onClick={handleCalc} disabled={!entries} style={{marginLeft:"auto"}}>Generate Reports →</Btn>
                      {calcErr&&<span style={{color:T.red,fontSize:11}}>{calcErr}</span>}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* ══════════ PROCESSING LOGS ══════════ */}
        {tab==="logs" && (
          <div className="fade">
            {(!nameLog.length && !collapseLog.length) ? (
              <div style={{textAlign:"center",padding:60,color:T.muted}}>
                <div style={{fontSize:36,marginBottom:12}}>📋</div>
                <div>No processing logs yet — parse a schedule first.</div>
                <Btn onClick={()=>setTab("setup")} style={{marginTop:16}}>Go to Setup →</Btn>
              </div>
            ) : (
              <div>
                {/* Log tabs */}
                <div style={{display:"flex",gap:8,marginBottom:16}}>
                  {[
                    ["names", `Name Normalizations (${nameLog.length})`],
                    ["dupes", `Weekend Duplicates Collapsed (${collapseLog.length})`],
                  ].map(([id,lbl])=>(
                    <button key={id} onClick={()=>setLogTab(id)} style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:10,letterSpacing:"0.1em",textTransform:"uppercase",padding:"6px 14px",borderRadius:4,cursor:"pointer",border:logTab===id?"none":`1px solid ${T.border}`,background:logTab===id?T.accent:"transparent",color:logTab===id?"#fff":T.muted}}>{lbl}</button>
                  ))}
                  <div style={{marginLeft:"auto",display:"flex",gap:8}}>
                    {nameLog.length>0&&<Btn small secondary onClick={()=>downloadCSV("name_log.csv",buildNameLogCSV(nameLog))}>↓ Name Log CSV</Btn>}
                    {collapseLog.length>0&&<Btn small secondary onClick={()=>downloadCSV("duplicate_log.csv",buildCollapseLogCSV(collapseLog))}>↓ Duplicate Log CSV</Btn>}
                  </div>
                </div>

                {/* Name log */}
                {logTab==="names" && (
                  <Card title="Name Normalization Log">
                    {nameLog.length===0 ? (
                      <div style={{color:T.muted,fontSize:12,padding:"20px 0",textAlign:"center"}}>
                        {rawContacts ? "All names matched exactly — no substitutions needed." : "No contact list loaded — paste Contact Info tab to enable name normalization."}
                      </div>
                    ) : (
                      <>
                        {/* Summary */}
                        <div style={{display:"flex",gap:10,marginBottom:14}}>
                          {[[autoCount,"Auto-corrected",T.green,"#0f2d1a"],[guessedCount,"Needs Review",T.yellow,"#2d2200"],[unresolvedCount,"Unresolved",T.red,"#2d0f0f"]].map(([n,lbl,col,bg])=>(
                            <div key={lbl} style={{background:bg,border:`1px solid ${col}22`,borderRadius:6,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                              <span style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:18,color:col}}>{n}</span>
                              <span style={{fontSize:10,color:col}}>{lbl}</span>
                            </div>
                          ))}
                        </div>
                        <div style={{overflowX:"auto"}}>
                          <table style={{width:"100%",borderCollapse:"collapse"}}>
                            <thead><tr>
                              <TH ch="Original Name in Schedule"/>
                              <TH ch="Resolved To"/>
                              <TH ch="Confidence"/>
                              <TH ch="Method"/>
                              <TH ch="Status"/>
                            </tr></thead>
                            <tbody>
                              {nameLog.map((l,i)=>(
                                <tr key={i} style={{borderBottom:`1px solid ${T.bg}`,background:l.status==="guessed"?"#1a1500":l.status==="unresolved"?"#1a0a0a":"transparent"}}>
                                  <TD ch={l.raw} color={T.dim}/>
                                  <TD ch={l.resolved} bold={l.resolved!==l.raw}/>
                                  <TD ch={l.confidence>0?PCT(l.confidence):"—"} color={l.confidence>=CONF_AUTO?T.green:l.confidence>=CONF_GUESS?T.yellow:T.red}/>
                                  <TD ch={l.method} color={T.muted} sm/>
                                  <td style={{padding:"6px 10px"}}><StatusBadge status={l.status}/></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </Card>
                )}

                {/* Duplicate log */}
                {logTab==="dupes" && (
                  <Card title="Weekend Duplicate Collapse Log">
                    {collapseLog.length===0 ? (
                      <div style={{color:T.muted,fontSize:12,padding:"20px 0",textAlign:"center"}}>No same-day daytime duplicates detected.</div>
                    ) : (
                      <>
                        <div style={{padding:10,background:T.bg,borderRadius:6,fontSize:11,color:T.dim,lineHeight:1.7,marginBottom:14}}>
                          {collapseLog.length} instance(s) where a physician appeared in multiple same-day daytime shifts (08–17).
                          Only the first shift was retained for pay and invoice purposes. Evening and overnight shifts are unaffected.
                        </div>
                        <div style={{overflowX:"auto"}}>
                          <table style={{width:"100%",borderCollapse:"collapse"}}>
                            <thead><tr>
                              <TH ch="Physician"/>
                              <TH ch="Date"/>
                              <TH ch="Shift Kept (Paid)"/>
                              <TH ch="Shift Suppressed"/>
                              <TH ch="Rule Applied"/>
                            </tr></thead>
                            <tbody>
                              {collapseLog.map((l,i)=>(
                                <tr key={i} style={{borderBottom:`1px solid ${T.bg}`,background:"#1a1000"}}>
                                  <TD ch={l.physician} bold/>
                                  <TD ch={l.date} color={T.dim}/>
                                  <TD ch={l.kept} color={T.green}/>
                                  <TD ch={l.suppressed} color={T.red}/>
                                  <TD ch={l.reason} color={T.muted} sm/>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </Card>
                )}
              </div>
            )}
          </div>
        )}

        {/* ══════════ REPORTS ══════════ */}
        {tab==="reports" && (
          <div className="fade">
            {!results ? (
              <div style={{textAlign:"center",padding:60,color:T.muted}}>
                <div style={{fontSize:36,marginBottom:12}}>📋</div>
                <div style={{marginBottom:16}}>No results yet — set up rates, parse schedule, and click Generate Reports.</div>
                <Btn onClick={()=>setTab("setup")}>Go to Setup →</Btn>
              </div>
            ) : detail ? (
              /* PHYSICIAN DETAIL */
              <div className="fade">
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
                  <button onClick={()=>setDetail(null)} style={{background:"none",border:`1px solid ${T.border}`,color:T.dim,borderRadius:4,padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:11}}>← Back</button>
                  <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:18}}>{detail}</div>
                  <div style={{fontSize:11,color:T.muted}}>{periodLabel}</div>
                  {results[detail].overlapHours>0&&<OBadge/>}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:10,marginBottom:18}}>
                  {[["Shifts",results[detail].shiftCount,T.accent],["Regular Hrs",H(results[detail].regularHours),T.dim],["Evening Hrs",H(results[detail].eveningHours),T.amber],["Overnight Hrs",H(results[detail].overnightHours),T.violet],["Total Payable",H(results[detail].payableHours),T.accent],["Gross Pay",C(results[detail].gross),T.amber],["Net Payout",C(results[detail].net),T.green]].map(([l,v,c])=>(
                    <div key={l} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:7,padding:12,textAlign:"center"}}>
                      <div style={{fontSize:9,color:T.muted,letterSpacing:"0.1em",marginBottom:5}}>{l.toUpperCase()}</div>
                      <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>
                <Card title="Pay Composition" style={{marginBottom:18}}>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}}>
                    {[["Base Pay",C(results[detail].basePay),T.text,`${H(results[detail].regularHours)} × ${C(rates.base)}/hr`],["Evening Bonus",C(results[detail].evePay),T.amber,`${H(results[detail].eveningHours)} × +${C(rates.evening)}/hr`],["Overnight Bonus",C(results[detail].onPay),T.violet,`${H(results[detail].overnightHours)} × +${C(rates.overnight)}/hr`],["Gross Pay",C(results[detail].gross),T.amber,"Total before holdback"]].map(([l,v,c,sub])=>(
                      <div key={l} style={{background:T.bg,borderRadius:6,padding:12}}>
                        <div style={{fontSize:10,color:T.muted,marginBottom:4}}>{l.toUpperCase()}</div>
                        <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:17,color:c}}>{v}</div>
                        <div style={{fontSize:10,color:T.muted,marginTop:3}}>{sub}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",justifyContent:"flex-end",gap:20,padding:"10px 12px",background:T.bg,borderRadius:6,fontSize:12}}>
                    <span style={{color:T.dim}}>Holdback ({rates.holdback}%)</span>
                    <span style={{color:T.red}}>− {C(results[detail].holdback)}</span>
                    <span style={{color:T.dim,marginLeft:8}}>Net Payout</span>
                    <span style={{color:T.green,fontWeight:700,fontSize:14}}>{C(results[detail].net)}</span>
                  </div>
                </Card>
                <Card title="Shift-by-Shift Detail" action={<Btn small secondary onClick={()=>{const rows=[["Date","Shift","Regular Hrs","Evening Hrs","Overnight Hrs","Payable Hrs","Inv Hrs","Base Pay","Eve Bonus","ON Bonus","Gross","Overlap"],...results[detail].shiftDetails.map(s=>[s.date,s.shift,s.regularHours.toFixed(1),s.eveningHours.toFixed(1),s.overnightHours.toFixed(1),s.payableHours.toFixed(1),s.invoiceableHours.toFixed(1),s.basePay.toFixed(2),s.evePay.toFixed(2),s.onPay.toFixed(2),s.gross.toFixed(2),s.overlapDeducted||0])];downloadCSV(`${detail}_${periodLabel}.csv`,rows);}}>↓ CSV</Btn>}>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse"}}>
                      <thead><tr>{["Date","Shift","Regular","Evening","Overnight","Payable","Inv.","Base Pay","Eve Bonus","ON Bonus","Gross","Overlap"].map(h=><TH key={h} ch={h}/>)}</tr></thead>
                      <tbody>
                        {results[detail].shiftDetails.map((s,i)=>(
                          <tr key={i} style={{borderBottom:`1px solid ${T.bg}`}}>
                            <TD ch={s.date} color={T.dim}/><TD ch={s.shift}/>
                            <TD ch={H(s.regularHours)} color={T.dim}/>
                            <TD ch={H(s.eveningHours)} color={s.eveningHours?T.amber:T.muted}/>
                            <TD ch={H(s.overnightHours)} color={s.overnightHours?T.violet:T.muted}/>
                            <TD ch={H(s.payableHours)} color={T.accent} bold/>
                            <TD ch={H(s.invoiceableHours)} color={T.dim}/>
                            <TD ch={C(s.basePay)}/><TD ch={s.evePay?C(s.evePay):"—"} color={s.evePay?T.amber:T.muted}/>
                            <TD ch={s.onPay?C(s.onPay):"—"} color={s.onPay?T.violet:T.muted}/>
                            <TD ch={C(s.gross)} color={T.green} bold/>
                            <TD ch={s.overlapDeducted?`−${s.overlapDeducted}h`:"—"} color={s.overlapDeducted?T.red:T.muted}/>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr>
                        <TF ch="TOTALS" color={T.muted}/><TF ch=""/>
                        <TF ch={H(results[detail].regularHours)} color={T.dim}/>
                        <TF ch={H(results[detail].eveningHours)} color={T.amber}/>
                        <TF ch={H(results[detail].overnightHours)} color={T.violet}/>
                        <TF ch={H(results[detail].payableHours)} color={T.accent} bold/>
                        <TF ch={H(results[detail].invoiceableHours)} color={T.dim}/>
                        <TF ch={C(results[detail].basePay)} bold/>
                        <TF ch={C(results[detail].evePay)} color={T.amber} bold/>
                        <TF ch={C(results[detail].onPay)} color={T.violet} bold/>
                        <TF ch={C(results[detail].gross)} color={T.green} bold/>
                        <TF ch={results[detail].overlapHours?`−${results[detail].overlapHours}h`:"—"} color={T.red}/>
                      </tr></tfoot>
                    </table>
                  </div>
                </Card>
              </div>
            ) : (
              /* SUMMARY */
              <div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:10,marginBottom:20}}>
                  {[["Physicians",Object.keys(results).length,T.accent],["Regular Hrs",H(totals.regularHours),T.dim],["Evening Hrs",H(totals.eveningHours),T.amber],["Overnight Hrs",H(totals.overnightHours),T.violet],["Total Payable",H(totals.payableHours),T.accent],["Total Gross",C(totals.gross),T.amber],["Total Holdback",C(totals.holdback),T.red],["Total Net",C(totals.net),T.green]].map(([l,v,c])=>(
                    <div key={l} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:7,padding:12}}>
                      <div style={{fontSize:9,color:T.muted,letterSpacing:"0.1em",marginBottom:5}}>{l.toUpperCase()}</div>
                      <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:14,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",gap:8,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
                  {[["payroll","💰 Payroll Report"],["invoice","🏥 Health Authority Invoice"]].map(([id,lbl])=>(
                    <button key={id} onClick={()=>setReport(id)} style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:10,letterSpacing:"0.1em",textTransform:"uppercase",padding:"7px 16px",borderRadius:4,cursor:"pointer",border:reportView===id?"none":`1px solid ${T.border}`,background:reportView===id?T.accent:"transparent",color:reportView===id?"#fff":T.muted}}>{lbl}</button>
                  ))}
                  <div style={{marginLeft:"auto",display:"flex",gap:8}}>
                    <Btn small secondary onClick={()=>downloadCSV(`payroll_${periodLabel}.csv`,buildPayrollCSV(results,rates,periodLabel))}>↓ Payroll CSV</Btn>
                    <Btn small secondary onClick={()=>downloadCSV(`invoice_${periodLabel}.csv`,buildInvoiceCSV(results,rates,periodLabel))}>↓ Invoice CSV</Btn>
                    <Btn small secondary onClick={()=>window.print()}>🖨 Print</Btn>
                  </div>
                  {totals.overlapHours>0&&<span style={{fontSize:10,color:T.red}}>⚠ {H(totals.overlapHours)} shift overlap · {Object.values(results).filter(r=>r.overlapHours>0).length} physician(s)</span>}
                </div>

                {reportView==="payroll"&&(
                  <Card title={`Payroll Report — ${periodLabel}`}>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse"}}>
                        <thead><tr>
                          <TH ch="Physician"/><TH ch="Shifts" right/><TH ch="Regular Hrs" right/><TH ch="Evening Hrs" right/><TH ch="Overnight Hrs" right/>
                          <TH ch="Total Payable" right/><TH ch="Base Pay" right/><TH ch="Evening Bonus" right/><TH ch="Overnight Bonus" right/>
                          <TH ch="Gross Pay" right/><TH ch={`Holdback ${rates.holdback}%`} right/><TH ch="Net Payout" right/><TH ch=""/>
                        </tr></thead>
                        <tbody>
                          {Object.entries(results).sort((a,b)=>a[0].localeCompare(b[0])).map(([doc,r])=>(
                            <tr key={doc} className="dr" style={{borderBottom:`1px solid ${T.bg}`}} onClick={()=>setDetail(doc)}>
                              <td style={{padding:"7px 10px",fontSize:12,fontWeight:500,whiteSpace:"nowrap"}}>{doc}{r.overlapHours>0&&<OBadge/>}</td>
                              <TD ch={r.shiftCount} color={T.dim} right/><TD ch={H(r.regularHours)} color={T.dim} right/>
                              <TD ch={H(r.eveningHours)} color={r.eveningHours?T.amber:T.muted} right/>
                              <TD ch={H(r.overnightHours)} color={r.overnightHours?T.violet:T.muted} right/>
                              <TD ch={H(r.payableHours)} color={T.accent} bold right/>
                              <TD ch={C(r.basePay)} right/><TD ch={r.evePay?C(r.evePay):"—"} color={r.evePay?T.amber:T.muted} right/>
                              <TD ch={r.onPay?C(r.onPay):"—"} color={r.onPay?T.violet:T.muted} right/>
                              <TD ch={C(r.gross)} color={T.amber} bold right/>
                              <TD ch={`−${C(r.holdback)}`} color={T.red} right/>
                              <TD ch={C(r.net)} color={T.green} bold right/>
                              <TD ch="→" color={T.muted} sm/>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot><tr>
                          <TF ch="TOTALS" color={T.muted}/><TF ch={totals.shifts} color={T.dim} right/>
                          <TF ch={H(totals.regularHours)} color={T.dim} right/><TF ch={H(totals.eveningHours)} color={T.amber} right/>
                          <TF ch={H(totals.overnightHours)} color={T.violet} right/><TF ch={H(totals.payableHours)} color={T.accent} bold right/>
                          <TF ch={C(totals.basePay)} bold right/><TF ch={C(totals.evePay)} color={T.amber} bold right/>
                          <TF ch={C(totals.onPay)} color={T.violet} bold right/><TF ch={C(totals.gross)} color={T.amber} bold right/>
                          <TF ch={`−${C(totals.holdback)}`} color={T.red} bold right/><TF ch={C(totals.net)} color={T.green} bold right/>
                          <TF ch=""/>
                        </tr></tfoot>
                      </table>
                    </div>
                    <div style={{fontSize:10,color:T.muted,marginTop:10}}>Click any row for shift-by-shift detail</div>
                  </Card>
                )}

                {reportView==="invoice"&&(
                  <Card title={`Health Authority Invoice — ${periodLabel}`}>
                    <div style={{padding:10,background:T.bg,borderRadius:6,fontSize:11,color:T.dim,lineHeight:1.8,marginBottom:14}}>
                      Invoiceable hours = actual clock hours worked, overlap deducted, weekend duplicates removed.
                      {totals.overlapHours>0&&<span style={{color:T.red}}> {H(totals.overlapHours)} overlapping time excluded.</span>}
                      {collapseLog.length>0&&<span style={{color:T.amber}}> {collapseLog.length} weekend duplicate shift(s) suppressed.</span>}
                    </div>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse"}}>
                        <thead><tr>
                          <TH ch="Physician"/><TH ch="Invoiceable Hrs" right/>
                          <TH ch={`Regular @ ${C(rates.base)}/hr`} right/>
                          <TH ch={`Evening @ +${C(rates.evening)}/hr`} right/>
                          <TH ch={`Overnight @ +${C(rates.overnight)}/hr`} right/>
                          <TH ch="Overlap Deducted" right/><TH ch="Total Invoiced" right/>
                        </tr></thead>
                        <tbody>
                          {Object.entries(results).sort((a,b)=>a[0].localeCompare(b[0])).map(([doc,r])=>{
                            const inv=r.invoiceableHours*rates.base+r.evePay+r.onPay;
                            return(<tr key={doc} className="dr" style={{borderBottom:`1px solid ${T.bg}`}} onClick={()=>setDetail(doc)}>
                              <td style={{padding:"7px 10px",fontSize:12,fontWeight:500}}>{doc}{r.overlapHours>0&&<OBadge/>}</td>
                              <TD ch={H(r.invoiceableHours)} color={T.accent} bold right/>
                              <TD ch={C(r.invoiceableHours*rates.base)} right/>
                              <TD ch={r.evePay?C(r.evePay):"—"} color={r.evePay?T.amber:T.muted} right/>
                              <TD ch={r.onPay?C(r.onPay):"—"} color={r.onPay?T.violet:T.muted} right/>
                              <TD ch={r.overlapHours?`−${r.overlapHours}h`:"—"} color={r.overlapHours?T.red:T.muted} right/>
                              <TD ch={C(inv)} color={T.green} bold right/>
                            </tr>);
                          })}
                        </tbody>
                        <tfoot>{(()=>{const ti=totals.invoiceableHours*rates.base+totals.evePay+totals.onPay;return(<tr>
                          <TF ch="TOTALS" color={T.muted}/>
                          <TF ch={H(totals.invoiceableHours)} color={T.accent} bold right/>
                          <TF ch={C(totals.invoiceableHours*rates.base)} bold right/>
                          <TF ch={C(totals.evePay)} color={T.amber} bold right/>
                          <TF ch={C(totals.onPay)} color={T.violet} bold right/>
                          <TF ch={totals.overlapHours?`−${totals.overlapHours}h`:"—"} color={T.red} right/>
                          <TF ch={C(ti)} color={T.green} bold right/>
                        </tr>);})()}</tfoot>
                      </table>
                    </div>
                    <div style={{fontSize:10,color:T.muted,marginTop:10}}>Click any row for shift-by-shift detail</div>
                  </Card>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
