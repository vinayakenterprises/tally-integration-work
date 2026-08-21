const { escapeXml } = require('./tallyCore.cjs'); // We'll just rely on what we need if any.

const SALES_INVOICE_XML = `
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
            <FILTER>IsSalesInvoice</FILTER>
            <FILTER>DateFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="IsSalesInvoice">
            $VoucherTypeName = "Sales" OR $VoucherTypeName = "Tax Invoice"
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

function parseSalesVouchers(xmlText, companyDetails) {
  const vouchers = [];
  const vchRegex = /<VOUCHER\b[^>]*>(.*?)<\/VOUCHER>/gis;
  let match;

  while ((match = vchRegex.exec(xmlText)) !== null) {
    const vContent = match[1];

    const extract = (tag, context = vContent) => {
      const reg = new RegExp(`<${tag}\\b[^>]*>(.*?)<\\/${tag}>`, 'is');
      const m = context.match(reg);
      return m ? m[1].replace(/&#4;|<[^>]+>/g, '\n').trim() : '';
    };

    const extractList = (tag, context = vContent) => {
      const reg = new RegExp(`<${tag}\\b[^>]*>(.*?)<\\/${tag}>`, 'is');
      const m = context.match(reg);
      if (!m) return '';
      return m[1].split('\n').map(s => s.trim().replace(/<[^>]+>/g, '')).filter(Boolean).join(', ');
    };

    const guid = extract('GUID');
    if (!guid) continue;

    const voucherNo = extract('VOUCHERNUMBER');
    const invoiceDate = extract('DATE');

    // E-Way Bill Details
    const ewbContentMatch = vContent.match(/<EWAYBILLDETAILS\.LIST>(.*?)<\/EWAYBILLDETAILS\.LIST>/is);
    const ewbContent = ewbContentMatch ? ewbContentMatch[1] : '';
    const eWayBillNo = extract('BILLNUMBER', ewbContent);

    let irn = extract('IRN');
    let ackNo = extract('ACKNO');
    let ackDate = extract('ACKDATE');

    // Dispatch and Order Info
    const modeOfPayment = extract('BASICPAYMENTTERMS');
    const buyersOrderNo = extract('BASICBUYERORDERNO') || extract('REFERENCE');
    const dispatchDocNo = extract('BASICSHIPDOCUMENTNO');
    const dispatchedThrough = extract('BASICSHIPPEDBY');
    const destination = extract('BASICPLACEBEFOREDELIVERY');
    const billOfLadingNo = extract('BASICLADINGNO');
    const motorVehicleNo = extract('BASICMOTORVEHICLENO');
    const termsOfDelivery = extractList('TERMSOFDELIVERY');

    // Seller Details
    const sellerDetails = {
      name: companyDetails?.name || '',
      address: companyDetails?.address || '',
      msme: 'UDYAM-DL-02-0021351', // Default from PDF
      gstin: companyDetails?.gstin || '',
      stateName: companyDetails?.statename || '',
      stateCode: companyDetails?.statecode || '07',
      email: companyDetails?.email || '',
      pan: companyDetails?.pan || ''
    };

    // Buyer Details
    const bName = extract('BASICBUYERNAME') || extract('PARTYLEDGERNAME');
    const bAddr = extractList('BASICBUYERADDRESS\\.LIST');
    const bGstin = extract('PARTYGSTIN');
    const bStateStr = extract('PARTYSTATENAME');

    // Consignee Details
    const cName = extract('CONSIGNEEMAILINGNAME');
    const cAddr = extractList('CONSIGNEEADDRESS\\.LIST') || extractList('ADDRESS\\.LIST');
    const cGstin = extract('CONSIGNEEGSTIN');
    const cStateStr = extract('CONSIGNEESTATENAME');

    // E-Way Bill Transport
    const transportContentMatch = ewbContent.match(/<TRANSPORTDETAILS\.LIST>(.*?)<\/TRANSPORTDETAILS\.LIST>/is);
    const transportContent = transportContentMatch ? transportContentMatch[1] : '';

    // Items
    const items = [];
    let totalQuantity = 0;

    const invRegex = /<ALLINVENTORYENTRIES\.LIST>(.*?)<\/ALLINVENTORYENTRIES\.LIST>/gis;
    let invMatch;
    let slNo = 1;
    while ((invMatch = invRegex.exec(vContent)) !== null) {
      const invContent = invMatch[1];
      const desc = extract('STOCKITEMNAME', invContent);
      if (!desc) continue;

      const additionalDesc = extractList('BASICUSERDESCRIPTION\\.LIST', invContent) || extract('ADDITIONALDESCRIPTION', invContent);
      let qtyStr = extract('BILLEDQTY', invContent);
      let qtyMatch = qtyStr.match(/([\d\.]+)\s*(.*)/);
      let quantity = qtyMatch ? parseFloat(qtyMatch[1]) : 0;
      let unit = qtyMatch ? qtyMatch[2] : extract('ACTUALUOM', invContent);

      let rate = parseFloat(extract('RATE', invContent).replace(/[^\d\.]/g, '') || 0);
      let amount = parseFloat(extract('AMOUNT', invContent).replace(/[^\d\.-]/g, '') || 0);
      amount = Math.abs(amount);

      const hsnSac = extract('HSNCODE', invContent) || extract('GSTHSNNAME', invContent);

      items.push({
        slNo: slNo++,
        description: desc,
        additionalDescription: additionalDesc,
        hsnSac,
        quantity,
        unit,
        rate,
        per: unit,
        amount
      });

      totalQuantity += quantity;
    }

    // Ledgers (Taxes, Rounding, Main party)
    const ledgers = [];
    const ledgRegex = /<ALLLEDGERENTRIES\.LIST>(.*?)<\/ALLLEDGERENTRIES\.LIST>/gis;
    let ledgMatch;
    let igstAmount = 0;

    while ((ledgMatch = ledgRegex.exec(vContent)) !== null) {
      const ledgContent = ledgMatch[1];
      const ledgerName = extract('LEDGERNAME', ledgContent);
      if (!ledgerName) continue;

      let amt = parseFloat(extract('AMOUNT', ledgContent) || 0);
      const isDeemedPositive = extract('ISDEEMEDPOSITIVE', ledgContent) === 'Yes';

      // Keep true raw value
      let realAmt = isDeemedPositive ? Math.abs(amt) : -Math.abs(amt);

      if (ledgerName.toLowerCase().includes('igst')) {
        igstAmount = Math.abs(amt);
      }

      ledgers.push({
        ledgerName,
        amount: realAmt,
        isDeemedPositive
      });
    }

    const totalTaxableValue = items.reduce((acc, item) => acc + item.amount, 0);
    const totalInvoiceAmount = ledgers.filter(l => l.isDeemedPositive).reduce((acc, l) => acc + Math.abs(l.amount), 0);

    const doc = {
      documentType: "Sales Invoice",
      invoiceInfo: {
        invoiceNo: voucherNo,
        invoiceDate,
        eWayBillNo,
        irn,
        ackNo,
        ackDate
      },
      dispatchAndOrderInfo: {
        deliveryNote: extract('DELIVERYNOTE'),
        modeOfPayment,
        referenceNo: extract('REFERENCE'),
        buyersOrderNo,
        buyersOrderDate: '',
        dispatchDocNo,
        dispatchedThrough,
        destination,
        billOfLadingNo,
        motorVehicleNo,
        termsOfDelivery
      },
      sellerDetails,
      consigneeDetails: {
        name: cName,
        address: cAddr,
        gstin: cGstin,
        stateName: cStateStr,
        stateCode: ""
      },
      buyerDetails: {
        name: bName,
        address: bAddr,
        gstin: bGstin,
        stateName: bStateStr,
        stateCode: ""
      },
      items,
      ledgers,
      totals: {
        totalQuantity,
        totalQuantityUnit: items.length ? items[0].unit : '',
        totalAmount: totalTaxableValue + igstAmount,
        totalInvoiceAmount,
        amountInWords: "INR..." // Left stubbed as Tally amount parsing is complex without more context
      },
      taxDetails: {
        items: items.map(i => ({
          hsnSac: i.hsnSac,
          taxableValue: i.amount,
          igstRate: 18,
          igstAmount: (i.amount * 0.18),
          totalTaxAmount: (i.amount * 0.18)
        })),
        totalTaxableValue,
        totalTaxAmount: igstAmount
      },
      eWayBillDetails: {
        generatedDate: extract('GENERATEDON', ewbContent),
        generatedBy: '',
        validUpto: extract('VALIDUPTO', ewbContent),
        mode: extract('TRANSPORTMODE', transportContent),
        approxDistance: extract('DISTANCE', transportContent),
        supplyType: extract('SUBTYPE', ewbContent),
        transactionType: extract('DOCUMENTTYPE', ewbContent),
        transportation: {
          transporterId: extract('TRANSPORTERID', transportContent),
          transporterName: extract('TRANSPORTERNAME', transportContent),
          docNo: extract('DOCUMENTNUMBER', transportContent),
          date: extract('DOCUMENTDATE', transportContent)
        },
        vehicle: {
          vehicleNo: extract('VEHICLENUMBER', transportContent),
          from: extract('CONSIGNORPLACE', ewbContent),
          cewbNo: ""
        }
      }
    };

    vouchers.push(doc);
  }

  return vouchers;
}

module.exports = {
  SALES_INVOICE_XML,
  parseSalesVouchers
};
