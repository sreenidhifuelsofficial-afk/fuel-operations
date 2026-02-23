// Simple auth helpers for client-side role checks
// Caches the current user on window.__currentUser to avoid extra calls

export async function fetchCurrentUser(force = false) {
  try {
    if (!force && window.__currentUser && window.__currentUser.id) return window.__currentUser;
    const token = localStorage.getItem('authToken') || localStorage.getItem('token');
    const headers = token ? { 'Authorization': `Bearer ${token}` } : undefined;
    const res = await fetch('/api/auth/me', { headers });
    if (!res.ok) return null;
    const me = await res.json();
    window.__currentUser = me;
    return me;
  } catch {
    return null;
  }
}

export async function isAdmin() {
  const me = await fetchCurrentUser();
  return !!me && me.role === 'ADMIN';
}

export async function getRole() {
  const me = await fetchCurrentUser();
  return me?.role || null;
}
