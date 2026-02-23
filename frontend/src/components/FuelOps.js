import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { fmtDateInput, parseWallClockDate, formatWallClockTimeDisplay, formatWallClockDateDisplay, formatWallClockDateTimeDisplay, parseLiters3, safeJson } from './fuelops/utils';
import ReadingsSection from './fuelops/OdometerTab';

const AtDepotSection = lazy(() => import('./fuelops/AtDepotTab'));
const DayLogsSection = lazy(() => import('./fuelops/DayLogsTab'));
const PurchaseSection = lazy(() => import('./fuelops/PurchaseTab'));
const InternalTransferSection = lazy(() => import('./fuelops/InternalTransfersTab'));
const SaleSection = lazy(() => import('./fuelops/SalesTab'));
const AuditSection = lazy(() => import('./fuelops/AuditTab'));
const FuelMeterChecksSection = lazy(() => import('./fuelops/FuelMeterChecksTab'));
const VehiclesStorageSection = lazy(() => import('./fuelops/VehiclesStorageTab'));
const DriversSection = lazy(() => import('./fuelops/DriversTab'));

export default function FuelOps({ perms }) {
  const token = useMemo(() => {
    try { return localStorage.getItem('authToken'); } catch { return null; }
  }, []);
  const [units, setUnits] = useState([]);
  const [unitId, setUnitId] = useState('');
  const [drivers, setDrivers] = useState([]); // Initialize drivers state
  const [driverRowId, setDriverRowId] = useState('');
  const [datums, setDatums] = useState([]);
  const [loadDate, setLoadDate] = useState(() => fmtDateInput(new Date()));
  const [liters, setLiters] = useState('');
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState(null);
  const [purchaseTime, setPurchaseTime] = useState('');
  const [dailyDate, setDailyDate] = useState(() => fmtDateInput(new Date()));
  const [openKm, setOpenKm] = useState('');
  const [closeKm, setCloseKm] = useState(''); // Initialize closing kilometers state
  const [odoNote, setOdoNote] = useState('');
  const [postingOdo, setPostingOdo] = useState(false);
  const [stockSummary, setStockSummary] = useState({ items: [], generatedAt: null });
  const [stockLoading, setStockLoading] = useState(false);
  const stockInFlight = useRef(false);

  // Load trucks
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
    const r = await fetch('/api/fuel-ops/vehicles?type=TRUCK', { headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
        const data = await safeJson(r);
        if (!aborted) {
          setUnits(data || []);
          if (!unitId && data && data.length) setUnitId(String(data[0].id));
        }
      } catch {
        if (!aborted) setUnits([]);
      }
    })();
    return () => { aborted = true; };
  }, [token]);

  // Load drivers
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const r = await fetch('/api/fuel-ops/drivers', { headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
        const data = await safeJson(r);
        if (!r.ok) throw new Error((data && data.error) || 'Failed to load drivers');
        if (!aborted) {
          const arr = Array.isArray(data) ? data : [];
          setDrivers(arr);
          if (!driverRowId && arr && arr.length) setDriverRowId(String(arr[0].id));
        }
      } catch {
        if (!aborted) setDrivers([]);
      }
    })();
    return () => { aborted = true; };
  }, [token]);

  // Load datum storage units
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const r = await fetch('/api/fuel-ops/vehicles?type=DATUM', { headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
        const data = await safeJson(r);
        if (!aborted) setDatums(Array.isArray(data) ? data : []);
      } catch {
        if (!aborted) setDatums([]);
      }
    })();
    return () => { aborted = true; };
  }, [token]);

  // Load mini stock summary (and expose reload helper so children can trigger refresh)
  async function reloadStockSummary(manual = false) {
    if (stockInFlight.current) return null;
    stockInFlight.current = true;
    if (manual) setStockLoading(true);
    try {
      const r = await fetch('/api/fuel-ops/stock/summary', { headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed to load stock summary');
      setStockSummary(data);
      return data;
    } catch (e) {
      setStockSummary({ items: [], generatedAt: null });
      return null;
    } finally {
      stockInFlight.current = false;
      if (manual) setStockLoading(false);
    }
  }

  useEffect(() => {
    let aborted = false;
    (async () => {
      if (aborted) return;
      await reloadStockSummary();
    })();
    return () => { aborted = true; };
  }, [token]);

  // 45s polling for mini dashboard (auto-refresh)
  useEffect(() => {
    const id = setInterval(() => { reloadStockSummary(); }, 45000);
    return () => clearInterval(id);
  }, [token]);

  // Load existing daily odometer readings or suggestions
  useEffect(() => {
    let aborted = false;
    (async () => {
      if (!unitId || !dailyDate) return;
      const auth = token ? { Authorization: 'Bearer ' + token } : {};
      try {
        const r = await fetch(`/api/fuel-ops/day/odometer?truck_id=${unitId}&date=${dailyDate}`, { headers: { ...auth, Accept: 'application/json' } });
        const data = await safeJson(r);
        if (!aborted && data) {
          setOpenKm(String(data.opening_km));
          setCloseKm(String(data.closing_km));
          setOdoNote(data.note || '');
        } else if (!aborted) {
          const s = await fetch(`/api/fuel-ops/opening-suggestion/odometer?truck_id=${unitId}&date=${dailyDate}`, { headers: auth }).then(x=>x.json());
          setOpenKm(s.opening != null ? String(s.opening) : '');
          setCloseKm('');
          setOdoNote('');
        }
      } catch {}
    })();
    return () => { aborted = true; };
  }, [unitId, dailyDate, token]);

  // Preview lot code
  useEffect(() => {
    let aborted = false;
    (async () => {
      setPreview(null); setMessage(null);
      const uid = parseInt(unitId, 10);
      const l = parseLiters3(liters);
      if (!uid || !loadDate || l == null || l <= 0) return;
      try {
        const q = new URLSearchParams({ unit_id: String(uid), load_date: loadDate, loaded_liters: String(l) });
        const r = await fetch('/api/fuel-ops/lot-code?' + q.toString(), { headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
        if (!r.ok) {
          const err = await safeJson(r).catch(()=>({ error: 'Unable to preview' }));
          if (!aborted) setMessage(err.error || 'Unable to preview');
          return;
        }
        const data = await safeJson(r);
        if (!aborted) setPreview(data);
      } catch { if (!aborted) setMessage('Preview failed'); }
    })();
    return () => { aborted = true; };
  }, [unitId, loadDate, liters, token]);

  async function onCreateLot(e) {
    e.preventDefault(); setSubmitting(true); setMessage(null);
    try {
  // Send explicit load_time to backend (falls back to performed_time if omitted server-side)
  const loaded = parseLiters3(liters);
  if (loaded == null || loaded <= 0) throw new Error('Enter liters');
  const body = { unit_id: parseInt(unitId, 10), load_date: loadDate, loaded_liters: loaded, load_time: purchaseTime || undefined };
      const r = await fetch('/api/fuel-ops/lots', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
      const data = await safeJson(r);
      if (r.ok) {
        setMessage(`Created lot ${data.lot_code}`);
        setPreview({ lot_code: data.lot_code, seq_index: data.seq_index });
        setLiters('');
        setPurchaseTime('');
      } else {
        setMessage(data.error || 'Create failed');
      }
    } catch (e) { setMessage(String(e.message || e || 'Create failed')); }
    finally { setSubmitting(false); }
  }

  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const permsProvided = !!perms;
  const canMini = permsProvided ? !!perms?.actions?.['FuelOps.view_mini_stock'] : true;
  return (
  <div className="fuel-ops-wrap">
      <h2 style={{ margin: 0, fontSize: 20 }}>Fuel Ops</h2>
      <div className="ops-layout" style={{ marginTop: 16 }}>
        <div className="ops-main">
          {canMini && (
            <button className="mobile-indicators-btn btn" onClick={()=> setIndicatorsOpen(true)} style={{ marginBottom: 10 }}>Stock Indicators</button>
          )}
          <SubTabs
          token={token}
          units={units}
          setUnits={setUnits}
          unitId={unitId}
          setUnitId={setUnitId}
          loadDate={loadDate}
          setLoadDate={setLoadDate}
          liters={liters}
          setLiters={setLiters}
          preview={preview}
          setPreview={setPreview}
          message={message}
          setMessage={setMessage}
          submitting={submitting}
          setSubmitting={setSubmitting}
          refreshStock={reloadStockSummary}
          stockSummary={stockSummary}
          purchaseTime={purchaseTime}
          setPurchaseTime={setPurchaseTime}
          perms={perms}
          readingsSection={<ReadingsSection
            token={token}
            units={units}
            unitId={unitId}
            setUnitId={setUnitId}
            drivers={drivers}
            driverRowId={driverRowId}
            setDriverRowId={setDriverRowId}
            dailyDate={dailyDate}
            setDailyDate={setDailyDate}
            openKm={openKm}
            setOpenKm={setOpenKm}
            closeKm={closeKm}
            setCloseKm={setCloseKm}
            odoNote={odoNote}
            setOdoNote={setOdoNote}
            postingOdo={postingOdo}
            setPostingOdo={setPostingOdo}
          />}
          drivers={drivers}
          setDrivers={setDrivers}
          onCreateLot={onCreateLot}
            datums={datums}
            setDatums={setDatums}
        />
        </div>
        <aside className="ops-aside">
          {canMini && (
            <MiniStockCard
              stockSummary={stockSummary}
              reloadStockSummary={reloadStockSummary}
              stockLoading={stockLoading}
            />
          )}
        </aside>
      </div>

      {/* Mobile slide-out drawer for indicators */}
      {canMini && indicatorsOpen && <div className="drawer-backdrop" onClick={()=> setIndicatorsOpen(false)} />}
      {canMini && (
        <div className={`drawer-panel ${indicatorsOpen ? 'open' : ''}`}>
          <MiniStockCard
            stockSummary={stockSummary}
            reloadStockSummary={reloadStockSummary}
            stockLoading={stockLoading}
            onClose={()=> setIndicatorsOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function GroupList({ title, items }) {
  if (!items || items.length === 0) return (
    <div>
      <div style={{ fontWeight:600, margin:'6px 0' }}>{title}</div>
      <div style={{ color:'#6b7280', fontSize:12 }}>—</div>
    </div>
  );
  return (
    <div>
      <div style={{ fontWeight:600, margin:'6px 0' }}>{title}</div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:6 }}>
        {items.map(it => (
          <React.Fragment key={it.id}>
            <div style={{ display:'flex', flexDirection:'column' }}>
              <div style={{ fontSize:13, fontWeight:600 }}>{it.unit_code}{it.vehicle_number ? ` · ${it.vehicle_number}` : ''}</div>
              {/* Live meter = latest snapshot + all outbound (sales + transfers) since that snapshot.*/}
              <div style={{ fontSize:12, color:'#111' }}>
                Fuel meter: <b>{Number(it.meter_reading_liters||0)}</b> L
                {(() => {
                  try {
                    // For DATUM, show the latest meter snapshot date/time
                    if (it.unit_type === 'DATUM') {
                      const snapAt = it.latest_snapshot_at;
                      if (!snapAt) return null;
                      const dateStr = formatWallClockDateDisplay(snapAt);
                      const timeStr = formatWallClockTimeDisplay(snapAt);
                      return (
                        <span style={{ marginLeft:6, color:'#6b7280' }}>
                          (latest snapshot at {dateStr} at {timeStr})
                        </span>
                      );
                    }
                    // For TRUCK, prefer last outbound (sale/transfer) if valid; otherwise fall back to snapshot
                    const outAt = parseWallClockDate(it.last_outbound_at);
                    const isValidOutAt = outAt && outAt.getFullYear() > 2000; // guard against 1970 placeholder
                    if (isValidOutAt) {
                      const saleAt = parseWallClockDate(it.last_sale_at);
                      const isSale = saleAt && outAt.getTime() === saleAt.getTime();
                      const label = isSale ? 'sale' : 'transfer';
                      return (
                        <span style={{ marginLeft:6, color:'#6b7280' }}>
                          (latest {label} at {formatWallClockTimeDisplay(it.last_outbound_at)})
                        </span>
                      );
                    }
                    const snapAt = it.latest_snapshot_at;
                    if (snapAt) {
                      const dateStr = formatWallClockDateDisplay(snapAt);
                      const timeStr = formatWallClockTimeDisplay(snapAt);
                      return (
                        <span style={{ marginLeft:6, color:'#6b7280' }}>
                          (latest snapshot at {dateStr} at {timeStr})
                        </span>
                      );
                    }
                    return null;
                  } catch { return null; }
                })()}
              </div>
              <div style={{ fontSize:11, color:'#6b7280' }}>
                Capacity: {it.capacity_liters} L
                {it.vehicle_number ? ` · Vehicle: ${it.vehicle_number}` : ''}
              </div>
              {it.lot_code_initial && (
                <div style={{ fontSize:11, color:'#6b7280' }}>Lot: {it.lot_code_initial}</div>
              )}
            </div>
            <div style={{ textAlign:'right', fontSize:12 }}>
              <div><span style={{ color:'#374151' }}>In-stock:</span> <b>{it.instock_liters}</b> L</div>
              <div><span style={{ color:'#374151' }}>Sale only:</span> <b>{it.sale_only_liters}</b> L</div>
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function MiniStockCard({ stockSummary, reloadStockSummary, stockLoading, onClose }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>Mini stock indicators</div>
        <div style={{ display:'flex', gap:6 }}>
          {onClose && (
            <button className="btn ghost" onClick={onClose} style={{ padding:'4px 8px', fontSize:12 }}>Close</button>
          )}
          <button className="btn ghost" onClick={() => reloadStockSummary(true)} disabled={stockLoading} style={{ padding:'4px 8px', fontSize:12 }}>
            {stockLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      {(stockSummary.items||[]).length === 0 ? (
        <div style={{ color:'#6b7280', fontSize:12 }}>No data</div>
      ) : (
        <>
          <GroupList title="Tankers" items={(stockSummary.items||[]).filter(x=>x.unit_type==='TRUCK')} />
          <div style={{ height: 8 }} />
          <GroupList title="DATUM" items={(stockSummary.items||[]).filter(x=>x.unit_type==='DATUM')} />
        </>
      )}
      {stockSummary.generatedAt && (
        <div style={{ marginTop:8, color:'#9CA3AF', fontSize:11 }}>as of {formatWallClockDateTimeDisplay(stockSummary.generatedAt)}</div>
      )}
    </div>
  );
}

function SubTabs({ token, units, setUnits, unitId, setUnitId, loadDate, setLoadDate, liters, setLiters, preview, setPreview, message, setMessage, submitting, setSubmitting, readingsSection, drivers, setDrivers, onCreateLot, datums, setDatums, refreshStock, stockSummary, purchaseTime, setPurchaseTime, perms }) {
  const navigate = useNavigate();
  const location = useLocation();
  const permsProvided = !!perms;
  const can = useMemo(() => ({
    readings: permsProvided ? !!perms?.actions?.['FuelOps.view_readings'] : true,
    meterChecks: permsProvided ? !!perms?.actions?.['FuelOps.view_meter_checks'] : true,
    atDepot: permsProvided ? !!perms?.actions?.['FuelOps.view_at_depot'] : true,
    dayLogs: permsProvided ? !!perms?.actions?.['FuelOps.view_day_logs'] : true,
    vehiclesInfo: permsProvided ? !!perms?.actions?.['FuelOps.view_vehicles_storage_info'] : true,
    drivers: permsProvided ? !!perms?.actions?.['FuelOps.view_drivers'] : true,
    purchase: permsProvided ? !!perms?.actions?.['FuelOps.view_purchase'] : true,
    internal: permsProvided ? !!perms?.actions?.['FuelOps.view_internal_transfers'] : true,
    sales: permsProvided ? !!perms?.actions?.['FuelOps.view_sales'] : true,
    audit: permsProvided ? !!perms?.actions?.['FuelOps.view_audit'] : true,
  }), [permsProvided, perms]);

  const TAB_ROUTES = useMemo(() => [
    can.readings      && { label: 'Odometer Readings',      route: 'odometer' },
    can.meterChecks   && { label: 'Fuel Meter Checks',      route: 'meter-checks' },
    can.atDepot       && { label: 'At Depot',                route: 'at-depot' },
    can.dayLogs       && { label: 'Day Logs',                route: 'day-logs' },
    can.vehiclesInfo  && { label: 'Vehicles & Storage Info', route: 'vehicles' },
    can.drivers       && { label: 'Drivers',                 route: 'drivers' },
    can.purchase      && { label: 'Purchase',                route: 'purchase' },
    can.internal      && { label: 'Internal Transfers',      route: 'internal-transfers' },
    can.sales         && { label: 'Sales',                   route: 'sales' },
    can.audit         && { label: 'Audit',                   route: 'audit' },
  ].filter(Boolean), [can]);

  // Derive the active route slug from the current URL
  const activeRoute = location.pathname.replace(/^\/fuelops\/?/, '').split('/')[0] || '';

  // Default route for the index
  const defaultRoute = TAB_ROUTES.length > 0 ? TAB_ROUTES[0].route : '';

  return (
    <div>
      {TAB_ROUTES.length === 0 ? (
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>No Fuel Ops access</div>
          <div style={{ color: '#6b7280', fontSize: 13, lineHeight: 1.4 }}>
            No Fuel Ops sub-tabs are enabled for this user. If you are an employee, ask an owner/admin to enable Fuel Ops permissions in Employee Control.
          </div>
        </div>
      ) : (
      <div className="fo-tabs">
        {TAB_ROUTES.map(t => (
          <button key={t.route} className={activeRoute===t.route ? 'nav-btn active fo-tab-item' : 'nav-btn fo-tab-item'} onClick={()=>navigate('/fuelops/'+t.route)}>{t.label}</button>
        ))}
      </div>
      )}
      <Suspense fallback={<div style={{ padding: 24, color: '#6b7280' }}>Loading</div>}>
      <Routes>
        {defaultRoute && <Route index element={<Navigate to={defaultRoute} replace />} />}
        {can.readings && <Route path="odometer" element={<>{readingsSection}</>} />}
        {can.meterChecks && <Route path="meter-checks" element={<FuelMeterChecksSection token={token} units={[...(units||[]), ...(datums||[])]} />} />}
        {can.atDepot && <Route path="at-depot" element={
          <AtDepotSection
            token={token}
            units={units}
            datums={datums}
            drivers={drivers}
            refreshStock={refreshStock}
            stockSummary={stockSummary}
            perms={perms}
          />
        } />}
        {can.dayLogs && <Route path="day-logs" element={
          <DayLogsSection token={token} units={units} datums={datums} refreshStock={refreshStock} drivers={drivers} perms={perms} />
        } />}
        {can.vehiclesInfo && <Route path="vehicles" element={
          <VehiclesStorageSection token={token} units={units} datums={datums} setUnits={setUnits} setDatums={setDatums} perms={perms} />
        } />}
        {can.drivers && <Route path="drivers" element={
          <DriversSection token={token} drivers={drivers} setDrivers={setDrivers} perms={perms} />
        } />}
        {can.purchase && <Route path="purchase" element={
          <>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16 }}>Purchase fuel (create lot)</h3>
            <PurchaseSection
              token={token}
              units={units}
              unitId={unitId}
              setUnitId={setUnitId}
              loadDate={loadDate}
              setLoadDate={setLoadDate}
              liters={liters}
              setLiters={setLiters}
              preview={preview}
              setPreview={setPreview}
              message={message}
              setMessage={setMessage}
              submitting={submitting}
              setSubmitting={setSubmitting}
              onCreateLot={onCreateLot}
              refreshStock={refreshStock}
              datums={datums}
              purchaseTime={purchaseTime}
              setPurchaseTime={setPurchaseTime}
            />
          </>
        } />}
        {can.internal && <Route path="internal-transfers" element={
          <>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16 }}>Internal transfers</h3>
            <InternalTransferSection token={token} units={units} datums={datums} drivers={drivers} refreshStock={refreshStock} />
          </>
        } />}
        {can.sales && <Route path="sales" element={
          <>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 16 }}>Lot sale records</h3>
            <SaleSection token={token} units={units} datums={datums} drivers={drivers} refreshStock={refreshStock} />
          </>
        } />}
        {can.audit && <Route path="audit" element={
          <AuditSection token={token} units={units} datums={datums} drivers={drivers} refreshStock={refreshStock} />
        } />}
        {defaultRoute && <Route path="*" element={<Navigate to={'/fuelops/' + defaultRoute} replace />} />}
      </Routes>
      </Suspense>
    </div>
  );
}
