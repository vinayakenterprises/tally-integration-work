const express = require('express');
const app = express();

const {
  getEffectiveQueryDate,
  loadLastSnapshot,
  TALLY_URL
} = require('./tallyCore.cjs');

const { syncAndPushSO, startSchedulerSO } = require('./sync-so.cjs');
const { syncAndPushPO, startSchedulerPO } = require('./sync-po.cjs');
const { syncAndPushSI, startSchedulerSI } = require('./sync-si.cjs');

// ============================================================
// HTTP ENDPOINTS
// ============================================================

app.get('/', (req, res) => {
  res.send('Tally Connector Backend is running.\n\nUse:\n- /fetch/so for Sales Orders\n- /fetch/po for Purchase Orders\n- /fetch/si for Sales Invoices\n- /fetch for all transaction types');
});

// Manual SO Sync
app.get('/fetch/so', async (req, res) => {
  let queryDate = getEffectiveQueryDate();
  if (req.query.date) {
    queryDate = req.query.date.replace(/-/g, '');
  }
  const outcome = await syncAndPushSO(queryDate);
  res.json({ success: outcome.status !== 'error' && outcome.status !== 'push_failed', ...outcome });
});

// Manual PO Sync
app.get('/fetch/po', async (req, res) => {
  let queryDate = getEffectiveQueryDate();
  if (req.query.date) {
    queryDate = req.query.date.replace(/-/g, '');
  }
  const outcome = await syncAndPushPO(queryDate);
  res.json({ success: outcome.status !== 'error' && outcome.status !== 'push_failed', ...outcome });
});

// Manual SI Sync
app.get('/fetch/si', async (req, res) => {
  let queryDate = getEffectiveQueryDate();
  if (req.query.date) {
    queryDate = req.query.date.replace(/-/g, '');
  }
  const outcome = await syncAndPushSI(queryDate);
  res.json({ success: outcome.status !== 'error' && outcome.status !== 'push_failed', ...outcome });
});

// Full Sync (all categories in parallel)
app.get('/fetch', async (req, res) => {
  let queryDate = getEffectiveQueryDate();
  if (req.query.date) {
    queryDate = req.query.date.replace(/-/g, '');
  }

  console.log(`\n[Manual Fetch All] Triggering manual sync for ${queryDate}...`);
  const [so, po, si] = await Promise.all([
    syncAndPushSO(queryDate),
    syncAndPushPO(queryDate),
    syncAndPushSI(queryDate)
  ]);

  res.json({
    success: true,
    salesOrders: so,
    purchaseOrders: po,
    salesInvoices: si
  });
});

// Check sync state/hash status for individual types
app.get('/sync-status/:type', (req, res) => {
  const type = req.params.type.toLowerCase();
  if (type !== 'so' && type !== 'po' && type !== 'si') {
    return res.status(400).json({ error: "Invalid type parameter. Use 'so', 'po', or 'si'." });
  }

  let queryDate = getEffectiveQueryDate();
  if (req.query.date) {
    queryDate = req.query.date.replace(/-/g, '');
  }

  const snapshot = loadLastSnapshot(type, queryDate);
  if (!snapshot) {
    return res.json({ found: false, type, date: queryDate });
  }

  const dataRecords = snapshot.data.salesOrders || snapshot.data.purchaseOrders || snapshot.data.salesInvoices || [];
  res.json({
    found: true,
    type,
    date: queryDate,
    hash: snapshot.hash,
    savedAt: snapshot.savedAt,
    recordsCount: dataRecords.length
  });
});

// ============================================================
// APP START
// ============================================================
const PORT = 3000;
app.listen(PORT, () => {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const formattedToday = `${yyyy}-${mm}-${dd}`;

  console.log(`\n🚀 Backend Express Coordinator running on port ${PORT}`);
  console.log(`🔗 Manual fetch SO: http://localhost:${PORT}/fetch/so?date=${formattedToday}`);
  console.log(`🔗 Manual fetch PO: http://localhost:${PORT}/fetch/po?date=${formattedToday}`);
  console.log(`🔗 Manual fetch SI: http://localhost:${PORT}/fetch/si?date=${formattedToday}`);
  console.log(`🔗 Sync status SO:  http://localhost:${PORT}/sync-status/so?date=${formattedToday}`);

  // Launch all individual schedulers in parallel
  startSchedulerSO();
  startSchedulerPO();
  startSchedulerSI();
});