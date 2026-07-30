import { useState, useEffect, useMemo } from 'react';
import './App.css';

// Import utility modules
import { formatDate, getTallyDateString, formatCurrency } from './utils/formatters';
import { GET_COMPANIES_XML, PURCHASE_ORDERS_XML, SALES_ORDERS_XML, injectCompanyInXml } from './utils/tallyTemplates';
import { parseTallyXmlCollection, parseTallyVouchers, flattenVouchersToRows } from './utils/tallyParsers';

function App() {
  const [connectionStatus, setConnectionStatus] = useState('checking'); // 'checking', 'online', 'offline'
  const [companies, setCompanies] = useState([]); // List of open companies: [{ name, periodStart, periodEnd }]
  const [selectedCompany, setSelectedCompany] = useState(() => {
    try {
      const saved = localStorage.getItem('tally_selected_company');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [hasConfirmedCompany, setHasConfirmedCompany] = useState(() => {
    try {
      return localStorage.getItem('tally_company_confirmed') === 'true';
    } catch {
      return false;
    }
  });

  const [selectedCategory, setSelectedCategory] = useState('purchase'); // 'purchase' or 'sales'
  const [ordersData, setOrdersData] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortConfig, setSortConfig] = useState({ key: 'date', direction: 'desc' }); // default sorting by date descending

  // XML/JSON Inspector State
  const [showInspector, setShowInspector] = useState(false);
  const [lastRequestXml, setLastRequestXml] = useState('');
  const [lastResponseXml, setLastResponseXml] = useState('');
  const [lastParsedJson, setLastParsedJson] = useState(null);

  // Auto-check connection on mount
  useEffect(() => {
    checkConnection();
  }, []);

  // Re-fetch data automatically if the company is switched, confirmed, or category changes
  useEffect(() => {
    if (hasConfirmedCompany && selectedCompany) {
      handleFetch(selectedCategory);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompany?.name, hasConfirmedCompany, selectedCategory]);

  async function checkConnection() {
    setConnectionStatus('checking');
    setErrorMsg('');
    setLastRequestXml(GET_COMPANIES_XML);
    try {
      const response = await fetch('/tally', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: GET_COMPANIES_XML
      });

      const xmlText = await response.text();
      setLastResponseXml(xmlText);

      // Parse the open company collection
      const parsed = parseTallyXmlCollection(xmlText, 'company');
      setLastParsedJson(parsed);

      const formatted = parsed.map(current => ({
        name: current.name || 'Unknown Company',
        periodStart: current.startingfrom || '',
        periodEnd: current.endingat || ''
      }));

      setCompanies(formatted);

      if (formatted.length > 0) {
        setConnectionStatus('online');
        setSelectedCompany(prev => {
          const stillOpen = prev ? formatted.find(c => c.name === prev.name) : null;
          if (stillOpen) {
            localStorage.setItem('tally_selected_company', JSON.stringify(stillOpen));
            return stillOpen;
          } else {
            // Force re-confirmation if the previously selected company is gone
            setHasConfirmedCompany(false);
            localStorage.setItem('tally_company_confirmed', 'false');
            localStorage.setItem('tally_selected_company', JSON.stringify(formatted[0]));
            return formatted[0];
          }
        });
      } else {
        // Connected but no active company loaded
        setSelectedCompany(null);
        setHasConfirmedCompany(false);
        localStorage.removeItem('tally_selected_company');
        localStorage.setItem('tally_company_confirmed', 'false');
        setConnectionStatus('online');
      }
    } catch (err) {
      console.error(err);
      setConnectionStatus('offline');
      setSelectedCompany(null);
      setHasConfirmedCompany(false);
      localStorage.removeItem('tally_selected_company');
      localStorage.setItem('tally_company_confirmed', 'false');
      setLastResponseXml('Error: Connection refused. Check if Tally is running on port 9001 and the Tally server is active.');
      setLastParsedJson(null);
    }
  }

  async function handleFetch(category = selectedCategory) {
    setIsLoading(true);
    setErrorMsg('');
    setSearchQuery('');
    setOrdersData([]);

    // 1. Perform Connectivity Check first
    setConnectionStatus('checking');

    try {
      const checkRes = await fetch('/tally', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: GET_COMPANIES_XML
      });
      const checkXml = await checkRes.text();
      const parsed = parseTallyXmlCollection(checkXml, 'company');
      const loadedCompanies = parsed.map(current => ({
        name: current.name || 'Unknown Company',
        periodStart: current.startingfrom || '',
        periodEnd: current.endingat || ''
      }));
      setCompanies(loadedCompanies);

      if (loadedCompanies.length > 0) {
        setConnectionStatus('online');
        const stillOpen = selectedCompany ? loadedCompanies.find(c => c.name === selectedCompany.name) : null;
        if (stillOpen) {
          setSelectedCompany(stillOpen);
          localStorage.setItem('tally_selected_company', JSON.stringify(stillOpen));
        } else {
          setSelectedCompany(loadedCompanies[0]);
          localStorage.setItem('tally_selected_company', JSON.stringify(loadedCompanies[0]));
          setHasConfirmedCompany(false);
          localStorage.setItem('tally_company_confirmed', 'false');
          setIsLoading(false);
          setErrorMsg('The selected company is no longer open. Please choose an open company.');
          return;
        }
      } else {
        setSelectedCompany(null);
        setHasConfirmedCompany(false);
        localStorage.setItem('tally_company_confirmed', 'false');
        setConnectionStatus('online');
        setIsLoading(false);
        setErrorMsg('Tally is responding, but no company is open. Please open a company in Tally.');
        return;
      }
    } catch (err) {
      console.error(err);
      setConnectionStatus('offline');
      setSelectedCompany(null);
      setHasConfirmedCompany(false);
      localStorage.setItem('tally_company_confirmed', 'false');
      setIsLoading(false);
      setErrorMsg('Tally port 9001 is not reachable. Please start Tally and enable the HTTP server.');
      return;
    }

    // 2. Fetch the corresponding XML data
    const today = new Date();
    let periodStart;
    let periodEnd;
    let xmlTemplate;

    if (category === 'sales') {
      // Sales Orders: current day only (today)
      periodStart = getTallyDateString(today);
      periodEnd = getTallyDateString(today);
      xmlTemplate = SALES_ORDERS_XML;
    } else {
      // Purchase Orders: last 2 days (yesterday & today)
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);
      periodStart = getTallyDateString(yesterday);
      periodEnd = getTallyDateString(today);
      xmlTemplate = PURCHASE_ORDERS_XML;
    }

    const injectedPayload = injectCompanyInXml(
      xmlTemplate,
      selectedCompany?.name,
      periodStart,
      periodEnd
    );
    setLastRequestXml(injectedPayload);

    try {
      const response = await fetch('/tally', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: injectedPayload
      });

      const xmlText = await response.text();
      setLastResponseXml(xmlText);

      const parsedVouchers = parseTallyVouchers(xmlText);
      const parsedList = flattenVouchersToRows(parsedVouchers);

      setOrdersData(parsedList);
      setLastParsedJson(parsedList);
    } catch (err) {
      console.error(err);
      setErrorMsg(`Failed to fetch data for ${category === 'sales' ? 'Sales Orders' : 'Purchase Orders'}. Tally returned a connection error.`);
    } finally {
      setIsLoading(false);
    }
  }

  // Sorting Handler
  const requestSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // Process and Filter Data
  const processedData = useMemo(() => {
    let result = [...ordersData];

    // Filter by search query
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      result = result.filter(item => {
        const name = (item.itemname || '').toLowerCase();
        const party = (item.partyname || '').toLowerCase();
        const orderNo = (item.orderno || '').toLowerCase();
        return name.includes(q) || party.includes(q) || orderNo.includes(q);
      });
    }

    // Sort Data
    result.sort((a, b) => {
      let aVal = a[sortConfig.key] || '';
      let bVal = b[sortConfig.key] || '';

      // Numerical sorting for amount and totalamount
      if (sortConfig.key === 'amount' || sortConfig.key === 'totalamount') {
        const aNum = parseFloat(aVal.replace(/[^0-9.-]/g, '')) || 0;
        const bNum = parseFloat(bVal.replace(/[^0-9.-]/g, '')) || 0;
        return sortConfig.direction === 'asc' ? aNum - bNum : bNum - aNum;
      }

      // String sorting
      return sortConfig.direction === 'asc'
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    });

    return result;
  }, [ordersData, searchQuery, sortConfig]);

  // Metric Computations
  const metrics = useMemo(() => {
    let totalVal = 0;
    let totalTax = 0;
    let totalQty = 0;
    const orderNumbers = new Set();

    processedData.forEach(item => {
      const amt = parseFloat((item.amount || '0').replace(/[^0-9.-]/g, '')) || 0;
      const tot = parseFloat((item.totalamount || '0').replace(/[^0-9.-]/g, '')) || 0;
      totalVal += tot;
      totalTax += (tot - amt);
      const qtyNum = parseFloat((item.quantity || '').replace(/[^0-9.-]/g, '')) || 0;
      totalQty += qtyNum;
      if (item.orderno && item.orderno !== 'N/A') orderNumbers.add(item.orderno);
    });

    return {
      totalValue: formatCurrency(totalVal.toString()),
      totalTax: formatCurrency(totalTax.toString()),
      totalQty: totalQty.toFixed(2).replace(/\.00$/, ''),
      totalItems: processedData.length,
      totalVouchers: orderNumbers.size
    };
  }, [processedData]);

  return (
    <div className="app-container">
      {/* Header Panel */}
      <header className="app-header">
        <div className="brand-section">
          <h1 className="brand-title">Tally Link Pro</h1>
          <span className="brand-subtitle">Real-time ERP Gateway & Analysis Dashboard</span>
        </div>

        <div className={`connection-banner ${connectionStatus}`}>
          <div className={`status-indicator ${connectionStatus}`}></div>
          {connectionStatus === 'checking' && <span>Checking Gateway...</span>}
          {connectionStatus === 'online' && (
            <div className="company-meta">
              <span>Gateway: Port 9001</span>
              {hasConfirmedCompany && companies.length > 0 ? (
                <>
                  <div className="divider"></div>
                  <select
                    className="header-company-select"
                    value={selectedCompany?.name || ''}
                    onChange={(e) => {
                      const newCompName = e.target.value;
                      const newComp = companies.find(c => c.name === newCompName);
                      if (newComp) {
                        setSelectedCompany(newComp);
                        localStorage.setItem('tally_selected_company', JSON.stringify(newComp));
                      }
                    }}
                  >
                    {companies.map((comp, idx) => (
                      <option key={idx} value={comp.name}>{comp.name}</option>
                    ))}
                  </select>
                  {selectedCompany && (
                    <>
                      <div className="divider"></div>
                      <span style={{ fontSize: '12px' }}>
                        Period: {formatDate(selectedCompany.periodStart)} – {formatDate(selectedCompany.periodEnd)}
                      </span>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="divider"></div>
                  <span style={{ color: 'var(--accent-emerald)', fontWeight: 600 }}>Online</span>
                </>
              )}
            </div>
          )}
          {connectionStatus === 'offline' && <span>Gateway Offline</span>}

          <button className="action-btn" style={{ padding: '4px 10px', fontSize: '12px', marginLeft: '8px' }} onClick={checkConnection}>
            🔄 Refresh
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      {!hasConfirmedCompany ? (
        <div className="company-select-container">
          {connectionStatus === 'checking' && (
            <div className="company-select-card">
              <div className="company-select-icon">🔄</div>
              <h2 className="company-select-title">Connecting to Tally</h2>
              <p className="company-select-subtitle">Locating Tally Gateway on Port 9001...</p>
              <div className="spinner" style={{ margin: '16px auto' }}></div>
            </div>
          )}

          {connectionStatus === 'offline' && (
            <div className="company-select-card" style={{ borderColor: 'var(--accent-rose)' }}>
              <div className="company-select-icon">⚠️</div>
              <h2 className="company-select-title" style={{ background: 'linear-gradient(135deg, var(--text-primary) 30%, var(--accent-rose) 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Gateway Offline
              </h2>
              <p className="company-select-subtitle">
                Could not connect to Tally on port 9001. Please ensure:
              </p>
              <ul style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '8px', paddingLeft: '20px', margin: '0' }}>
                <li>Tally ERP or TallyPrime is running on your machine.</li>
                <li>HTTP Server is enabled in Tally configuration (F12 &gt; Advanced Configuration &gt; TallyPrime acts as HTTP Server = Yes, Port = 9001).</li>
                <li>The network connection to the Tally machine is active.</li>
              </ul>
              <button className="company-select-btn" style={{ background: 'linear-gradient(135deg, var(--accent-rose) 0%, var(--accent-purple) 100%)' }} onClick={checkConnection}>
                Retry Connection
              </button>
            </div>
          )}

          {connectionStatus === 'online' && companies.length === 0 && (
            <div className="company-select-card" style={{ borderColor: 'var(--accent-rose)' }}>
              <div className="company-select-icon">📂</div>
              <h2 className="company-select-title">No Company Open</h2>
              <p className="company-select-subtitle">
                Gateway is running, but no companies are currently open in Tally.
              </p>
              <p className="company-select-subtitle" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Please load or open a company inside Tally application, then click Check Again below.
              </p>
              <button className="company-select-btn" onClick={checkConnection}>
                Check Again
              </button>
            </div>
          )}

          {connectionStatus === 'online' && companies.length > 0 && (
            <div className="company-select-card">
              <div className="company-select-icon">🏢</div>
              <div className="company-select-header">
                <h2 className="company-select-title">Select Tally Company</h2>
                <p className="company-select-subtitle">
                  Choose a company from the currently open Tally instances to open the dashboard.
                </p>
              </div>

              <div className="company-select-form">
                <div className="company-select-field">
                  <label className="company-select-label">Available Companies ({companies.length})</label>
                  <select
                    className="company-select-dropdown"
                    value={selectedCompany?.name || ''}
                    onChange={(e) => {
                      const comp = companies.find(c => c.name === e.target.value);
                      if (comp) {
                        setSelectedCompany(comp);
                        localStorage.setItem('tally_selected_company', JSON.stringify(comp));
                      }
                    }}
                  >
                    {companies.map((comp, idx) => (
                      <option key={idx} value={comp.name}>{comp.name}</option>
                    ))}
                  </select>
                </div>

                <button
                  className="company-select-btn"
                  onClick={() => {
                    if (selectedCompany) {
                      setHasConfirmedCompany(true);
                      localStorage.setItem('tally_company_confirmed', 'true');
                    }
                  }}
                >
                  Open Company &rarr;
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Dashboard Controls / Cards Selection */}
          <section className="dashboard-controls" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px', marginBottom: '24px' }}>
            {/* Purchase Orders Card */}
            <div
              className={`control-card ${selectedCategory === 'purchase' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('purchase')}
              style={{ cursor: 'pointer' }}
            >
              <div className="card-header-icon" style={{ color: 'var(--accent-emerald)' }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><circle cx="9" cy="15" r="1"></circle><circle cx="15" cy="15" r="1"></circle><path d="M9 19h6"></path></svg>
              </div>
              <div className="card-info">
                <h3 className="card-title">Purchase Orders</h3>
                <span className="card-desc">Retrieve purchase order details, item quantities, descriptions, tax calculations, and totals for the last 2 days.</span>
              </div>
              <button className="card-action-btn">
                View Purchase Orders &rarr;
              </button>
            </div>

            {/* Sales Orders Card */}
            <div
              className={`control-card ${selectedCategory === 'sales' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('sales')}
              style={{ cursor: 'pointer' }}
            >
              <div className="card-header-icon" style={{ color: 'var(--accent-blue)' }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
              </div>
              <div className="card-info">
                <h3 className="card-title">Sales Orders</h3>
                <span className="card-desc">Retrieve sales order details, item quantities, descriptions, tax calculations, and totals for the current day.</span>
              </div>
              <button className="card-action-btn">
                View Sales Orders &rarr;
              </button>
            </div>
          </section>

          <section className="detail-panel">
            <div className="panel-header">
              <div className="panel-title-area">
                <h2 className="panel-title">{selectedCategory === 'sales' ? 'Sales Orders Details' : 'Purchase Orders Details'}</h2>
                <span className="panel-subtitle">
                  Showing {processedData.length} of {ordersData.length} records retrieved from Tally
                  {selectedCategory === 'sales' ? (
                    ` (Querying today: ${formatDate(getTallyDateString(new Date()))})`
                  ) : (
                    ` (Querying last 2 days: ${formatDate(getTallyDateString(new Date(Date.now() - 86400000)))} to ${formatDate(getTallyDateString(new Date()))})`
                  )}.
                </span>
              </div>

              {/* Search filter bar */}
              {!isLoading && !errorMsg && ordersData.length > 0 && (
                <div className="search-container">
                  <input
                    type="text"
                    placeholder={selectedCategory === 'sales' ? 'Search by sales order no, party, or item...' : 'Search by purchase order no, party, or item...'}
                    className="search-input"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                <svg className="search-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              </div>
            )}
          </div>

          {/* Loader Spinner */}
          {isLoading && (
            <div className="loading-container">
              <div className="spinner"></div>
              <span>Connecting to Tally gateway, running connectivity check and exporting report...</span>
            </div>
          )}

          {/* Error Message Section */}
          {!isLoading && errorMsg && (
            <div className="empty-state">
              <div className="empty-icon" style={{ color: 'var(--accent-rose)' }}>⚠️</div>
              <h4 className="empty-title">Data Extraction Failed</h4>
              <p className="empty-desc">{errorMsg}</p>
              <button className="btn-retry" onClick={handleFetch}>
                Try Again
              </button>
            </div>
          )}

          {/* Render data table if loading complete and no errors */}
          {!isLoading && !errorMsg && (
            <>
              {/* Summary KPIs */}
              {ordersData.length > 0 && (
                <div className="panel-metrics">
                  <div className="metric-pill highlight">
                    <div className="metric-icon-box">🛒</div>
                    <div className="metric-info">
                      <span className="metric-label">Total Orders Value</span>
                      <span className="metric-value">{metrics.totalValue}</span>
                    </div>
                  </div>
                  <div className="metric-pill">
                    <div className="metric-icon-box">🧾</div>
                    <div className="metric-info">
                      <span className="metric-label">Total Allocated Tax</span>
                      <span className="metric-value">{metrics.totalTax}</span>
                    </div>
                  </div>
                  <div className="metric-pill">
                    <div className="metric-icon-box">📦</div>
                    <div className="metric-info">
                      <span className="metric-label">Total Items Ordered</span>
                      <span className="metric-value">{metrics.totalItems} items ({metrics.totalQty} qty)</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Data Table */}
              {processedData.length > 0 ? (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ cursor: 'pointer' }} onClick={() => requestSort('orderno')}>
                          {selectedCategory === 'sales' ? 'Sales Order No' : 'Purchase Order No'} {sortConfig.key === 'orderno' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                        </th>
                        <th style={{ cursor: 'pointer' }} onClick={() => requestSort('date')}>
                          Date {sortConfig.key === 'date' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                        </th>
                        <th style={{ cursor: 'pointer' }} onClick={() => requestSort('partyname')}>
                          Party Name {sortConfig.key === 'partyname' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                        </th>
                        <th style={{ cursor: 'pointer' }} onClick={() => requestSort('itemname')}>
                          Item Name {sortConfig.key === 'itemname' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                        </th>
                        <th style={{ textAlign: 'right' }}>Qty</th>
                        <th style={{ textAlign: 'right' }}>Rate</th>
                        <th style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => requestSort('amount')}>
                          Amount {sortConfig.key === 'amount' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                        </th>
                        <th>Description</th>
                        <th>Tax Details</th>
                        <th>Tax Type</th>
                        <th style={{ textAlign: 'center' }}>Tax Rate</th>
                        <th style={{ cursor: 'pointer', textAlign: 'right' }} onClick={() => requestSort('totalamount')}>
                          Total Amount {sortConfig.key === 'totalamount' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {processedData.map((item, idx) => {
                        const amtNum = parseFloat((item.amount || '0').replace(/[^0-9.-]/g, '')) || 0;
                        const totNum = parseFloat((item.totalamount || '0').replace(/[^0-9.-]/g, '')) || 0;
                        return (
                          <tr key={idx}>
                            <td style={{ fontWeight: 600 }}>{item.orderno}</td>
                            <td>{formatDate(item.date)}</td>
                            <td>{item.partyname}</td>
                            <td style={{ fontWeight: 500 }}>{item.itemname}</td>
                            <td className="amount-cell">{item.quantity}</td>
                            <td className="amount-cell">{item.rate}</td>
                            <td className="amount-cell">{formatCurrency(amtNum.toString())}</td>
                            <td style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{item.description}</td>
                            <td style={{ fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.taxcalculation}>
                              {item.taxcalculation}
                            </td>
                            <td>
                              <span className="badge">{item.taxtype}</span>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <span className="badge purple">{item.taxrate}</span>
                            </td>
                            <td className="amount-cell amount-debit" style={{ fontWeight: 600 }}>
                              {formatCurrency(totNum.toString())}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan="4" style={{ fontWeight: 700 }}>Total</td>
                        <td className="amount-cell" style={{ fontWeight: 700 }}>{metrics.totalVouchers} orders</td>
                        <td></td>
                        <td></td>
                        <td colSpan="4" style={{ fontWeight: 700, textAlign: 'right' }}>Total Amount</td>
                        <td className="amount-cell amount-debit" style={{ fontWeight: 700 }}>{metrics.totalValue}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">📁</div>
                  <h4 className="empty-title">No Records Found</h4>
                  <p className="empty-desc">
                    {searchQuery ? `No matching records found for "${searchQuery}".` : `No ${selectedCategory === 'sales' ? 'sales' : 'purchase'} orders present for this period in Tally.`}
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </>
    )}

      {/* Raw Payload XML/JSON Inspector */}
      <section className="inspector-card">
        <div className="inspector-header" onClick={() => setShowInspector(!showInspector)}>
          <div className="inspector-title">
            <span>⚙️</span>
            <span>Tally XML Gateway Inspector</span>
          </div>
          <button className="inspector-toggle-btn">
            {showInspector ? 'Hide Logs ▲' : 'Show Logs ▼'}
          </button>
        </div>

        {showInspector && (
          <div className="inspector-content">
            <div className="code-box xml">
              <div className="code-box-header">
                <span>Last Sent XML Request</span>
                <span className="badge">XML Payload</span>
              </div>
              <pre>{lastRequestXml || 'No request sent yet.'}</pre>
            </div>

            <div className="code-box xml">
              <div className="code-box-header">
                <span>Raw XML Response Received</span>
                <span className="badge">XML Response</span>
              </div>
              <pre>{lastResponseXml || 'No response received yet.'}</pre>
            </div>

            <div className="code-box">
              <div className="code-box-header">
                <span>Parsed JSON Data Object</span>
                <span className="badge purple">React State</span>
              </div>
              <pre>{lastParsedJson ? JSON.stringify(lastParsedJson, null, 2) : 'No parsed data yet.'}</pre>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
