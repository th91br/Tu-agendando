import { handleGoogle } from '../../../lib/google-api.js';

export default {
  fetch(request) {
    const id = request.query?.id ||
      decodeURIComponent(new URL(request.url).pathname.split('/').pop() || '');
    return handleGoogle(request, 'event', id);
  },
};
