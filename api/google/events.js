import { handleGoogle } from '../../lib/google-api.js';

export default { fetch(request) { return handleGoogle(request, 'events'); } };
