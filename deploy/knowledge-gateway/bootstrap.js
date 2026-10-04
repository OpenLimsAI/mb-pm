// Run before the existing SPA: same-origin gateway supplies credentials on the server.
sessionStorage.setItem('dikw-web.serverUrl', 'http://127.0.0.1:8765');
sessionStorage.removeItem('dikw-web.token');
localStorage.setItem('dikw-web.serverUrl', 'http://127.0.0.1:8765');
localStorage.removeItem('dikw-web.token');
if (!location.hash) location.hash = 'mb-web';

(() => {
  let identity;
  let busy = false;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
    if (response.status === 401 && url.origin === location.origin && !url.pathname.startsWith('/auth/')) {
      location.assign('/auth/login');
    }
    return response;
  };
  function attach() {
    if (!identity || document.getElementById('kb-iam-account') || !document.body) return;
    const group = document.querySelector('.mb-rgroup, .mb-topbar-right');
    const wrapper = document.createElement('div');
    wrapper.id = 'kb-iam-account';
    wrapper.style.cssText = 'display:flex;align-items:center;gap:10px;font:13px system-ui;color:#587080;white-space:nowrap';
    if (!group) wrapper.style.cssText += ';position:fixed;right:20px;bottom:20px;padding:10px 14px;background:#fff;border:1px solid #dbe4e9;border-radius:10px;z-index:999';
    const label = document.createElement('span');
    label.textContent = identity.user.displayName + ' · IAM';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '退出登录';
    button.style.cssText = 'color:#23486f;background:transparent;border:1px solid #cbd9e2;border-radius:6px;padding:5px 9px;cursor:pointer';
    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      try {
        const response = await originalFetch('/auth/logout', {method:'POST',headers:{'X-KB-CSRF':identity.csrf}});
        if (response.ok) location.assign((await response.json()).redirect);
        else if (response.status === 401) location.assign('/login');
        else throw new Error('退出失败，请稍后重试');
      } catch { button.textContent = '重试退出'; busy = false; button.disabled = false; }
    });
    wrapper.append(label, button);
    (group || document.body).append(wrapper);
  }
  async function check() {
    try {
      const response = await originalFetch('/auth/session');
      if (response.status === 401) { location.assign('/auth/login'); return; }
      if (!response.ok) return;
      identity = await response.json();
      attach();
    } catch { /* Next check retries; gateway denies data while IAM is unavailable. */ }
  }
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(attach).observe(document.body, {childList:true,subtree:true});
    check();
  });
  setInterval(check, 60000);
})();
