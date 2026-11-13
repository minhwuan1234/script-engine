import { randomUUID } from 'node:crypto';

export function hubspotConfig(env) {
  if (env.HUBSPOT_FORMS_ENABLED !== 'true') return null;
  if (env.SUBMISSION_ARCHIVE_ENABLED !== 'true') {
    throw new Error('HubSpot Forms requires SUBMISSION_ARCHIVE_ENABLED=true.');
  }
  const portalId = env.HUBSPOT_PORTAL_ID;
  const formGuid = env.HUBSPOT_FORM_GUID;
  if (!portalId || !/^\d+$/.test(portalId)) throw new Error('Invalid HUBSPOT_PORTAL_ID.');
  if (!formGuid || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(formGuid)) {
    throw new Error('Invalid HUBSPOT_FORM_GUID.');
  }
  return { portalId, formGuid };
}

function retryAfterMs(value) {
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(86_400_000, Math.max(0, ms)) : 0;
}

export function createHubSpotLeadConfirmation({ store, config, pageUri, fetchImpl = fetch }) {
  const endpoint = `https://api.hsforms.com/submissions/v3/integration/submit/${config.portalId}/${config.formGuid}`;
  return async (submissionId, email) => {
    const claim = randomUUID();
    const state = await store.claimHubSpotSubmission(submissionId, claim);
    if (state === 'confirmed') return;
    if (state === 'claimed') {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            submittedAt: Date.now(),
            fields: [{ name: 'email', value: email }],
            context: { pageUri, pageName: 'F.Learning Script Engine' },
          }),
        });
      } catch (error) {
        const kind = error?.name === 'TimeoutError' ? 'timeout' : 'network failure';
        console.error(`HubSpot form submission failed: ${kind}.`);
      }
      if (response?.body) void response.body.cancel().catch(() => {});
      if (response && !response.ok) {
        console.error(`HubSpot form submission failed: HTTP ${response.status}.`);
      }
      const retryMs = response?.status === 429
        ? retryAfterMs(response.headers.get('Retry-After')) || 10_000 : 0;
      const accepted = response?.ok === true;
      const recorded = await store.finishHubSpotSubmission(submissionId, claim, accepted, retryMs);
      if (accepted && recorded) return;
    }
    throw Object.assign(new Error('Could not unlock downloads right now. Please retry shortly.'), { status: 503 });
  };
}
