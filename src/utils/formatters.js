export const formatDate = (dateStr) => {
  if (!dateStr) return '';
  const trimmed = dateStr.trim();
  if (trimmed.length === 8 && /^\d+$/.test(trimmed)) {
    const year = trimmed.slice(0, 4);
    const month = trimmed.slice(4, 6);
    const day = trimmed.slice(6, 8);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthIdx = parseInt(month, 10) - 1;
    return `${day} ${months[monthIdx]} ${year}`;
  }
  return dateStr;
};

export const getTallyDateString = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
};

export const formatCurrency = (val) => {
  if (!val) return '₹0.00';
  const num = parseFloat(val.replace(/[^0-9.-]/g, ''));
  if (isNaN(num)) return val;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2
  }).format(num);
};
