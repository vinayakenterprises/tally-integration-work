export const sanitizeTallyXml = (xmlStr) => {
  const isValidXmlCodePoint = (codePoint) => (
    codePoint === 0x9 || codePoint === 0xA || codePoint === 0xD ||
    (codePoint >= 0x20 && codePoint <= 0xD7FF) ||
    (codePoint >= 0xE000 && codePoint <= 0xFFFD) ||
    (codePoint >= 0x10000 && codePoint <= 0x10FFFF)
  );

  return xmlStr
    .replace(/&#x([0-9a-f]+);/gi, (match, value) => {
      return isValidXmlCodePoint(parseInt(value, 16)) ? match : '';
    })
    .replace(/&#([0-9]+);/g, (match, value) => {
      return isValidXmlCodePoint(parseInt(value, 10)) ? match : '';
    })
    /* eslint-disable-next-line no-control-regex */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
};

// Generic parser to extract child elements from Tally collections
export const parseTallyXmlCollection = (xmlStr, tagName) => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(sanitizeTallyXml(xmlStr), "text/xml");

  let elements = xmlDoc.getElementsByTagName(tagName);
  if (elements.length === 0) {
    elements = xmlDoc.getElementsByTagName(tagName.toUpperCase());
  }

  const cleanText = (str) => {
    if (!str) return '';
    /* eslint-disable-next-line no-control-regex */
    return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  };

  const results = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const item = {};

    // Read attributes (like NAME, RESERVEDNAME)
    for (let k = 0; k < el.attributes.length; k++) {
      const attr = el.attributes[k];
      item[attr.name.toLowerCase()] = cleanText(attr.value);
    }

    // Read child text tags
    for (let j = 0; j < el.children.length; j++) {
      const child = el.children[j];
      item[child.tagName.toLowerCase()] = cleanText(child.textContent);
    }
    results.push(item);
  }
  return results;
};

// Dedicated parser to recursively extract child elements from Tally Vouchers
export const parseTallyVouchers = (xmlStr) => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(sanitizeTallyXml(xmlStr), "text/xml");
  const voucherElements = xmlDoc.getElementsByTagName("VOUCHER");

  const cleanText = (str) => {
    if (!str) return '';
    /* eslint-disable-next-line no-control-regex */
    return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  };

  const vouchers = [];

  for (let i = 0; i < voucherElements.length; i++) {
    const vEl = voucherElements[i];
    const voucher = {
      date: '',
      vouchernumber: '',
      partyledgername: '',
      inventoryEntries: [],
      ledgerEntries: []
    };

    // Read top level fields
    for (let j = 0; j < vEl.children.length; j++) {
      const child = vEl.children[j];
      const tagName = child.tagName.toUpperCase();

      if (tagName === 'DATE') {
        voucher.date = cleanText(child.textContent);
      } else if (tagName === 'VOUCHERNUMBER') {
        voucher.vouchernumber = cleanText(child.textContent);
      } else if (tagName === 'PARTYLEDGERNAME') {
        voucher.partyledgername = cleanText(child.textContent);
      } else if (tagName === 'ALLINVENTORYENTRIES.LIST' || tagName === 'INVENTORYENTRIES.LIST') {
        const invItem = {
          stockitemname: '',
          billedqty: '',
          rate: '',
          amount: '',
          description: ''
        };

        for (let k = 0; k < child.children.length; k++) {
          const invChild = child.children[k];
          const invTagName = invChild.tagName.toUpperCase();

          if (invTagName === 'STOCKITEMNAME') {
            invItem.stockitemname = cleanText(invChild.textContent);
          } else if (invTagName === 'BILLEDQTY' || invTagName === 'ACTUALQTY') {
            invItem.billedqty = cleanText(invChild.textContent);
          } else if (invTagName === 'RATE') {
            invItem.rate = cleanText(invChild.textContent);
          } else if (invTagName === 'AMOUNT') {
            invItem.amount = cleanText(invChild.textContent);
          } else if (invTagName === 'ADDITIONALDESCRIPTION.LIST') {
            const descriptions = [];
            for (let d = 0; d < invChild.children.length; d++) {
              if (invChild.children[d].tagName.toUpperCase() === 'ADDITIONALDESCRIPTION') {
                descriptions.push(cleanText(invChild.children[d].textContent));
              }
            }
            invItem.description = descriptions.join(', ');
          } else if (invTagName === 'BASICUSERDESCRIPTION' || invTagName === 'BASICUSERDESCRIPTION.LIST') {
            invItem.description = cleanText(invChild.textContent);
          }
        }
        voucher.inventoryEntries.push(invItem);
      } else if (tagName === 'ALLLEDGERENTRIES.LIST' || tagName === 'LEDGERENTRIES.LIST') {
        const ledItem = {
          ledgername: '',
          amount: '',
          isdeemedpositive: ''
        };

        for (let k = 0; k < child.children.length; k++) {
          const ledChild = child.children[k];
          const ledTagName = ledChild.tagName.toUpperCase();

          if (ledTagName === 'LEDGERNAME') {
            ledItem.ledgername = cleanText(ledChild.textContent);
          } else if (ledTagName === 'AMOUNT') {
            ledItem.amount = cleanText(ledChild.textContent);
          } else if (ledTagName === 'ISDEEMEDPOSITIVE') {
            ledItem.isdeemedpositive = cleanText(ledChild.textContent);
          }
        }
        voucher.ledgerEntries.push(ledItem);
      }
    }
    vouchers.push(voucher);
  }

  return vouchers;
};

// Flattens voucher hierarchy into inventory item-level rows and allocates tax proportionally
export const flattenVouchersToRows = (vouchers) => {
  const rows = [];

  vouchers.forEach(v => {
    // 1. Identify tax ledgers in the voucher
    const taxLedgers = Array.from(new Map(
      v.ledgerEntries
        .filter(le => {
          const name = le.ledgername.toUpperCase();
          return name.includes('CGST') || name.includes('SGST') || name.includes('IGST') || name.includes('UTGST') || name.includes('GST') || name.includes('TAX');
        })
        .map(le => [
          `${le.ledgername.toUpperCase()}|${le.amount}|${le.isdeemedpositive}`,
          le
        ])
    ).values());

    // Calculate total item value in the voucher
    let totalItemVal = 0;
    v.inventoryEntries.forEach(item => {
      const val = Math.abs(parseFloat((item.amount || '0').replace(/[^0-9.-]/g, ''))) || 0;
      totalItemVal += val;
    });

    // 2. Map inventory entries to rows
    v.inventoryEntries.forEach(item => {
      const itemAmt = Math.abs(parseFloat((item.amount || '0').replace(/[^0-9.-]/g, ''))) || 0;

      // Proportional allocation of tax ledgers to this item
      const share = totalItemVal > 0 ? itemAmt / totalItemVal : 0;

      // Build Tax Calculation details and calculate tax type, rate, and amount
      let taxAmtSum = 0;
      const taxDetails = [];
      const taxTypes = new Set();
      let maxRate = 0;

      taxLedgers.forEach(tl => {
        const tlAmt = Math.abs(parseFloat((tl.amount || '0').replace(/[^0-9.-]/g, ''))) || 0;
        const allocatedTlAmt = tlAmt * share;
        taxAmtSum += allocatedTlAmt;

        // Try to parse rate from ledger name (e.g. "CGST @ 9%" -> 9%)
        const rateMatch = tl.ledgername.match(/(\d+(?:\.\d+)?)\s*%/);
        const rate = rateMatch ? parseFloat(rateMatch[1]) : 0;
        maxRate += rate; // e.g. CGST 9% + SGST 9% = 18% total

        // Identify type of tax
        let type = 'Tax';
        if (tl.ledgername.toUpperCase().includes('CGST')) type = 'CGST';
        else if (tl.ledgername.toUpperCase().includes('SGST')) type = 'SGST';
        else if (tl.ledgername.toUpperCase().includes('IGST')) type = 'IGST';
        else if (tl.ledgername.toUpperCase().includes('UTGST')) type = 'UTGST';
        else if (tl.ledgername.toUpperCase().includes('GST')) type = 'GST';

        taxTypes.add(type);
        taxDetails.push(`${tl.ledgername}: ₹${allocatedTlAmt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      });

      const taxCalculationStr = taxDetails.join(', ') || 'No Tax';
      const taxTypeStr = Array.from(taxTypes).join(' + ') || 'N/A';
      const taxRateStr = maxRate > 0 ? `${maxRate}%` : '0%';
      const totalAmount = itemAmt + taxAmtSum;

      rows.push({
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
        totalamount: totalAmount.toString()
      });
    });
  });

  return rows;
};
