export default {
  fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
    const publicKey = key.startsWith('sb_publishable_') ||
      (key.split('.').length === 3 && (() => {
        try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; }
        catch { return false; }
      })());
    const config = {
      url: url.startsWith('https://') && publicKey ? url : '',
      publishableKey: url.startsWith('https://') && publicKey ? key : '',
    };
    return new Response('window.TU_AGENDANDO_CONFIG = Object.freeze(' +
      JSON.stringify(config) + ');', {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
