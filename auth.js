// Reads local .env (git-ignored) for username/password and
// exchanges them for an API token at page load. The username/password are
// only ever held in memory for the duration of that exchange - they are
// never written to the DOM, localStorage, or any field, and the resulting
// token is read-only against the AMCSD API.
window.AMCSD_AUTH_READY = (async () => {
  let username, password;
  try {
    const res = await fetch('.env', { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === 'username') username = value;
      else if (key === 'password') password = value;
    }
  } catch {
    return null;
  }

  if (!username || !password) return null;

  try {
    const res = await fetch('https://www.rruff.net/odr_rruff/api/v4/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`Login failed: ${res.status} ${res.statusText}`);

    let token;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      token = data.token || data.access_token || data.jwt;
    } else {
      token = (await res.text()).trim();
    }
    if (!token) throw new Error('Login response did not include a token');

    window.AMCSD_API_TOKEN = token;
    return token;
  } catch (err) {
    console.error('AMCSD auto-login failed:', err);
    return null;
  } finally {
    username = password = undefined;
  }
})();
