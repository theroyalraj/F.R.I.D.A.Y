const base = 'http://127.0.0.1:3847';

document.getElementById('ping')?.addEventListener('click', async () => {
  const out = document.getElementById('out');
  out.textContent = '…';
  try {
    const r = await fetch(`${base}/voice/ping`);
    const t = await r.text();
    out.textContent = `${r.status} ${t.slice(0, 400)}`;
  } catch (e) {
    out.textContent = String(e.message || e);
  }
});
