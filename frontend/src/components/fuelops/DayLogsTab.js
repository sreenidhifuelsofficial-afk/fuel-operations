import React, { useEffect, useMemo, useState } from 'react';
import SortIcon from '../SortIcon';
import { fmtDateInput, parseWallClockDate, formatTimeForInput, fmtDateInputValue, formatWallClockTimeDisplay, formatWallClockDateDisplay, parseLiters3, safeJson } from './utils';
import Timeline from './Timeline';

export default function DayLogsSection({ token, units, datums, refreshStock, drivers, perms }) {
  const permsProvided = !!perms;
  const canEditDayLogs = permsProvided ? !!perms?.actions?.['FuelOps.edit_day_logs'] : true;
  const canDeleteDayLogs = permsProvided ? !!perms?.actions?.['FuelOps.delete_day_logs'] : true;
  const allUnits = useMemo(() => ([...(units||[]), ...(datums||[])]), [units, datums]);
  const [truckId, setTruckId] = useState(() => (allUnits && allUnits[0] ? String(allUnits[0].id) : ''));
  useEffect(() => { if (!truckId && allUnits && allUnits[0]) setTruckId(String(allUnits[0].id)); }, [units, datums]);
  const [date, setDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  });
  const [openingLiters, setOpeningLiters] = useState('');
  const [openingTime, setOpeningTime] = useState('');
  const [closingLiters, setClosingLiters] = useState('');
  const [closingTime, setClosingTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [existing, setExisting] = useState(null);
  const [driverId, setDriverId] = useState(() => (drivers && drivers[0] ? String(drivers[0].id) : ''));
  const [listRows, setListRows] = useState([]);
  const [listMsg, setListMsg] = useState('');

  useEffect(() => {
    let aborted = false;
    (async () => {
      if (!truckId || !date) { setExisting(null); return; }
      setLoading(true); setMsg('');
      try {
        const auth = token ? { Authorization: 'Bearer ' + token } : {};
        const r = await fetch(`/api/fuel-ops/day/logs?truck_id=${truckId}&date=${date}`, { headers: { ...auth, Accept:'application/json' } });
        const data = await safeJson(r);
        if (!aborted) {
          if (data) {
            setExisting(data);
            setOpeningLiters(data.opening_liters != null ? String(data.opening_liters) : '');
            setOpeningTime(data.opening_at ? formatTimeForInput(data.opening_at) : '');
            setClosingLiters(data.closing_liters != null ? String(data.closing_liters) : '');
            setClosingTime(data.closing_at ? formatTimeForInput(data.closing_at) : '');
            setDriverId(data.driver_id ? String(data.driver_id) : (data.driver_code ? (drivers||[]).find(d=>d.driver_id===data.driver_code)?.id : (drivers&&drivers[0]?String(drivers[0].id):'')));
          } else {
            setExisting(null);
            setOpeningLiters(''); setOpeningTime(''); setClosingLiters(''); setClosingTime('');
          }
        }
      } catch (e) { if (!aborted) setMsg(String(e.message||e)); }
      finally { if (!aborted) setLoading(false); }
    })();
    return () => { aborted = true; };
  }, [truckId, date, token]);

  // Load list of recent day logs for the selected truck
  useEffect(() => {
    let aborted = false;
    (async () => {
      setListMsg('');
      try {
        if (!truckId) { setListRows([]); return; }
        const auth = token ? { Authorization: 'Bearer ' + token } : {};
        const url = `/api/fuel-ops/day/logs/list?truck_id=${truckId}&limit=100`;
        const r = await fetch(url, { headers: { ...auth, Accept:'application/json' } });
        const data = await safeJson(r).catch(() => null);
        if (aborted) return;
        if (!r.ok) {
          const err = data && data.error ? data.error : `status ${r.status}`;
          setListMsg(`Failed to load day logs: ${err}`);
          setListRows([]);
          return;
        }
        const items = Array.isArray(data && data.items ? data.items : data) ? (data.items || data) : [];
        // Attach unit_code for display (if units loaded)
        const enriched = (items || []).map(it => ({
          ...it,
          unit_code: (allUnits || []).find(u => String(u.id) === String(it.truck_id))?.unit_code || null,
        }));
        setListRows(enriched);
      } catch (e) {
        if (!aborted) {
          setListMsg(String(e.message || e));
          setListRows([]);
        }
      }
    })();
    return () => { aborted = true; };
  }, [token, truckId, units, datums]);

  async function submit() {
    if (!canEditDayLogs) { setMsg('Not allowed'); return; }
    if (!truckId || !date || openingLiters === '') return setMsg('Please fill required fields');
    setLoading(true); setMsg('');
    try {
      const headers = { 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) };
      const drv = (Array.isArray(drivers)?drivers:[]).find(d => String(d.id) === String(driverId));
      const openingVal = parseLiters3(openingLiters);
      if (openingVal == null) throw new Error('Invalid opening liters');
      const closingVal = (closingLiters !== '') ? parseLiters3(closingLiters) : undefined;
      if (closingLiters !== '' && closingVal == null) throw new Error('Invalid closing liters');
      // Send opening_at/closing_at as full local date+time strings (YYYY-MM-DD HH:mm:00)
      const openingAtPayload = openingTime ? `${date} ${openingTime}:00` : undefined;
      const closingAtPayload = closingTime ? `${date} ${closingTime}:00` : undefined;
      const body = {
        truck_id: parseInt(truckId,10),
        date,
        opening_liters: openingVal,
        opening_at: openingAtPayload,
        closing_liters: closingVal,
        closing_at: closingAtPayload,
        driver_name: drv ? drv.name : undefined,
        driver_code: drv ? drv.driver_id : undefined,
        driver_id: drv ? parseInt(drv.id,10) : undefined
      };
      let r;
      if (existing && existing.id) {
        r = await fetch(`/api/fuel-ops/day/logs/${existing.id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
      } else {
        r = await fetch('/api/fuel-ops/day/logs', { method: 'POST', headers, body: JSON.stringify(body) });
      }
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data && data.error ? data.error : 'Failed');
      setMsg('Saved');
      setExisting(data);
      // refresh list for the current truck
      try {
        const auth = token ? { Authorization: 'Bearer ' + token } : {};
        const rl = await fetch(`/api/fuel-ops/day/logs/list?truck_id=${truckId}&limit=100`, { headers: { ...auth, Accept:'application/json' } });
        const dl = await safeJson(rl);
        const items = (dl && dl.items) ? dl.items : [];
        const enriched = (items || []).map(it => ({
          ...it,
          unit_code: (allUnits || []).find(u => String(u.id) === String(it.truck_id))?.unit_code || null,
        }));
        setListRows(enriched);
      } catch {}
      try { if (typeof refreshStock === 'function') await refreshStock(); } catch {}
    } catch (e) { setMsg(String(e.message||e)); }
    finally { setLoading(false); }
  }

  const isActive = existing ? (existing.closing_liters == null) : true;

  function loadRowIntoForm(r) {
    try {
      setTruckId(String(r.truck_id));
      setDate(fmtDateInputValue(r.reading_date) || date);
      setExisting(r);
      setOpeningLiters(r.opening_liters != null ? String(r.opening_liters) : '');
      setOpeningTime(r.opening_at ? formatTimeForInput(r.opening_at) : '');
      setClosingLiters(r.closing_liters != null ? String(r.closing_liters) : '');
      setClosingTime(r.closing_at ? formatTimeForInput(r.closing_at) : '');
      setDriverId(r.driver_id ? String(r.driver_id) : (r.driver_code ? (drivers||[]).find(d=>d.driver_id===r.driver_code)?.id : (drivers&&drivers[0]?String(drivers[0].id):'')));
      setMsg('');
    } catch (e) { /* ignore */ }
  }

  function cancelEdit() {
    if (existing) {
      setOpeningLiters(existing.opening_liters != null ? String(existing.opening_liters) : '');
      setOpeningTime(existing.opening_at ? formatTimeForInput(existing.opening_at) : '');
      setClosingLiters(existing.closing_liters != null ? String(existing.closing_liters) : '');
      setClosingTime(existing.closing_at ? formatTimeForInput(existing.closing_at) : '');
      setDriverId(existing.driver_id ? String(existing.driver_id) : (existing.driver_code ? (drivers||[]).find(d=>d.driver_id===existing.driver_code)?.id : (drivers&&drivers[0]?String(drivers[0].id):'')));
      setMsg('');
    } else {
      setOpeningLiters(''); setOpeningTime(''); setClosingLiters(''); setClosingTime(''); setMsg('');
    }
  }

  return (
    <>
    <div className="card" style={{ padding: 16, maxWidth: 900 }}>
          <div className="fo-grid-4">
        <label style={{ display:'flex', flexDirection:'column' }}>
          <span style={{ fontSize:12, color:'#374151' }}>Date</span>
          <input type="date" value={date} onChange={e=>setDate(e.target.value)} />
        </label>
        <label style={{ display:'flex', flexDirection:'column' }}>
          <span style={{ fontSize:12, color:'#374151' }}>Truck / Datum</span>
          <select value={truckId} onChange={e=>setTruckId(e.target.value)}>
            {(allUnits||[]).map(u => (
              <option key={u.id} value={u.id}>
                {u.unit_code || u.vehicle_number || u.id}{u.unit_type ? ` · ${u.unit_type}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display:'flex', flexDirection:'column' }}>
          <span style={{ fontSize:12, color:'#374151' }}>Driver</span>
          <select value={driverId} onChange={e=>setDriverId(e.target.value)}>
            <option value="">Select</option>
            {(Array.isArray(drivers)?drivers:[]).map(d => (<option key={d.id} value={d.id}>{d.driver_id} · {d.name}</option>))}
          </select>
        </label>
        <label style={{ display:'flex', flexDirection:'column' }}>
          <span style={{ fontSize:12, color:'#374151' }}>Opening reading (L)</span>
          <input type="number" min={0} step={0.001} value={openingLiters} onChange={e=>setOpeningLiters(e.target.value)} />
        </label>
        <label style={{ display:'flex', flexDirection:'column' }}>
          <span style={{ fontSize:12, color:'#374151' }}>Opening time</span>
          <input type="time" value={openingTime} onChange={e=>setOpeningTime(e.target.value)} />
        </label>
        <label style={{ display:'flex', flexDirection:'column' }}>
          <span style={{ fontSize:12, color:'#374151' }}>Closing reading (L)</span>
          <input type="number" min={0} step={0.001} value={closingLiters} onChange={e=>setClosingLiters(e.target.value)} />
        </label>
        <label style={{ display:'flex', flexDirection:'column' }}>
          <span style={{ fontSize:12, color:'#374151' }}>Closing time</span>
          <input type="time" value={closingTime} onChange={e=>setClosingTime(e.target.value)} />
        </label>
      </div>
      <div style={{ marginTop:12, display:'flex', alignItems:'center', gap:12 }}>
        <button className="btn" disabled={loading || !canEditDayLogs} onClick={submit}>{loading? 'Saving…' : (existing? 'Update' : 'Create')}</button>
        {existing && (<button className="btn ghost" onClick={cancelEdit}>Cancel</button>)}
        <div style={{ color: isActive ? '#065f46' : '#6b7280', fontWeight:600 }}>{existing ? (isActive ? 'Active' : 'Closed') : 'No record'}</div>
        <div style={{ color:'#b91c1c' }}>{msg}</div>
      </div>
    </div>
    {/* Recent records listing */}
    <div className="card" style={{ marginTop: 16, maxWidth: 900, padding: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Recent Day Logs</div>
      {listMsg && (<div style={{ marginBottom:8, color:'#b91c1c' }}>{listMsg}</div>)}
      <div className="table-wrap fo-table-responsive" style={{ height: 420, overflowY:'scroll', overflowX:'auto', scrollbarGutter: 'stable' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ textAlign:'left' }}>
              <th>Date</th>
              <th>Truck</th>
              <th>Opening (L)</th>
              <th>Opening Time</th>
              <th>Closing (L)</th>
              <th>Closing Time</th>
              <th>Driver</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(listRows||[]).length === 0 ? (
              <tr><td colSpan={9} style={{ color:'#6b7280', padding:8 }}>No records</td></tr>
            ) : (
              (listRows||[]).map(r => (
                <tr key={r.id} style={{ cursor:'pointer' }} onClick={() => loadRowIntoForm(r)}>
                  <td data-label="Date">{formatWallClockDateDisplay(r.reading_date)}</td>
                  <td data-label="Truck">{(allUnits||[]).find(u=>String(u.id)===String(r.truck_id))?.unit_code || r.truck_id || '-'}</td>
                  <td data-label="Opening (L)">{r.opening_liters != null ? r.opening_liters : '-'}</td>
                  <td data-label="Opening Time">{r.opening_at ? formatWallClockTimeDisplay(r.opening_at) : '-'}</td>
                  <td data-label="Closing (L)">{r.closing_liters != null ? r.closing_liters : '-'}</td>
                  <td data-label="Closing Time">{r.closing_at ? formatWallClockTimeDisplay(r.closing_at) : '-'}</td>
                  <td data-label="Driver">{r.driver_name || r.driver_code || '-'}</td>
                  <td data-label="Status">
                    {r.closing_liters == null ? (
                      <span style={{ background:'#d1fae5', color:'#065f46', padding:'4px 8px', borderRadius:12, fontSize:12, fontWeight:600 }}>Still active</span>
                    ) : (
                      <span style={{ background:'#e5e7eb', color:'#374151', padding:'4px 8px', borderRadius:12, fontSize:12 }}>Closed</span>
                    )}
                  </td>
                  <td data-label="Actions"><div className="fo-actions">
                    {canEditDayLogs && (<button className="btn ghost" onClick={(ev) => { ev.stopPropagation(); loadRowIntoForm(r); }}>Edit</button>)}
                    {canDeleteDayLogs && (<button className="btn ghost" onClick={async (ev) => { ev.stopPropagation(); try {
                      // allow deleting a day log
                      if (!window.confirm('Delete this day log?')) return;
                      const auth = token ? { Authorization: 'Bearer ' + token } : {};
                      const res = await fetch(`/api/fuel-ops/day/logs/${r.id}`, { method: 'DELETE', headers: { ...auth, Accept:'application/json' } });
                      const jd = await safeJson(res);
                      if (!res.ok) { alert(jd.error || 'Delete failed'); return; }
                      // refresh list for current truck
                      const rl = await fetch(`/api/fuel-ops/day/logs/list?truck_id=${truckId}&limit=100`, { headers: { ...(token?{ Authorization: 'Bearer ' + token }:{}) , Accept:'application/json' } });
                      const dl = await safeJson(rl);
                      const items = (dl && dl.items) ? dl.items : [];
                      const enriched = (items || []).map(it => ({
                        ...it,
                        unit_code: (allUnits || []).find(u => String(u.id) === String(it.truck_id))?.unit_code || null,
                      }));
                      setListRows(enriched);
                      if (existing && existing.id === r.id) { setExisting(null); setOpeningLiters(''); setOpeningTime(''); setClosingLiters(''); setClosingTime(''); }
                    } catch (e) { alert(String(e.message||e)); } }}>Delete</button>)}
                  </div></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
    </>
  );
}
