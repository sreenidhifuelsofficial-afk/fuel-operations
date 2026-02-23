import React, { useEffect, useMemo, useState } from 'react';
import { fmtDateInput, formatWallClockDateDisplay, formatWallClockDateTimeDisplay, safeJson } from './utils';

export default function SaleSection({ token, units, datums, drivers, refreshStock }) {
  // Filters (read-only view)
  const initialFrom = useMemo(() => fmtDateInput(new Date()), []);
  const initialTo = useMemo(() => fmtDateInput(new Date()), []);
  const [draft, setDraft] = useState(() => ({
    fromDate: initialFrom,
    toDate: initialTo,
    unitId: '',
  }));

  // Applied filters used for fetching (prevents stale state when clicking Apply quickly)
  const [applied, setApplied] = useState(() => ({
    fromDate: initialFrom,
    toDate: initialTo,
    unitId: '',
  }));

  const [reloadSeq, setReloadSeq] = useState(0);

  const [salesLoading, setSalesLoading] = useState(false);
  const [salesRows, setSalesRows] = useState([]);
  const allUnits = [...(units||[]), ...(datums||[])].filter(u => u.unit_type==='TRUCK' || u.unit_type==='DATUM');

  function buildQuery(filters) {
    const qs = new URLSearchParams();
    if (filters?.fromDate) qs.set('from', filters.fromDate);
    if (filters?.toDate) qs.set('to', filters.toDate);
    if (filters?.unitId) qs.set('unit_id', filters.unitId);
    qs.set('limit', '500');
    return qs.toString();
  }

  useEffect(() => {
    if (!token) { setSalesRows([]); return; }
    let aborted = false;
    (async () => {
      setSalesLoading(true);
      try {
        const r = await fetch(`/api/fuel-ops/transfers/sales/list?${buildQuery(applied)}`, { headers: { Accept:'application/json', ...(token?{ Authorization:'Bearer '+token }: {}) } });
        const data = await safeJson(r);
        if (!r.ok) throw new Error(data && data.error ? data.error : 'Failed to load sales');
        if (!aborted) {
          const items = (data && data.items) ? data.items : [];
          // Ensure stable ordering within page.
          items.sort((a, b) => {
            const ad = (a.sale_date || (a.performed_at ? String(a.performed_at).slice(0, 10) : '')) || '';
            const bd = (b.sale_date || (b.performed_at ? String(b.performed_at).slice(0, 10) : '')) || '';
            if (ad !== bd) return bd.localeCompare(ad);
            const at = a.performed_at ? String(a.performed_at) : '';
            const bt = b.performed_at ? String(b.performed_at) : '';
            if (at !== bt) return bt.localeCompare(at);
            // final fallback
            const ai = Number(a.id) || 0;
            const bi = Number(b.id) || 0;
            return bi - ai;
          });
          setSalesRows(items);
        }
      } catch {
        if (!aborted) { setSalesRows([]); }
      } finally {
        if (!aborted) setSalesLoading(false);
      }
    })();
    return () => { aborted = true; };
  }, [token, applied, reloadSeq]);

  async function onExportCsv() {
    const qs = new URLSearchParams();
    if (applied.fromDate) qs.set('from', applied.fromDate);
    if (applied.toDate) qs.set('to', applied.toDate);
    if (applied.unitId) qs.set('unit_id', applied.unitId);
    const url = `/api/fuel-ops/transfers/sales/export?${qs.toString()}`;
    try {
      const r = await fetch(url, { headers: { ...(token?{ Authorization:'Bearer '+token }: {}) }});
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || 'Export failed');
      }
      const blob = await r.blob();
      const disposition = r.headers.get('Content-Disposition') || '';
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match ? match[1] : `sales_${applied.fromDate || 'all'}_${applied.toDate || 'all'}.csv`;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      setTimeout(()=> URL.revokeObjectURL(link.href), 1000);
    } catch (e) {
      alert(String(e.message||e));
    }
  }

  function onPrint() {
    const rows = salesRows;
    const unitLabel = applied.unitId ? (((allUnits.find(u=>String(u.id)===String(applied.unitId))||{}).unit_code)||applied.unitId) : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales</title>
      <style>body{font-family:Arial,Helvetica,sans-serif;padding:16px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left} th{background:#f9fafb}</style>
    </head><body>
      <h3>Sales (${applied.fromDate || '-'} to ${applied.toDate || '-'}${unitLabel?`, Unit ${unitLabel}`:''})</h3>
      <table><thead><tr>
        <th>Date</th><th>From Unit Code</th><th>To Vehicle</th><th>Sale Volume (L)</th><th>Lot Code After</th><th>Driver Name</th><th>Performed By</th><th>Trip</th><th>Performed At</th><th>Activity</th>
      </tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td>${formatWallClockDateDisplay(r.sale_date || r.performed_at)}</td>
          <td>${r.from_unit_code||''}</td>
          <td>${r.to_vehicle||''}</td>
          <td>${r.sale_volume_liters||''}</td>
          <td>${r.lot_code_after||''}</td>
          <td>${r.driver_name||''}</td>
          <td>${r.performed_by||''}</td>
          <td>${r.trip!=null?r.trip:''}</td>
          <td>${r.performed_at ? formatWallClockDateTimeDisplay(r.performed_at) : ''}</td>
          <td>${r.activity||''}</td>
        </tr>`).join('')}
      </tbody></table>
      <script>window.print();</script>
    </body></html>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  }

  return (
    <div className="card" style={{ padding: 16, maxWidth: 1100 }}>
      <div style={{ fontSize:12, color:'#374151', marginBottom:12 }}>
        Sales tab is read-only. Creation of sale records is disabled here per requirement. Use At Depot timeline for operational entries.
      </div>
      <div className="fo-grid-auto">
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          From Date
          <input type="date" value={draft.fromDate} onChange={e=> setDraft(s => ({ ...s, fromDate: e.target.value }))} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          To Date
          <input type="date" value={draft.toDate} onChange={e=> setDraft(s => ({ ...s, toDate: e.target.value }))} style={{ padding:8 }} />
        </label>
        <label style={{ display:'flex', flexDirection:'column', fontSize:12, color:'#374151' }}>
          Tanker/Datum
          <select value={draft.unitId} onChange={e=> setDraft(s => ({ ...s, unitId: e.target.value }))} style={{ padding:8 }}>
            <option value="">All</option>
            {allUnits.map(u => (<option key={u.id} value={u.id}>{u.unit_code}{u.unit_type==='DATUM'?' (DATUM)':''}</option>))}
          </select>
        </label>
      </div>
      <div className="fo-filter-bar" style={{ marginTop:12 }}>
        <button className="btn" onClick={()=>{ setApplied({ ...draft }); }} disabled={salesLoading}>Apply</button>
        <button className="btn ghost" disabled={salesLoading} onClick={onExportCsv}>Export CSV</button>
        <button className="btn ghost" disabled={salesLoading} onClick={onPrint}>Print / PDF</button>
        <button className="btn ghost" disabled={salesLoading} onClick={()=> setReloadSeq(s=>s+1)}>{salesLoading? 'Loading…':'Refresh'}</button>
      </div>
      <div style={{ marginTop:16, paddingTop:12, borderTop:'1px solid #eee' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
          <div style={{ fontWeight:600 }}>Sales transfer records</div>
        </div>
        <div className="table-wrap fo-table-responsive" style={{ height: 420, overflowY:'scroll', overflowX:'auto', scrollbarGutter: 'stable' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ textAlign:'left' }}>
                <th>Date</th>
                <th>From Unit Code</th>
                <th>To Vehicle</th>
                <th>Sale Volume (L)</th>
                <th>Lot Code After</th>
                <th>Driver Name</th>
                <th>Performed By</th>
                <th>Trip</th>
                <th>Performed At</th>
                <th>Activity</th>
              </tr>
            </thead>
            <tbody>
              {(salesRows||[]).length===0 ? (
                <tr><td colSpan={10} style={{ padding:8, color:'#6b7280' }}>{salesLoading ? 'Loading…' : 'No records'}</td></tr>
              ) : (
                salesRows.map(r => (
                  <tr key={r.id}>
                    <td data-label="Date">{formatWallClockDateDisplay(r.sale_date || r.performed_at)}</td>
                    <td data-label="From Unit">{r.from_unit_code}</td>
                    <td data-label="To Vehicle">{r.to_vehicle}</td>
                    <td data-label="Volume (L)">{r.sale_volume_liters}</td>
                    <td data-label="Lot Code">{r.lot_code_after}</td>
                    <td data-label="Driver">{r.driver_name || '-'}</td>
                    <td data-label="Performed By">{r.performed_by || '-'}</td>
                    <td data-label="Trip">{r.trip != null ? r.trip : '-'}</td>
                    <td data-label="Performed At">{r.performed_at ? formatWallClockDateTimeDisplay(r.performed_at) : '-'}</td>
                    <td data-label="Activity">{r.activity || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}