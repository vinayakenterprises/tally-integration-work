/**
 * formatters.cjs
 * Contains common formatting, parsing, and extraction utilities used across Tally XML integration.
 */

const GST_STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh'
};

function getStateFromGstin(gstin) {
  if (!gstin || gstin.length < 2) return { name: '', code: '' };
  const code = gstin.substring(0, 2);
  const name = GST_STATE_CODES[code] || '';
  return { name, code };
}

function getCompanyFYSuffix(dateStr) {
  let year = new Date().getFullYear();
  let month = new Date().getMonth();
  if (dateStr && dateStr.length === 8) {
    year = parseInt(dateStr.substring(0, 4), 10);
    month = parseInt(dateStr.substring(4, 6), 10) - 1;
  }
  let currentFYStart = year;
  if (month < 3) {
    currentFYStart = year - 1;
  }
  const currentShort = `${String(currentFYStart).slice(-2)}-${String(currentFYStart + 1).slice(-2)}`;
  const prevShort = `${String(currentFYStart - 1).slice(-2)}-${String(currentFYStart).slice(-2)}`;
  return `-(${prevShort})-(${currentShort})`;
}

/**
 * Converts a number to Indian words
 */
function numberToWords(num) {
  const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const format = (n) => {
    if (n < 20) return a[n];
    let d = Math.floor(n / 10);
    let rem = n % 10;
    return b[d] + (rem ? ' ' + a[rem] : ' ');
  };
  
  if (num === 0) return 'Zero';
  
  let intPart = Math.floor(num);
  let decPart = Math.round((num - intPart) * 100);
  
  let str = '';
  if (intPart > 9999999) {
    str += format(Math.floor(intPart / 10000000)) + 'Crore ';
    intPart %= 10000000;
  }
  if (intPart > 99999) {
    str += format(Math.floor(intPart / 100000)) + 'Lakh ';
    intPart %= 100000;
  }
  if (intPart > 999) {
    str += format(Math.floor(intPart / 1000)) + 'Thousand ';
    intPart %= 1000;
  }
  if (intPart > 99) {
    str += format(Math.floor(intPart / 100)) + 'Hundred ';
    intPart %= 100;
  }
  if (intPart > 0) {
    str += format(intPart);
  }
  
  str = str.trim();
  if (decPart > 0) {
    str += ' and ' + format(decPart).trim() + ' paise';
  }
  return str + ' Only';
}

function formatDateDisplay(yyyyMMdd) {
  if (!yyyyMMdd || yyyyMMdd.length !== 8) return yyyyMMdd;
  const year = yyyyMMdd.substring(0, 4);
  const monthStr = yyyyMMdd.substring(4, 6);
  const day = yyyyMMdd.substring(6, 8);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = monthNames[parseInt(monthStr, 10) - 1];
  return `${day}-${month}-${year.substring(2)}`;
}

function formatAmount(amt) {
  if (amt === undefined || amt === null) return '0.00';
  let num = parseFloat(amt);
  if (isNaN(num)) return '0.00';
  const isNegative = num < 0;
  num = Math.abs(num);
  let str = num.toFixed(2);
  let [intPart, decPart] = str.split('.');
  let lastThree = intPart.substring(intPart.length - 3);
  let otherNumbers = intPart.substring(0, intPart.length - 3);
  if (otherNumbers !== '') {
    lastThree = ',' + lastThree;
  }
  let res = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree + '.' + decPart;
  return isNegative ? '-' + res : res;
}

const extract = (tag, context) => {
  if (!context) return '';
  const reg = new RegExp(`<${tag}\\b[^>]*>(.*?)<\\/${tag}>`, 'is');
  const m = context.match(reg);
  return m ? m[1].replace(/&#4;|<[^>]+>/g, '\n').trim() : '';
};

const extractList = (tag, context) => {
  if (!context) return '';
  const reg = new RegExp(`<${tag}\\b[^>]*>(.*?)<\\/${tag}>`, 'is');
  const m = context.match(reg);
  if (!m) return '';
  const items = m[1].match(/<[^>]+>(.*?)<\/[^>]+>/gs);
  if (!items) return m[1].trim();
  return items.map(i => i.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join('\n');
};

const escapeXml = (unsafe) => {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

module.exports = {
  GST_STATE_CODES,
  getStateFromGstin,
  getCompanyFYSuffix,
  numberToWords,
  formatDateDisplay,
  formatAmount,
  extract,
  extractList,
  escapeXml
};
