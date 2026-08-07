const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ============================================================
// CONFIGURATION RESOLVED FROM TALLY
// ============================================================
const TALLY_URL = 'http://103.218.127.45:9000/';
const tallyUrlObj = new URL(TALLY_URL);

const COMPANY_NAME_FILTER = 'VINAYAK ENTERPRISES';

// --- Scheduler window ---
const SCHEDULE_START_HOUR = 9;
const SCHEDULE_START_MIN = 30;
const SCHEDULE_END_HOUR = 18;
const SCHEDULE_END_MIN = 30;
const SCHEDULE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Where the "last known good" JSON snapshot is stored
const STATE_DIR = path.join(__dirname, 'tally-sync-state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// Where exported PDFs are permanently saved
const PDF_DIR = path.join(__dirname, '..', 'pdfs');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

function stateFilePath(type, dateStr) {
  return path.join(STATE_DIR, `last-sync-${type}-${dateStr}.json`);
}

// ============================================================
// TALLY XML TEMPLATES
// ============================================================
const GET_COMPANIES_XML = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>Company</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <FETCHLIST>
        <FETCH>Name</FETCH>
        <FETCH>StartingFrom</FETCH>
        <FETCH>EndingAt</FETCH>
      </FETCHLIST>
    </DESC>
  </BODY>
</ENVELOPE>
`;

const PURCHASE_ORDERS_XML = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>PurchaseOrderCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="PurchaseOrderCollection" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>Date</FETCH>
            <FETCH>VoucherNumber</FETCH>
            <FETCH>GUID</FETCH>
            <FETCH>PartyLedgerName</FETCH>
            <FETCH>ALLINVENTORYENTRIES.STOCKITEMNAME</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BILLEDQTY</FETCH>
            <FETCH>ALLINVENTORYENTRIES.RATE</FETCH>
            <FETCH>ALLINVENTORYENTRIES.AMOUNT</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BASICUSERDESCRIPTION</FETCH>
            <FETCH>ALLINVENTORYENTRIES.ADDITIONALDESCRIPTION</FETCH>
            <FETCH>ALLLEDGERENTRIES.LEDGERNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.AMOUNT</FETCH>
            <FETCH>ALLLEDGERENTRIES.ISDEEMEDPOSITIVE</FETCH>
            <FILTER>IsPurchaseOrder</FILTER>
            <FILTER>DateFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="IsPurchaseOrder">
            $VoucherTypeName = "Purchase Order"
          </SYSTEM>
          <SYSTEM TYPE="Formulae" NAME="DateFilter">
            $Date &gt;= ##SVFromDate and $Date &lt;= ##SVToDate
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

const SALES_ORDERS_XML = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>SalesOrderCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="SalesOrderCollection" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>Date</FETCH>
            <FETCH>VoucherNumber</FETCH>
            <FETCH>GUID</FETCH>
            <FETCH>PartyLedgerName</FETCH>
            <FETCH>ALLINVENTORYENTRIES.STOCKITEMNAME</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BILLEDQTY</FETCH>
            <FETCH>ALLINVENTORYENTRIES.RATE</FETCH>
            <FETCH>ALLINVENTORYENTRIES.AMOUNT</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BASICUSERDESCRIPTION</FETCH>
            <FETCH>ALLINVENTORYENTRIES.ADDITIONALDESCRIPTION</FETCH>
            <FETCH>ALLLEDGERENTRIES.LEDGERNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.AMOUNT</FETCH>
            <FETCH>ALLLEDGERENTRIES.ISDEEMEDPOSITIVE</FETCH>
            <FILTER>IsSalesOrder</FILTER>
            <FILTER>DateFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="IsSalesOrder">
            $VoucherTypeName = "Sales Order"
          </SYSTEM>
          <SYSTEM TYPE="Formulae" NAME="DateFilter">
            $Date &gt;= ##SVFromDate and $Date &lt;= ##SVToDate
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

const SALES_INVOICES_XML = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>SalesInvoiceCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="SalesInvoiceCollection" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>Date</FETCH>
            <FETCH>VoucherNumber</FETCH>
            <FETCH>GUID</FETCH>
            <FETCH>PartyLedgerName</FETCH>
            <FETCH>ALLINVENTORYENTRIES.STOCKITEMNAME</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BILLEDQTY</FETCH>
            <FETCH>ALLINVENTORYENTRIES.RATE</FETCH>
            <FETCH>ALLINVENTORYENTRIES.AMOUNT</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BASICUSERDESCRIPTION</FETCH>
            <FETCH>ALLINVENTORYENTRIES.ADDITIONALDESCRIPTION</FETCH>
            <FETCH>ALLLEDGERENTRIES.LEDGERNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.AMOUNT</FETCH>
            <FETCH>ALLLEDGERENTRIES.ISDEEMEDPOSITIVE</FETCH>
            <FILTER>IsSalesInvoice</FILTER>
            <FILTER>DateFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="IsSalesInvoice">
            $VoucherTypeName = "Sales"
          </SYSTEM>
          <SYSTEM TYPE="Formulae" NAME="DateFilter">
            $Date &gt;= ##SVFromDate and $Date &lt;= ##SVToDate
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
`;

// ============================================================
// UTILITY METHODS
// ============================================================
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function injectCompanyInXml(xmlStr, companyName, periodStart, periodEnd) {
  const staticVariables = [
    companyName && `  <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`,
    periodStart && `  <SVFROMDATE TYPE="Date">${escapeXml(periodStart)}</SVFROMDATE>`,
    periodEnd && `  <SVTODATE TYPE="Date">${escapeXml(periodEnd)}</SVTODATE>`
  ].filter(Boolean).join('\n      ');

  if (!staticVariables) return xmlStr;

  return xmlStr.replace(
    /<\/STATICVARIABLES>/i,
    `${staticVariables}\n      </STATICVARIABLES>`
  );
}

// ============================================================
// XML PARSERS
// ============================================================
function parseCompanies(xmlText) {
  const companies = [];
  const compRegex = /<COMPANY\b[^>]*>(.*?)<\/COMPANY>/gis;
  let match;
  while ((match = compRegex.exec(xmlText)) !== null) {
    const compContent = match[1];
    const nameMatch = compContent.match(/<NAME\b[^>]*>(.*?)<\/NAME>/i);
    const startingMatch = compContent.match(/<STARTINGFROM\b[^>]*>(.*?)<\/STARTINGFROM>/i);
    const endingMatch = compContent.match(/<ENDINGAT\b[^>]*>(.*?)<\/ENDINGAT>/i);

    const name = nameMatch ? nameMatch[1].trim() : '';
    const startingfrom = startingMatch ? startingMatch[1].trim() : '';
    const endingat = endingMatch ? endingMatch[1].trim() : '';

    if (name) {
      companies.push({ name, startingfrom, endingat });
    }
  }
  return companies;
}

function parseVouchers(xmlText) {
  const vouchers = [];
  const voucherRegex = /<VOUCHER\b[^>]*>(.*?)<\/VOUCHER>/gs;
  let match;

  while ((match = voucherRegex.exec(xmlText)) !== null) {
    const vContent = match[1];

    const dateMatch = vContent.match(/<DATE\b[^>]*>(.*?)<\/DATE>/i);
    const date = dateMatch ? dateMatch[1].trim() : '';

    const guidMatch = vContent.match(/<GUID\b[^>]*>(.*?)<\/GUID>/i);
    const guid = guidMatch ? guidMatch[1].trim() : '';

    const vNumMatch = vContent.match(/<VOUCHERNUMBER\b[^>]*>(.*?)<\/VOUCHERNUMBER>/i);
    const vouchernumber = vNumMatch ? vNumMatch[1].trim() : '';

    const partyMatch = vContent.match(/<PARTYLEDGERNAME\b[^>]*>(.*?)<\/PARTYLEDGERNAME>/i);
    const partyledgername = partyMatch ? partyMatch[1].trim() : '';

    const inventoryEntries = [];
    const invRegex = /<(?:ALL)?INVENTORYENTRIES\.LIST\b[^>]*>(.*?)<\/(?:ALL)?INVENTORYENTRIES\.LIST>/gs;
    let invMatch;
    while ((invMatch = invRegex.exec(vContent)) !== null) {
      const invContent = invMatch[1];
      const stockItemMatch = invContent.match(/<STOCKITEMNAME\b[^>]*>(.*?)<\/STOCKITEMNAME>/i);
      const billedQtyMatch = invContent.match(/<BILLEDQTY\b[^>]*>(.*?)<\/BILLEDQTY>/i);
      const actualQtyMatch = invContent.match(/<ACTUALQTY\b[^>]*>(.*?)<\/ACTUALQTY>/i);
      const rateMatch = invContent.match(/<RATE\b[^>]*>(.*?)<\/RATE>/i);
      const amountMatch = invContent.match(/<AMOUNT\b[^>]*>(.*?)<\/AMOUNT>/i);

      const stockitemname = stockItemMatch ? stockItemMatch[1].trim() : '';
      const billedqty = billedQtyMatch ? billedQtyMatch[1].trim() : (actualQtyMatch ? actualQtyMatch[1].trim() : '');
      const rate = rateMatch ? rateMatch[1].trim() : '';
      const amount = amountMatch ? amountMatch[1].trim() : '';

      let description = '';
      const descRegex = /<ADDITIONALDESCRIPTION\b[^>]*>(.*?)<\/ADDITIONALDESCRIPTION>/gi;
      let descMatch;
      const descriptions = [];
      while ((descMatch = descRegex.exec(invContent)) !== null) {
        descriptions.push(descMatch[1].trim());
      }
      if (descriptions.length > 0) {
        description = descriptions.join(', ');
      } else {
        const basicDescMatch = invContent.match(/<BASICUSERDESCRIPTION\b[^>]*>(.*?)<\/BASICUSERDESCRIPTION>/i);
        if (basicDescMatch) description = basicDescMatch[1].trim();
      }

      if (stockitemname) {
        inventoryEntries.push({ stockitemname, billedqty, rate, amount, description });
      }
    }

    const ledgerEntries = [];
    const ledRegex = /<(?:ALL)?LEDGERENTRIES\.LIST\b[^>]*>(.*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gs;
    let ledMatch;
    while ((ledMatch = ledRegex.exec(vContent)) !== null) {
      const ledContent = ledMatch[1];
      const ledgerNameMatch = ledContent.match(/<LEDGERNAME\b[^>]*>(.*?)<\/LEDGERNAME>/i);
      const amountMatch = ledContent.match(/<AMOUNT\b[^>]*>(.*?)<\/AMOUNT>/i);
      const isDeemedPosMatch = ledContent.match(/<ISDEEMEDPOSITIVE\b[^>]*>(.*?)<\/ISDEEMEDPOSITIVE>/i);

      const ledgername = ledgerNameMatch ? ledgerNameMatch[1].trim() : '';
      const amount = amountMatch ? amountMatch[1].trim() : '';
      const isdeemedpositive = isDeemedPosMatch ? isDeemedPosMatch[1].trim() : '';

      if (ledgername) {
        ledgerEntries.push({ ledgername, amount, isdeemedpositive });
      }
    }

    vouchers.push({ date, guid, partyledgername, inventoryEntries, ledgerEntries, vouchernumber });
  }

  return vouchers;
}

function flattenVouchers(vouchers) {
  const rows = [];
  vouchers.forEach(v => {
    const taxLedgers = v.ledgerEntries.filter(le => {
      const name = le.ledgername.toUpperCase();
      return name.includes('CGST') || name.includes('SGST') || name.includes('IGST') || name.includes('UTGST') || name.includes('GST') || name.includes('TAX');
    });

    const uniqueTaxLedgers = [];
    const seenNames = new Set();
    taxLedgers.forEach(tl => {
      if (!seenNames.has(tl.ledgername)) {
        seenNames.add(tl.ledgername);
        uniqueTaxLedgers.push(tl);
      }
    });

    let totalItemVal = 0;
    v.inventoryEntries.forEach(item => {
      const val = Math.abs(parseFloat((item.amount || '0').replace(/[^0-9.-]/g, ''))) || 0;
      totalItemVal += val;
    });

    v.inventoryEntries.forEach(item => {
      const itemAmt = Math.abs(parseFloat((item.amount || '0').replace(/[^0-9.-]/g, ''))) || 0;
      const share = totalItemVal > 0 ? itemAmt / totalItemVal : 0;

      let taxAmtSum = 0;
      const taxDetails = [];
      const taxTypes = new Set();
      let maxRate = 0;

      uniqueTaxLedgers.forEach(tl => {
        const tlAmt = Math.abs(parseFloat((tl.amount || '0').replace(/[^0-9.-]/g, ''))) || 0;
        const allocatedTlAmt = tlAmt * share;
        taxAmtSum += allocatedTlAmt;

        const rateMatch = tl.ledgername.match(/(\d+(?:\.\d+)?)\s*%/);
        const rate = rateMatch ? parseFloat(rateMatch[1]) : 0;
        maxRate += rate;

        let type = 'Tax';
        if (tl.ledgername.toUpperCase().includes('CGST')) type = 'CGST';
        else if (tl.ledgername.toUpperCase().includes('SGST')) type = 'SGST';
        else if (tl.ledgername.toUpperCase().includes('IGST')) type = 'IGST';
        else if (tl.ledgername.toUpperCase().includes('UTGST')) type = 'UTGST';
        else if (tl.ledgername.toUpperCase().includes('GST')) type = 'GST';

        taxTypes.add(type);
        taxDetails.push(`${tl.ledgername}: ₹${allocatedTlAmt.toFixed(2)}`);
      });

      const taxCalculationStr = taxDetails.join(', ') || 'No Tax';
      const taxTypeStr = Array.from(taxTypes).join(' + ') || 'N/A';
      const taxRateStr = maxRate > 0 ? `${maxRate}%` : '0%';
      const totalAmount = itemAmt + taxAmtSum;

      rows.push({
        guid: v.guid || '',
        orderno: v.vouchernumber || 'N/A',
        date: v.date,
        partyname: v.partyledgername || 'N/A',
        itemname: item.stockitemname || 'N/A',
        quantity: item.billedqty || '0',
        rate: item.rate || '₹0.00',
        amount: item.amount || '₹0.00',
        description: item.description || '-',
        taxcalculation: taxCalculationStr,
        taxtype: taxTypeStr,
        taxrate: taxRateStr,
        totalamount: totalAmount.toFixed(2)
      });
    });
  });
  return rows;
}

// ============================================================
// FINANCIAL YEAR & COMPANY RESOLUTION
// ============================================================
function getCurrentFinancialYearStrings() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  let startYear, endYear;
  if (month >= 3) {
    startYear = year;
    endYear = year + 1;
  } else {
    startYear = year - 1;
    endYear = year;
  }

  const startShort = String(startYear).slice(-2);
  const endShort = String(endYear).slice(-2);

  return {
    full: `${startYear}-${endYear}`,
    short: `${startShort}-${endShort}`,
    assessmentFull: `${endYear}-${endYear + 1}`,
    assessmentShort: `${endShort}-${String(endYear + 1).slice(-2)}`,
    startYear,
    endYear
  };
}

function findBestMatchingCompany(companyList) {
  const validCompanies = companyList.filter(c => {
    const name = (c.name || '').trim().toUpperCase();
    return name !== '' && name !== 'UNKNOWN COMPANY';
  });
  if (validCompanies.length === 0) return null;

  const fy = getCurrentFinancialYearStrings();
  let candidates = validCompanies;
  let nameFilterMatched = true;

  if (COMPANY_NAME_FILTER) {
    const filtered = validCompanies.filter(c => c.name.toUpperCase().includes(COMPANY_NAME_FILTER));
    if (filtered.length > 0) {
      candidates = filtered;
    } else {
      nameFilterMatched = false;
    }
  }

  let match = candidates.find(c => c.name.includes(fy.short) || c.name.includes(fy.full));
  if (!match) match = candidates.find(c => c.name.includes(fy.assessmentShort) || c.name.includes(fy.assessmentFull));
  if (!match) match = candidates.find(c => c.name.includes(String(fy.startYear)) || c.name.includes(String(fy.endYear)));

  if (!nameFilterMatched || !match) {
    console.error('\n===================================================================');
    console.error(' 🟡 ALERT 3: Wrong company is open in Tally.');
    console.error('===================================================================');
    console.error(`    Expected: an open company named "${COMPANY_NAME_FILTER}" for the`);
    console.error(`    current year (FY ${fy.full} / AY ${fy.assessmentFull}).`);
    console.error(`    Currently open companies: ${validCompanies.map(c => c.name).join(', ') || 'none'}`);
    console.error('    👉 If Tally has a different company name instead of "Vinayak');
    console.error('       Enterprises" for the current working year (assessment year');
    console.error('       or financial year on which you are working this year),');
    console.error('       please rename it (or open the correct company).');
    console.error('===================================================================\n');
  }

  return match || candidates[0] || null;
}

// ============================================================
// TALLY HTTP CLIENT
// ============================================================
let tallyQueue = Promise.resolve();

function queueTallyRequest(payload, timeoutMs) {
  const run = () => rawFetchFromTally(payload, timeoutMs);
  const result = tallyQueue.then(run, run);
  tallyQueue = result.catch(() => { }).then(() => sleep(400));
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rawFetchFromTally(payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = Buffer.from(payload, 'utf8');

    const options = {
      hostname: tallyUrlObj.hostname,
      port: tallyUrlObj.port || 9000,
      path: tallyUrlObj.pathname || '/',
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': bodyBuffer.length,
        'Connection': 'close'
      },
      timeout: timeoutMs
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy(new Error('Tally request timed out'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(bodyBuffer);
    req.end();
  });
}

async function fetchFromTallyWithRetry(payload, { retries = 2, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await queueTallyRequest(payload, timeoutMs);
    } catch (err) {
      lastErr = err;
      console.warn(`[Tally Sync] Request attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

// ============================================================
// GENERAL UTILS EXPORTED
// ============================================================
function getEffectiveQueryDate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function hashJson(obj) {
  const str = JSON.stringify(obj);
  return crypto.createHash('sha256').update(str).digest('hex');
}

function loadLastSnapshot(type, dateStr) {
  const file = stateFilePath(type, dateStr);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[State] Could not read previous snapshot for ${type} on ${dateStr}: ${err.message}`);
    return null;
  }
}

function saveSnapshot(type, dateStr, hash, data) {
  const file = stateFilePath(type, dateStr);
  const payload = { hash, savedAt: new Date().toISOString(), data };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

function postJson(urlStr, jsonBody) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const bodyBuffer = Buffer.from(JSON.stringify(jsonBody), 'utf8');

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuffer.length
      },
      timeout: 20000
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.on('timeout', () => req.destroy(new Error('Push API request timed out')));
    req.on('error', reject);

    req.write(bodyBuffer);
    req.end();
  });
}

/**
 * Sends a multipart/form-data POST request containing pdf-file binary and sale_order JSON field.
 */
async function postMultipart(urlStr, pdfFilePath, fileName, salesOrdersData) {
  const formData = new FormData();

  if (pdfFilePath && fs.existsSync(pdfFilePath)) {
    const pdfBuffer = fs.readFileSync(pdfFilePath);
    const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
    formData.append('pdf-file', pdfBlob, fileName || path.basename(pdfFilePath));
  }

  formData.append('sale_order', JSON.stringify(salesOrdersData));

  const res = await fetch(urlStr, {
    method: 'POST',
    body: formData
  });

  const bodyText = await res.text();
  return {
    statusCode: res.status,
    body: bodyText
  };
}

function isWithinScheduleWindow(date = new Date()) {
  const minutesNow = date.getHours() * 60 + date.getMinutes();
  const startMinutes = SCHEDULE_START_HOUR * 60 + SCHEDULE_START_MIN;
  const endMinutes = SCHEDULE_END_HOUR * 60 + SCHEDULE_END_MIN;
  return minutesNow >= startMinutes && minutesNow <= endMinutes;
}

// Fetch general open company helper so modules can re-use it
async function getTallySelectedCompany() {
  let compXml;
  try {
    compXml = await fetchFromTallyWithRetry(GET_COMPANIES_XML);
  } catch (connErr) {
    console.error('\n===================================================================');
    console.error(' 🔴 ALERT 1: Tally is NOT open / not reachable.');
    console.error('===================================================================');
    console.error(`    Could not connect to ${TALLY_URL}`);
    console.error(`    (${connErr.message})`);
    console.error('    👉 Please open Tally on the server.');
    console.error('===================================================================\n');
    return null;
  }

  const rawCompanies = parseCompanies(compXml);
  const openCompanies = rawCompanies.filter(c => {
    const name = (c.name || '').trim().toUpperCase();
    return name !== '' && name !== 'UNKNOWN COMPANY';
  });

  if (openCompanies.length === 0) {
    console.error('\n===================================================================');
    console.error(' 🟠 ALERT 2: Tally is open, but no company is selected.');
    console.error('===================================================================');
    console.error('    👉 Please open Tally and select a company.');
    console.error('===================================================================\n');
    return null;
  }

  const selectedCompany = findBestMatchingCompany(openCompanies);
  if (!selectedCompany) {
    console.error('\n❌ [Tally Sync Error] Could not determine a company to use.');
    return null;
  }
  return selectedCompany;
}

const { execFileSync } = require('child_process');

/**
 * Programmatically exports a specific Tally voucher as a PDF file
 * by querying Tally in HTML format first, rendering to PDF via Microsoft Edge,
 * and permanently saving the PDF file in the project `pdfs` directory.
 */
async function exportVoucherAsPdf(voucherKey, companyName, fileName) {
  const printXml = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Voucher</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:HTML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>
        <SVOPENFILEAFTEREXPORT>No</SVOPENFILEAFTEREXPORT>
        <VOUCHERKEY>${escapeXml(voucherKey)}</VOUCHERKEY>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>
  `;

  try {
    const htmlBuffer = await fetchFromTallyWithRetry(printXml);
    
    const tempHtmlPath = path.join(STATE_DIR, `temp-${voucherKey}.html`);
    
    // Sanitize output PDF filename if provided (e.g. order number SO-2026/08/001 -> SO-2026_08_001.pdf)
    const sanitizedName = fileName
      ? fileName.replace(/[/\\?%*:|"<>]/g, '_').trim()
      : voucherKey;
    const finalPdfPath = path.join(PDF_DIR, `${sanitizedName}.pdf`);
    
    fs.writeFileSync(tempHtmlPath, htmlBuffer);

    try {
      execFileSync("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        `--print-to-pdf=${finalPdfPath}`,
        tempHtmlPath
      ], { stdio: 'ignore' });
      
      if (fs.existsSync(finalPdfPath)) {
        const pdfBuffer = fs.readFileSync(finalPdfPath);
        return pdfBuffer.toString('base64');
      } else {
        console.warn(`[PDF Export Error] PDF was not generated for key: ${voucherKey}`);
        return null;
      }
    } finally {
      try {
        if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  } catch (err) {
    console.error(`[PDF Export Exception] ${err.message}`);
    return null;
  }
}

module.exports = {
  TALLY_URL,
  tallyUrlObj,
  GET_COMPANIES_XML,
  PURCHASE_ORDERS_XML,
  SALES_ORDERS_XML,
  SALES_INVOICES_XML,
  injectCompanyInXml,
  parseCompanies,
  parseVouchers,
  flattenVouchers,
  getCurrentFinancialYearStrings,
  findBestMatchingCompany,
  fetchFromTallyWithRetry,
  getEffectiveQueryDate,
  hashJson,
  loadLastSnapshot,
  saveSnapshot,
  postJson,
  postMultipart,
  isWithinScheduleWindow,
  getTallySelectedCompany,
  exportVoucherAsPdf,
  PDF_DIR,
  sleep,
  SCHEDULE_INTERVAL_MS,
  SCHEDULE_START_HOUR,
  SCHEDULE_START_MIN,
  SCHEDULE_END_HOUR,
  SCHEDULE_END_MIN
};
