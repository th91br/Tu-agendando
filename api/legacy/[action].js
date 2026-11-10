import { handleLegacy } from '../../lib/google-api.js';

export default {
  fetch(request) {
    const action = request.query?.action ||
      decodeURIComponent(new URL(request.url).pathname.split('/').pop() || '');
    return handleLegacy(request, action);
  },
};
