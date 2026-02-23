import React, { useEffect, useMemo, useState } from 'react';
import SortIcon from '../SortIcon';
import { fmtDateInput, parseWallClockDate, formatWallClockDateDisplay, parseLiters3, safeJson } from './utils';

export default function InternalTransferSection({ token, units, datums, drivers, refreshStock }) {
  const [activity, setActivity] = useState('TANKER_TO_TANKER');
  const [transferDate, setTransferDate] = useState(() => fmtDateInput(new Date()));
  const [transferTime, setTransferTime] = useState(''); // HH:mm
  const [fromUnit, setFromUnit] = useState('');
  const [toUnit, setToUnit] = useState('');
  const [vol, setVol] = useState('');
  const [saving, setSaving] = useState(false);
  const [transferMsg, setTransferMsg] = useState(null);

  // Testing (same logic as At Depot)
  const [testingDate, setTestingDate] = useState(() => fmtDateInput(new Date()));
  const [testingTime, setTestingTime] = useState('');
  const [testingFromUnit, setTestingFromUnit] = useState('');
  const [testingToUnitId, setTestingToUnitId] = useState('');
  const [testingVol, setTestingVol] = useState('');
  const [testingSaving, setTestingSaving] = useState(false);
  const [testingWindowInfo, setTestingWindowInfo] = useState({ status: 'unknown', opening_at: null, closing_at: null });
  const [testingMsg, setTestingMsg] = useState(null);
  useEffect(() => { if (testingFromUnit && !testingToUnitId) setTestingToUnitId(String(testingFromUnit)); }, [testingFromUnit]);
  // Simple display list state
  const [listLoading, setListLoading] = useState(false);
  const [listRows, setListRows] = useState([]);
  // Filters & sorting
  const [fromFilter, setFromFilter] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 6); return fmtDateInput(d); });
  const [toFilter, setToFilter] = useState(() => fmtDateInput(new Date()));
  const [activityFilter, setActivityFilter] = useState('ALL'); // ALL | TANKER_TO_TANKER | TANKER_TO_DATUM
  const [tableSort, setTableSort] = useState({ key: 'time', dir: 'desc' }); // key: 'date'|'time'
  // Full-form edit mode state (disabled by requirement; kept for compatibility)
  const [editMode, setEditMode] = useState(false);
  const [editRowId, setEditRowId] = useState(null);
  // Double-confirmation modal for creation
  const [showConfirm, setShowConfirm] = useState(false);
  // Driver selection
  const [driverId, setDriverId] = useState(() => (drivers && drivers[0] ? String(drivers[0].id) : ''));
  useEffect(() => { if (!driverId && drivers && drivers[0]) setDriverId(String(drivers[0].id)); }, [drivers]);
  // Sale window indicator for source tanker
  const [windowInfo, setWindowInfo] = useState({ status: 'unknown', opening_at: null, closing_at: null });
  useEffect(() => { setFromUnit(''); setToUnit(''); setTransferMsg(null); }, [activity]);

  // Fetch opening/closing info for testing source tanker and date
  useEffect(() => {
    let aborted = false;
    (async () => {
      if (!testingFromUnit || !testingDate) { setTestingWindowInfo({ status:'na', opening_at:null, closing_at:null }); return; }
      try {
        try {
          const rLogs = await fetch(`/api/fuel-ops/day/logs?truck_id=${testingFromUnit}&date=${testingDate}`, { headers: { Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
          const logData = await safeJson(rLogs);
          if (aborted) return;
          if (logData && logData.opening_liters != null) {
            setTestingWindowInfo({ status:'present', opening_at: logData.opening_at || null, closing_at: logData.closing_at || null });
            return;
          }
        } catch {}

        try {
          const r = await fetch(`/api/fuel-ops/day/dispenser?truck_id=${testingFromUnit}&date=${testingDate}`, { headers: { Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
          const data = await safeJson(r);
          if (aborted) return;
          if (data && data.opening_liters != null) {
            setTestingWindowInfo({ status:'present', opening_at: data.opening_at || null, closing_at: data.closing_at || null });
            return;
          }
        } catch {}

        try {
          const rt = await fetch(`/api/fuel-ops/trips?truck_id=${testingFromUnit}&date=${testingDate}`, { headers: { Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
          const trips = await safeJson(rt);
          if (aborted) return;
          const items = (trips && trips.items) ? trips.items : [];
          const hasTripOpening = items.some(t => t && (t.opening_at != null || t.opening_liters != null));
          if (hasTripOpening) setTestingWindowInfo({ status:'present', opening_at: (items.find(t=>t.opening_at)?.opening_at)||null, closing_at: null });
          else setTestingWindowInfo({ status:'missing', opening_at:null, closing_at:null });
        } catch {
          setTestingWindowInfo({ status:'missing', opening_at:null, closing_at:null });
        }
      } catch {
        if (!aborted) setTestingWindowInfo({ status:'error', opening_at:null, closing_at:null });
      }
    })();
    return () => { aborted = true; };
  }, [testingFromUnit, testingDate, token]);

  // Fetch opening/closing info for source tanker and date
  useEffect(() => {
    let aborted = false;
    (async () => {
      if (!fromUnit || !transferDate) { setWindowInfo({ status:'na', opening_at:null, closing_at:null }); return; }
      try {
        // Prefer the Day Logs table (dispenser_day_reading_logs) which is authoritative for opening readings
        try {
          const rLogs = await fetch(`/api/fuel-ops/day/logs?truck_id=${fromUnit}&date=${transferDate}`, { headers: { Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
          const logData = await safeJson(rLogs);
          if (aborted) return;
          if (logData && logData.opening_liters != null) {
            setWindowInfo({ status:'present', opening_at: logData.opening_at || null, closing_at: logData.closing_at || null });
            return;
          }
        } catch (e) {
          // non-fatal, continue to other checks
        }

        // Fallback: check legacy day dispenser readings
        try {
          const r = await fetch(`/api/fuel-ops/day/dispenser?truck_id=${fromUnit}&date=${transferDate}`, { headers: { Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
          const data = await safeJson(r);
          if (aborted) return;
          const hasOpening = !!(data && data.opening_liters != null);
          if (hasOpening) {
            setWindowInfo({ status:'present', opening_at: data.opening_at || null, closing_at: data.closing_at || null });
            return;
          }
        } catch (e) {
          // ignore and fallback to trip checks
        }

        // Final fallback: accept a trip opening (truck_dispenser_trips)
        try {
          const rt = await fetch(`/api/fuel-ops/trips?truck_id=${fromUnit}&date=${transferDate}`, { headers: { Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
          const trips = await safeJson(rt);
          if (aborted) return;
          const items = (trips && trips.items) ? trips.items : [];
          const hasTripOpening = items.some(t => t && (t.opening_at != null || t.opening_liters != null));
          if (hasTripOpening) setWindowInfo({ status:'present', opening_at: (items.find(t=>t.opening_at)?.opening_at)||null, closing_at: null });
          else setWindowInfo({ status:'missing', opening_at:null, closing_at:null });
        } catch {
          setWindowInfo({ status:'missing', opening_at:null, closing_at:null });
        }
      } catch {
        if (!aborted) setWindowInfo({ status:'error', opening_at:null, closing_at:null });
      }
    })();
    return () => { aborted = true; };
  }, [fromUnit, transferDate, token]);
  async function submitActivity() {
    setSaving(true); setTransferMsg(null);
    try {
      const volVal = parseLiters3(vol);
      if (volVal == null || volVal <= 0) throw new Error('Enter a valid volume');
      const body = {
        activity,
        from_unit_id: parseInt(fromUnit,10),
        to_unit_id: parseInt(toUnit,10),
        volume_liters: volVal,
        driver_id: driverId ? parseInt(driverId,10) : undefined,
        transfer_date: transferDate,
        performed_time: transferTime || undefined
      };
      const r = await fetch('/api/fuel-ops/lots/activity', { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) }, body: JSON.stringify(body) });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed');
      setTransferMsg(`Activity recorded. Lot ${data.lot.lot_code_initial} now used ${data.lot.used_liters}/${data.lot.loaded_liters}. ${data.lot.lot_code_by_transfer ? 'Code: '+data.lot.lot_code_by_transfer : ''}`);
      setFromUnit(''); setToUnit(''); setVol(''); setTransferTime(''); setDriverId(drivers && drivers[0] ? String(drivers[0].id) : '');
      try { if (typeof refreshStock==='function') refreshStock(); } catch {}
      // reload simple list to reflect new record
      try { await reloadSimpleTransfers(); } catch {}
    } catch(e){ setTransferMsg(String(e.message||e)); } finally { setSaving(false); }
  }

  async function submitTesting() {
    setTestingSaving(true); setTestingMsg(null);
    try {
      const drow = (Array.isArray(drivers)?drivers:[]).find(d => String(d.id)===String(driverId));
      const fromIdInt = parseInt(testingFromUnit,10);
      const toId = testingToUnitId ? parseInt(testingToUnitId,10) : null;
      const volVal = parseLiters3(testingVol);
      if (volVal == null || volVal <= 0) throw new Error('Enter a valid volume');

      let payload = null;
      if (toId && toId !== fromIdInt) {
        const all = [ ...(units||[]), ...(datums||[]) ];
        const dest = all.find(u => Number(u.id) === Number(toId));
        const actType = dest && dest.unit_type === 'DATUM' ? 'TANKER_TO_DATUM' : 'TANKER_TO_TANKER';
        payload = {
          activity: actType,
          from_unit_id: fromIdInt,
          to_unit_id: toId,
          volume_liters: volVal,
          transfer_date: testingDate,
          performed_time: testingTime || undefined,
          driver_id: drow ? parseInt(drow.id,10) : undefined,
          driver_name: drow ? drow.name : undefined
        };
      } else {
        const unitRow = (units||[]).find(u => String(u.id)===String(testingFromUnit));
        const toVehicleLabel = unitRow ? unitRow.unit_code : undefined;
        payload = {
          activity: 'TESTING',
          from_unit_id: fromIdInt,
          to_vehicle: toVehicleLabel,
          volume_liters: volVal,
          transfer_date: testingDate,
          performed_time: testingTime || undefined,
          driver_id: drow ? parseInt(drow.id,10) : undefined,
          driver_name: drow ? drow.name : undefined
        };
      }

      const r = await fetch('/api/fuel-ops/lots/activity', { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) }, body: JSON.stringify(payload) });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed');
      setTestingMsg('Activity recorded');
      setTestingFromUnit(''); setTestingToUnitId(''); setTestingVol(''); setTestingTime('');
      try { if (typeof refreshStock==='function') refreshStock(); } catch {}
      try { await reloadSimpleTransfers(); } catch {}
    } catch(e) {
      setTestingMsg(String(e.message||e));
    } finally {
      setTestingSaving(false);
    }
  }
  // Compose labels for confirmation modal
  const activityLabel = useMemo(() => (activity === 'TANKER_TO_TANKER' ? 'Tanker to Tanker' : 'Tanker to Datum'), [activity]);
  const fromUnitRow = useMemo(() => (units||[]).find(u => String(u.id) === String(fromUnit)), [units, fromUnit]);
  const toUnitRow = useMemo(() => (activity === 'TANKER_TO_TANKER' ? (units||[]) : (datums||[])).find(u => String(u.id) === String(toUnit)), [activity, units, datums, toUnit]);
  const fromLabel = useMemo(() => {
    if (!fromUnitRow) return '-';
    return `Tanker · ${fromUnitRow.unit_code}${fromUnitRow.vehicle_number ? ` · ${fromUnitRow.vehicle_number}` : ''}`;
  }, [fromUnitRow]);
  const toLabel = useMemo(() => {
    if (!toUnitRow) return '-';
    const prefix = activity === 'TANKER_TO_TANKER' ? 'Tanker' : 'Datum';
    return `${prefix} · ${toUnitRow.unit_code}${toUnitRow.vehicle_number ? ` · ${toUnitRow.vehicle_number}` : ''}`;
  }, [toUnitRow, activity]);
  const driverRow = useMemo(() => (Array.isArray(drivers)?drivers:[]).find(d => String(d.id) === String(driverId)), [drivers, driverId]);
  const driverLabel = useMemo(() => (driverRow ? (driverRow.name || (driverRow.driver_id || '-')) : '-'), [driverRow]);
  // eslint-disable-next-line no-unused-vars
  const allUnits = [...units, ...datums];
  // Load simple list on mount/token change
  useEffect(() => { reloadSimpleTransfers(); }, [token]);
  async function reloadSimpleTransfers() {
    setListLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('limit','200');
      if (fromFilter) qs.set('from', fromFilter);
      if (toFilter) qs.set('to', toFilter);
      if (activityFilter && activityFilter !== 'ALL') qs.set('activity', activityFilter);
      // No server-side sort; header sorting will be applied on the client table
      const r = await fetch(`/api/fuel-ops/transfers/internal/list?${qs.toString()}`, { headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data && data.error ? data.error : 'Failed to load transfers');
      setListRows((data && data.items) ? data.items : []);
    } catch { setListRows([]); } finally { setListLoading(false); }
  }
  // Submit full edit via comprehensive server endpoint
  // eslint-disable-next-line no-unused-vars
  async function submitFullEdit() {
    if (!editMode || !editRowId) return;
    setSaving(true); setTransferMsg(null);
    try {
      const headers = { 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) };
      const volVal = parseLiters3(vol);
      if (volVal == null || volVal <= 0) throw new Error('Enter a valid volume');
      const payload = {
        activity,
        from_unit_id: parseInt(fromUnit,10),
        to_unit_id: parseInt(toUnit,10),
        volume_liters: volVal,
        driver_id: driverId ? parseInt(driverId,10) : undefined,
        transfer_date: transferDate,
        performed_time: transferTime || undefined
      };
      const r = await fetch(`/api/fuel-ops/transfers/internal/${editRowId}/full`, { method:'PUT', headers, body: JSON.stringify(payload) });
      const j = await safeJson(r);
      if (!r.ok) throw new Error(j && j.error ? j.error : 'Failed to update transfer');
      setTransferMsg('Edit saved');
      setEditMode(false); setEditRowId(null);
      setFromUnit(''); setToUnit(''); setVol(''); setTransferTime(''); setDriverId(drivers && drivers[0] ? String(drivers[0].id) : '');
      await reloadSimpleTransfers();
      try { if (typeof refreshStock==='function') await refreshStock(); } catch {}
    } catch (e) { setTransferMsg(String(e.message||e)); }
    finally { setSaving(false); }
  }
  return (
    <>
      <div className="card" style={{ padding:16, maxWidth:1000 }}>
        <div style={{ fontWeight:600, marginBottom:8 }}>Testing</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
          <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
            Date
            <input type="date" value={testingDate} onChange={e=>setTestingDate(e.target.value)} style={{ padding:8 }} />
          </label>
          <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
            Time (optional)
            <input type="time" value={testingTime} onChange={e=>setTestingTime(e.target.value)} style={{ padding:8 }} />
          </label>
          <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
            From Tanker
            <select value={testingFromUnit} onChange={e=>setTestingFromUnit(e.target.value)} style={{ padding:8 }}>
              <option value="">Select</option>
              {(units||[]).map(u => (<option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}</option>))}
            </select>
            <span style={{ marginTop:6, fontSize:11, color: testingWindowInfo.status==='present' ? '#065f46' : (testingWindowInfo.status==='missing' ? '#b91c1c' : '#6b7280') }}>
              {testingWindowInfo.status==='present' && 'Opening recorded'}
              {testingWindowInfo.status==='missing' && (() => {
                const u = (units||[]).find(x => String(x.id) === String(testingFromUnit));
                const code = u ? u.unit_code : (testingFromUnit || '');
                const date = testingDate || '';
                return `No day log for the tanker "${code}" and date "${date}" is recorded.`;
              })()}
              {testingWindowInfo.status==='na' && '—'}
              {testingWindowInfo.status==='error' && 'Window check failed'}
            </span>
          </label>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginTop:12 }}>
          <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
            Testing filled back to
            <select value={testingToUnitId} onChange={e=>setTestingToUnitId(e.target.value)} style={{ padding:8 }}>
              <option value="">Select</option>
              {[...(units||[]), ...(datums||[])].map(u => (
                <option key={u.id} value={u.id}>
                  {u.unit_type==='DATUM' ? 'Datum' : 'Tanker'} · {u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
            Volume (L)
            <input type="number" min={1} step={0.001} value={testingVol} onChange={e=>setTestingVol(e.target.value)} style={{ padding:8 }} />
          </label>
          <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
            Driver
            <select value={driverId} onChange={e=>setDriverId(e.target.value)} style={{ padding:8 }}>
              {(Array.isArray(drivers)?drivers:[]).map(d => (<option key={d.id} value={d.id}>{d.driver_id} · {d.name}</option>))}
            </select>
          </label>
        </div>
        <div style={{ marginTop:12, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <button className="btn" disabled={testingSaving || !testingFromUnit || !testingToUnitId || !testingVol || testingWindowInfo.status!=='present'} onClick={submitTesting}>{testingSaving? 'Saving…':'Log Test'}</button>
          {testingMsg && (<div style={{ color: testingMsg.startsWith('Activity recorded') ? '#065f46' : '#b91c1c' }}>{testingMsg}</div>)}
        </div>
      </div>

      <div className="card" style={{ padding:16, maxWidth:1000, marginTop:12 }}>
        <div style={{ fontWeight:600, marginBottom:8 }}>Internal transfer</div>
        {/* Row 1: Date, Time, Activity */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Date
          <input type="date" value={transferDate} onChange={e=>setTransferDate(e.target.value)} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Time (optional)
          <input type="time" value={transferTime} onChange={e=>setTransferTime(e.target.value)} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Activity
          <select value={activity} onChange={e=>setActivity(e.target.value)} style={{ padding:8 }}>
            <option value="TANKER_TO_TANKER">Tanker to Tanker</option>
            <option value="TANKER_TO_DATUM">Tanker to Datum</option>
          </select>
        </label>
      </div>
      {/* Row 2: From Tanker, To Tanker/Datum */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12 }}>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          From Tanker
          <select value={fromUnit} onChange={e=>setFromUnit(e.target.value)} style={{ padding:8 }}>
            <option value="">Select</option>
            {units.filter(u => !toUnit || String(u.id)!==String(toUnit)).map(u => (<option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}</option>))}
          </select>
          <span style={{ marginTop:6, fontSize:11, color: windowInfo.status==='present' ? '#065f46' : (windowInfo.status==='missing' ? '#b91c1c' : '#6b7280') }}>
            {windowInfo.status==='present' && 'Opening recorded'}
            {windowInfo.status==='missing' && (() => {
              const u = (units||[]).find(x => String(x.id) === String(fromUnit));
              const code = u ? u.unit_code : (fromUnit || '');
              const date = transferDate || '';
              return `No day log for the tanker "${code}" and date "${date}" is recorded.`;
            })()}
            {windowInfo.status==='na' && '—'}
            {windowInfo.status==='error' && 'Window check failed'}
          </span>
        </label>
        {activity==='TANKER_TO_TANKER' && (
          <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
            To Tanker
            <select value={toUnit} onChange={e=>setToUnit(e.target.value)} style={{ padding:8 }}>
              <option value="">Select</option>
              {units.filter(u => !fromUnit || String(u.id)!==String(fromUnit)).map(u => (<option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}</option>))}
            </select>
          </label>
        )}
        {activity==='TANKER_TO_DATUM' && (
          <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
            To Datum
            <select value={toUnit} onChange={e=>setToUnit(e.target.value)} style={{ padding:8 }}>
              <option value="">Select</option>
              {datums.map(d => (<option key={d.id} value={d.id}>{d.unit_code}{d.vehicle_number?` · ${d.vehicle_number}`:''}</option>))}
            </select>
          </label>
        )}
      </div>
      {/* Row 3: Volume, Driver */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12 }}>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Volume (L)
          <input type="number" min={0} step={0.001} value={vol} onChange={e=>setVol(e.target.value)} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Driver
          <select value={driverId} onChange={e=>setDriverId(e.target.value)} style={{ padding:8 }}>
            {(Array.isArray(drivers)?drivers:[]).map(d => (<option key={d.id} value={d.id}>{d.driver_id} · {d.name}</option>))}
          </select>
        </label>
      </div>
      <div style={{ marginTop:12 }}>
        <button className="btn" disabled={saving || !activity || !vol || !fromUnit || !toUnit || windowInfo.status!=='present'} onClick={()=> setShowConfirm(true)}>{saving? 'Saving…':'Save Activity'}</button>
        {transferMsg && (<div style={{ marginTop:8, color: (transferMsg.startsWith('Activity recorded') || transferMsg.startsWith('Edit saved')) ? '#065f46' : '#b91c1c' }}>{transferMsg}</div>)}
        <div style={{ marginTop:8, color:'#6b7280', fontSize:12 }}>Code by transfer format: [InitialLotCode]-[CumulativeUsed]</div>
      </div>
      {showConfirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div className="card" style={{ padding:16, width:520, background:'#fff', boxShadow:'0 10px 30px rgba(0,0,0,0.2)' }}>
            <div style={{ fontWeight:700, fontSize:18, textAlign:'center', marginBottom:8 }}>Internal Transfer</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:14, color:'#111' }}>
              <div style={{ color:'#374151' }}>Activity:</div><div style={{ fontWeight:600 }}>{activityLabel}</div>
              <div style={{ color:'#374151' }}>From tanker:</div><div style={{ fontWeight:600 }}>{fromLabel}</div>
              <div style={{ color:'#374151' }}>{activity === 'TANKER_TO_TANKER' ? 'To tanker:' : 'To datum:'}</div><div style={{ fontWeight:600 }}>{toLabel}</div>
              <div style={{ color:'#374151' }}>Volume:</div><div style={{ fontWeight:600 }}>{vol ? Number(vol).toLocaleString() : '-'} L</div>
              <div style={{ color:'#374151' }}>Driver:</div><div style={{ fontWeight:600 }}>{driverLabel}</div>
              <div style={{ color:'#374151' }}>Date:</div><div style={{ fontWeight:600 }}>{transferDate || '-'}</div>
              <div style={{ color:'#374151' }}>Time:</div><div style={{ fontWeight:600 }}>{transferTime || '—'}</div>
            </div>
            <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:12 }}>
              <button className="btn ghost" onClick={()=> setShowConfirm(false)} disabled={saving}>Cancel</button>
              <button className="btn" onClick={async()=>{ await submitActivity(); setShowConfirm(false); }} disabled={saving || !activity || !vol || !fromUnit || !toUnit || windowInfo.status!=='present'}>{saving? 'Saving…' : 'Confirm & Save'}</button>
            </div>
          </div>
        </div>
      )}
      </div>

      <div className="card" style={{ padding:16, maxWidth:1000, marginTop:12 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, flexWrap:'wrap', gap:12 }}>
          <div style={{ fontWeight:600 }}>Internal transfer records</div>
          <div className="fo-filter-bar">
            <input id="internal-from-filter" type="date" value={fromFilter} onChange={e=>setFromFilter(e.target.value)} style={{ padding:6 }} placeholder="From" />
            <input id="internal-to-filter" type="date" value={toFilter} onChange={e=>setToFilter(e.target.value)} style={{ padding:6 }} placeholder="To" />
            <select id="internal-activity-filter" value={activityFilter} onChange={e=>setActivityFilter(e.target.value)} style={{ padding:6 }}>
              <option value="ALL">All Activities</option>
              <option value="TANKER_TO_TANKER">Tanker â†’ Tanker</option>
              <option value="TANKER_TO_DATUM">Tanker â†’ Datum</option>
            </select>
            <button className="btn" disabled={listLoading} onClick={reloadSimpleTransfers} style={{ padding:'4px 10px', fontSize:12 }}>Apply</button>
            <button className="btn ghost" disabled={listLoading} onClick={()=>{ const d=new Date(); const to=fmtDateInput(d); d.setDate(d.getDate()-6); const from=fmtDateInput(d); setFromFilter(from); setToFilter(to); setActivityFilter('ALL'); reloadSimpleTransfers(); }} style={{ padding:'4px 10px', fontSize:12 }}>Refresh</button>
            <button className="btn ghost" disabled={listLoading} onClick={exportInternalCsv} style={{ padding:'4px 10px', fontSize:12 }}>Export CSV</button>
            <button className="btn ghost" disabled={listLoading} onClick={printInternalTransfers} style={{ padding:'4px 10px', fontSize:12 }}>Print / PDF</button>
          </div>
        </div>
        <div className="table-wrap fo-table-responsive" style={{ height: 420, overflowY:'scroll', overflowX:'auto', scrollbarGutter: 'stable' }}>
          <table id="internal-transfers-table" style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ textAlign:'left' }}>
                <th
                  style={{ cursor:'pointer' }}
                  onClick={() => setTableSort(s => s.key==='date' ? { key:'date', dir: s.dir==='asc'?'desc':'asc' } : { key:'date', dir:'asc' })}
                >
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                    Date
                    <SortIcon dir={tableSort.key==='date'?tableSort.dir:undefined} active={tableSort.key==='date'} />
                  </span>
                </th>
                <th
                  style={{ cursor:'pointer' }}
                  onClick={() => setTableSort(s => s.key==='time' ? { key:'time', dir: s.dir==='asc'?'desc':'asc' } : { key:'time', dir:'asc' })}
                >
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                    Performed At
                    <SortIcon dir={tableSort.key==='time'?tableSort.dir:undefined} active={tableSort.key==='time'} />
                  </span>
                </th>
                <th>From Unit Code</th>
                <th>To Unit Code</th>
                <th>Transfer Volume (L)</th>
                <th>From Lot Code</th>
                <th>To Lot Code</th>
                <th>Transfer To Empty</th>
                <th>Driver Name</th>
                <th>Performed By</th>
                <th>Activity</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const sorted = [...(listRows||[])].sort((a,b) => {
                  const dir = tableSort.dir === 'asc' ? 1 : -1;
                  if (tableSort.key === 'date') {
                    const da0 = a.transfer_date ? parseWallClockDate(a.transfer_date) : (a.performed_at ? parseWallClockDate(a.performed_at) : null);
                    const db0 = b.transfer_date ? parseWallClockDate(b.transfer_date) : (b.performed_at ? parseWallClockDate(b.performed_at) : null);
                    const da = da0 ? da0.setHours(0,0,0,0) : 0;
                    const db = db0 ? db0.setHours(0,0,0,0) : 0;
                    return (da - db) * dir;
                  }
                  // time sort: minutes-of-day from transfer_time or performed_at
                  const toMinutes = (row) => {
                    if (typeof row.transfer_time === 'string' && row.transfer_time) {
                      const [hh, mm] = row.transfer_time.split(':');
                      const h = Number(hh)||0, m = Number(mm)||0; return h*60+m;
                    }
                    if (row.performed_at) {
                      const d = parseWallClockDate(row.performed_at); return d ? (d.getHours()*60 + d.getMinutes()) : 0;
                    }
                    return 0;
                  };
                  const va = toMinutes(a);
                  const vb = toMinutes(b);
                  return (va - vb) * dir;
                });
                if (sorted.length===0) return (
                <tr><td colSpan={11} style={{ padding:8, color:'#6b7280' }}>{listLoading ? 'Loading…' : 'No records'}</td></tr>
                );
                return sorted.map(r => {
                  const performedAtDisplay = (() => {
                    if (typeof r.transfer_time === 'string' && r.transfer_time) return r.transfer_time.slice(0,5);
                    if (r.performed_at) {
                      const d = parseWallClockDate(r.performed_at);
                      if (!d) return '-';
                      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                    }
                    return '-';
                  })();
                  return (
                    <tr key={r.id}>
                      <td data-label="Date">{formatWallClockDateDisplay(r.transfer_date || r.performed_at)}</td>
                      <td data-label="Performed At">{performedAtDisplay}</td>
                      <td data-label="From">{r.from_unit_code}</td>
                      <td data-label="To">{r.to_unit_code}</td>
                      <td data-label="Volume (L)">{r.transfer_volume != null ? r.transfer_volume : (r.transfer_volume_liters != null ? r.transfer_volume_liters : '')}</td>
                      <td data-label="From Lot">{r.from_lot_code_change || r.from_lot_code_after || '-'}</td>
                      <td data-label="To Lot">{r.to_lot_code_change || r.to_lot_code_after || '-'}</td>
                      <td data-label="To Empty">{r.transfer_to_empty ? 'Yes' : 'No'}</td>
                      <td data-label="Driver">{r.driver_name || '-'}</td>
                      <td data-label="Performed By">{r.performed_by || '-'}</td>
                      <td data-label="Activity">{r.activity || '-'}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function exportInternalCsv() {
  try {
    // eslint-disable-next-line no-unused-vars
    const auth = localStorage.getItem('authToken');
    // Build params from current filters in component state indirectly (fallback to DOM if necessary)
    // Safer to just grab the states through window since this function is in same bundle; but we keep simple by reading inputs
    const fromInput = document.getElementById('internal-from-filter');
    const toInput = document.getElementById('internal-to-filter');
    const params = new URLSearchParams();
    if (fromInput && fromInput.value) params.set('from', fromInput.value);
    if (toInput && toInput.value) params.set('to', toInput.value);
    const activitySelect = document.getElementById('internal-activity-filter');
    if (activitySelect && activitySelect.value && activitySelect.value !== 'ALL') params.set('activity', activitySelect.value);
    params.set('sort','time_desc');
    fetch(`/api/fuel-ops/transfers/internal/export?${params.toString()}`, { headers: { ...(auth?{ Authorization:'Bearer '+auth }: {}) } })
      .then(r => { if(!r.ok) throw new Error('Export failed'); return r.blob(); })
      .then(blob => { const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`internal_transfers_${Date.now()}.csv`; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },800); })
      .catch(e => alert(String(e.message||e)));
  } catch(e) { alert(String(e.message||e)); }
}
function printInternalTransfers() {
  try {
    const table = document.querySelector('#internal-transfers-table');
    if (!table) { alert('Table not found'); return; }
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Internal Transfers</title><style>body{font-family:Arial;padding:16px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left} th{background:#f9fafb}</style></head><body>${table.outerHTML}<script>window.print();</script></body></html>`);
    w.document.close();
  } catch(e) { alert(String(e.message||e)); }
}
