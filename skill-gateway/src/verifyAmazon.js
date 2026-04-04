/**
 * Request verification per Amazon:
 * https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html
 * Prefers Signature-256 + SHA-256; falls back to Signature + SHA-1.
 */
import crypto from 'node:crypto';
import url from 'node:url';
import validator from 'validator';
import validateCert from 'alexa-verifier/validate-cert.js';
import validateCertUri from 'alexa-verifier/validate-cert-uri.js';
import { rootLogger } from './log.js';

const TIMESTAMP_TOLERANCE_SEC = 150;
/** Avoid hanging forever if S3 / network blocks cert download (Alexa would show “problem communicating”). */
const CERT_FETCH_MS = 10_000;

export function validateRequestTimestamp(requestBody) {
  let json;
  try {
    json = JSON.parse(requestBody);
  } catch {
    return 'request body invalid json';
  }
  const ts = json.request?.timestamp;
  if (!ts) return 'Timestamp field not present in request';
  const d = new Date(ts).getTime();
  const now = Date.now();
  if (Number.isNaN(d)) return 'Invalid timestamp';
  if (Math.abs(now - d) > TIMESTAMP_TOLERANCE_SEC * 1000) {
    return 'Request timestamp outside allowed window (150s)';
  }
}

function getCert(certUrl, callback) {
  const parsed = url.parse(certUrl);
  const result = validateCertUri(parsed);
  if (result !== true) {
    return process.nextTick(callback, result);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CERT_FETCH_MS);
  fetch(certUrl, { signal: controller.signal })
    .then((r) => {
      clearTimeout(timer);
      if (!r.ok) throw new Error(`cert fetch failed: ${r.status}`);
      return r.text();
    })
    .then((pem) => {
      const v = validateCert(pem);
      if (v) return callback(v);
      callback(null, pem);
    })
    .catch((e) => {
      clearTimeout(timer);
      const msg =
        e?.name === 'AbortError'
          ? 'cert fetch timeout (check HTTPS to s3.amazonaws.com)'
          : String(e?.message || e);
      rootLogger.warn({ err: msg, phase: 'amazon-cert-fetch' }, 'cert chain download failed');
      callback(msg);
    });
}

function verifySignature(pem, signatureB64, body, algorithm) {
  const v = crypto.createVerify(algorithm);
  v.update(body, 'utf8');
  return v.verify(pem, signatureB64, 'base64');
}

/**
 * @param {string|undefined} certUrl - SignatureCertChainUrl
 * @param {string|undefined} signature256 - Signature-256 header (recommended)
 * @param {string|undefined} signature - legacy Signature header
 * @param {string} rawBody - exact request body string used for hashing
 */
export function verifyAlexaHttpRequest(certUrl, signature256, signature, rawBody, callback) {
  const tsErr = validateRequestTimestamp(rawBody);
  if (tsErr) return process.nextTick(callback, tsErr);

  const use256 = Boolean(signature256);
  const sig = use256 ? signature256 : signature;
  const algorithm = use256 ? 'RSA-SHA256' : 'RSA-SHA1';

  if (!certUrl || !sig) {
    return process.nextTick(callback, 'missing certificate url or signature');
  }
  if (!validator.isBase64(sig)) {
    return process.nextTick(callback, 'invalid signature (not base64 encoded)');
  }

  getCert(certUrl, (er, pem) => {
    if (er) return callback(er);
    if (!verifySignature(pem, sig, rawBody, algorithm)) {
      return callback('invalid signature');
    }
    callback();
  });
}
