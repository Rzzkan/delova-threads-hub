// Dimuat di <head> (tanpa defer) agar tema gelap terpasang sebelum halaman tampil.
try {
  const t = localStorage.getItem('hub-theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch { /* penyimpanan diblokir: pakai tema terang */ }
