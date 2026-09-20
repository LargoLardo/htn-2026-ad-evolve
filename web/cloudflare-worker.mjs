import handler from './.open-next/worker.js';

// Keep the browser request intact, including Access JWT, range and SSE headers.
export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/assets/')) return env.API.fetch(request);
    return handler.fetch(request, env, ctx);
  },
};
