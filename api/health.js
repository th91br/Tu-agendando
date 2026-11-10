export default {
  fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const configured = Boolean(String(process.env.SUPABASE_URL || '').startsWith('https://') &&
      process.env.SUPABASE_PUBLISHABLE_KEY);
    return Response.json({ status: configured ? 'ready' : 'configuration_required' }, {
      status: configured ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  },
};
