import React, { useEffect, useState } from 'react';
import { fmtDateInput, parseWallClockDate, formatTimeForInput, fmtDateInputValue, formatWallClockDateDisplay, formatWallClockTimeDisplay, safeJson } from './utils';

export default function ReadingsSection({ token, units, unitId, setUnitId, drivers, driverRowId, setDriverRowId, dailyDate, setDailyDate, openKm, setOpenKm, closeKm, setCloseKm, odoNote, setOdoNote, postingOdo, setPostingOdo }) {
  // Only odometer reading remains; dispenser form removed.
  const [hasOdoRecord, setHasOdoRecord] = useState(false);
  const [openingTime, setOpeningTime] = useState('');
  const [closingTime, setClosingTime] = useState('');
  const [list, setList] = useState([]);
  const [listLoading, setListLoading] = useState(false);

  // Check existing odometer record for selected truck/date to enable Edit
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        setHasOdoRecord(false);
        if (!unitId || !dailyDate) return;
        const auth = token ? { Authorization: 'Bearer ' + token } : {};
        const r = await fetch(`/api/fuel-ops/day/odometer?truck_id=${unitId}&date=${dailyDate}`, { headers: { Accept:'application/json', ...auth } });
        const data = await safeJson(r);
        if (!aborted && data && data.truck_id) {
          setHasOdoRecord(true);
          try {
            const ot = data.opening_at ? (parseWallClockDate(data.opening_at) || new Date(data.opening_at)) : null;
            const ct = data.closing_at ? (parseWallClockDate(data.closing_at) || new Date(data.closing_at)) : null;
            setOpeningTime(ot ? String(ot.getHours()).padStart(2,'0')+':'+String(ot.getMinutes()).padStart(2,'0') : '');
            setClosingTime(ct ? String(ct.getHours()).padStart(2,'0')+':'+String(ct.getMinutes()).padStart(2,'0') : '');
          } catch {}
        } else if (!aborted) {
          setOpeningTime(''); setClosingTime('');
        }
        // load recent list
        setListLoading(true);
        try {
          const lr = await fetch(`/api/fuel-ops/day/odometer/list?truck_id=${unitId}&limit=90`, { headers: { Accept:'application/json', ...auth } });
          const lj = await safeJson(lr);
          if (!aborted) setList((lj && lj.items) ? lj.items : []);
        } catch { if (!aborted) setList([]); } finally { if (!aborted) setListLoading(false); }
      } catch {}
    })();
    return () => { aborted = true; };
  }, [unitId, dailyDate, token]);
  return (
    <div className="card" style={{ padding: 16, maxWidth: 980 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Select Truck
          <select value={unitId} onChange={e=>setUnitId(e.target.value)} style={{ padding: 8 }}>
            {units.map(u => (<option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}</option>))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
          Date
          <input type="date" value={dailyDate} onChange={e=>setDailyDate(e.target.value)} style={{ padding: 8 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151', gridColumn: '1 / 2' }}>
          Driver
          <select value={driverRowId} onChange={e=>setDriverRowId(e.target.value)} style={{ padding: 8 }}>
            {(Array.isArray(drivers) ? drivers : []).map(d => (<option key={d.id} value={d.id}>{d.driver_id} · {d.name}</option>))}
          </select>
        </label>
      </div>

      <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid #eee' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Odometer reading</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
            Opening Reading (km)
            <input type="number" step="0.1" min={0} value={openKm} onChange={e=>setOpenKm(e.target.value)} placeholder="auto from yesterday or enter first time" style={{ padding: 8 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
            Opening Time (optional)
            <input type="time" value={openingTime} onChange={e=>setOpeningTime(e.target.value)} style={{ padding: 8 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
            Closing Reading (km)
            <input type="number" step="0.1" min={0} value={closeKm} onChange={e=>setCloseKm(e.target.value)} placeholder="required" style={{ padding: 8 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
            Closing Time (optional)
            <input type="time" value={closingTime} onChange={e=>setClosingTime(e.target.value)} style={{ padding: 8 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: '#374151' }}>
            Note
            <input value={odoNote} onChange={e=>setOdoNote(e.target.value)} placeholder="optional" style={{ padding: 8 }} />
          </label>
          <div style={{ display:'flex', gap:12 }}>
            <button className="btn" disabled={postingOdo || !unitId || !dailyDate || openKm==='' || closeKm===''} onClick={async()=>{
              setPostingOdo(true);
              try {
                const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
                const drow = drivers.find(d => String(d.id) === String(driverRowId));
                const odoBody = { truck_id: parseInt(unitId,10), date: dailyDate, opening_km: Number(openKm), closing_km: Number(closeKm), note: odoNote || undefined, driver_name: drow ? drow.name : undefined, driver_code: drow ? drow.driver_id : undefined };
                if (openingTime) odoBody.opening_time = openingTime;
                if (closingTime) odoBody.closing_time = closingTime;
                const r2 = await fetch('/api/fuel-ops/day/odometer', { method: 'POST', headers, body: JSON.stringify(odoBody) });
                const j2 = await safeJson(r2);
                if (!r2.ok) throw new Error(j2.error || 'Failed to save odometer reading');
                alert('Truck odometer reading saved');
              } catch (e) { alert(e.message); }
              finally { setPostingOdo(false); }
            }}>Save Odometer Reading</button>
            <button className="btn ghost" disabled={!hasOdoRecord || postingOdo || !unitId || !dailyDate || openKm==='' || closeKm===''} onClick={async()=>{
              setPostingOdo(true);
              try {
                const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
                const drow = drivers.find(d => String(d.id) === String(driverRowId));
                const odoBody = { truck_id: parseInt(unitId,10), date: dailyDate, opening_km: Number(openKm), closing_km: Number(closeKm), note: odoNote || undefined, driver_name: drow ? drow.name : undefined, driver_code: drow ? drow.driver_id : undefined };
                if (openingTime) odoBody.opening_time = openingTime;
                if (closingTime) odoBody.closing_time = closingTime;
                const r2 = await fetch('/api/fuel-ops/day/odometer', { method: 'PATCH', headers, body: JSON.stringify(odoBody) });
                const j2 = await safeJson(r2);
                if (!r2.ok) throw new Error(j2.error || 'Failed to update odometer reading');
                alert('Truck odometer reading updated');
              } catch (e) { alert(e.message); }
              finally { setPostingOdo(false); }
            }}>Edit</button>
          </div>
        </div>
      </div>

      {/* Dispenser day records removed */}

      {/* List of odometer day readings */}
      <div style={{ marginTop:18, paddingTop:12, borderTop:'1px solid #eee' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
          <div style={{ fontWeight:600 }}>Recent odometer day readings</div>
          <button className="btn ghost" disabled={listLoading} onClick={async()=>{
            setListLoading(true);
            try {
              const auth = token ? { Authorization: 'Bearer ' + token } : {};
              const lr = await fetch(`/api/fuel-ops/day/odometer/list?truck_id=${unitId}&limit=90`, { headers: { Accept:'application/json', ...auth } });
              const lj = await safeJson(lr);
              setList((lj && lj.items) ? lj.items : []);
            } catch { setList([]); } finally { setListLoading(false); }
          }} style={{ padding:'4px 10px', fontSize:12 }}>{listLoading? 'Loading…' : 'Refresh'}</button>
        </div>
        <div className="table-wrap fo-table-responsive">
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ textAlign:'left' }}>
                <th>Date</th>
                <th>Opening (km)</th>
                <th>Closing (km)</th>
                <th>Opening Time</th>
                <th>Closing Time</th>
                <th>Driver</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(list||[]).length===0 ? (
                <tr><td colSpan={7} style={{ padding:8, color:'#6b7280' }}>{listLoading? 'Loading…' : 'No records'}</td></tr>
              ) : (
                list.map(row => (
                  <tr key={row.id}>
                    <td data-label="Date">{formatWallClockDateDisplay(row.reading_date)}</td>
                    <td data-label="Opening (km)">{row.opening_km}</td>
                    <td data-label="Closing (km)">{row.closing_km}</td>
                    <td data-label="Opening Time">{row.opening_at ? formatWallClockTimeDisplay(row.opening_at) : '-'}</td>
                    <td data-label="Closing Time">{row.closing_at ? formatWallClockTimeDisplay(row.closing_at) : '-'}</td>
                    <td data-label="Driver">{row.driver_name || '-'}</td>
                    <td data-label="Actions"><div className="fo-actions">
                      <button className="btn ghost" style={{ padding:'4px 8px', fontSize:12 }} onClick={()=>{
                        setDailyDate(fmtDateInputValue(row.reading_date));
                        setOpenKm(String(row.opening_km));
                        setCloseKm(String(row.closing_km));
                        try {
                          setOpeningTime(row.opening_at ? formatTimeForInput(row.opening_at) : '');
                          setClosingTime(row.closing_at ? formatTimeForInput(row.closing_at) : '');
                        } catch {}
                      }}>Edit</button>
                      <button className="btn ghost" style={{ padding:'4px 8px', fontSize:12 }} onClick={async()=>{
                        if (!window.confirm('Delete this record?')) return;
                        const auth = token ? { Authorization: 'Bearer ' + token } : {};
                        const r = await fetch(`/api/fuel-ops/day/odometer?id=${row.id}`, { method:'DELETE', headers: { Accept:'application/json', ...auth } });
                        const j = await safeJson(r);
                        if (!r.ok) { alert(j && j.error ? j.error : 'Delete failed'); return; }
                        setList(xs => xs.filter(x => x.id !== row.id));
                      }}>Delete</button>
                    </div></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Meter checks moved to dedicated Fuel Meter Checks tab */}
    </div>
  );
}