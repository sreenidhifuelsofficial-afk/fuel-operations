import React, { useState } from 'react';
import { fmtDateInput, parseLiters3, safeJson } from './utils';

export default function FuelMeterChecksSection({ token, units }) {
  return (
    <div className="card" style={{ padding:16, maxWidth: 900 }}>
      {/* Quick meter snapshot */}
      <div style={{ marginTop: 4, paddingTop: 4 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Quick meter snapshot</div>
        <SnapshotCapture token={token} units={units} />
      </div>
      {/* Daily reconciliation */}
      <div style={{ marginTop: 24, paddingTop: 12, borderTop:'1px solid #eee' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Daily reconciliation</div>
        <DailyReconcile token={token} units={units} />
        <div style={{ marginTop: 24, paddingTop: 12, borderTop:'1px solid #eee' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Range reconciliation</div>
          <RangeReconcile token={token} units={units} />
        </div>
      </div>
    </div>
  );
}

function SnapshotCapture({ token, units }) {
  const [truckId, setTruckId] = useState('');
  const [reading, setReading] = useState('');
  const [when, setWhen] = useState('');
  const [posting, setPosting] = useState(false);
  return (
    <div className="card" style={{ padding: 12, maxWidth: 720 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto', gap: 8 }}>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Truck / Datum
          <select value={truckId} onChange={e=>setTruckId(e.target.value)} style={{ padding: 8 }}>
            <option value="">Select</option>
            {(units||[]).filter(u=>u.unit_type==='TRUCK' || u.unit_type==='DATUM').map(u => (
              <option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}{u.unit_type==='DATUM'? ' (DATUM)':''}</option>
            ))}
          </select>
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Meter Reading (L)
          <input type="number" min={0} step={0.001} value={reading} onChange={e=>setReading(e.target.value)} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Time
          <input type="datetime-local" value={when} onChange={e=>setWhen(e.target.value)} style={{ padding:8 }} />
        </label>
        <div style={{ display:'flex', alignItems:'flex-end' }}>
          <button className="btn" disabled={posting || !truckId || !reading} onClick={async()=>{
            setPosting(true);
            try {
              const readingVal = parseLiters3(reading);
              if (readingVal == null || readingVal < 0) throw new Error('Enter a valid meter reading');
              const body = { truck_id: parseInt(truckId,10), reading_liters: readingVal };
              if (when) body.reading_at = when.replace('T',' ') + ':00';
              const r = await fetch('/api/fuel-ops/meter-snapshots', { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) }, body: JSON.stringify(body) });
              const data = await safeJson(r);
              if (!r.ok) throw new Error(data.error || 'Failed to save snapshot');
              alert('Snapshot saved');
              setTruckId(''); setReading(''); setWhen('');
            } catch (e) { alert(String(e.message||e)); } finally { setPosting(false); }
          }}>{posting? 'Saving…':'Save Snapshot'}</button>
        </div>
      </div>
    </div>
  );
}


function DailyReconcile({ token, units }) {
  const [truckId, setTruckId] = useState('');
  const [date, setDate] = useState(() => fmtDateInput(new Date()));
  const [loading, setLoading] = useState(false);
  const [row, setRow] = useState(null);
  const [tolerance, setTolerance] = useState('2');
  return (
    <div className="card" style={{ padding:12, maxWidth: 720 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 120px 1fr auto', gap: 8 }}>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Truck / Datum
          <select value={truckId} onChange={e=>setTruckId(e.target.value)} style={{ padding:8 }}>
            <option value="">Select</option>
            {(units||[]).filter(u=>u.unit_type==='TRUCK' || u.unit_type==='DATUM').map(u => (
              <option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}{u.unit_type==='DATUM'? ' (DATUM)':''}</option>
            ))}
          </select>
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Date
          <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Tolerance (L)
          <input type="number" min={0} step={0.1} value={tolerance} onChange={e=>setTolerance(e.target.value)} style={{ padding:8 }} />
        </label>
        <div style={{ display:'flex', alignItems:'flex-end' }}>
          <button className="btn" disabled={loading || !truckId || !date} onClick={async()=>{
            setLoading(true);
            try {
              const r = await fetch(`/api/fuel-ops/reconcile/daily?truck_id=${truckId}&date=${date}`, { headers:{ Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
              const data = await safeJson(r);
              if (!r.ok) throw new Error(data.error || 'Failed to reconcile');
              setRow(data);
            } catch (e) { alert(String(e.message||e)); } finally { setLoading(false); }
          }}>{loading? 'Checking…':'Reconcile'}</button>
        </div>
      </div>
      {row && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <div>Opening: <b>{row.opening}</b> at {row.opening_at}</div>
          <div>Closing: <b>{row.closing}</b> at {row.closing_at}</div>
          <div>Sales: <b>{row.sales}</b> · Transfers Out: <b>{row.transfers_out}</b> · Transfers In: <b>{row.transfers_in}</b> · Testing: <b>{row.testing_used_liters}</b></div>
          <div>Meter ΔM: <b>{row.delta_meter}</b> · Expected ΔE: <b>{row.delta_expected}</b> · Difference: <b style={{ color: Math.abs(row.delta_difference) > Number(tolerance||0) ? '#b91c1c' : '#065f46' }}>{row.delta_difference}</b></div>
        </div>
      )}
    </div>
  );
}

function RangeReconcile({ token, units }) {
  const [truckId, setTruckId] = useState('');
  const [from, setFrom] = useState(() => fmtDateInput(new Date()));
  const [to, setTo] = useState(() => fmtDateInput(new Date()));
  const [tolerance, setTolerance] = useState('2');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  async function run() {
    if (!truckId || !from || !to) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/fuel-ops/reconcile/range?truck_id=${truckId}&from=${from}&to=${to}`, { headers:{ Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data.error || 'Failed');
      setRows(data.items || []);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  return (
    <div className="card" style={{ padding:12, maxWidth: 1000 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 140px 1fr auto', gap:8 }}>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Truck / Datum
          <select value={truckId} onChange={e=>setTruckId(e.target.value)} style={{ padding:8 }}>
            <option value="">Select</option>
            {(units||[]).filter(u=>u.unit_type==='TRUCK' || u.unit_type==='DATUM').map(u => (
              <option key={u.id} value={u.id}>{u.unit_code}{u.vehicle_number?` · ${u.vehicle_number}`:''}{u.unit_type==='DATUM'? ' (DATUM)':''}</option>
            ))}
          </select>
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          From
          <input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          To
          <input type="date" value={to} onChange={e=>setTo(e.target.value)} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Tolerance (L)
          <input type="number" min={0} step={0.1} value={tolerance} onChange={e=>setTolerance(e.target.value)} style={{ padding:8 }} />
        </label>
        <div style={{ display:'flex', alignItems:'flex-end' }}>
          <button className="btn" disabled={loading || !truckId} onClick={run}>{loading? 'Loading…':'Run'}</button>
        </div>
      </div>
      {error && (<div style={{ marginTop:8, color:'#b91c1c' }}>{error}</div>)}
      {rows.length > 0 && (
        <div className="table-wrap" style={{ marginTop:12 }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Date</th>
                <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Opening</th>
                <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Closing</th>
                <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Meter ΔM</th>
                <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Expected ΔE</th>
                <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Sales</th>
                <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Transfers Out</th>
                <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Testing</th>
                <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Balance</th>
                <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>Off-hours Δ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const diffOk = r.day_meter_delta != null && Math.abs((r.day_meter_delta||0) - (r.expected_delta||0)) <= Number(tolerance||0);
                return (
                  <tr key={r.date} style={{ borderBottom:'1px solid #f1f5f9' }}>
                    <td style={{ padding:'4px 8px' }}>{r.date}</td>
                    <td style={{ padding:'4px 8px', textAlign:'right' }}>{r.opening != null ? r.opening : '-'}</td>
                    <td style={{ padding:'4px 8px', textAlign:'right' }}>{r.closing != null ? r.closing : '-'}</td>
                    <td style={{ padding:'4px 8px' }}>{r.day_meter_delta == null ? '-' : r.day_meter_delta}</td>
                    <td style={{ padding:'4px 8px' }}>{r.expected_delta}</td>
                    <td style={{ padding:'4px 8px' }}>{r.sales}</td>
                    <td style={{ padding:'4px 8px' }}>{r.transfers_out}</td>
                    <td style={{ padding:'4px 8px' }}>{r.testing_used_liters}</td>
                    <td style={{ padding:'4px 8px', fontWeight:600, color: r.status==='BALANCED'? '#065f46' : (diffOk? '#065f46':'#b91c1c') }}>{r.status==='BALANCED'? 'Balanced' : r.status_note}</td>
                    <td style={{ padding:'4px 8px' }}>{r.off_hours_meter_delta == null ? '-' : r.off_hours_meter_delta}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
