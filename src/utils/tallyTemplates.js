export const GET_COMPANIES_XML = `
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

export const PURCHASE_ORDERS_XML = `
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

export const SALES_ORDERS_XML = `
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

export const escapeXml = (unsafe) => {
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
};

export const injectCompanyInXml = (xmlStr, companyName, periodStart, periodEnd) => {
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
};
