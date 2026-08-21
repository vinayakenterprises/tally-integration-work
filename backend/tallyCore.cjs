require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const axios = require('axios');
const FormData = require('form-data');

// ============================================================
// CONFIGURATION RESOLVED FROM TALLY
// ============================================================
const TALLY_URL = process.env.TALLY_URL || 'http://103.218.127.45:9000/';
const tallyUrlObj = new URL(TALLY_URL);

const COMPANY_NAME_FILTER = 'VINAYAK ENTERPRISES';

// --- Scheduler window ---
const SCHEDULE_START_HOUR = parseInt(process.env.SCHEDULE_START_HOUR || '9', 10);
const SCHEDULE_START_MIN = parseInt(process.env.SCHEDULE_START_MIN || '30', 10);
const SCHEDULE_END_HOUR = parseInt(process.env.SCHEDULE_END_HOUR || '18', 10);
const SCHEDULE_END_MIN = parseInt(process.env.SCHEDULE_END_MIN || '30', 10);
const SCHEDULE_INTERVAL_MS = parseInt(process.env.SCHEDULE_INTERVAL_MS || String(1 * 60 * 1000), 10);

const { STATE_DIR, hashJson, loadLastSnapshot, saveSnapshot, saveOutgoingJson } = require('./utils/syncState.cjs');
const { PDF_DIR, generatePdfFromHtml } = require('./utils/pdfGenerator.cjs');
const { GST_STATE_CODES, getStateFromGstin, getCompanyFYSuffix, escapeXml } = require('./utils/formatters.cjs');

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
        <FETCH>Address</FETCH>
        <FETCH>StateName</FETCH>
        <FETCH>PinCode</FETCH>
        <FETCH>Telephone</FETCH>
        <FETCH>Email</FETCH>
        <FETCH>IncomeTaxNumber</FETCH>
        <FETCH>CompanyGSTIN</FETCH>
      </FETCHLIST>
    </DESC>
  </BODY>
</ENVELOPE>
`;

const BANK_LEDGERS_XML = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>BankLedgerCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="BankLedgerCollection" ISINITIALIZE="Yes">
            <TYPE>Ledger</TYPE>
            <FETCH>Name, BankDetails</FETCH>
            <FILTER>IsBank</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="IsBank">
            $IsBankLedger OR $IsBankOD
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
            <FETCH>PARTYGSTIN</FETCH>
            <FETCH>BASICBUYERNAME</FETCH>
            <FETCH>BASICBUYERADDRESS</FETCH>
            <FETCH>ADDRESS</FETCH>
            <FETCH>CONSIGNEEMAILINGNAME</FETCH>
            <FETCH>CONSIGNEEADDRESS</FETCH>
            <FETCH>CONSIGNEEGSTIN</FETCH>
            <FETCH>PARTYSTATENAME</FETCH>
            <FETCH>CONSIGNEESTATENAME</FETCH>
            <FETCH>BASICSHIPPEDBY</FETCH>
            <FETCH>BASICPLACEBEFOREDELIVERY</FETCH>
            <FETCH>BASICPAYMENTTERMS</FETCH>
            <FETCH>TERMSOFDELIVERY</FETCH>
            <FETCH>BASICMOTORVEHICLENO</FETCH>
            <FETCH>BASICSHIPDOCUMENTNO</FETCH>
            <FETCH>ALLINVENTORYENTRIES.STOCKITEMNAME</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BILLEDQTY</FETCH>
            <FETCH>ALLINVENTORYENTRIES.ACTUALUOM</FETCH>
            <FETCH>ALLINVENTORYENTRIES.RATE</FETCH>
            <FETCH>ALLINVENTORYENTRIES.DISCOUNT</FETCH>
            <FETCH>ALLINVENTORYENTRIES.AMOUNT</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BASICUSERDESCRIPTION</FETCH>
            <FETCH>ALLINVENTORYENTRIES.ADDITIONALDESCRIPTION</FETCH>
            <FETCH>ALLINVENTORYENTRIES.HSNCODE</FETCH>
            <FETCH>ALLINVENTORYENTRIES.DUEON</FETCH>
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


// ============================================================
// UTILITY METHODS
// ============================================================

function wrapText(value, maxChars) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  words.forEach((word) => {
    if (line && (line.length + 1 + word.length) > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  });

  if (line) lines.push(line);
  return lines.length ? lines : [''];
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

    const extract = (tag) => {
      const reg = new RegExp(`<${tag}\\b[^>]*>(.*?)<\\/${tag}>`, 'is');
      const m = compContent.match(reg);
      return m ? m[1].replace(/&#4;|<[^>]+>/g, '\n').trim() : '';
    };

    const name = extract('NAME');
    const startingfrom = extract('STARTINGFROM');
    const endingat = extract('ENDINGAT');

    // Some tags can be multiple like Address, so we grab all inner text
    const rawAddress = extract('ADDRESS');
    const address = rawAddress ? rawAddress.split('\n').map(s => s.trim()).filter(Boolean).join(', ') : '';

    const statename = extract('STATENAME');
    const pincode = extract('PINCODE');
    const telephone = extract('TELEPHONE');
    const email = extract('EMAIL');
    const pan = extract('INCOMETAXNUMBER');
    const gstin = extract('COMPANYGSTIN');

    if (name) {
      companies.push({
        name, startingfrom, endingat,
        address, statename, pincode, telephone, email, pan, gstin
      });
    }
  }
  return companies;
}

function parseBankLedgers(xmlText) {
  const banks = [];
  const ledRegex = /<LEDGER\b[^>]*>(.*?)<\/LEDGER>/gis;
  let match;
  while ((match = ledRegex.exec(xmlText)) !== null) {
    const ledContent = match[1];

    const extract = (tag) => {
      const reg = new RegExp(`<${tag}\\b[^>]*>(.*?)<\\/${tag}>`, 'is');
      const m = ledContent.match(reg);
      return m ? m[1].replace(/&#4;|<[^>]+>/g, '\n').trim() : '';
    };

    const name = extract('NAME');
    const accountName = extract('FAVOURINGNAME') || extract('ACCOUNTHOLDERNAME');
    const accountNo = extract('ACCOUNTNUMBER') || extract('BANKACCOUNTNUMBER');
    const ifsc = extract('IFSCODE');
    const swift = extract('SWIFTCODE');
    const bankName = extract('BANKNAME');

    if (name) {
      banks.push({ name, accountName, accountNo, ifsc, swift, bankName });
    }
  }
  return banks;
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

    const partygstinMatch = vContent.match(/<PARTYGSTIN\b[^>]*>(.*?)<\/PARTYGSTIN>/i);
    const partygstin = partygstinMatch ? partygstinMatch[1].trim() : '';

    const buyernameMatch = vContent.match(/<BASICBUYERNAME\b[^>]*>(.*?)<\/BASICBUYERNAME>/i);
    const buyername = buyernameMatch ? buyernameMatch[1].trim() : '';

    const consigneenameMatch = vContent.match(/<CONSIGNEEMAILINGNAME\b[^>]*>(.*?)<\/CONSIGNEEMAILINGNAME>/i);
    const consigneename = consigneenameMatch ? consigneenameMatch[1].trim() : '';

    const consigneegstinMatch = vContent.match(/<CONSIGNEEGSTIN\b[^>]*>(.*?)<\/CONSIGNEEGSTIN>/i);
    const consigneegstin = consigneegstinMatch ? consigneegstinMatch[1].trim() : '';

    const shippedbyMatch = vContent.match(/<BASICSHIPPEDBY\b[^>]*>(.*?)<\/BASICSHIPPEDBY>/i);
    const shippedby = shippedbyMatch ? shippedbyMatch[1].trim() : '';

    const destinationMatch = vContent.match(/<BASICPLACEBEFOREDELIVERY\b[^>]*>(.*?)<\/BASICPLACEBEFOREDELIVERY>/i);
    const destination = destinationMatch ? destinationMatch[1].trim() : '';

    const paymenttermsMatch = vContent.match(/<BASICPAYMENTTERMS\b[^>]*>(.*?)<\/BASICPAYMENTTERMS>/i);
    const paymentterms = paymenttermsMatch ? paymenttermsMatch[1].trim() : '';

    const shipdocnoMatch = vContent.match(/<BASICSHIPDOCUMENTNO\b[^>]*>(.*?)<\/BASICSHIPDOCUMENTNO>/i);
    const shipdocno = shipdocnoMatch ? shipdocnoMatch[1].trim() : '';

    const buyeraddress = [];
    const baRegex = /<BASICBUYERADDRESS\b[^>]*>(.*?)<\/BASICBUYERADDRESS>/gi;
    let baMatch;
    while ((baMatch = baRegex.exec(vContent)) !== null) {
      buyeraddress.push(baMatch[1].trim());
    }

    const consigneeaddress = [];
    const caRegex = /<CONSIGNEEADDRESS\b[^>]*>(.*?)<\/CONSIGNEEADDRESS>/gi;
    let caMatch;
    while ((caMatch = caRegex.exec(vContent)) !== null) {
      consigneeaddress.push(caMatch[1].trim());
    }

    const ledgeraddress = [];
    const addrRegex = /<ADDRESS\b[^>]*>(.*?)<\/ADDRESS>/gi;
    let addrMatch;
    while ((addrMatch = addrRegex.exec(vContent)) !== null) {
      ledgeraddress.push(addrMatch[1].trim());
    }

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

    if (guid || vouchernumber) {
      vouchers.push({
        date,
        guid,
        partyledgername,
        inventoryEntries,
        ledgerEntries,
        vouchernumber,
        partygstin,
        buyername,
        buyeraddress,
        consigneename,
        consigneeaddress,
        consigneegstin,
        shippedby,
        destination,
        paymentterms,
        shipdocno,
        ledgeraddress
      });
    }
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
    req.on('error', (err) => reject(err));
    req.write(bodyBuffer);
    req.end();
  });
}

async function postMultipartData(urlStr, jsonBody, pdfMap) {
  const form = new FormData();
  form.append('so_orders_data', JSON.stringify(jsonBody));

  if (pdfMap) {
    for (const [filename, filePath] of Object.entries(pdfMap)) {
      if (fs.existsSync(filePath)) {
        form.append('pdf-file', fs.createReadStream(filePath), { filename: filename });
      } else {
        console.warn(`[Multipart] PDF file not found: ${filePath}`);
      }
    }
  }

  try {
    const response = await axios.post(urlStr, form, {
      headers: { ...form.getHeaders() },
      timeout: 30000
    });
    return {
      statusCode: response.status,
      body: JSON.stringify(response.data)
    };
  } catch (error) {
    if (error.response) {
      return {
        statusCode: error.response.status,
        body: JSON.stringify(error.response.data)
      };
    }
    throw new Error(error.message || 'Push API request failed');
  }
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
const BROWSER_PATH = process.env.PDF_BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatIndianNumber(num) {
  if (num === null || num === undefined) return '0.00';
  const parts = parseFloat(num).toFixed(2).split('.');
  let lastThree = parts[0].substring(parts[0].length - 3);
  const otherParts = parts[0].substring(0, parts[0].length - 3);
  if (otherParts !== '') {
    lastThree = ',' + lastThree;
  }
  const formatted = otherParts.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree;
  return formatted + '.' + parts[1];
}

function numberToIndianWords(num) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function numToWords(n) {
    if (n < 20) return a[n];
    const digit = n % 10;
    return b[Math.floor(n / 10)] + (digit ? ' ' + a[digit] : '');
  }

  let amount = Math.round(parseFloat(num));
  if (amount === 0) return 'Zero';

  const crore = Math.floor(amount / 10000000);
  amount %= 10000000;
  const lakh = Math.floor(amount / 100000);
  amount %= 100000;
  const thousand = Math.floor(amount / 1000);
  amount %= 1000;
  const hundred = Math.floor(amount / 100);
  amount %= 100;
  const remaining = amount;

  let str = '';
  if (crore > 0) {
    str += numToWords(crore) + ' Crore ';
  }
  if (lakh > 0) {
    str += numToWords(lakh) + ' Lakh ';
  }
  if (thousand > 0) {
    str += numToWords(thousand) + ' Thousand ';
  }
  if (hundred > 0) {
    str += numToWords(hundred) + ' Hundred ';
  }
  if (remaining > 0) {
    str += numToWords(remaining) + ' ';
  }

  return 'INR ' + str.trim() + ' Only';
}

function formatTallyDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return dateStr || '';
  const yyyy = dateStr.substring(0, 4);
  const mm = parseInt(dateStr.substring(4, 6), 10);
  const dd = parseInt(dateStr.substring(6, 8), 10);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[mm - 1] || '';
  const shortYear = yyyy.substring(2);

  return `${dd}-${monthName}-${shortYear}`;
}



async function exportSalesOrderAsPdf(voucher, companyObj, bankObj) {
  const companyName = typeof companyObj === 'string' ? companyObj : (companyObj?.name || 'UNKNOWN');

  const fySuffix = getCompanyFYSuffix(voucher.date);

  let sellerName = companyName + fySuffix;
  if (companyName.toUpperCase().includes('VINAYAK')) {
    sellerName = 'VINAYAK ENTERPRISES' + fySuffix;
  }

  // Use companyObj details if available, else fallback
  const sellerAddress1 = companyObj?.address ? companyObj.address : 'PLOTNO. 7 & 8, NEW MANDOLI INDUSTRIAL';
  const sellerAddress2 = companyObj?.address ? '' : 'AREA, DELHI-110093';
  const sellerMsme = 'MSME- UDYAM-DL-02-0021351'; // usually static for a company, could keep hardcoded or add to Tally if needed
  const sellerGstin = companyObj?.gstin || '07AAIPM1107G1Z3';
  const cStateCode = (companyObj?.gstin && companyObj.gstin.length > 1) ? companyObj.gstin.substring(0, 2) : '07';
  const sellerState = companyObj?.statename ? `${companyObj.statename}, Code : ${cStateCode}` : 'Delhi, Code : 07';
  const sellerEmail = companyObj?.email || 'accounts@vinayak-enterprises.com';
  const sellerPan = companyObj?.pan || 'AAIPM1107G';

  const bName = voucher.buyername || voucher.partyledgername || 'N/A';
  const bAddrLines = (voucher.buyeraddress && voucher.buyeraddress.length > 0) ? voucher.buyeraddress : (voucher.ledgeraddress || []);
  const bAddr1 = bAddrLines[0] || '';
  const bAddr2 = bAddrLines[1] || '';
  const bGstin = voucher.partygstin || '';
  const bStateObj = getStateFromGstin(bGstin);
  const bStateStr = bStateObj.name ? bStateObj.name + ', Code : ' + bStateObj.code : '';

  const cName = voucher.consigneename || bName;
  const cAddrLines = (voucher.consigneeaddress && voucher.consigneeaddress.length > 0) ? voucher.consigneeaddress : bAddrLines;
  const cAddr1 = cAddrLines[0] || '';
  const cAddr2 = cAddrLines[1] || '';
  const cGstin = voucher.consigneegstin || bGstin;
  const cStateObj = getStateFromGstin(cGstin);
  const cStateStr = cStateObj.name ? cStateObj.name + ', Code : ' + cStateObj.code : '';

  const taxLedgers = (voucher.ledgerEntries || []).filter(le => {
    const name = (le.ledgername || '').toUpperCase();
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

  let gstRateStr = '18%';
  const cgstItem = uniqueTaxLedgers.find(l => l.ledgername.toUpperCase().includes('CGST'));
  const sgstItem = uniqueTaxLedgers.find(l => l.ledgername.toUpperCase().includes('SGST'));
  const igstItem = uniqueTaxLedgers.find(l => l.ledgername.toUpperCase().includes('IGST'));
  if (igstItem) {
    const match = igstItem.ledgername.match(/[0-9]+/);
    if (match) gstRateStr = match[0] + '%';
  } else if (cgstItem && sgstItem) {
    const matchC = cgstItem.ledgername.match(/[0-9]+/);
    const matchS = sgstItem.ledgername.match(/[0-9]+/);
    if (matchC && matchS) {
      gstRateStr = (parseInt(matchC[0], 10) + parseInt(matchS[0], 10)) + '%';
    }
  }

  let tableRowsHtml = '';
  let slNo = 1;
  let totalAmtVal = 0;
  let totalQtyVal = 0;
  let qtyUnit = 'KGS';

  (voucher.inventoryEntries || []).forEach(item => {
    const name = item.stockitemname || '';
    const qty = item.billedqty || '';
    const rate = item.rate ? parseFloat(item.rate).toFixed(2) : '0.00';
    const amountVal = item.amount ? Math.abs(parseFloat(item.amount)) : 0;
    totalAmtVal += amountVal;

    const amountStr = formatIndianNumber(amountVal.toFixed(2));
    const hsn = item.hsncode || item.basicuserdescription || '';
    const dueOn = item.dueon ? formatTallyDate(item.dueon) : formatTallyDate(voucher.date);
    const discount = item.discount ? item.discount + '%' : '';

    const parts = qty.trim().split(' ');
    const numStr = parts[0] || '0';
    const parsedUnit = item.actualuom || parts.slice(1).join(' ') || 'KGS';

    totalQtyVal += parseFloat(numStr.replace(/,/g, ''));
    qtyUnit = parsedUnit;
    const qtyStr = qty;

    tableRowsHtml += `
      <tr>
        <td class="c-sl">${slNo}</td>
        <td class="c-desc"><div class="item-name">${esc(name)}</div><div class="discount">${esc(discount)}</div></td>
        <td class="c-hsn">${esc(hsn)}</td>
        <td class="c-gst">${gstRateStr}</td>
        <td class="c-due"><span class="due-date">${dueOn}</span></td>
        <td class="c-qty">${esc(qtyStr)}</td>
        <td class="c-rate">${formatIndianNumber(rate)}</td>
        <td class="c-per">${esc(parsedUnit)}</td>
        <td class="c-amt">${amountStr}</td>
      </tr>
    `;

    slNo++;
  });

  uniqueTaxLedgers.forEach(tax => {
    const taxName = tax.ledgername;
    const taxAmtVal = tax.amount ? Math.abs(parseFloat(tax.amount)) : 0;
    totalAmtVal += taxAmtVal;
    const taxAmtStr = formatIndianNumber(taxAmtVal.toFixed(2));

    tableRowsHtml += `
      <tr class="tax-row">
        <td class="c-sl"></td>
        <td class="c-desc tax-name">${esc(taxName)}</td>
        <td class="c-hsn"></td>
        <td class="c-gst"></td>
        <td class="c-due"></td>
        <td class="c-qty"></td>
        <td class="c-rate"></td>
        <td class="c-per"></td>
        <td class="c-amt">${taxAmtStr}</td>
      </tr>
    `;
  });

  // Small filler row so the item table has a touch of breathing room before Total,
  // matching the reference which leaves a blank gap above the Total line.
  tableRowsHtml += `
    <tr class="spacer-row">
      <td class="c-sl"></td><td class="c-desc"></td><td class="c-hsn"></td><td class="c-gst"></td>
      <td class="c-due"></td><td class="c-qty"></td><td class="c-rate"></td><td class="c-per"></td><td class="c-amt"></td>
    </tr>
  `;

  const totalAmtStr = formatIndianNumber(totalAmtVal.toFixed(2));
  const totalQtyStr = formatIndianNumber(totalQtyVal.toFixed(2)) + ' ' + qtyUnit;
  const totalAmtInWords = numberToIndianWords(totalAmtVal);

  tableRowsHtml += `
    <tr class="total-row">
      <td class="c-sl"></td>
      <td class="c-desc total-label">Total</td>
      <td class="c-hsn"></td>
      <td class="c-gst"></td>
      <td class="c-due"></td>
      <td class="c-qty">${totalQtyStr}</td>
      <td class="c-rate"></td>
      <td class="c-per"></td>
      <td class="c-amt">&#8377; ${totalAmtStr}</td>
    </tr>
  `;

  const voucherNo = (voucher.vouchernumber || voucher.voucherNo || '').replace(/_/g, '/');
  const orderNo = (voucher.basicshipdocumentno || voucher.shipdocno || voucher.vouchernumber || '').replace(/_/g, '/');
  const paymentTerms = voucher.basicpaymentterms || voucher.paymentterms || '7 Days';
  const shippedBy = voucher.basicshippedby || voucher.shippedby || 'By Road';
  const destination = voucher.basicplacebeforedelivery || '';
  const motorVehicle = voucher.basicmotorvehicleno || '';
  const deliveryTerms = voucher.termsofdelivery || '';
  const partyState = voucher.partystatename || '';
  const cState = voucher.consigneestatename || partyState || '';
  const voucherDate = formatTallyDate(voucher.date);

  const cssPath = path.join(__dirname, 'css', 'sales_order.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const htmlTemplatePath = path.join(__dirname, 'html', 'sales_order.html');
  let htmlContent = fs.readFileSync(htmlTemplatePath, 'utf8');

  const templateVars = {
    cssContent,
    sellerName: esc(sellerName),
    sellerAddress1: esc(sellerAddress1),
    sellerAddress2: esc(sellerAddress2),
    sellerMsme: esc(sellerMsme),
    sellerGstin: esc(sellerGstin),
    sellerState: esc(sellerState),
    sellerEmail: esc(sellerEmail),
    voucherNo: esc(voucherNo),
    voucherDate,
    paymentTerms: esc(paymentTerms),
    orderNo: esc(orderNo),
    shipDocumentNo: esc(voucher.basicshipdocumentno || ''),
    cName: esc(cName),
    cAddr1: esc(cAddr1),
    cAddr2: esc(cAddr2),
    cGstin: esc(cGstin),
    cStateStr: cStateStr || esc(voucher.consigneestatename || ''),
    shippedBy: esc(shippedBy),
    destination: esc(destination),
    motorVehicle: esc(motorVehicle),
    bName: esc(bName),
    bAddr1: esc(bAddr1),
    bAddr2: esc(bAddr2),
    bGstin: esc(bGstin),
    bStateStr: bStateStr || esc(voucher.partystatename || ''),
    tableRowsHtml,
    totalAmtInWords: totalAmtInWords.replace(/(Thousand[^ ]*) /, '$1<br>'),
    sellerPan: esc(sellerPan),
    bankAccountName: esc(bankObj?.accountName || companyName.split('-')[0].trim()),
    bankName: esc(bankObj?.bankName || bankObj?.name || 'OD AXIS BANK'),
    bankAccountNo: esc(bankObj?.accountNo || '922030000492649'),
    bankIfsc: esc(bankObj?.ifsc || 'UTIB0003058'),
    bankSwift: esc(bankObj?.swift || 'AXISINBB04'),
    sigCompanyName: esc(companyObj?.name || sellerName)
  };

  // Remove CSS comment wrapper used to bypass HTML formatter
  htmlContent = htmlContent.replace(/\/\*\s*\{\{cssContent\}\}\s*\*\//g, '{{cssContent}}');

  htmlContent = htmlContent.replace(/\{\{(.*?)\}\}/g, (match, p1) => {
    return templateVars[p1] !== undefined ? templateVars[p1] : '';
  });


  const sanitizedOrderNo = (voucher.vouchernumber || voucher.guid).replace(/[^a-zA-Z0-9-_]/g, '_').trim();
  const finalPdfPath = path.join(PDF_DIR, sanitizedOrderNo + '.pdf');

  const success = generatePdfFromHtml(htmlContent, finalPdfPath);
  if (success) {
    console.log('   PDF successfully generated.');
    return finalPdfPath;
  } else {
    console.error('   [PDF Export Exception]');
    return null;
  }
}


module.exports = {
  TALLY_URL,
  tallyUrlObj,
  GET_COMPANIES_XML,
  BANK_LEDGERS_XML,
  SALES_ORDERS_XML,
  injectCompanyInXml,
  parseCompanies,
  parseBankLedgers,
  parseVouchers,
  flattenVouchers,
  getCurrentFinancialYearStrings,
  findBestMatchingCompany,
  fetchFromTallyWithRetry,
  getEffectiveQueryDate,
  hashJson,
  loadLastSnapshot,
  saveSnapshot,
  saveOutgoingJson,
  postJson,
  postMultipartData,
  isWithinScheduleWindow,
  getTallySelectedCompany,
  exportSalesOrderAsPdf,
  PDF_DIR,
  sleep,
  SCHEDULE_INTERVAL_MS,
  SCHEDULE_START_HOUR,
  SCHEDULE_START_MIN,
  SCHEDULE_END_HOUR,
  SCHEDULE_END_MIN
};