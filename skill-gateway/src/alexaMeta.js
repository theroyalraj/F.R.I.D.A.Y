/** Safe fields for logs (no tokens, no userId bodies). */
export function summarizeAlexaRequest(body) {
  if (!body?.request) return { parse: 'empty' };
  const r = body.request;
  const appId =
    body.session?.application?.applicationId || body.context?.System?.application?.applicationId;
  let intent;
  let slotPreview;
  if (r.type === 'IntentRequest' && r.intent) {
    intent = r.intent.name;
    const slots = r.intent.slots || {};
    const v =
      slots.command?.value ||
      slots.Command?.value ||
      slots.query?.value ||
      Object.values(slots)[0]?.value;
    if (v) slotPreview = String(v).slice(0, 120);
  }
  const api = body.context?.System?.apiEndpoint || '';
  return {
    requestType: r.type,
    requestId: r.requestId,
    locale: r.locale,
    applicationId: appId,
    intent,
    slotPreview,
    apiRegion: api.includes('eu.') ? 'EU' : api.includes('fe.') ? 'FE' : api ? 'NA' : 'unknown',
  };
}
