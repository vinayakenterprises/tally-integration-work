const { escapeXml, getCompanyFYSuffix, getStateFromGstin, numberToWords, formatDateDisplay, formatAmount, extract, extractList } = require('./utils/formatters.cjs');
const { PDF_DIR, generatePdfFromHtml } = require('./utils/pdfGenerator.cjs');

const fs = require('fs');
const path = require('path');

// XML Payload to fetch Credit Note vouchers for a specific date range
const CREDIT_NOTE_XML = `
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>CreditNoteCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CreditNoteCollection" ISINITIALIZE="Yes">
            <TYPE>Voucher</TYPE>
            <FETCH>Date</FETCH>
            <FETCH>VoucherNumber</FETCH>
            <FETCH>GUID</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BILLEDQTY</FETCH>
            <FETCH>IRN</FETCH>
            <FETCH>ACKNO</FETCH>
            <FETCH>ACKDATE</FETCH>
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
            <FETCH>BASICBUYERORDERNO</FETCH>
            <FETCH>BASICLADINGNO</FETCH>
            <FETCH>REFERENCE</FETCH>
            <FETCH>REFERENCEDATE</FETCH>
            <FETCH>ORIGINALINVOICENO</FETCH>
            <FETCH>ORIGINALINVOICEDATE</FETCH>
            <FETCH>BASICBUYERDOCUMENTNO</FETCH>
            <FETCH>BASICBUYERDOCUMENTDATE</FETCH>
            <FETCH>EWAYBILLDETAILS.*</FETCH>
            <FETCH>ALLINVENTORYENTRIES.STOCKITEMNAME</FETCH>
            <FETCH>ALLINVENTORYENTRIES.ACTUALUOM</FETCH>
            <FETCH>ALLINVENTORYENTRIES.RATE</FETCH>
            <FETCH>ALLINVENTORYENTRIES.AMOUNT</FETCH>
            <FETCH>ALLINVENTORYENTRIES.BASICUSERDESCRIPTION</FETCH>
            <FETCH>ALLINVENTORYENTRIES.ADDITIONALDESCRIPTION</FETCH>
            <FETCH>ALLINVENTORYENTRIES.HSNCODE</FETCH>
            <FETCH>ALLINVENTORYENTRIES.GSTHSNNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.LEDGERNAME</FETCH>
            <FETCH>ALLLEDGERENTRIES.AMOUNT</FETCH>
            <FETCH>ALLLEDGERENTRIES.ISDEEMEDPOSITIVE</FETCH>
            <FILTER>IsCreditNote</FILTER>
            <FILTER>DateFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="IsCreditNote">
            $VoucherTypeName = "Credit Note"
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

/**
 * Parses the raw XML response from Tally into a structured JSON array of Credit Notes.
 */
function parseCreditNoteVouchers(xmlResponse, selectedCompany) {
  const vouchers = [];
  const vchRegex = /<VOUCHER\b[^>]*>(.*?)<\/VOUCHER>/gis;
  let match;

  while ((match = vchRegex.exec(xmlResponse)) !== null) {
    const vContent = match[1];

    const voucherNo = extract('VOUCHERNUMBER', vContent);
    const invoiceDate = extract('DATE', vContent) || extract('EFFECTIVEDATE', vContent); // YYYYMMDD
    const guid = extract('GUID', vContent);
    
    if (!guid) continue;

    // Some debit/credit notes use REFERENCE or ORIGINALINVOICENO
    const origInvoiceNo = extract('ORIGINALINVOICENO', vContent) || extract('REFERENCE', vContent) || extract('BASICBUYERDOCUMENTNO', vContent) || "";
    const origInvoiceDate = extract('ORIGINALINVOICEDATE', vContent) || extract('REFERENCEDATE', vContent) || extract('BASICBUYERDOCUMENTDATE', vContent) || "";

    // Party Details
    const pName = extract('PARTYLEDGERNAME', vContent);
    const bName = extract('BASICBUYERNAME', vContent) || pName;
    const bAddr = extractList('BASICBUYERADDRESS\\.LIST', vContent) || extractList('ADDRESS\\.LIST', vContent);
    const bGstin = extract('PARTYGSTIN', vContent);
    const bStateObj = getStateFromGstin(bGstin);
    const bStateStr = bStateObj.name ? `${bStateObj.name}, Code : ${bStateObj.code}` : extract('PARTYSTATENAME', vContent);

    const cName = extract('CONSIGNEEMAILINGNAME', vContent) || bName;
    const cAddr = extractList('CONSIGNEEADDRESS\\.LIST', vContent) || bAddr;
    const cGstin = extract('CONSIGNEEGSTIN', vContent) || bGstin;
    const cStateObj = getStateFromGstin(cGstin);
    const cStateStr = cStateObj.name ? `${cStateObj.name}, Code : ${cStateObj.code}` : (extract('CONSIGNEESTATENAME', vContent) || bStateStr);

    const items = [];
    let totalQuantity = 0;

    const invRegex = /<ALLINVENTORYENTRIES\.LIST>(.*?)<\/ALLINVENTORYENTRIES\.LIST>/gis;
    let invMatch;
    let slNo = 1;
    while ((invMatch = invRegex.exec(vContent)) !== null) {
      const invContent = invMatch[1];
      const desc = extract('STOCKITEMNAME', invContent);
      if (!desc) continue;

      const additionalDesc = extractList('BASICUSERDESCRIPTION\\.LIST', invContent) || extract('BASICUSERDESCRIPTION', invContent) || extract('ADDITIONALDESCRIPTION', invContent);
      let qtyStr = extract('BILLEDQTY', invContent) || extract('ACTUALQTY', invContent) || "0";
      let qtyMatch = qtyStr.match(/([\d\.]+)\s*(.*)/);
      let quantity = qtyMatch ? parseFloat(qtyMatch[1]) : 0;
      let unit = qtyMatch ? qtyMatch[2] : extract('ACTUALUOM', invContent);

      let rate = parseFloat(extract('RATE', invContent).replace(/[^\d\.]/g, '') || 0);
      let amount = parseFloat(extract('AMOUNT', invContent).replace(/[^\d\.-]/g, '') || 0);
      amount = Math.abs(amount); // Tally uses negative for credits/debits

      const hsncode = extract('HSNCODE', invContent) || extract('GSTHSNNAME', invContent) || '76041010';

      items.push({
        sl_no: slNo++,
        description: desc,
        additional_description: additionalDesc,
        quantity,
        unit,
        rate,
        amount,
        hsncode
      });

      totalQuantity += quantity;
    }

    // Ledgers (Taxes, Rounding, Main party)
    const ledgers = [];
    const ledgRegex = /<ALLLEDGERENTRIES\.LIST>(.*?)<\/ALLLEDGERENTRIES\.LIST>/gis;
    let ledgMatch;

    while ((ledgMatch = ledgRegex.exec(vContent)) !== null) {
      const ledgContent = ledgMatch[1];
      const ledgerName = extract('LEDGERNAME', ledgContent);
      if (!ledgerName) continue;

      let amt = parseFloat(extract('AMOUNT', ledgContent) || 0);
      const isDeemedPositive = extract('ISDEEMEDPOSITIVE', ledgContent) === 'Yes';
      let realAmt = isDeemedPositive ? Math.abs(amt) : -Math.abs(amt);

      ledgers.push({
        ledger_name: ledgerName,
        amount: realAmt,
        is_debit: isDeemedPositive
      });
    }

    const totalAmount = ledgers.filter(l => !l.is_debit).reduce((acc, l) => acc + Math.abs(l.amount), 0); // For Credit Note, credit is positive? We'll just take sum of taxes + basic.
    
    const doc = {
      document_type: "Credit Note",
      voucher_info: {
        voucher_number: voucherNo,
        voucher_date: invoiceDate,
        guid: guid
      },
      original_invoice_info: {
        original_invoice_number: origInvoiceNo,
        original_invoice_date: origInvoiceDate,
        other_references: extract('REFERENCE', vContent) || ""
      },
      party_details: {
        buyer_name: bName,
        buyer_address: bAddr,
        buyer_gstin: bGstin,
        buyer_state: bStateStr,
        consignee_name: cName,
        consignee_address: cAddr,
        consignee_gstin: cGstin,
        consignee_state: cStateStr
      },
      other_details: {
        payment_terms: extract('BASICPAYMENTTERMS', vContent),
        order_no: extract('BASICBUYERORDERNO', vContent),
        ship_document_no: extract('BASICSHIPDOCUMENTNO', vContent),
        shipped_by: extract('BASICSHIPPEDBY', vContent),
        destination: extract('BASICPLACEBEFOREDELIVERY', vContent)
      },
      items,
      ledgers,
      totals: {
        total_quantity: totalQuantity,
        total_amount: totalAmount
      }
    };

    if (doc.voucher_info.voucher_number || doc.voucher_info.guid) {
      vouchers.push(doc);
    }
  }

  return vouchers;
}
/**
 * Generate PDF for a Credit Note
 */
async function exportCreditNoteAsPdf(voucher, companyObj, bankObj) {
  const companyName = typeof companyObj === 'string' ? companyObj : (companyObj?.name || 'UNKNOWN');
  const fySuffix = getCompanyFYSuffix ? getCompanyFYSuffix(voucher.voucher_info.voucher_date) : '';

  let sellerName = companyName + fySuffix;
  if (companyName.toUpperCase().includes('VINAYAK')) {
    sellerName = 'VINAYAK ENTERPRISES' + fySuffix;
  }

  const sellerAddress1 = companyObj?.address ? companyObj.address : 'PLOTNO. 7 & 8, NEW MANDOLI INDUSTRIAL';
  const sellerAddress2 = companyObj?.address ? '' : 'AREA, DELHI-110093';
  const sellerMsme = 'MSME- UDYAM-DL-02-0021351';
  const sellerGstin = companyObj?.gstin || '07AAIPM1107G1Z3';
  const cStateCode = (companyObj?.gstin && companyObj.gstin.length > 1) ? companyObj.gstin.substring(0, 2) : '07';
  const sellerState = companyObj?.statename ? `${companyObj.statename}, Code : ${cStateCode}` : 'Delhi, Code : 07';
  const sellerEmail = companyObj?.email || 'accounts@vinayak-enterprises.com';
  const sellerPan = companyObj?.pan || 'AAIPM1107G';

  const bName = voucher.party_details.buyer_name;
  const bAddrLines = (voucher.party_details.buyer_address || '').split('\n');
  const bAddr1 = bAddrLines[0] || '';
  const bAddr2 = bAddrLines.slice(1).join(', ') || '';
  const bGstin = voucher.party_details.buyer_gstin;
  const bStateStr = voucher.party_details.buyer_state;

  const cName = voucher.party_details.consignee_name;
  const cAddrLines = (voucher.party_details.consignee_address || '').split('\n');
  const cAddr1 = cAddrLines[0] || '';
  const cAddr2 = cAddrLines.slice(1).join(', ') || '';
  const cGstin = voucher.party_details.consignee_gstin;
  const cStateStr = voucher.party_details.consignee_state;

  const taxLedgers = (voucher.ledgers || []).filter(le => {
    const name = (le.ledger_name || '').toUpperCase();
    return name.includes('CGST') || name.includes('SGST') || name.includes('IGST') || name.includes('UTGST') || name.includes('GST') || name.includes('TAX');
  });

  const isIgst = taxLedgers.some(tl => tl.ledger_name.toUpperCase().includes('IGST'));
  let gstRateStr = '18%'; // Default assumption for the screenshot

  let tableRowsHtml = '';
  let taxableTotal = 0;
  
  voucher.items.forEach(item => {
    taxableTotal += item.amount;
    tableRowsHtml += `        <tr>
          <td class="c-sl">${item.sl_no}</td>
          <td class="c-desc"><div class="item-name">${item.description}</div><div class="discount">${item.additional_description || ''}</div></td>
          <td class="c-hsn">${item.hsncode || ''}</td>
        <td class="c-gst">${gstRateStr}</td>
        <td class="c-qty">${formatAmount(item.quantity)} ${item.unit}</td>
        <td class="c-rate">${formatAmount(item.rate)}</td>
        <td class="c-per">${item.unit}</td>
        <td class="c-amt">${formatAmount(item.amount)}</td>
      </tr>
    `;
  });

  // Add taxes to table
  let totalTaxAmt = 0;
  let taxBreakupHtml = '';

    taxLedgers.forEach(tl => {
      totalTaxAmt += tl.amount;
      tableRowsHtml += `
        <tr class="tax-row">
          <td class="c-sl"></td>
          <td class="c-desc tax-name">${tl.ledger_name}</td>
          <td class="c-hsn"></td>
          <td class="c-gst"></td>
          <td class="c-qty"></td>
          <td class="c-rate"></td>
          <td class="c-per"></td>
          <td class="c-amt">${formatAmount(tl.amount)}</td>
        </tr>
      `;
    });
  
  // Calculate Grand Total
  let grandTotal = taxableTotal + totalTaxAmt;
  
  // Roundoff logic if present
  const roundoffLedger = (voucher.ledgers || []).find(le => le.ledger_name.toUpperCase().includes('ROUND') || le.ledger_name.toUpperCase().includes('SHORT'));
    if (roundoffLedger) {
        const roAmount = roundoffLedger.is_debit ? -roundoffLedger.amount : roundoffLedger.amount;
        grandTotal += roAmount;
        tableRowsHtml += `
        <tr class="tax-row">
          <td class="c-sl"></td>
          <td class="c-desc tax-name">${roundoffLedger.ledger_name}</td>
          <td class="c-hsn"></td>
          <td class="c-gst"></td>
          <td class="c-qty"></td>
          <td class="c-rate"></td>
          <td class="c-per"></td>
          <td class="c-amt">${formatAmount(roundoffLedger.amount)}</td>
        </tr>
        `;
    }

    // Spacer row
    tableRowsHtml += `
      <tr class="spacer-row">
        <td class="c-sl"></td><td class="c-desc"></td><td class="c-hsn"></td><td class="c-gst"></td>
        <td class="c-qty"></td><td class="c-rate"></td><td class="c-per"></td><td class="c-amt"></td>
      </tr>
    `;

    // Total row
    tableRowsHtml += `
      <tr class="total-row">
        <td class="c-sl"></td>
        <td class="c-desc total-label">Total</td>
        <td class="c-hsn"></td>
        <td class="c-gst"></td>
        <td class="c-qty">${formatAmount(voucher.totals.total_quantity)} KGS</td>
        <td class="c-rate"></td>
        <td class="c-per"></td>
        <td class="c-amt">&#8377; ${formatAmount(grandTotal)}</td>
      </tr>
    `;

  // Tax Breakup
  let hsnFirst = voucher.items.length > 0 ? voucher.items[0].hsncode : '76041010';
  let taxTypeHeaders = '';
  let taxSubHeaders = '';
  let taxRate = taxableTotal > 0 ? (totalTaxAmt / taxableTotal) * 100 : 18;
  taxRate = Math.round(taxRate);
  let halfRate = taxRate / 2;
  let halfTax = totalTaxAmt / 2;

  if (isIgst) {
    taxTypeHeaders = `
      <th colspan="2" style="border-right: 1px solid #000; padding: 2px; text-align: center; font-weight: normal;">IGST</th>
    `;
    taxSubHeaders = `
      <th style="border-right: 1px solid #000; padding: 2px; font-weight: normal;">Rate</th>
      <th style="border-right: 1px solid #000; padding: 2px; font-weight: normal;">Amount</th>
    `;
    taxBreakupHtml = `
      <tr>
        <td style="border-right: 1px solid #000; padding: 2px;">${hsnFirst}</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(taxableTotal)}</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${taxRate.toFixed(2)}%</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(totalTaxAmt)}</td>
        <td style="padding: 2px; text-align: right;">${formatAmount(totalTaxAmt)}</td>
      </tr>
      <tr style="font-weight: bold; border-top: 1px solid #000;">
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">Total</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(taxableTotal)}</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;"></td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(totalTaxAmt)}</td>
        <td style="padding: 2px; text-align: right;">${formatAmount(totalTaxAmt)}</td>
      </tr>
    `;
  } else {
    taxTypeHeaders = `
      <th colspan="2" style="border-right: 1px solid #000; padding: 2px; text-align: center; font-weight: normal;">CGST</th>
      <th colspan="2" style="border-right: 1px solid #000; padding: 2px; text-align: center; font-weight: normal;">SGST/UTGST</th>
    `;
    taxSubHeaders = `
      <th style="border-right: 1px solid #000; padding: 2px; font-weight: normal;">Rate</th>
      <th style="border-right: 1px solid #000; padding: 2px; font-weight: normal;">Amount</th>
      <th style="border-right: 1px solid #000; padding: 2px; font-weight: normal;">Rate</th>
      <th style="border-right: 1px solid #000; padding: 2px; font-weight: normal;">Amount</th>
    `;
    taxBreakupHtml = `
      <tr>
        <td style="border-right: 1px solid #000; padding: 2px;">${hsnFirst}</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(taxableTotal)}</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${halfRate.toFixed(2)}%</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(halfTax)}</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${halfRate.toFixed(2)}%</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(halfTax)}</td>
        <td style="padding: 2px; text-align: right;">${formatAmount(totalTaxAmt)}</td>
      </tr>
      <tr style="font-weight: bold; border-top: 1px solid #000;">
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">Total</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(taxableTotal)}</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;"></td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(halfTax)}</td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;"></td>
        <td style="border-right: 1px solid #000; padding: 2px; text-align: right;">${formatAmount(halfTax)}</td>
        <td style="padding: 2px; text-align: right;">${formatAmount(totalTaxAmt)}</td>
      </tr>
    `;
  }

  let originalInvoiceStr = '';
  if (voucher.original_invoice_info.original_invoice_number) {
    originalInvoiceStr = voucher.original_invoice_info.original_invoice_number;
    if (voucher.original_invoice_info.original_invoice_date) {
        originalInvoiceStr += ' dt. ' + formatDateDisplay(voucher.original_invoice_info.original_invoice_date);
    }
  }

  const htmlTemplatePath = path.join(__dirname, 'html', 'credit_note.html');
  const cssPath = path.join(__dirname, 'css', 'credit_note.css');
  
  let htmlContent = fs.readFileSync(htmlTemplatePath, 'utf8');
  let cssContent = '';
  if (fs.existsSync(cssPath)) {
    cssContent = fs.readFileSync(cssPath, 'utf8');
  }

  const replacements = {
    cssContent,
    sellerName,
    sellerAddress1,
    sellerAddress2,
    sellerMsme,
    sellerGstin,
    sellerState,
    sellerEmail,
    voucherNo: voucher.voucher_info.voucher_number,
    voucherDate: formatDateDisplay(voucher.voucher_info.voucher_date),
    originalInvoiceStr,
    paymentTerms: voucher.other_details.payment_terms || '10 Days',
    orderNo: voucher.other_details.order_no || '',
    shipDocumentNo: voucher.other_details.ship_document_no || '',
    cName,
    cAddr1,
    cAddr2,
    cGstin,
    cStateStr,
    shippedBy: voucher.other_details.shipped_by || '',
    destination: voucher.other_details.destination || '',
    bName,
    bAddr1,
    bAddr2,
    bGstin,
    bStateStr,
    placeOfSupply: bStateStr ? bStateStr.split(',')[0].trim() : 'Delhi',
    tableRowsHtml,
    taxBreakupRowsHtml: taxBreakupHtml,
    taxTypeHeaders,
    taxSubHeaders,
    totalAmtInWords: numberToWords(grandTotal),
    taxAmtInWords: numberToWords(totalTaxAmt),
    sellerPan,
    sigCompanyName: sellerName,
    bankAccountName: bankObj?.accountName || companyName.split('-')[0].trim(),
    bankName: bankObj?.bankName || bankObj?.name || 'OD AXIS BANK A/C NO. 922030000492649',
    bankAccountNo: bankObj?.accountNo || '922030000492649',
    bankIfsc: bankObj?.ifsc || 'UTIB0001261',
    bankSwift: bankObj?.swift || ''
  };

  // Remove CSS comment wrapper used to bypass HTML formatter
  htmlContent = htmlContent.replace(/\/\*\s*\{\{cssContent\}\}\s*\*\//g, '{{cssContent}}');

  for (const [key, val] of Object.entries(replacements)) {
    const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    htmlContent = htmlContent.replace(regex, val || '');
  }

  const sanitizedOrderNo = (voucher.voucher_info.voucher_number || voucher.voucher_info.guid).replace(/[^a-zA-Z0-9-_]/g, '_').trim();
  const pdfPath = path.join(PDF_DIR, sanitizedOrderNo + '.pdf');

  const success = generatePdfFromHtml(htmlContent, pdfPath);
  if (success) {
    console.log('   PDF successfully generated.');
    return pdfPath;
  } else {
    console.error(`[Credit Note PDF Export] Error for ${voucher.voucher_info.voucher_number}`);
    return null;
  }
}

module.exports = {
  CREDIT_NOTE_XML,
  parseCreditNoteVouchers,
  exportCreditNoteAsPdf
};
