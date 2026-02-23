import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchCurrentUser } from '../../utils/auth';
import { fmtDateInput, parseWallClockDate, formatWallClockTimeDisplay, parseLiters3, round3, safeJson } from './utils';
import Timeline from './Timeline';

export default function AtDepotSection({ token, units, datums, drivers, refreshStock, stockSummary, perms }) {
  const permsProvided = !!perms;
  const canEditAtDepot = permsProvided ? !!perms?.actions?.['FuelOps.edit_at_depot'] : true;
  const canDeleteAtDepot = permsProvided ? !!perms?.actions?.['FuelOps.delete_at_depot'] : true;
  const [currentUserRole, setCurrentUserRole] = useState(null);
  useEffect(() => {
    let aborted = false;
    (async () => {
      const me = await fetchCurrentUser();
      if (!aborted) setCurrentUserRole(me?.role || null);
    })();
    return () => { aborted = true; };
  }, []);
  const isOwnerOrAdmin = currentUserRole === 'OWNER' || currentUserRole === 'ADMIN';
  const AT_DEPOT_SHORTCUTS_KEY = 'fuelops.atdepot.shortcuts.v1';
  // Shared selections
  // Allow selecting both TRUCK and DATUM units here (include datums alongside units)
  const [truckId, setTruckId] = useState(() => {
    const first = (units && units[0]) || (datums && datums[0]);
    return first ? String(first.id) : '';
  });
  useEffect(() => {
    if (truckId) return;
    const first = (units && units[0]) || (datums && datums[0]);
    if (first) setTruckId(String(first.id));
  }, [units, datums]);
  const [theDate, setTheDate] = useState(() => fmtDateInput(new Date()));
  const [driverId, setDriverId] = useState(() => (drivers && drivers[0] ? String(drivers[0].id) : ''));
  useEffect(() => { if (!driverId && drivers && drivers[0]) setDriverId(String(drivers[0].id)); }, [drivers]);

  const driverSelectRef = useRef(null);

  const allUnits = useMemo(() => ([...(units || []), ...(datums || [])]), [units, datums]);
  const unitById = useMemo(() => {
    const m = new Map();
    for (const u of allUnits) m.set(String(u.id), u);
    return m;
  }, [allUnits]);
  const driverById = useMemo(() => {
    const m = new Map();
    for (const d of (Array.isArray(drivers) ? drivers : [])) m.set(String(d.id), d);
    return m;
  }, [drivers]);

  // pendingTripNo != null means user clicked "+ Trip N" and must pick driver for that trip.
  const [pendingTripNo, setPendingTripNo] = useState(null);
  // Once confirmed (and/or after trip is created), lock driver editing.
  const [driverConfirmed, setDriverConfirmed] = useState(false);

  function driverLabelById(id) {
    try {
      const d = (Array.isArray(drivers) ? drivers : []).find(x => String(x.id) === String(id));
      if (!d) return '';
      return `${d.driver_id || '-'} · ${d.name || ''}`.trim();
    } catch {
      return '';
    }
  }

  useEffect(() => {
    // Changing context resets the create-trip flow.
    setPendingTripNo(null);
    setDriverConfirmed(false);
  }, [truckId, theDate]);

  const liveInStockLiters = useMemo(() => {
    try {
      const id = Number(truckId);
      if (!Number.isFinite(id) || id <= 0) return null;
      const items = (stockSummary && Array.isArray(stockSummary.items)) ? stockSummary.items : [];
      const row = items.find(x => Number(x.id) === id);
      const v = row && row.instock_liters != null ? Number(row.instock_liters) : null;
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }, [stockSummary, truckId]);

  const liveFuelMeterLiters = useMemo(() => {
    try {
      const id = Number(truckId);
      if (!Number.isFinite(id) || id <= 0) return null;
      const items = (stockSummary && Array.isArray(stockSummary.items)) ? stockSummary.items : [];
      const row = items.find(x => Number(x.id) === id);
      const v = row && row.meter_reading_liters != null ? Number(row.meter_reading_liters) : null;
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }, [stockSummary, truckId]);

  const [shortcuts, setShortcuts] = useState(() => {
    try {
      const raw = window.localStorage.getItem(AT_DEPOT_SHORTCUTS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(AT_DEPOT_SHORTCUTS_KEY, JSON.stringify(shortcuts || [])); } catch {}
  }, [shortcuts]);

  const shortcutsForDate = useMemo(() => {
    const d = String(theDate || '');
    const arr = Array.isArray(shortcuts) ? shortcuts : [];
    if (!d) return arr;
    return arr.filter(s => String(s.date || '') === d);
  }, [shortcuts, theDate]);

  function shortcutLabel(s) {
    const u = unitById.get(String(s.truckId));
    const d = driverById.get(String(s.driverId));
    const unitLabel = u ? `${u.unit_code}${u.vehicle_number ? ` · ${u.vehicle_number}` : ''}${u.unit_type ? ` · ${u.unit_type}` : ''}` : `Unit ${s.truckId}`;
    const driverLabel = d ? `${d.driver_id || '-'} · ${d.name || ''}`.trim() : `Driver ${s.driverId}`;
    return `${unitLabel} · ${s.date} · ${driverLabel}`;
  }

  function resetContextBeforeLoad() {
    setTrips([]);
    setActiveTripNo(null);
    setOpeningLiters(''); setOpeningAt('');
    setClosingLiters(''); setClosingAt('');
    setOpeningSaved(false); setClosingSaved(false);
    setOpeningEditMode(false); setClosingEditMode(false);
    setSaleVehicle(''); setTransferToUnit(''); setVolume(''); setActionTime('');
    setDayOps({ loading: false, error: '', remaining_liters: null, totals: null, sales: [], transfers_out: [], transfers_in: [], loads: [], testing: [] });
  }

  function saveShortcutCurrent() {
    if (!truckId || !theDate || !driverId) return;
    const key = `${String(truckId)}|${String(theDate)}|${String(driverId)}`;
    setShortcuts(prev => {
      const arr = Array.isArray(prev) ? prev : [];
      const filtered = arr.filter(x => `${String(x.truckId)}|${String(x.date)}|${String(x.driverId)}` !== key);
      const next = [{ truckId: String(truckId), date: String(theDate), driverId: String(driverId), savedAt: Date.now() }, ...filtered];
      return next.slice(0, 10);
    });
  }

  function applyShortcut(s) {
    const nextTruckId = unitById.has(String(s.truckId)) ? String(s.truckId) : (allUnits[0] ? String(allUnits[0].id) : '');
    const nextDriverId = driverById.has(String(s.driverId)) ? String(s.driverId) : ((Array.isArray(drivers) && drivers[0]) ? String(drivers[0].id) : '');
    resetContextBeforeLoad();
    if (nextTruckId) setTruckId(nextTruckId);
    if (s.date) setTheDate(String(s.date));
    if (nextDriverId) setDriverId(nextDriverId);
    if (!openInfo) setOpenInfo(true);
  }

  function removeShortcut(s) {
    const key = `${String(s.truckId)}|${String(s.date)}|${String(s.driverId)}`;
    setShortcuts(prev => (Array.isArray(prev) ? prev : []).filter(x => `${String(x.truckId)}|${String(x.date)}|${String(x.driverId)}` !== key));
  }

  // Collapsible toggles
  const [openInfo, setOpenInfo] = useState(true);
  const [openOpening, setOpenOpening] = useState(true);
  const [openSales, setOpenSales] = useState(true);
  const [openClosing, setOpenClosing] = useState(true);

  // Opening fields (scaffold)
  const [openingLiters, setOpeningLiters] = useState('');
  const [openingAt, setOpeningAt] = useState('');
  const [openingMsg, setOpeningMsg] = useState('');
  const [openingSaved, setOpeningSaved] = useState(false);
  const [openingEditMode, setOpeningEditMode] = useState(false);
  const openingOrig = useRef({ liters: '', at: '' });

  // Sales/Transfers fields (scaffold)
  const [action, setAction] = useState('SALE'); // SALE | TO_TANKER | TO_DATUM
  const [saleVehicle, setSaleVehicle] = useState('');
  const [transferToUnit, setTransferToUnit] = useState('');
  const [volume, setVolume] = useState('');
  const [actionTime, setActionTime] = useState(''); // HH:mm
  const [opsMsg, setOpsMsg] = useState('');
  // eslint-disable-next-line no-unused-vars
  const [externalTanker, setExternalTanker] = useState('');
  const [testingToUnitId, setTestingToUnitId] = useState('');
  useEffect(()=>{ if (!testingToUnitId && truckId) setTestingToUnitId(String(truckId)); }, [truckId]);

  // Closing fields (scaffold)
  const [closingLiters, setClosingLiters] = useState('');
  const [closingAt, setClosingAt] = useState('');
  const [closingMsg, setClosingMsg] = useState('');
  const [closingSaved, setClosingSaved] = useState(false);
  const [closingEditMode, setClosingEditMode] = useState(false);
  const closingOrig = useRef({ liters: '', at: '' });
  const [savingOpening, setSavingOpening] = useState(false);
  const [savingOps, setSavingOps] = useState(false);
  const [savingClosing, setSavingClosing] = useState(false);
  const [freezeBusy, setFreezeBusy] = useState(false);
  // Operations list (either whole day or filtered to active trip window)
  const [dayOps, setDayOps] = useState({ loading: false, error: '', remaining_liters: null, totals: null, sales: [], transfers_out: [], transfers_in: [], loads: [] });
  // Total sales for selected date across all trips
  const [dayAllOps, setDayAllOps] = useState({ loading: false, error: '', totals: null, sales: [] });
  // Trips state
  const [trips, setTrips] = useState([]); // list of trips for truck/date
  const [tripLoading, setTripLoading] = useState(false);
  const [creatingTrip, setCreatingTrip] = useState(false);
  const [activeTripNo, setActiveTripNo] = useState(null); // current selected trip number
  const prevActiveTripNoRef = useRef(null);
  // Lock opening/closing readings until a trip is created for the selected truck+date
  const readingsLocked = activeTripNo == null;
  const activeTripRow = useMemo(() => {
    if (activeTripNo == null) return null;
    return (trips || []).find(t => t.trip_no === activeTripNo) || null;
  }, [trips, activeTripNo]);
  const tripFrozen = !!(activeTripRow && activeTripRow.is_frozen);
  const opsLocked = readingsLocked || tripFrozen;
  const driverLocked = driverConfirmed === true && pendingTripNo == null;

  const remainingForUi = (liveInStockLiters != null) ? liveInStockLiters : dayOps.remaining_liters;

  function isTripClosed(tripRow) {
    if (!tripRow) return false;
    // Some DB rows may default closing_liters to 0 even before the trip is actually closed.
    // Treat a trip as closed only when a closing time is saved, or when a non-zero closing liters exists.
    if (tripRow.closing_at) return true;
    if (tripRow.closing_liters != null && Number(tripRow.closing_liters) !== 0) return true;
    return false;
  }

  async function getFreshFuelMeterLiters() {
    try {
      if (typeof refreshStock === 'function') {
        const latest = await refreshStock(true);
        const items = latest && Array.isArray(latest.items) ? latest.items : null;
        if (items && truckId) {
          const row = items.find(x => Number(x.id) === Number(truckId));
          const v = row && row.meter_reading_liters != null ? Number(row.meter_reading_liters) : null;
          if (Number.isFinite(v)) return v;
        }
      }
    } catch {}
    return liveFuelMeterLiters;
  }

  // Keep driver selection aligned to the active trip when not in pending create flow.
  useEffect(() => {
    try {
      if (pendingTripNo != null) return;
      if (activeTripNo == null) return;
      const tripRow = (trips || []).find(t => t.trip_no === activeTripNo);
      const code = tripRow && tripRow.driver_code ? String(tripRow.driver_code) : '';
      if (!code) return;
      const d = (Array.isArray(drivers) ? drivers : []).find(x => String(x.driver_id) === code);
      if (d) {
        setDriverId(String(d.id));
        setDriverConfirmed(true);
      }
    } catch {}
  }, [activeTripNo, trips, drivers, pendingTripNo]);

  // Keep opening/closing fields in sync with selected trip whenever trips list changes
  useEffect(() => {
    if (activeTripNo == null) return;
    const tripChanged = prevActiveTripNoRef.current !== activeTripNo;
    prevActiveTripNoRef.current = activeTripNo;
    const tripRow = (trips || []).find(t => t.trip_no === activeTripNo);
    if (tripRow) {
      const oL = tripRow.opening_liters != null ? String(tripRow.opening_liters) : '';
      const oT = tripRow.opening_at ? (d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)(parseWallClockDate(tripRow.opening_at) || new Date(tripRow.opening_at)) : '';
      const cL = tripRow.closing_liters != null ? String(tripRow.closing_liters) : '';
      const cT = tripRow.closing_at ? (d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)(parseWallClockDate(tripRow.closing_at) || new Date(tripRow.closing_at)) : '';
      const openingIsSaved = (tripRow.opening_at != null) || (tripRow.opening_liters != null && Number(tripRow.opening_liters) !== 0);
      const closingIsSaved = (tripRow.closing_liters != null) && !(Number(tripRow.closing_liters) === 0 && !tripRow.closing_at);
      setOpeningSaved(!!openingIsSaved); setClosingSaved(!!closingIsSaved);

      // Only sync liters/time from DB when the reading is saved.
      // For unsaved readings, preserve any in-progress UI values (manual time entry or captured closing liters).
      if (tripChanged) {
        setOpeningAt(oT);
        setClosingAt(cT);
        setOpeningLiters(openingIsSaved ? oL : '');
        setClosingLiters(closingIsSaved ? cL : '');
      } else {
        if (openingIsSaved) { setOpeningLiters(oL); setOpeningAt(oT); }
        if (closingIsSaved) { setClosingLiters(cL); setClosingAt(cT); }
      }

      openingOrig.current = { liters: oL, at: oT }; closingOrig.current = { liters: cL, at: cT };
      setOpeningEditMode(false); setClosingEditMode(false);
    }
  }, [trips, activeTripNo]);

  // Auto-fill opening liters from live Fuel meter until opening is saved.
  useEffect(() => {
    if (activeTripNo == null) return;
    if (openingSaved) return;
    if (openingEditMode) return;
    // Don't overwrite a non-zero value already displayed.
    if (openingLiters && Number(openingLiters) !== 0) return;
    if (liveFuelMeterLiters == null) return;
    setOpeningLiters(String(liveFuelMeterLiters));
  }, [activeTripNo, openingSaved, openingEditMode, liveFuelMeterLiters, openingLiters]);

  // Ensure Opening (L) shows a real Fuel meter value immediately (even before the polling stock summary updates).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (activeTripNo == null) return;
      if (openingSaved) return;
      if (openingEditMode) return;
      if (openingLiters && Number(openingLiters) !== 0) return;
      const v = await getFreshFuelMeterLiters();
      if (cancelled) return;
      if (v == null) return;
      setOpeningLiters(String(v));
    })();
    return () => { cancelled = true; };
  }, [activeTripNo, openingSaved, openingEditMode, truckId, theDate, openingLiters]);

  // Load existing day record or opening suggestion
  useEffect(() => {
    let aborted = false;
    (async () => {
      setOpeningMsg(''); setClosingMsg('');
      if (!truckId || !theDate) return;
      const auth = token ? { Authorization: 'Bearer ' + token } : {};
      try {
        // Always load trips first so we can derive opening/closing from selected trip
        try {
          setTripLoading(true);
          const tripsData = await fetch(`/api/fuel-ops/trips?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          if (!aborted) {
            const arr = tripsData && tripsData.items ? tripsData.items : [];
            // Do not auto-create Trip 1; require explicit user action via + Trip button
            setTrips(arr);
            if (arr.length > 0 && activeTripNo == null) setActiveTripNo(1);
            if (arr.length === 0) setActiveTripNo(null);
          }
        } catch { if (!aborted) { setTrips([]); setActiveTripNo(null); } } finally { if (!aborted) setTripLoading(false); }

        // If a trip is active load trip-scoped operations window; else fallback to whole-day dispenser + ops
        if (activeTripNo != null) {
          const tripRow = (trips||[]).find(t => t.trip_no === activeTripNo);
          if (tripRow) {
            const oL = tripRow.opening_liters != null ? String(tripRow.opening_liters) : '';
            const oT = tripRow.opening_at ? (d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)(parseWallClockDate(tripRow.opening_at) || new Date(tripRow.opening_at)) : '';
            const cL = tripRow.closing_liters != null ? String(tripRow.closing_liters) : '';
            const cT = tripRow.closing_at ? (d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)(parseWallClockDate(tripRow.closing_at) || new Date(tripRow.closing_at)) : '';
            // Do not surface default opening_liters=0 for an unsaved opening.
            setOpeningLiters(((tripRow.opening_at != null) || (tripRow.opening_liters != null && Number(tripRow.opening_liters) !== 0)) ? oL : '');
            setOpeningAt(oT);
            setClosingLiters(((tripRow.closing_liters != null) && !(Number(tripRow.closing_liters) === 0 && !tripRow.closing_at)) ? cL : '');
            setClosingAt(cT);
            // Treat an auto-created trip (opening_liters defaults to 0 and no opening_at) as "unsaved"
            // Consider opening saved when a non-null opening_liters is present (even if 0) OR when opening_at exists.
            // Only treat as unsaved when opening_liters is null OR (opening_liters===0 AND no opening_at AND trip just auto-created).
            const openingIsSaved = (tripRow.opening_liters != null && Number(tripRow.opening_liters) !== 0) || (tripRow.opening_at != null);
            const closingIsSaved = (tripRow.closing_liters != null) && !(Number(tripRow.closing_liters) === 0 && !tripRow.closing_at);
            setOpeningSaved(!!openingIsSaved); setClosingSaved(!!closingIsSaved);
            openingOrig.current = { liters: oL, at: oT }; closingOrig.current = { liters: cL, at: cT };
            setOpeningEditMode(false); setClosingEditMode(false);
          } else {
            setOpeningLiters(''); setOpeningAt(''); setClosingLiters(''); setClosingAt('');
            setOpeningSaved(false); setClosingSaved(false);
            openingOrig.current = { liters:'', at:'' }; closingOrig.current = { liters:'', at:'' };
            setOpeningEditMode(false); setClosingEditMode(false);
          }
          // Load per-trip ops window
          try {
            setDayOps(prev => ({ ...prev, loading: true, error: '' }));
            const ops = await fetch(`/api/fuel-ops/ops/trip?truck_id=${truckId}&date=${theDate}&trip_no=${activeTripNo}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
            if (!aborted) setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
          } catch (e) {
            if (!aborted) setDayOps({ loading:false, error: String(e.message||e), remaining_liters:null, totals:null, sales:[], transfers_out:[], transfers_in:[], loads:[], testing:[] });
          }
        } else {
          // Day-level opening suggestion or existing reading
          const r = await fetch(`/api/fuel-ops/day/dispenser?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth, Accept: 'application/json' } });
          const data = await safeJson(r);
          if (aborted) return;
          if (data && data.truck_id) {
            const oL = String(data.opening_liters ?? '');
            const oT = data.opening_at ? (d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)(parseWallClockDate(data.opening_at) || new Date(data.opening_at)) : '';
            const cL = String(data.closing_liters ?? '');
            const cT = data.closing_at ? (d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)(parseWallClockDate(data.closing_at) || new Date(data.closing_at)) : '';
            setOpeningLiters(oL); setOpeningAt(oT);
            setClosingLiters(cL); setClosingAt(cT);
            setOpeningSaved(oL !== ''); setClosingSaved(cL !== '');
            openingOrig.current = { liters: oL, at: oT }; closingOrig.current = { liters: cL, at: cT };
            setOpeningEditMode(false); setClosingEditMode(false);
          } else {
            // No existing day-level reading; do not auto-fill from AT-DEPOT suggestion anymore.
            setOpeningLiters(''); setOpeningAt(''); setClosingLiters(''); setClosingAt('');
            setOpeningSaved(false); setClosingSaved(false);
            openingOrig.current = { liters:'', at:'' }; closingOrig.current = { liters:'', at:'' };
            setOpeningEditMode(false); setClosingEditMode(false);
          }

          try {
            setDayOps(prev => ({ ...prev, loading: true, error: '' }));
            const ops = await fetch(`/api/fuel-ops/ops/day?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
            if (!aborted) setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
          } catch (e) {
            if (!aborted) setDayOps({ loading:false, error: String(e.message||e), remaining_liters:null, totals:null, sales:[], transfers_out:[], transfers_in:[], loads:[], testing:[] });
          }
        }
      } catch {
        if (!aborted) { setOpeningLiters(''); setOpeningAt(''); setClosingLiters(''); setClosingAt(''); }
      }
    })();
    return () => { aborted = true; };
  }, [truckId, theDate, token, activeTripNo]);

  async function reloadDayAllOps() {
    if (!truckId || !theDate) { setDayAllOps({ loading:false, error:'', totals:null, sales:[] }); return; }
    setDayAllOps(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const auth = token ? { Authorization: 'Bearer ' + token } : {};
      const ops = await fetch(`/api/fuel-ops/ops/day?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
      setDayAllOps({ loading:false, error:'', totals: ops.totals || null, sales: ops.sales || [] });
    } catch (e) {
      setDayAllOps({ loading:false, error: String(e.message || e), totals:null, sales: [] });
    }
  }

  useEffect(() => {
    reloadDayAllOps();
  }, [truckId, theDate, token]);

  const totalSalesAllTrips = useMemo(() => {
    try {
      const sales = (dayAllOps && Array.isArray(dayAllOps.sales)) ? dayAllOps.sales : [];
      const sum = sales.reduce((acc, r) => {
        const v = Number(r && (r.sale_volume_liters ?? r.sale_volume ?? 0));
        return acc + (Number.isFinite(v) ? v : 0);
      }, 0);
      return round3(sum) ?? 0;
    } catch { return 0; }
  }, [dayAllOps]);

  const salesCountAllTrips = useMemo(() => {
    const sales = (dayAllOps && Array.isArray(dayAllOps.sales)) ? dayAllOps.sales : [];
    return sales.length;
  }, [dayAllOps]);

  // Actions wired to backend
  async function saveOpening() {
    // Prevent day-level opening save when no trip exists for the truck+date
    if (activeTripNo == null) {
      setOpeningMsg('Create a Trip to enter opening');
      return;
    }
    if (!truckId || !theDate) return;
    if (!openingAt) { setOpeningMsg('Select an opening time'); return; }
    setSavingOpening(true); setOpeningMsg('');
    try {
      const headers = { 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) };
      const drow = (Array.isArray(drivers)?drivers:[]).find(d => String(d.id)===String(driverId));
      if (activeTripNo != null) {
        // Patch existing trip opening OR create if missing by calling createTrip previously
        const tripRow = (trips||[]).find(t => t.trip_no === activeTripNo);
        if (!tripRow) throw new Error('Trip not found');
        const body = {
          opening_at: `${theDate} ${openingAt}:00`,
          driver_name: drow ? drow.name : undefined,
          driver_code: drow ? drow.driver_id : undefined
        };

        // Only set opening_liters when first saving; during Edit we keep liters unchanged.
        if (!openingSaved && !openingEditMode) {
          const openingMeter = await getFreshFuelMeterLiters();
          if (openingMeter == null) throw new Error('Fuel meter not available yet. Refresh mini stock and try again.');
          body.opening_liters = Number(openingMeter);
          setOpeningLiters(String(openingMeter));
        }

        const r = await fetch(`/api/fuel-ops/trips/${tripRow.id}`, { method:'PATCH', headers, body: JSON.stringify(body) });
        const data = await safeJson(r);
        if (!r.ok) throw new Error(data && data.error ? data.error : 'Failed to save trip opening');
        setOpeningMsg('Saved trip opening');
        setOpeningSaved(true);
        openingOrig.current = { liters: String(body.opening_liters ?? openingOrig.current.liters ?? openingLiters), at: openingAt || '' };
        setOpeningEditMode(false);
        // Refresh trips list to ensure persisted opening displays on remount/switch
        try {
          const auth2 = token ? { Authorization:'Bearer '+token } : {};
          const tripsData = await fetch(`/api/fuel-ops/trips?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth2, Accept:'application/json' } }).then(safeJson);
          const arr = tripsData && tripsData.items ? tripsData.items : [];
          setTrips(arr);
          // Re-derive current trip state from refreshed data
          const updatedTrip = arr.find(t => t.trip_no === activeTripNo);
          if (updatedTrip) {
            const oL = updatedTrip.opening_liters != null ? String(updatedTrip.opening_liters) : '';
            const oT = updatedTrip.opening_at ? (d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)(new Date(updatedTrip.opening_at)) : '';
            setOpeningLiters(oL); setOpeningAt(oT);
            openingOrig.current = { liters: oL, at: oT };
          }
        } catch {/* non-critical */}
      } else {
        // Locked: do not allow creating day-level dispenser readings from At Depot anymore
        setOpeningMsg('Locked until a Trip is created');
        return;
      }
      // refresh ops list for current context
      try {
        const auth = token ? { Authorization: 'Bearer ' + token } : {};
        if (activeTripNo != null) {
          const ops = await fetch(`/api/fuel-ops/ops/trip?truck_id=${truckId}&date=${theDate}&trip_no=${activeTripNo}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
        } else {
          const ops = await fetch(`/api/fuel-ops/ops/day?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
        }
      } catch {}
    } catch (e) { setOpeningMsg(String(e.message||e)); }
    finally { setSavingOpening(false); }
  }

  async function createTrip(overrideDriverId = null) {
    if (!truckId || !theDate) return;
    setCreatingTrip(true);
    try {
      const headers = { 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) };
      // For a brand-new trip we do NOT carry over previous opening values
      const effectiveDriverId = overrideDriverId != null ? overrideDriverId : driverId;
      const drow = (Array.isArray(drivers)?drivers:[]).find(d => String(d.id)===String(effectiveDriverId));

      const body = {
        truck_id: parseInt(truckId,10),
        date: theDate,
        driver_name: drow ? drow.name : undefined,
        driver_code: drow ? drow.driver_id : undefined
      };
      const r = await fetch('/api/fuel-ops/trips', { method:'POST', headers, body: JSON.stringify(body) });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed to create trip');
      setDriverConfirmed(true);
      setPendingTripNo(null);
      // reload trips
      try {
        const auth = token ? { Authorization: 'Bearer ' + token } : {};
        const tripsData = await fetch(`/api/fuel-ops/trips?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
        const arr = tripsData && tripsData.items ? tripsData.items : [];
        setTrips(arr);
        setActiveTripNo(data.trip_no);
        // New trip: opening/closing not saved yet. Liters auto-fill, time is manual.
        setOpeningAt('');
        setClosingLiters(''); setClosingAt('');
        setOpeningSaved(false); setClosingSaved(false);
        setOpeningEditMode(false); setClosingEditMode(false);
        setSaleVehicle(''); setTransferToUnit(''); setVolume(''); setActionTime('');
        setDayOps({ loading:false, error:'', remaining_liters:null, totals:null, sales:[], transfers_out:[], transfers_in:[], loads:[], testing:[] });
      } catch {}
    } catch (e) { alert(String(e.message||e)); }
    finally { setCreatingTrip(false); }
  }

  async function endActiveTrip() {
    if (activeTripNo == null) return;
    const tripRow = (trips || []).find(t => t.trip_no === activeTripNo);
    if (!tripRow) { setClosingMsg('Trip not found'); return; }
    if (isTripClosed(tripRow)) return;

    // End trip only CAPTURES closing liters from the live Fuel meter.
    setSavingClosing(true); setClosingMsg('');
    try {
      const closingMeter = await getFreshFuelMeterLiters();
      if (closingMeter == null) throw new Error('Fuel meter not available yet. Refresh mini stock and try again.');
      setClosingLiters(String(closingMeter));
      setClosingSaved(false);
      setClosingEditMode(false);
      setClosingMsg('Captured closing liters. Select time and Save.');
    } catch (e) {
      setClosingMsg(String(e.message || e));
    } finally {
      setSavingClosing(false);
    }
  }

  async function unfreezeActiveTrip() {
    if (!activeTripRow) return;
    if (!isTripClosed(activeTripRow)) return;
    if (!tripFrozen) return;
    if (freezeBusy) return;
    try {
      const promptResult = window.prompt('Unfreeze reason (optional)');
      if (promptResult === null) return;
      const reason = promptResult || '';
      setFreezeBusy(true);
      const headers = { 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) };
      const r = await fetch(`/api/fuel-ops/trips/${activeTripRow.id}/unfreeze`, { method:'POST', headers, body: JSON.stringify({ reason }) });
      const j = await safeJson(r);
      if (!r.ok) throw new Error(j && j.error ? j.error : 'Unfreeze failed');
      const tripsData = await fetch(`/api/fuel-ops/trips?truck_id=${truckId}&date=${theDate}`, { headers:{ Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } }).then(safeJson);
      const arr = tripsData && tripsData.items ? tripsData.items : [];
      setTrips(arr);
      try { await reloadDayAllOps(); } catch {}
      try {
        if (activeTripNo != null) {
          const auth = token ? { Authorization: 'Bearer ' + token } : {};
          const ops = await fetch(`/api/fuel-ops/ops/trip?truck_id=${truckId}&date=${theDate}&trip_no=${activeTripNo}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
        }
      } catch {}
    } catch (e) {
      alert(String(e.message||e));
    } finally {
      setFreezeBusy(false);
    }
  }

  async function updateEndTripActiveTrip() {
    if (!activeTripRow) return;
    if (!isTripClosed(activeTripRow)) { alert('Trip must be ended first.'); return; }
    if (tripFrozen) { alert('Unfreeze the trip first.'); return; }
    if (freezeBusy) return;
    try {
      const promptResult = window.prompt('Update End Trip reason (optional)');
      if (promptResult === null) return;
      const reason = promptResult || '';
      setFreezeBusy(true);
      const headers = { 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) };
      const r = await fetch(`/api/fuel-ops/trips/${activeTripRow.id}/update-end-trip`, { method:'POST', headers, body: JSON.stringify({ reason }) });
      const j = await safeJson(r);
      if (!r.ok) throw new Error(j && j.error ? j.error : 'Update End Trip failed');
      const tripsData = await fetch(`/api/fuel-ops/trips?truck_id=${truckId}&date=${theDate}`, { headers:{ Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } }).then(safeJson);
      const arr = tripsData && tripsData.items ? tripsData.items : [];
      setTrips(arr);
      try { await reloadDayAllOps(); } catch {}
      try {
        if (activeTripNo != null) {
          const auth = token ? { Authorization: 'Bearer ' + token } : {};
          const ops = await fetch(`/api/fuel-ops/ops/trip?truck_id=${truckId}&date=${theDate}&trip_no=${activeTripNo}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
        }
      } catch {}
    } catch (e) {
      alert(String(e.message||e));
    } finally {
      setFreezeBusy(false);
    }
  }

  async function saveSaleOrTransfer() {
    if (activeTripNo == null) {
      setOpsMsg('Create a Trip to enter sales / transfers');
      return;
    }
    if (!truckId || !theDate || !volume) return;
    setSavingOps(true); setOpsMsg('');
    try {
      const headers = { 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) };
      const vol = parseLiters3(volume);
      if (vol == null || vol <= 0) {
        throw new Error('Enter a valid volume');
      }
      // Derive a default time anchored to the current trip's opening time if user leaves time blank
      let effectiveTime = actionTime;
      if (!effectiveTime && activeTripNo != null) {
        const tripRow = (trips||[]).find(t => t.trip_no === activeTripNo);
        if (tripRow && tripRow.opening_at) {
          const d = parseWallClockDate(tripRow.opening_at) || new Date(tripRow.opening_at);
          effectiveTime = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        }
      }
      let endpoint = '/api/fuel-ops/lots/activity';
      let method = 'POST';
      let payload = null;
      // Find selected driver
      const drow = (Array.isArray(drivers)?drivers:[]).find(d => String(d.id)===String(driverId));
      if (action === 'SALE') {
        payload = {
          activity: 'TANKER_TO_VEHICLE',
          from_unit_id: parseInt(truckId,10),
          to_vehicle: saleVehicle,
          volume_liters: vol,
          sale_date: theDate,
          performed_time: effectiveTime || undefined,
          trip: (activeTripNo != null ? parseInt(activeTripNo,10) : undefined),
          driver_id: drow ? parseInt(drow.id,10) : undefined,
          driver_name: drow ? drow.name : undefined
        };
      } else if (action === 'TO_TANKER') {
        payload = {
          activity: 'TANKER_TO_TANKER',
          from_unit_id: parseInt(truckId,10),
          to_unit_id: parseInt(transferToUnit,10),
          volume_liters: vol,
          transfer_date: theDate,
          performed_time: effectiveTime || undefined,
          trip: (activeTripNo != null ? parseInt(activeTripNo, 10) : undefined),
          driver_id: drow ? parseInt(drow.id,10) : undefined,
          driver_name: drow ? drow.name : undefined
        };
      } else if (action === 'TO_DATUM') {
        payload = {
          activity: 'TANKER_TO_DATUM',
          from_unit_id: parseInt(truckId,10),
          to_unit_id: parseInt(transferToUnit,10),
          volume_liters: vol,
          transfer_date: theDate,
          performed_time: effectiveTime || undefined,
          trip: (activeTripNo != null ? parseInt(activeTripNo, 10) : undefined),
          driver_id: drow ? parseInt(drow.id,10) : undefined,
          driver_name: drow ? drow.name : undefined
        };
      } else if (action === 'TESTING') {
        // Allow testing to be logged as net-zero (back to same tanker) OR as an internal transfer
        const toId = testingToUnitId ? parseInt(testingToUnitId,10) : null;
        const fromIdInt = parseInt(truckId,10);
          if (toId && toId !== fromIdInt) {
          // find unit to determine if DATUM or TRUCK
          const allUnits = [ ...(units||[]), ...(datums||[]) ];
          const dest = allUnits.find(u => Number(u.id) === Number(toId));
          const actType = dest && dest.unit_type === 'DATUM' ? 'TANKER_TO_DATUM' : 'TANKER_TO_TANKER';
          payload = {
            activity: actType,
            from_unit_id: fromIdInt,
            to_unit_id: toId,
            volume_liters: vol,
            transfer_date: theDate,
            performed_time: effectiveTime || undefined,
            driver_id: drow ? parseInt(drow.id,10) : undefined,
            driver_name: drow ? drow.name : undefined
            , trip: (activeTripNo != null ? parseInt(activeTripNo,10) : undefined)
          };
        } else {
          // testing filled back to same tanker — record as TESTING activity (net-zero)
          // include to_vehicle label for clarity in the table
          const unitRow = (units||[]).find(u => String(u.id)===String(truckId));
          const toVehicleLabel = unitRow ? unitRow.unit_code : undefined;
          payload = {
            activity: 'TESTING',
            from_unit_id: parseInt(truckId,10),
            to_vehicle: toVehicleLabel,
            volume_liters: vol,
            transfer_date: theDate,
            performed_time: effectiveTime || undefined,
            driver_id: drow ? parseInt(drow.id,10) : undefined,
            driver_name: drow ? drow.name : undefined
            , trip: (activeTripNo != null ? parseInt(activeTripNo,10) : undefined)
          };
        }
      }
      const r = await fetch(endpoint, { method, headers, body: JSON.stringify(payload) });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data && data.error ? data.error : 'Failed to save');
      setOpsMsg('Saved');
  setSaleVehicle(''); setTransferToUnit(''); setVolume(''); setActionTime('');
      try { if (typeof refreshStock==='function') await refreshStock(); } catch {}
      // refresh ops
      try {
        const auth = token ? { Authorization: 'Bearer ' + token } : {};
        if (activeTripNo != null) {
          const ops = await fetch(`/api/fuel-ops/ops/trip?truck_id=${truckId}&date=${theDate}&trip_no=${activeTripNo}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
        } else {
          const ops = await fetch(`/api/fuel-ops/ops/day?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
        }
      } catch {}
      try { await reloadDayAllOps(); } catch {}
    } catch (e) { setOpsMsg(String(e.message||e)); }
    finally { setSavingOps(false); }
  }

  // (Removed LOADED-specific override helper — LOADED action removed from UI.)

  async function saveClosing() {
    // Prevent day-level closing save when no trip exists for the truck+date
    if (activeTripNo == null) {
      setClosingMsg('Create a Trip to enter closing');
      return;
    }
    if (!truckId || !theDate) return;
    if (!closingAt) { setClosingMsg('Select a closing time'); return; }
    setSavingClosing(true); setClosingMsg('');
    try {
      const headers = { 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) };
      if (activeTripNo != null) {
        const tripRow = (trips||[]).find(t => t.trip_no === activeTripNo);
        if (!tripRow) throw new Error('Trip not found');
        const body = { closing_at: `${theDate} ${closingAt}:00` };

        // Only set closing_liters when first saving; during Edit we keep liters unchanged.
        if (!closingSaved && !closingEditMode) {
          if (!closingLiters) throw new Error('Press End trip to capture closing liters');
          const closingVal = parseLiters3(closingLiters);
          if (closingVal == null) throw new Error('Invalid closing liters');
          body.closing_liters = closingVal;
        }
        const r = await fetch(`/api/fuel-ops/trips/${tripRow.id}`, { method:'PATCH', headers, body: JSON.stringify(body) });
        const data = await safeJson(r);
        if (!r.ok) throw new Error(data && data.error ? data.error : 'Failed to save trip closing');
        setClosingMsg('Saved trip closing');
        setClosingSaved(true);
        closingOrig.current = { liters: String(body.closing_liters ?? closingOrig.current.liters ?? closingLiters), at: closingAt || '' };
        setClosingEditMode(false);

        // Refresh trips list to ensure persisted closing displays on remount/switch
        try {
          const auth2 = token ? { Authorization:'Bearer '+token } : {};
          const tripsData = await fetch(`/api/fuel-ops/trips?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth2, Accept:'application/json' } }).then(safeJson);
          const arr = tripsData && tripsData.items ? tripsData.items : [];
          setTrips(arr);
          const updatedTrip = arr.find(t => t.trip_no === activeTripNo);
          if (updatedTrip) {
            const cL = updatedTrip.closing_liters != null ? String(updatedTrip.closing_liters) : '';
            const cT = updatedTrip.closing_at ? (d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`)(new Date(updatedTrip.closing_at)) : '';
            setClosingLiters(cL); setClosingAt(cT);
            closingOrig.current = { liters: cL, at: cT };
          }
        } catch {/* non-critical */}
      } else {
        // Locked: do not allow day-level closing edits from At Depot
        setClosingMsg('Locked until a Trip is created');
        return;
      }
      // refresh ops context
      try {
        const auth = token ? { Authorization: 'Bearer ' + token } : {};
        if (activeTripNo != null) {
          const ops = await fetch(`/api/fuel-ops/ops/trip?truck_id=${truckId}&date=${theDate}&trip_no=${activeTripNo}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
        } else {
          const ops = await fetch(`/api/fuel-ops/ops/day?truck_id=${truckId}&date=${theDate}`, { headers: { ...auth, Accept:'application/json' } }).then(safeJson);
          setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
        }
      } catch {}

      try { if (typeof refreshStock==='function') await refreshStock(); } catch {}
    } catch (e) { setClosingMsg(String(e.message||e)); }
    finally { setSavingClosing(false); }
  }

  return (
    <div>
      {/* Info */}
      <div className="card" style={{ padding: 16, maxWidth: 980 }}>
        <button className="btn ghost" onClick={()=>setOpenInfo(v=>!v)} style={{ float:'right', padding:'4px 8px', fontSize:12 }}>{openInfo?'Hide':'Show'}</button>
        <div style={{ fontWeight:600, marginBottom: 8 }}>Info</div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', margin:'0 0 10px 0' }}>
          <div style={{ fontSize:12, color:'#6b7280', fontWeight:600 }}>Shortcuts</div>
          <button className="btn ghost" onClick={saveShortcutCurrent} disabled={!truckId || !theDate || !driverId} style={{ padding:'6px 10px', fontSize:12 }}>Save current</button>
          {(shortcutsForDate || []).length === 0 ? (
            <div style={{ fontSize:12, color:'#6b7280' }}>No shortcuts saved for this date.</div>
          ) : (
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              {(shortcutsForDate || []).map((s, idx) => (
                <div key={`${s.truckId}|${s.date}|${s.driverId}|${idx}`} style={{ display:'inline-flex', alignItems:'center', gap:6, border:'1px solid #e5e7eb', background:'#f9fafb', borderRadius:999, padding:'4px 10px' }}>
                  <button className="btn ghost" style={{ padding:0, border:'none', background:'transparent', fontSize:12, cursor:'pointer' }} onClick={()=>applyShortcut(s)} title="Load this selection">
                    {shortcutLabel(s)}
                  </button>
                  <button className="btn ghost" style={{ padding:0, border:'none', background:'transparent', fontSize:12, color:'#6b7280', cursor:'pointer' }} onClick={()=>removeShortcut(s)} title="Remove shortcut">Ã—</button>
                </div>
              ))}
            </div>
          )}
        </div>
        {openInfo && (
          <div className="fo-grid-3">
            <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
              Truck / Storage Unit
              <select value={truckId} onChange={e=>setTruckId(e.target.value)} style={{ padding:8 }}>
                {([...(units||[]), ...(datums||[])]).map(u => (
                  <option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}` : ''}{u.unit_type ? ` · ${u.unit_type}` : ''}</option>
                ))}
              </select>
            </label>
            <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
              Date
              <input type="date" value={theDate} onChange={e=>setTheDate(e.target.value)} style={{ padding:8 }} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
              Driver
              <select
                value={driverId}
                disabled={creatingTrip || driverLocked}
                ref={driverSelectRef}
                onChange={e=>{
                  const next = e.target.value;
                  const d = (Array.isArray(drivers)?drivers:[]).find(x => String(x.id)===String(next));
                  const label = d ? `${d.driver_id} · ${d.name}` : 'this driver';
                  if (pendingTripNo != null) {
                    const ok = window.confirm(`Select driver ${label} for Trip ${pendingTripNo} and create the trip?`);
                    if (!ok) return;
                    setDriverId(next);
                    setDriverConfirmed(true);
                    createTrip(next);
                    return;
                  }
                  const ok = window.confirm(`Confirm driver selection: ${label}`);
                  if (!ok) return;
                  setDriverId(next);
                  setDriverConfirmed(true);
                }}
                style={{ padding:8 }}
              >
                {(Array.isArray(drivers)?drivers:[]).map(d => (<option key={d.id} value={d.id}>{d.driver_id} · {d.name}</option>))}
              </select>
              {pendingTripNo != null && (
                <div style={{ marginTop:6, fontSize:12, color:'#b91c1c', fontWeight:600 }}>
                  Select the driver for Trip {pendingTripNo}
                </div>
              )}
            </label>
          </div>
        )}
        {/* Trips list and create */}
        <div style={{ marginTop:12 }}>
          <div style={{ fontSize:12, fontWeight:600, marginBottom:4 }}>Trips (today)</div>
          {tripLoading ? (<div style={{ fontSize:12, color:'#6b7280' }}>Loading trips…</div>) : (
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                {(trips||[]).map(t => (
                  <button key={t.id} className="nav-btn" style={{background: activeTripNo===t.trip_no?'#1f2937':'#e5e7eb',color: activeTripNo===t.trip_no?'#fff':'#111',border:'none',borderRadius:16,padding:'4px 10px',fontSize:11,cursor:'pointer'}} onClick={()=>{
                    setActiveTripNo(t.trip_no);
                    // Reset action form fields when switching context
                    setSaleVehicle(''); setTransferToUnit(''); setVolume(''); setActionTime('');
                  }}>Trip {t.trip_no}</button>
                ))}
                <button className="nav-btn" style={{background:'#10b981',color:'#fff',border:'none',borderRadius:16,padding:'4px 10px',fontSize:11,cursor:'pointer'}} disabled={creatingTrip || !canEditAtDepot} onClick={async()=>{
                  if (!canEditAtDepot) { alert('Not allowed'); return; }
                  const nextNo = (trips.length||0)+1;
                  // Enforce sequencing: previous trip must be ended.
                  if ((trips || []).length > 0) {
                    const last = trips[trips.length - 1];
                    if (!isTripClosed(last)) {
                      setActiveTripNo(last.trip_no);
                      alert(`End Trip ${last.trip_no} before creating Trip ${nextNo}.`);
                      return;
                    }
                  }
                  // If a driver is already selected (default or previously confirmed), allow creating immediately.
                  // This avoids forcing the user to re-pick the same driver just to trigger onChange.
                  const existingDriverLabel = driverId ? driverLabelById(driverId) : '';
                  if (driverId && existingDriverLabel) {
                    const ok = window.confirm(`Create Trip ${nextNo} with driver ${existingDriverLabel}?`);
                    if (ok) {
                      setDriverConfirmed(true);
                      setPendingTripNo(null);
                      await createTrip(driverId);
                      return;
                    }
                  }

                  // Otherwise, go to driver selection for this trip.
                  setPendingTripNo(nextNo);
                  setDriverConfirmed(false);
                  if (!openInfo) setOpenInfo(true);
                  setTimeout(() => {
                    try { driverSelectRef.current && driverSelectRef.current.focus && driverSelectRef.current.focus(); } catch {}
                    try { driverSelectRef.current && driverSelectRef.current.scrollIntoView && driverSelectRef.current.scrollIntoView({ behavior:'smooth', block:'center' }); } catch {}
                  }, 50);
                }}>{creatingTrip? 'Creating…' : `+ Trip ${(trips.length||0)+1}`}</button>
              </div>
              {activeTripNo!=null && trips.length>0 && canDeleteAtDepot && (
                <button className="nav-btn" style={{background:'#ef4444',color:'#fff',border:'none',borderRadius:16,padding:'4px 10px',fontSize:11,cursor:'pointer'}} onClick={async()=>{
                  try {
                    const trow = (trips||[]).find(t=>t.trip_no===activeTripNo);
                    if (!trow) return;
                    const ok = window.confirm(`Delete Trip ${trow.trip_no}? Only the last trip of the day can be deleted.`);
                    if (!ok) return;
                    const headers = { Accept:'application/json' };
                    const auth = token ? { Authorization:'Bearer '+token } : {};
                    const r = await fetch(`/api/fuel-ops/trips/${trow.id}`, { method:'DELETE', headers:{ ...headers, ...auth } });
                    const j = await safeJson(r);
                    if (!r.ok) { alert(j.error || 'Delete failed'); return; }
                    // Reload trips and reset selection to the new last trip (if any)
                    const auth2 = token ? { Authorization:'Bearer '+token } : {};
                    const tripsData = await fetch(`/api/fuel-ops/trips?truck_id=${truckId}&date=${theDate}`, { headers:{ ...auth2, Accept:'application/json' } }).then(safeJson);
                    const arr = tripsData && tripsData.items ? tripsData.items : [];
                    setTrips(arr);
                    if (arr.length) setActiveTripNo(arr[arr.length-1].trip_no); else setActiveTripNo(null);
                    // Clear forms and ops
                    setOpeningLiters(''); setOpeningAt(''); setClosingLiters(''); setClosingAt('');
                    setSaleVehicle(''); setTransferToUnit(''); setVolume(''); setActionTime('');
                    setDayOps({ loading:false, error:'', remaining_liters:null, totals:null, sales:[], transfers_out:[], transfers_in:[], loads:[], testing:[] });
                  } catch (e) { alert(String(e.message||e)); }
                }}>Delete Trip</button>
              )}

              {activeTripRow && isTripClosed(activeTripRow) && canEditAtDepot && (
                <></>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Opening */}
      <div className="card" style={{ padding: 16, marginTop: 12, maxWidth: 980 }}>
        <button className="btn ghost" onClick={()=>setOpenOpening(v=>!v)} style={{ float:'right', padding:'4px 8px', fontSize:12 }}>{openOpening?'Hide':'Show'}</button>
        <div style={{ fontWeight:600, marginBottom: 8 }}>Opening reading</div>
        {readingsLocked && (
          <div style={{ margin:'6px 0 8px 0', color:'#6b7280', fontSize:12 }}>Locked until a Trip is created for this truck and date. Use “+ Trip”.</div>
        )}
        {!readingsLocked && tripFrozen && (
          <div style={{ margin:'6px 0 8px 0', color:'#6b7280', fontSize:12 }}>Trip is frozen (locked). Unfreeze to edit past readings.</div>
        )}
        {openOpening && (
          <div className="fo-grid-4-action">
            <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
              Opening (L)
              <input type="number" min={0} step={0.001} value={openingLiters} readOnly style={{ padding:8 }} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
              Time
              <input type="time" value={openingAt} onChange={e=>setOpeningAt(e.target.value)} style={{ padding:8 }} disabled={readingsLocked || tripFrozen || (openingSaved && !openingEditMode)} />
            </label>
            <div style={{ display:'flex', alignItems:'flex-end' }}>
              {!openingSaved && !openingEditMode && (
                <button className="btn" onClick={()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } saveOpening(); }} disabled={readingsLocked || tripFrozen || savingOpening || !truckId || !theDate || !openingAt || !canEditAtDepot}>{(readingsLocked || tripFrozen)? 'Locked' : (savingOpening? 'Saving…':'Save Opening')}</button>
              )}
              {openingSaved && !openingEditMode && (
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn" disabled>Saved</button>
                  {canEditAtDepot && (<button className="btn ghost" onClick={()=>{ if (!readingsLocked && !tripFrozen) { setOpeningEditMode(true); setOpeningMsg(''); } }} disabled={readingsLocked || tripFrozen}>{'Edit'}</button>)}
                </div>
              )}
              {openingEditMode && (
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn" onClick={()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } saveOpening(); }} disabled={readingsLocked || tripFrozen || savingOpening || !truckId || !theDate || !openingAt || !canEditAtDepot}>{savingOpening? 'Saving…':'Submit Edit'}</button>
                  <button className="btn ghost" onClick={()=>{ setOpeningEditMode(false); setOpeningMsg(''); setOpeningLiters(openingOrig.current.liters); setOpeningAt(openingOrig.current.at); }}>{'Cancel'}</button>
                </div>
              )}
            </div>
            <div style={{ display:'flex', alignItems:'flex-end', color: openingMsg.startsWith('Saved')?'#065f46':'#b91c1c' }}>{openingMsg}</div>
          </div>
        )}
      </div>

      {/* Sales & Transfers */}
      <div className="card" style={{ padding: 16, marginTop: 12, maxWidth: 980 }}>
        <button className="btn ghost" onClick={()=>setOpenSales(v=>!v)} style={{ float:'right', padding:'4px 8px', fontSize:12 }}>{openSales?'Hide':'Show'}</button>
        <div style={{ fontWeight:600, marginBottom: 8 }}>Sales & Transfers</div>
        {readingsLocked && (
          <div style={{ margin:'6px 0 8px 0', color:'#6b7280', fontSize:12 }}>Locked until a Trip is created for this truck and date. Use “+ Trip”.</div>
        )}
        {!readingsLocked && tripFrozen && (
          <div style={{ margin:'6px 0 8px 0', color:'#6b7280', fontSize:12 }}>Trip is frozen (locked). Unfreeze to edit past operations.</div>
        )}
        {openSales && (
          <div>
            {/* Remaining */}
            <div style={{ margin:'6px 0 12px 0', fontSize: 12, color:'#374151' }}>
              In-stock: <b>{remainingForUi == null ? '—' : remainingForUi}</b> L
              {dayOps.totals && (
                <span style={{ marginLeft:8, color:'#6b7280' }}>
                  · Sold: {dayOps.totals.sales_liters} L · Xfer Out: {dayOps.totals.transfers_out_liters} L · Xfer In: {dayOps.totals.transfers_in_liters} L · Loaded: {dayOps.totals.loaded_liters} L · Testing: {dayOps.totals.testing_liters || 0} L
                </span>
              )}
            </div>
            {/* Loads list moved here (exclude from timeline) */}
            <div style={{ margin:'4px 0 12px 0' }}>
              <div style={{ fontSize:12, fontWeight:600, marginBottom:4 }}>Loads (today)</div>
              {(dayOps.loads||[]).length === 0 ? (
                <div style={{ fontSize:12, color:'#6b7280' }}>No loads</div>
              ) : (
                <div style={{ fontSize:12 }}>
                  {(dayOps.loads||[]).map(l => (
                    <div key={l.id} style={{ padding:'2px 0', borderBottom:'1px solid #eee' }}>
                      Lot {l.lot_code_initial} · {l.loaded_liters} L · Type {l.load_type||'-'} · {(() => {
                        const ts = l.load_time || l.created_at || l.load_date;
                        return ts ? formatWallClockTimeDisplay(ts) : '-';
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Day operations list (chronological) */}
            <div style={{ marginTop:16 }}>
              <div style={{ fontWeight:600, marginBottom:8 }}>Today’s operations</div>
              {dayOps.loading ? (
                <div style={{ color:'#6b7280', fontSize:12 }}>Loading…</div>
              ) : dayOps.error ? (
                <div style={{ color:'#b91c1c' }}>{dayOps.error}</div>
              ) : (
                <div style={{ height: 520, overflowY: 'scroll', scrollbarGutter: 'stable' }}>
                  <Timeline
                    token={token}
                    dayOps={dayOps}
                    units={units}
                    datums={datums}
                    locked={opsLocked}
                    allowXferOutActions={true}
                    onChanged={async()=>{
                      try {
                        const auth = token ? { Authorization:'Bearer '+token } : {};
                        let ops;
                        if (activeTripNo != null) {
                          ops = await fetch(`/api/fuel-ops/ops/trip?truck_id=${truckId}&date=${theDate}&trip_no=${activeTripNo}`, { headers:{ ...auth, Accept:'application/json' } }).then(safeJson);
                        } else {
                          ops = await fetch(`/api/fuel-ops/ops/day?truck_id=${truckId}&date=${theDate}`, { headers:{ ...auth, Accept:'application/json' } }).then(safeJson);
                        }
                        setDayOps({ loading:false, error:'', remaining_liters: ops.remaining_liters ?? null, totals: ops.totals || null, sales: ops.sales||[], transfers_out: ops.transfers_out||[], transfers_in: ops.transfers_in||[], loads: ops.loads||[], testing: ops.testing||[] });
                        try { await reloadDayAllOps(); } catch {}
                        try { if (typeof refreshStock==='function') await refreshStock(); } catch {}
                      } catch {}
                    }}
                  />
                </div>
              )}
            </div>

            {/* Action forms moved to bottom */}
            <div style={{ marginTop:20, paddingTop:12, borderTop:'1px solid #eee' }}>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12 }}>
                <button disabled={opsLocked} className={action==='SALE'?'nav-btn active':'nav-btn'} style={{background:action==='SALE'?'#1f2937':'#e5e7eb',color:action==='SALE'?'#fff':'#111',border:'none',borderRadius:18,padding:'6px 12px',cursor:'pointer', fontSize:12}} onClick={()=>setAction('SALE')}>+ Sale</button>
                <button disabled={opsLocked} className={action==='TO_TANKER'?'nav-btn active':'nav-btn'} style={{background:action==='TO_TANKER'?'#1f2937':'#e5e7eb',color:action==='TO_TANKER'?'#fff':'#111',border:'none',borderRadius:18,padding:'6px 12px',cursor:'pointer', fontSize:12}} onClick={()=>setAction('TO_TANKER')}>To tanker</button>
                <button disabled={opsLocked} className={action==='TO_DATUM'?'nav-btn active':'nav-btn'} style={{background:action==='TO_DATUM'?'#1f2937':'#e5e7eb',color:action==='TO_DATUM'?'#fff':'#111',border:'none',borderRadius:18,padding:'6px 12px',cursor:'pointer', fontSize:12}} onClick={()=>setAction('TO_DATUM')}>To datum</button>
                <button disabled={opsLocked} className={action==='TESTING'?'nav-btn active':'nav-btn'} style={{background:action==='TESTING'?'#1f2937':'#e5e7eb',color:action==='TESTING'?'#fff':'#111',border:'none',borderRadius:18,padding:'6px 12px',cursor:'pointer', fontSize:12}} onClick={()=>setAction('TESTING')}>Testing</button>
              </div>
              {/* Action forms */}
              {action==='SALE' && (
                <div className="fo-grid-4-action">
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    To Vehicle
                    <input value={saleVehicle} disabled={opsLocked} onChange={e=>setSaleVehicle(e.target.value)} placeholder="e.g., AP09 AB 1234" style={{ padding:8 }} />
                  </label>
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Volume (L)
                    <input type="number" min={0} step={0.001} value={volume} disabled={opsLocked} onChange={e=>setVolume(e.target.value)} style={{ padding:8 }} />
                  </label>
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Time
                    <input type="time" value={actionTime} disabled={opsLocked} onChange={e=>setActionTime(e.target.value)} style={{ padding:8 }} />
                  </label>
                  <div style={{ display:'flex', alignItems:'flex-end' }}>
                    <button className="btn" onClick={()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } saveSaleOrTransfer(); }} disabled={opsLocked || savingOps || !truckId || !theDate || !saleVehicle || !volume || (remainingForUi!=null && (parseLiters3(volume)||0) > Number(remainingForUi)) || !canEditAtDepot}>{opsLocked ? 'Locked' : (savingOps? 'Saving…':'Save Sale')}</button>
                  </div>
                </div>
              )}
              {action==='TO_TANKER' && (
                <div className="fo-grid-4-action">
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    To Tanker
                    <select value={transferToUnit} disabled={opsLocked} onChange={e=>setTransferToUnit(e.target.value)} style={{ padding:8 }}>
                      <option value="">Select</option>
                      {(units||[]).filter(u => String(u.id)!==String(truckId)).map(u => (<option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}</option>))}
                    </select>
                  </label>
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Volume (L)
                    <input type="number" min={0} step={0.001} value={volume} disabled={opsLocked} onChange={e=>setVolume(e.target.value)} style={{ padding:8 }} />
                  </label>
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Time
                    <input type="time" value={actionTime} disabled={opsLocked} onChange={e=>setActionTime(e.target.value)} style={{ padding:8 }} />
                  </label>
                  <div style={{ display:'flex', alignItems:'flex-end' }}>
                    <button className="btn" onClick={()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } saveSaleOrTransfer(); }} disabled={opsLocked || savingOps || !truckId || !theDate || !transferToUnit || !volume || (remainingForUi!=null && (parseLiters3(volume)||0) > Number(remainingForUi)) || !canEditAtDepot}>{opsLocked ? 'Locked' : (savingOps? 'Saving…':'Save Transfer')}</button>
                  </div>
                </div>
              )}
              {action==='TO_DATUM' && (
                <div className="fo-grid-4-action">
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    To Datum
                    <select value={transferToUnit} disabled={opsLocked} onChange={e=>setTransferToUnit(e.target.value)} style={{ padding:8 }}>
                      <option value="">Select</option>
                      {(datums||[]).map(d => (<option key={d.id} value={d.id}>{d.unit_code}{d.vehicle_number?` · ${d.vehicle_number}`:''}</option>))}
                    </select>
                  </label>
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Volume (L)
                    <input type="number" min={0} step={0.001} value={volume} disabled={opsLocked} onChange={e=>setVolume(e.target.value)} style={{ padding:8 }} />
                  </label>
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Time
                    <input type="time" value={actionTime} disabled={opsLocked} onChange={e=>setActionTime(e.target.value)} style={{ padding:8 }} />
                  </label>
                  <div style={{ display:'flex', alignItems:'flex-end' }}>
                    <button className="btn" onClick={()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } saveSaleOrTransfer(); }} disabled={opsLocked || savingOps || !truckId || !theDate || !transferToUnit || !volume || (remainingForUi!=null && (parseLiters3(volume)||0) > Number(remainingForUi)) || !canEditAtDepot}>{opsLocked ? 'Locked' : (savingOps? 'Saving…':'Save Transfer')}</button>
                  </div>
                </div>
              )}
              {/* LOADED action removed */}
              {action==='TESTING' && (
                <div className="fo-grid-4-action">
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Testing filled back to
                    <select value={testingToUnitId} disabled={opsLocked} onChange={e=>setTestingToUnitId(e.target.value)} style={{ padding:8 }}>
                      {/* Prefer same tanker first */}
                      {( (units||[]).filter(u => String(u.id)===String(truckId)) ).map(u => (
                        <option key={`self-${u.id}`} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''} (Same)</option>
                      ))}
                      {/* Other trucks */}
                      {(units||[]).filter(u => String(u.id)!==String(truckId)).map(u => (
                        <option key={`truck-${u.id}`} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}</option>
                      ))}
                      {/* Datums / storage units */}
                      {(datums||[]).map(d => (
                        <option key={`datum-${d.id}`} value={d.id}>{d.unit_code}{d.vehicle_number?` · ${d.vehicle_number}`:''} · DATUM</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Volume (L)
                    <input type="number" min={0} step={0.001} value={volume} disabled={opsLocked} onChange={e=>setVolume(e.target.value)} style={{ padding:8 }} />
                  </label>
                  <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
                    Time
                    <input type="time" value={actionTime} disabled={opsLocked} onChange={e=>setActionTime(e.target.value)} style={{ padding:8 }} />
                  </label>
                  <div style={{ display:'flex', alignItems:'flex-end' }}>
                    <button className="btn" onClick={()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } saveSaleOrTransfer(); }} disabled={opsLocked || savingOps || !truckId || !theDate || !volume || (remainingForUi!=null && (parseLiters3(volume)||0) > Number(remainingForUi)) || !canEditAtDepot}>{opsLocked ? 'Locked' : (savingOps? 'Saving…':'Log Test')}</button>
                  </div>
                </div>
              )}
              {opsMsg && (<div style={{ marginTop:8, color: opsMsg.startsWith('Saved')?'#065f46':'#b91c1c' }}>{opsMsg}</div>)}
            </div>
          </div>
        )}
      </div>

      {/* Closing */}
      <div className="card" style={{ padding: 16, marginTop: 12, maxWidth: 980 }}>
        <button className="btn ghost" onClick={()=>setOpenClosing(v=>!v)} style={{ float:'right', padding:'4px 8px', fontSize:12 }}>{openClosing?'Hide':'Show'}</button>
        <div style={{ fontWeight:600, marginBottom: 8 }}>Closing reading</div>
        {readingsLocked && (
          <div style={{ margin:'6px 0 8px 0', color:'#6b7280', fontSize:12 }}>Locked until a Trip is created for this truck and date. Use “+ Trip”.</div>
        )}
        {!readingsLocked && tripFrozen && (
          <div style={{ margin:'6px 0 8px 0', color:'#6b7280', fontSize:12 }}>Trip is frozen (locked). Unfreeze to edit past readings.</div>
        )}
        {openClosing && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto', gap: 12 }}>
            <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
              Closing (L)
              <input type="number" min={0} step={0.001} value={closingLiters} readOnly style={{ padding:8 }} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
              Time
              <input type="time" value={closingAt} onChange={e=>setClosingAt(e.target.value)} style={{ padding:8 }} disabled={readingsLocked || tripFrozen || (closingSaved && !closingEditMode)} />
            </label>
            <div style={{ display:'flex', alignItems:'flex-end' }}>
              {!closingSaved && !closingEditMode && (
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn ghost" onClick={async()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } await endActiveTrip(); }} disabled={readingsLocked || tripFrozen || savingClosing || !truckId || !theDate || !canEditAtDepot}>{savingClosing? 'Capturing…':'End trip'}</button>
                  <button className="btn" onClick={async()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } await saveClosing(); }} disabled={readingsLocked || tripFrozen || savingClosing || !truckId || !theDate || !closingLiters || !closingAt || !canEditAtDepot}>{savingClosing? 'Saving…':'Save Closing'}</button>
                </div>
              )}
              {closingSaved && !closingEditMode && (
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn" disabled>Saved</button>
                  {canEditAtDepot && (<button className="btn ghost" onClick={()=>{ if (!readingsLocked && !tripFrozen) { setClosingEditMode(true); setClosingMsg(''); } }} disabled={readingsLocked || tripFrozen}>{'Edit'}</button>)}
                </div>
              )}
              {closingEditMode && (
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn" onClick={async()=>{ if (!canEditAtDepot) { alert('Not allowed'); return; } await saveClosing(); }} disabled={readingsLocked || tripFrozen || savingClosing || !truckId || !theDate || !closingAt || !canEditAtDepot}>{savingClosing? 'Saving…':'Submit Edit'}</button>
                  <button className="btn ghost" onClick={()=>{ setClosingEditMode(false); setClosingMsg(''); setClosingLiters(closingOrig.current.liters); setClosingAt(closingOrig.current.at); }}>{'Cancel'}</button>
                </div>
              )}
            </div>
            <div style={{ display:'flex', alignItems:'flex-end', color: closingMsg.startsWith('Saved')?'#065f46':'#b91c1c' }}>{closingMsg}</div>
          </div>
        )}
      </div>

      {/* Total sales for selected date across all trips */}
      <div className="card" style={{ padding: 16, marginTop: 12, maxWidth: 980 }}>
        <div style={{ fontWeight:600, marginBottom: 8 }}>Total sales (all trips)</div>
        <div style={{ fontSize:12, color:'#6b7280', marginBottom: 10 }}>
          {(() => {
            const u = unitById.get(String(truckId));
            const unitLabel = u ? `${u.unit_code || u.id}${u.unit_type ? ` · ${u.unit_type}` : ''}` : (truckId || '-');
            return `${unitLabel} · ${theDate || '-'}`;
          })()}
        </div>
        {dayAllOps.loading ? (
          <div style={{ color:'#6b7280', fontSize:12 }}>Loading…</div>
        ) : dayAllOps.error ? (
          <div style={{ color:'#b91c1c' }}>{dayAllOps.error}</div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, maxWidth: 520 }}>
            <div>
              <div style={{ fontSize:12, color:'#374151' }}>Sales records</div>
              <div style={{ fontWeight:700, fontSize:16 }}>{salesCountAllTrips}</div>
            </div>
            <div>
              <div style={{ fontSize:12, color:'#374151' }}>Total sales (L)</div>
              <div style={{ fontWeight:700, fontSize:16 }}>{totalSalesAllTrips}</div>
            </div>
          </div>
        )}

        {activeTripRow && isTripClosed(activeTripRow) && (
          <div style={{ marginTop: 12, display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
            <div style={{ fontSize:12, color:'#6b7280' }}>Trip {activeTripRow.trip_no} status: {tripFrozen ? 'Frozen' : 'Unfrozen'}</div>
            {isOwnerOrAdmin && tripFrozen && (
              <button className="btn" onClick={unfreezeActiveTrip} disabled={freezeBusy}>{freezeBusy ? 'Working…' : 'Unfreeze'}</button>
            )}
            {isOwnerOrAdmin && !tripFrozen && (
              <button className="btn" onClick={updateEndTripActiveTrip} disabled={freezeBusy}>{freezeBusy ? 'Working…' : 'Update End Trip'}</button>
            )}
            {!isOwnerOrAdmin && tripFrozen && (
              <div style={{ fontSize:12, color:'#6b7280' }}>Only Owner/Admin can unfreeze.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}