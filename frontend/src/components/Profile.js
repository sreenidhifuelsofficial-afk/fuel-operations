import React, { useEffect, useState } from 'react';
import { isValidEmail, isValidIndianPhoneLoose, isValidPAN, isValidAadhaar } from '../utils/validators';
import useValidation from '../utils/useValidation';

export default function Profile({ token }) {
  const [tab, setTab] = useState('Profile');
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState({});
  // Keep a saved baseline snapshot to allow cancel/discard
  const [baseUser, setBaseUser] = useState(null);
  const [baseProfile, setBaseProfile] = useState(null);
  // Edit-mode and confirm modal
  const [isEditing, setIsEditing] = useState(false);
  const [confirm, setConfirm] = useState({ open:false, action:'save' }); // action: 'save' | 'discard'
  const [msg, setMsg] = useState('');
  const [pwd, setPwd] = useState({ current:'', next:'', confirm:'' });
  const [pwdMsg, setPwdMsg] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [role, setRole] = useState(null);
  // eslint-disable-next-line no-unused-vars
  const [employees, setEmployees] = useState([]);
  // eslint-disable-next-line no-unused-vars
  const [empLoading, setEmpLoading] = useState(false);

  // Live field validation for phone, PAN, Aadhaar
  const v = useValidation(
    { phone: user?.phone || '', pan: profile?.pan || '', aadhaar: profile?.aadhaar || '' },
    {
      phone: { required: false, validate: (val) => { if (!val) return ''; return isValidIndianPhoneLoose(val) ? '' : 'Invalid phone'; } },
      pan: { required: false, validate: (val) => { if (!val) return ''; return isValidPAN(val) ? '' : 'Invalid PAN'; } },
      aadhaar: { required: false, validate: (val) => { if (!val) return ''; return isValidAadhaar(val) ? '' : 'Invalid Aadhaar'; } },
    },
    { debounceMs: 150 }
  );

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true); setMsg('');
    try {
      const r = await fetch('/api/profile/me', { headers: { Authorization: 'Bearer '+token }});
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load profile');
      setUser(data.user);
      setRole(data.user?.role || null);
      setProfile(data.profile || {});
      setBaseUser(data.user);
      setBaseProfile(data.profile || {});
      setIsEditing(false);
      try {
        const img = await fetch('/api/profile/photo/me', { headers: { Authorization: 'Bearer '+token }});
        if (img.ok) {
          const blob = await img.blob();
          setPhotoUrl(URL.createObjectURL(blob));
        } else {
          if (img.status >= 500) console.error('Profile photo fetch error', img.status);
          setPhotoUrl('');
        }
      } catch { setPhotoUrl(''); }
    } catch (e) {
      setMsg(e.message);
    } finally { setLoading(false); }
  }
  async function loadEmployees() {
    if (!(role==='OWNER' || role==='ADMIN')) return;
    setEmpLoading(true);
    try {
      const r = await fetch('/api/admin/employee-profiles', { headers: { Authorization: 'Bearer '+token }});
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load employees');
      setEmployees(Array.isArray(data)?data:[]);
    } catch (e) {
      setMsg(e.message);
    } finally { setEmpLoading(false); }
  }

  async function saveProfile() {
    setMsg('');
    // Basic client validations
    if (user?.email && !isValidEmail(user.email)) return setMsg('Invalid email');
    const ok = v.validateAll();
    if (!ok) return setMsg('Please fix the highlighted errors');
    try {
      const r = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type':'application/json', Authorization:'Bearer '+token },
        body: JSON.stringify({
          full_name: user.full_name,
          phone: user.phone,
          email: user.email,
          date_of_birth: profile.date_of_birth,
          gender: profile.gender,
          emergency_contact_name: profile.emergency_contact_name,
          emergency_contact_phone: profile.emergency_contact_phone,
          address: profile.address,
          pan: profile.pan,
          aadhaar: profile.aadhaar
        })
      });
      let data = null;
      try { data = await r.json(); }
      catch { const txt = await r.text().catch(()=> ''); if (!r.ok) throw new Error(txt || 'Failed to save'); }
      if (!r.ok) throw new Error((data && data.error) || 'Failed to save');
      setMsg('Saved');
      // Commit new baseline and exit edit mode
      setBaseUser(user);
      setBaseProfile(profile);
      setIsEditing(false);
    } catch (e) { setMsg(e.message); }
  }

  async function changePassword() {
    setPwdMsg('');
    if (!pwd.next || pwd.next.length < 6) return setPwdMsg('Password must be at least 6 chars');
    if (pwd.next !== pwd.confirm) return setPwdMsg('Passwords do not match');
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', Authorization:'Bearer '+token },
        body: JSON.stringify({ currentPassword: pwd.current, newPassword: pwd.next })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to change password');
      setPwd({ current:'', next:'', confirm:'' });
      setPwdMsg('Password changed successfully');
    } catch (e) { setPwdMsg(e.message); }
  }

  async function onPickPhoto(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) { setMsg('Only PNG/JPEG/WEBP allowed'); return; }
    if (file.size > 5*1024*1024) { setMsg('Image too large'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await fetch('/api/profile/photo', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', Authorization:'Bearer '+token },
          body: JSON.stringify({ dataUrl: reader.result })
        });
        if (!r.ok) {
          const d = await r.json().catch(()=>({}));
          throw new Error(d.error || 'Failed to upload');
        }
        await load();
        setMsg('Photo updated');
      } catch (e) { setMsg(e.message); }
    };
    reader.readAsDataURL(file);
  }

  if (loading) return <div style={{padding:24}}>Loading…</div>;
  return (
    <div style={{padding:'16px 8px', maxWidth: 1000, margin:'0 auto'}}>
      <div style={{display:'flex', gap:8, marginBottom:16, alignItems:'center'}}>
        <img src="/assets/branding/logo.png" alt="Sreenidhi Fuels" width="28" height="28" style={{borderRadius:'50%', objectFit:'cover', marginRight:6}} onError={(e)=>{ e.currentTarget.style.display='none'; }} />
        <button onClick={()=>setTab('Profile')} className="btn" style={{padding:'8px 14px', borderRadius:20, background: tab==='Profile'?'#111':'#e5e7eb', color: tab==='Profile'?'#fff':'#111'}}>Profile</button>
        <button onClick={()=>setTab('Password')} className="btn" style={{padding:'8px 14px', borderRadius:20, background: tab==='Password'?'#111':'#e5e7eb', color: tab==='Password'?'#fff':'#111'}}>Change Password</button>
        {(role==='OWNER' || role==='ADMIN') && (
          <button onClick={()=>{ setTab('Employees'); loadEmployees(); }} className="btn" style={{padding:'8px 14px', borderRadius:20, background: tab==='Employees'?'#111':'#e5e7eb', color: tab==='Employees'?'#fff':'#111'}}>Employees Profile</button>
        )}
      </div>
      {tab==='Profile' && (
        <div style={{display:'grid', gridTemplateColumns:'220px 1fr', gap:24}}>
          <div>
            <div style={{width:200, height:200, borderRadius:8, border:'1px solid #ddd', overflow:'hidden', background:'#f3f4f6', display:'flex',alignItems:'center',justifyContent:'center'}}>
              {photoUrl ? <img alt="profile" src={photoUrl} style={{width:'100%',height:'100%',objectFit:'cover'}}/> : <span style={{color:'#888'}}>No photo</span>}
            </div>
            <div style={{marginTop:8}}>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onPickPhoto} disabled={!isEditing} />
            </div>
            <div style={{marginTop:8, fontSize:12, color:'#6b7280'}}>Max 5MB. PNG/JPEG/WEBP.</div>
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0,1fr))', gap:12}}>
            <Field label="Full name"><input value={user?.full_name||''} onChange={e=>setUser({...user, full_name:e.target.value})} style={isEditing?input:inputDisabled} disabled={!isEditing}/></Field>
            <Field label="Username"><input value={user?.username||''} disabled style={{...input, background:'#f3f4f6'}}/></Field>
            <Field label="Email"><input value={user?.email||''} onChange={e=>setUser({...user, email:e.target.value})} style={isEditing?input:inputDisabled} disabled={!isEditing} /></Field>
            <Field label="Phone">
              <input value={user?.phone||''}
                     onChange={e=>{ const val = lockPhone(e.target.value); setUser({...user, phone: val}); v.schedule('phone', val); }}
                     onBlur={()=> v.onBlur('phone')}
                     style={isEditing?input:inputDisabled} disabled={!isEditing} placeholder="+91 9876543210 or 9876543210" />
              {v.touched.phone && v.errors.phone && <div style={errText}>{v.errors.phone}</div>}
            </Field>
            <Field label="Date of Birth"><input type="date" value={profile?.date_of_birth||''} onChange={e=>setProfile({...profile, date_of_birth:e.target.value})} style={isEditing?input:inputDisabled} disabled={!isEditing}/></Field>
            <Field label="Gender">
              <select value={profile?.gender||''} onChange={e=>setProfile({...profile, gender:e.target.value})} style={isEditing?input:inputDisabled} disabled={!isEditing}>
                <option value="">Select…</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
                <option value="PREFER_NOT_TO_SAY">Prefer not to say</option>
              </select>
            </Field>
            <Field label="Emergency Contact Name"><input value={profile?.emergency_contact_name||''} onChange={e=>setProfile({...profile, emergency_contact_name:e.target.value})} style={isEditing?input:inputDisabled} disabled={!isEditing} /></Field>
            <Field label="Emergency Contact Phone"><input value={profile?.emergency_contact_phone||''} onChange={e=>setProfile({...profile, emergency_contact_phone:e.target.value})} style={isEditing?input:inputDisabled} disabled={!isEditing} /></Field>
            <Field label="Address" full><textarea value={profile?.address||''} onChange={e=>setProfile({...profile, address:e.target.value})} style={{...(isEditing?input:inputDisabled), minHeight:64}} disabled={!isEditing} /></Field>
            <Field label="Joining Date"><input type="date" value={(user?.joining_date||'').slice(0,10)} disabled style={{...input, background:'#f3f4f6'}} /></Field>
            <Field label="Status">
              <input value={user?.status||''} disabled style={{...input, background:'#f3f4f6'}} />
            </Field>
            <Field label="PAN">
              <input value={profile?.pan||''}
                     onChange={e=>{ const val = lockPan(e.target.value); setProfile({...profile, pan: val}); v.schedule('pan', val); }}
                     onBlur={()=> v.onBlur('pan')}
                     style={isEditing?input:inputDisabled} disabled={!isEditing} placeholder="ABCDE1234F"/>
              {v.touched.pan && v.errors.pan && <div style={errText}>{v.errors.pan}</div>}
            </Field>
            <Field label="Aadhaar">
              <input value={profile?.aadhaar||''}
                     onChange={e=>{ const val = lockAadhaar(e.target.value); setProfile({...profile, aadhaar: val}); v.schedule('aadhaar', val); }}
                     onBlur={()=> v.onBlur('aadhaar')}
                     style={isEditing?input:inputDisabled} disabled={!isEditing} placeholder="12-digit"/>
              {v.touched.aadhaar && v.errors.aadhaar && <div style={errText}>{v.errors.aadhaar}</div>}
            </Field>
            <div style={{gridColumn:'1/-1', display:'flex', alignItems:'center', gap:10}}>
              {!isEditing ? (
                <button onClick={() => { setIsEditing(true); setUser(baseUser); setProfile(baseProfile || {}); }} className="btn" style={{background:'#111',color:'#fff',padding:'10px 16px',borderRadius:8}}>
                  Edit
                </button>
              ) : (
                <>
                  <button onClick={(e) => { e.preventDefault(); setConfirm({ open:true, action:'save' }); }} className="btn" style={{background:'#111',color:'#fff',padding:'10px 16px',borderRadius:8, opacity: (v.errors.phone||v.errors.pan||v.errors.aadhaar) ? 0.6 : 1}}
                    disabled={Boolean(v.errors.phone||v.errors.pan||v.errors.aadhaar)}>
                    Save
                  </button>
                  <button onClick={() => { setConfirm({ open:true, action:'discard' }); }} className="btn" style={{background:'#eee',color:'#222',padding:'10px 16px',borderRadius:8}}>Cancel</button>
                </>
              )}
              {msg && <span style={{fontSize:12, color: msg==='Saved' ? 'green' : 'crimson'}}>{msg}</span>}
            </div>
          </div>
        </div>
      )}
      {tab==='Password' && (
        <div style={{maxWidth:480}}>
          <div style={{marginBottom:12, fontSize:12, color:'#6b7280'}}>Username: <strong>{user?.username || user?.email}</strong></div>
          <Field label="Current password"><input type="password" value={pwd.current} onChange={e=>setPwd({...pwd, current:e.target.value})} style={input} /></Field>
          <Field label="New password"><input type="password" value={pwd.next} onChange={e=>setPwd({...pwd, next:e.target.value})} style={input} /></Field>
          <Field label="Re-enter new password"><input type="password" value={pwd.confirm} onChange={e=>setPwd({...pwd, confirm:e.target.value})} style={input} /></Field>
          <div style={{display:'flex', alignItems:'center', gap:10}}>
            <button onClick={changePassword} className="btn" style={{background:'#111',color:'#fff',padding:'10px 16px',borderRadius:8}}>Update Password</button>
            {pwdMsg && <span style={{fontSize:12, color: pwdMsg.toLowerCase().includes('success') ? 'green' : 'crimson'}}>{pwdMsg}</span>}
          </div>
        </div>
      )}
      {tab==='Employees' && (role==='OWNER' || role==='ADMIN') && (
        <EmployeesGrid token={token} />
      )}
      <ConfirmModal
        open={confirm.open}
        title={confirm.action==='save' ? 'Save changes?' : 'Discard changes?'}
        message={confirm.action==='save' ? 'Do you want to save your changes to profile?' : 'Discard all changes made to the profile?'}
        confirmText={confirm.action==='save' ? 'Save' : 'Discard'}
        cancelText="Cancel"
        onCancel={() => setConfirm({ open:false, action:'save' })}
        onConfirm={() => {
          if (confirm.action === 'save') {
            setConfirm({ open:false, action:'save' });
            saveProfile();
          } else {
            // discard
            setUser(baseUser);
            setProfile(baseProfile || {});
            setIsEditing(false);
            setConfirm({ open:false, action:'save' });
          }
        }}
      />
    </div>
  );
}

function Field({ label, children, full }) {
  return (
    <label style={{display:'flex', flexDirection:'column', gap:6, gridColumn: full ? '1/-1' : undefined}}>
      <span style={{fontSize:12, fontWeight:600}}>{label}</span>
      {children}
    </label>
  );
}

const input = { padding:'8px 10px', border:'1px solid #d1d5db', borderRadius:8, width:'100%' };
const errText = { fontSize:12, color:'crimson', marginTop:4 };

// Input lock helpers
function lockPhone(v) {
  if (!v) return '';
  let s = String(v);
  // Allow optional +91 prefix; keep spaces/dashes out
  s = s.replace(/\s+/g, '').replace(/-/g, '');
  if (s.startsWith('+91')) {
    const digits = s.replace(/\D/g, '');
    const tail = digits.slice(-10); // last 10 digits after country code
    return '+91' + tail;
  }
  // Otherwise, strip to 10 digits
  const digits = s.replace(/\D/g, '').slice(0, 10);
  return digits;
}
function lockPan(v) {
  if (!v) return '';
  return String(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}
function lockAadhaar(v) {
  if (!v) return '';
  return String(v).replace(/\D/g, '').slice(0, 12);
}
function EmployeesGrid({ token }) {
  const [modal, setModal] = useState({ open:false, user:null });
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [qDebounced, setQDebounced] = useState('');

  async function fetchPage(p=1, r=role, query=q) {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (r) params.set('role', r);
      if (query) params.set('q', query);
      params.set('page', String(p));
      params.set('pageSize', String(pageSize));
      const res = await fetch(`/api/admin/employee-profiles?${params.toString()}`, { headers: { Authorization: 'Bearer '+token }});
      const data = await res.json();
      if (res.ok) {
        setTotal(data.total || 0);
        setItems(Array.isArray(data.items) ? data.items : []);
      }
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(()=>{ fetchPage(page, role, qDebounced); }, [page, role, pageSize, qDebounced]);
  useEffect(()=>{ fetchPage(1, role, qDebounced); }, []); // first load
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const disablePrev = page <= 1;
  const disableNext = page >= pages;

  return (
    <div>
      <div style={{display:'flex', gap:10, alignItems:'center', marginBottom:12}}>
        <input placeholder="Search name/email/username/phone" value={q} onChange={(e)=>{ setQ(e.target.value); setPage(1); }} style={{...input, maxWidth:300}} />
        <select value={role} onChange={(e)=>{ setRole(e.target.value); setPage(1); }} style={input}>
          <option value="">All roles</option>
          <option value="OWNER">Owner</option>
          <option value="ADMIN">Admin</option>
          <option value="EMPLOYEE">Employee</option>
        </select>
        <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:8}}>
          <button className="btn" onClick={()=> setPage(p=>Math.max(1,p-1))} disabled={disablePrev}>Prev</button>
          <span style={{fontSize:12, color:'#6b7280'}}>Page {page} of {pages}</span>
          <button className="btn" onClick={()=> setPage(p=>p+1)} disabled={disableNext}>Next</button>
          <select value={pageSize} onChange={(e)=>{ setPageSize(parseInt(e.target.value,10)); setPage(1); }} style={input}>
            {[8,12,16,20].map(n => <option key={n} value={n}>{n}/page</option>)}
          </select>
        </div>
      </div>

      {loading ? <div style={{padding:8}}>Loading…</div> : (
        <>
          <div style={{display:'grid', gridTemplateColumns:'repeat(4, minmax(0,1fr))', gap:16}}>
            {(items||[]).map(e => (
              <div key={e.user_id} style={{border:'1px solid #e5e7eb', borderRadius:12, background:'#fff', padding:12, display:'flex', flexDirection:'column', gap:8}}>
                <Avatar userId={e.user_id} token={token} size={64} fallbackName={e.full_name || e.username || e.email} />
                <div style={{fontWeight:700}}>{e.full_name || e.username || e.email}</div>
                <div style={{fontSize:12, color:'#6b7280'}}>{e.email || '—'}</div>
                <div style={{fontSize:12, color:'#6b7280'}}>Role: {e.role} • {e.joining_date ? String(e.joining_date).slice(0,10) : '—'}</div>
                <button className="btn" style={{marginTop:6}} onClick={()=> setModal({ open:true, user: e })}>View Details</button>
              </div>
            ))}
            {(items||[]).length===0 && <div className="muted">No users</div>}
          </div>
          {modal.open && (
            <EmployeeModal token={token} user={modal.user} onClose={()=> setModal({ open:false, user:null })} />
          )}
        </>
      )}
    </div>
  );
}

function Avatar({ userId, token, size=48, fallbackName='' }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const res = await fetch(`/api/profile/photo/${userId}`, { headers: { Authorization: 'Bearer '+token }});
        if (res.ok) {
          const blob = await res.blob();
          if (!stop) setSrc(URL.createObjectURL(blob));
        } else if (res.status >= 500) {
          console.error('Avatar photo fetch error', res.status);
        }
      } catch {}
    })();
    return () => { stop = true; };
  }, [userId, token]);
  return (
    <div style={{width:size, height:size, borderRadius:'50%', overflow:'hidden', background:'#f3f4f6', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, color:'#475569'}}>
      {src ? <img alt="avatar" src={src} style={{width:'100%',height:'100%',objectFit:'cover'}} /> : (fallbackName ? (fallbackName[0] || '').toUpperCase() : '')}
    </div>
  );
}

function EmployeeModal({ token, user, onClose }) {
  const [photo, setPhoto] = useState('');
  const [details, setDetails] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const pr = await fetch(`/api/admin/employee-profile/${user.user_id}`, { headers: { Authorization: 'Bearer '+token }});
        const data = await pr.json();
        if (pr.ok) setDetails(data); else setDetails(user);
      } catch {}
      try {
        const img = await fetch(`/api/profile/photo/${user.user_id}`, { headers: { Authorization: 'Bearer '+token }});
        if (img.ok) { const blob = await img.blob(); setPhoto(URL.createObjectURL(blob)); }
        else if (img.status >= 500) console.error('Employee photo fetch error', img.status);
      } catch {}
    })();
  }, [user, token]);
  if (!details) return null;
  return (
    <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000}}>
      <div style={{background:'#fff', borderRadius:12, padding:20, width:900, maxHeight:'90vh', overflowY:'auto'}}>
        <div style={{display:'grid', gridTemplateColumns:'220px 1fr', gap:24}}>
          <div>
            <div style={{width:200, height:200, borderRadius:8, border:'1px solid #ddd', overflow:'hidden', background:'#f3f4f6', display:'flex',alignItems:'center',justifyContent:'center'}}>
              {photo ? <img alt="profile" src={photo} style={{width:'100%',height:'100%',objectFit:'cover'}}/> : <span style={{color:'#888'}}>No photo</span>}
            </div>
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0,1fr))', gap:12}}>
            <Field label="Full name"><input value={details?.full_name||''} disabled style={inputDisabled}/></Field>
            <Field label="Username"><input value={details?.username||''} disabled style={inputDisabled}/></Field>
            <Field label="Email"><input value={details?.email||''} disabled style={inputDisabled} /></Field>
            <Field label="Phone"><input value={details?.phone||''} disabled style={inputDisabled} /></Field>
            <Field label="Date of Birth"><input type="date" value={(details?.date_of_birth||'')} disabled style={inputDisabled}/></Field>
            <Field label="Gender"><input value={details?.gender||''} disabled style={inputDisabled}/></Field>
            <Field label="Emergency Contact Name"><input value={details?.emergency_contact_name||''} disabled style={inputDisabled} /></Field>
            <Field label="Emergency Contact Phone"><input value={details?.emergency_contact_phone||''} disabled style={inputDisabled} /></Field>
            <Field label="Address" full><textarea value={details?.address||''} disabled style={{...inputDisabled, minHeight:64}} /></Field>
            <Field label="Joining Date"><input type="date" value={(details?.joining_date? String(details.joining_date).slice(0,10):'')} disabled style={inputDisabled} /></Field>
            <Field label="Status"><input value={details?.status||''} disabled style={inputDisabled} /></Field>
            <Field label="PAN"><input value={maskPan(details?.pan)} disabled style={inputDisabled} /></Field>
            <Field label="Aadhaar last4"><input value={details?.aadhaar_last4||''} disabled style={inputDisabled} /></Field>
          </div>
        </div>
        <div style={{marginTop:16, textAlign:'right'}}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

const inputDisabled = { ...input, background:'#f3f4f6' };
function maskPan(p) { if (!p) return ''; const s = String(p); return s.length>=10 ? `${s.slice(0,5)}****${s.slice(-1)}` : '****'; }

// Simple confirm modal used for Save/Discard in Profile edit
function ConfirmModal({ open, title='Confirm', message='Are you sure?', confirmText='Yes', cancelText='No', onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000}}>
      <div style={{background:'#fff', borderRadius:12, padding:20, width:420, maxWidth:'90vw'}}>
        <div style={{fontWeight:700, marginBottom:8}}>{title}</div>
        <div style={{marginBottom:16}}>{message}</div>
        <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
          <button className="btn" onClick={onCancel} style={{background:'#eee', color:'#111'}}>{cancelText}</button>
          <button className="btn" onClick={onConfirm} style={{background:'#111', color:'#fff'}}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
