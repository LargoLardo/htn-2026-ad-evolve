import { createProviders } from '../../lib/provider-core.mjs';
import { createMedia, base64JsonStream } from './media.mjs';
import { getScoringContract } from './contract.mjs';
import { accountStore } from './storage.mjs';
import { createVideoProvider } from './video.mjs';

export function cloudProviders(env, accountId, { step, checkpoint } = {}) {
  const media = createMedia(env, accountId), store = accountStore(env, accountId);
  return createProviders({ env, ...media, ...store, getScoringContract,
    renderVideo: createVideoProvider(env, media, store, { step, checkpoint }),
    async neuralRequest(endpoint, payload, { token, signal }) {
      if (payload.candidates.length !== 1) throw new Error('Neural requests must contain exactly one stimulus.');
      const item = payload.candidates[0];
      if (!item.media_key.startsWith(`${accountId}/`)) throw new Error('Media account mismatch.');
      const object = await env.MEDIA.get(item.media_key);
      if (!object) throw new Error('Media not found.');
      const prefix = JSON.stringify({ action: 'neural', contract_hash: payload.contract_hash, baseline: payload.baseline }).slice(0, -1)
        + ',"candidates":[' + JSON.stringify({ id: item.id, media_hash: item.media_hash, media_type: item.media_type }).slice(0, -1) + ',"media_base64":"';
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: base64JsonStream(object.body, prefix, '"}]}'),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(360_000)]),
      });
      if (!response.ok) throw new Error(`TRIBE returned HTTP ${response.status}.`);
      return response.json();
    },
  });
}
