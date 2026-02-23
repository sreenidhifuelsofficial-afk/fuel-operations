import React, { useEffect, useState } from 'react';

export default function Login({ onAuthed }) {
  const [mode, setMode] = useState('login'); // login | register-initial
  const [identifier, setIdentifier] = useState(''); // username or email
  const [email, setEmail] = useState(''); // used only for register-initial
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ownerExists, setOwnerExists] = useState(null);
  const [requireChange, setRequireChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/auth/owner-exists');
        const d = await r.json().catch(()=>({}));
        if (!cancelled) setOwnerExists(!!d.exists);
      } catch { if (!cancelled) setOwnerExists(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const path = mode === 'register-initial' ? '/api/auth/register-initial' : '/api/auth/login';
      const body = mode === 'register-initial'
        ? { email, password, full_name: fullName || undefined }
        : { identifier, password };
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let data;
      try {
        data = await res.json();
      } catch (e) {
        // Backend may be down or proxy returned text; surface useful message
        const txt = await res.text().catch(()=> '');
        throw new Error(txt && txt.trim().slice(0, 200) || 'Server did not return JSON');
      }
      // eslint-disable-next-line no-mixed-operators
      if (!res.ok) throw new Error(data.error || 'Request failed');
      localStorage.setItem('authToken', data.token);
      if (data.requirePasswordChange) {
        setRequireChange(true);
      } else {
        onAuthed(data.user);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+localStorage.getItem('authToken') },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      let data;
      try {
        data = await res.json();
      } catch (e) {
        const txt = await res.text().catch(()=> '');
        throw new Error(txt && txt.trim().slice(0, 200) || 'Server did not return JSON');
      }
      // eslint-disable-next-line no-mixed-operators
      if (!res.ok) throw new Error(data.error || 'Failed to change password');
      // Re-login with new password (optional), or fetch /me
      const me = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer '+localStorage.getItem('authToken') }}).then(r=>r.json());
      if (!me || !me.id) throw new Error('Login expired; please login again');
      setRequireChange(false);
      onAuthed(me);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{maxWidth:420, margin:'80px auto', padding:'32px', border:'1px solid #ddd', borderRadius:12, background:'#fff'}}>
      <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:6}}>
        <img src="/assets/branding/logo.png" alt="Sreenidhi Fuels" width="36" height="36" style={{borderRadius:'50%', objectFit:'cover'}} onError={(e)=>{ e.currentTarget.style.display='none'; }} />
        <h2 style={{margin:0}}>Sreenidhi Fuel Ops</h2>
      </div>
      <div style={{marginBottom:12, fontSize:14, color:'#555'}}>
        {mode === 'login' ? 'Login to your account' : 'Initial owner registration (only if no owner exists)'}
      </div>
      {!requireChange ? (
        <form onSubmit={submit}>
          <div style={{display:'flex', flexDirection:'column', gap:12}}>
            {mode === 'login' ? (
              <>
                <input type="text" placeholder="Username or email" value={identifier} onChange={e=>setIdentifier(e.target.value)} required style={inputStyle} />
                <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required style={inputStyle} />
              </>
            ) : (
              <>
                <input type="email" placeholder="Owner email" value={email} onChange={e=>setEmail(e.target.value)} required style={inputStyle} />
                <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required style={inputStyle} />
                <input type="text" placeholder="Full Name (optional)" value={fullName} onChange={e=>setFullName(e.target.value)} style={inputStyle} />
              </>
            )}
            {error && <div style={{color:'crimson', fontSize:13}}>{error}</div>}
            <button disabled={loading} style={btnStyle}>{loading? 'Please wait...' : (mode === 'login' ? 'Login' : 'Register Owner')}</button>
          </div>
        </form>
      ) : (
        <form onSubmit={changePassword}>
          <div style={{display:'flex', flexDirection:'column', gap:12}}>
            <div style={{fontSize:13, color:'#555'}}>You must change your password before continuing.</div>
            <input type="password" placeholder="Current password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)} required style={inputStyle} />
            <input type="password" placeholder="New password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} required style={inputStyle} />
            {error && <div style={{color:'crimson', fontSize:13}}>{error}</div>}
            <button disabled={loading} style={btnStyle}>{loading? 'Please wait...' : 'Change Password'}</button>
          </div>
        </form>
      )}
      <div style={{marginTop:16, fontSize:13}}>
        {!requireChange && (
          mode === 'login' ? (
            ownerExists === false ? (
              <button type="button" style={linkBtn} onClick={()=>setMode('register-initial')}>First time? Register Owner</button>
            ) : null
          ) : (
            <button type="button" style={linkBtn} onClick={()=>setMode('login')}>Back to Login</button>
          )
        )}
      </div>
    </div>
  );
}

const inputStyle = { padding:'10px 14px', borderRadius:8, border:'1px solid #ccc', fontSize:14 };
const btnStyle = { padding:'10px 16px', fontSize:15, border:'none', background:'#111', color:'#fff', borderRadius:8, cursor:'pointer' };
const linkBtn = { background:'none', border:'none', color:'#0366d6', cursor:'pointer', padding:0 };
