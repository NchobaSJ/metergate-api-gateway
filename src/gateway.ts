import Fastify from 'fastify';
import crypto from 'node:crypto';
import {
  createApiKey,
  validateApiKey,
  revokeApiKey,
  listApiKeys,
  getApiKey,
} from './api-keys.js';



const PORT = Number(process.env.PORT ?? 3000);

const UPSTREAM_URL =
  process.env.UPSTREAM_URL ?? 'http://127.0.0.1:4000'; 
const UPSTREAM_TIMEOUT_MS =
  Number(process.env.UPSTREAM_TIMEOUT_MS ?? 5000);

const app = Fastify({
  logger: true
});

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
]);

function createRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

function buildUpstreamUrl(
  path: string,
  query: string
): string {
  const base = UPSTREAM_URL.endsWith('/')
    ? UPSTREAM_URL.slice(0, -1)
    : UPSTREAM_URL;

  return `${base}${path}${query ? `?${query}` : ''}`;
}

function copyResponseHeaders(
  headers: Headers
): Record<string, string> {

  const result: Record<string, string> = {};

  headers.forEach((value, key) => {

    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }

  });

  return result;
}

function buildRequestBody(
  body: unknown
): string | undefined {

  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }

  return JSON.stringify(body);
}


/*
 * Gateway health endpoint
 */
app.get('/health', async () => {

  return {
    status: 'ok',
    service: 'metergate',
    upstream: UPSTREAM_URL
  };

});


/*
 * -------------------------------------------------------------------------
 * Admin endpoints for API key management
 *
 * ⚠️ These are unprotected in M2 — anyone who can reach the gateway can
 *    create and revoke keys. In a later milestone we'll lock these behind
 *    a proper admin credential. For now, this lets us test the auth flow.
 * -------------------------------------------------------------------------
 */

/*
 * POST /admin/api-keys
 *
 * Body: { tenant_id: string, name: string, env?: 'live' | 'test' }
 *
 * Returns the plaintext key EXACTLY ONCE. The caller must save it.
 * On subsequent GETs, only the prefix is returned.
 */
app.post('/admin/api-keys', async (request, reply) => {

  const body = (request.body ?? {}) as {
    tenant_id?: string;
    name?: string;
    env?: 'live' | 'test';
  };

  if (!body.tenant_id || typeof body.tenant_id !== 'string') {
    return reply.code(400).send({
      error: 'invalid_request',
      message: 'tenant_id is required and must be a string',
    });
  }

  if (!body.name || typeof body.name !== 'string') {
    return reply.code(400).send({
      error: 'invalid_request',
      message: 'name is required and must be a string',
    });
  }

  if (body.env !== undefined && body.env !== 'live' && body.env !== 'test') {
    return reply.code(400).send({
      error: 'invalid_request',
      message: "env must be 'live' or 'test'",
    });
  }

  const { plaintext, record } = createApiKey(
    body.tenant_id,
    body.name,
    { env: body.env }
  );

  request.log.info(
    {
      event: 'api_key.created',
      key_id: record.id,
      tenant_id: record.tenant_id,
      prefix: record.prefix,
      // NOTE: we log the prefix, NEVER the plaintext or hash.
    },
    'api key created'
  );

  return reply.code(201).send({
    id: record.id,
    plaintext,                    // shown ONCE
    prefix: record.prefix,
    tenant_id: record.tenant_id,
    name: record.name,
    created_at: record.created_at,
    expires_at: record.expires_at,
    warning: 'Save this key now. It will not be shown again.',
  });

});

/*
 * GET /admin/api-keys
 *
 * Optional query: ?tenant_id=tenant_acme
 *
 * Returns the list of keys WITHOUT plaintext or hash.
 */
app.get('/admin/api-keys', async (request) => {

  const query = request.query as { tenant_id?: string };

  const keys = listApiKeys(query.tenant_id);

  return {
    count: keys.length,
    keys,
  };

});

/*
 * DELETE /admin/api-keys/:id
 *
 * Revokes a key. Idempotent.
 */
app.delete('/admin/api-keys/:id', async (request, reply) => {

  const { id } = request.params as { id: string };

  const existing = getApiKey(id);

  if (!existing) {
    return reply.code(404).send({
      error: 'not_found',
      message: 'No such API key',
    });
  }

  revokeApiKey(id);

  request.log.info(
    {
      event: 'api_key.revoked',
      key_id: id,
      tenant_id: existing.tenant_id,
      prefix: existing.prefix,
    },
    'api key revoked'
  );

  return reply.code(200).send({
    id,
    revoked: true,
  });

});

/*
 * Catch all other requests and proxy them
 */
app.all('/*', async (request, reply) => {

  const requestId = createRequestId();

  const startedAt = performance.now();

  const path = request.url.split('?')[0];

  const query =
    request.url.split('?')[1] ?? '';

  const upstreamUrl =
    buildUpstreamUrl(path, query);


    /*
   * -----------------------------------------------------------------------
   * AUTHENTICATION
   *
   * Extract the Bearer token, hash it, validate it.
   * If anything fails → 401 and STOP. Do not proxy.
   * -----------------------------------------------------------------------
   */

  const authHeader = request.headers['authorization'];

  if (
    typeof authHeader !== 'string' ||
    !authHeader.startsWith('Bearer ')
  ) {
    request.log.warn(
      {
        event: 'auth.missing',
        request_id: requestId,
        route: path,
      },
      'request rejected: missing api key'
    );

    return reply
      .code(401)
      .header('content-type', 'application/json')
      .header('x-request-id', requestId)
      .send({
        error: 'missing_api_key',
        message:
          'Authorization header must be in the form: Bearer <api_key>',
        request_id: requestId,
      });
  }

  const plaintextKey = authHeader.slice('Bearer '.length).trim();

  if (!plaintextKey) {
    request.log.warn(
      {
        event: 'auth.empty',
        request_id: requestId,
        route: path,
      },
      'request rejected: empty api key'
    );

    return reply
      .code(401)
      .header('content-type', 'application/json')
      .header('x-request-id', requestId)
      .send({
        error: 'missing_api_key',
        message: 'Bearer token was empty.',
        request_id: requestId,
      });
  }

  const apiKeyRecord = validateApiKey(plaintextKey);

  if (!apiKeyRecord) {
    request.log.warn(
      {
        event: 'auth.invalid',
        request_id: requestId,
        route: path,
        // NOTE: We log a prefix-like fingerprint, NEVER the key.
        // We only use the first 12 chars so operators can correlate
        // repeated failed attempts with the same bad key.
        attempted_prefix: plaintextKey.slice(0, 12),
      },
      'request rejected: invalid api key'
    );

    return reply
      .code(401)
      .header('content-type', 'application/json')
      .header('x-request-id', requestId)
      .send({
        error: 'invalid_api_key',
        message: 'The provided API key is invalid or revoked.',
        request_id: requestId,
      });
  }

  request.log.info(
    {
      event: 'auth.ok',
      request_id: requestId,
      route: path,
      tenant_id: apiKeyRecord.tenant_id,
      key_id: apiKeyRecord.id,
      key_prefix: apiKeyRecord.prefix,
    },
    'authentication succeeded'
  );

  /*
   * From this point on, `apiKeyRecord` is the trusted tenant context.
   * We do NOT trust anything the client sent us about identity.
   */


  /*
   * Build headers that will be sent
   * to the upstream API.
   */
  const upstreamHeaders: Record<string, string> = {};


  for (const [key, value] of Object.entries(
    request.headers
  )) {

    /*
     * Remove hop-by-hop headers.
     */
    if (
      HOP_BY_HOP_HEADERS.has(
        key.toLowerCase()
      )
    ) {
      continue;
    }


    /*
     * Never trust client-supplied
     * identity headers.
     */
    if (key.toLowerCase() === 'x-tenant-id') {
      continue;
    }

    if (key.toLowerCase() === 'x-user-id') {
      continue;
    }

    if (key.toLowerCase() === 'x-role') {
      continue;
    }


    if (Array.isArray(value)) {

      upstreamHeaders[key] =
        value.join(', ');

    } else if (value !== undefined) {

      upstreamHeaders[key] = value;

    }

  }


  /*
   * Headers controlled by MeterGate.
   */
  upstreamHeaders['x-request-id'] =
    requestId;

  upstreamHeaders['x-metergate-request'] =
    'true';

    /*
   * Inject TRUSTED identity headers.
   *
   * These come from the validated API key record — NOT from the client.
   * This is the moment MeterGate's identity guarantee becomes real:
   * the upstream can now trust X-Tenant-ID because the gateway set it
   * AFTER stripping any client-supplied value.
   */
  upstreamHeaders['x-tenant-id'] = apiKeyRecord.tenant_id;

  /*
   * x-user-id: if you later add individual users within tenants,
   * this is where their id would go. For now, tenant == user.
   */
  upstreamHeaders['x-user-id'] = apiKeyRecord.tenant_id;

  /*
   * x-api-key-id: useful for the upstream to correlate logs.
   * This is the internal id, not the secret. Safe to forward.
   */
  upstreamHeaders['x-api-key-id'] = apiKeyRecord.id;

  /*
   * x-api-key-prefix: the display prefix, useful for upstream logs.
   */
  upstreamHeaders['x-api-key-prefix'] = apiKeyRecord.prefix;
  


  /*
   * Prepare request body.
   */
  const body =
    buildRequestBody(request.body);


  if (
    body !== undefined &&
    !upstreamHeaders['content-type']
  ) {

    upstreamHeaders['content-type'] =
      'application/json';

  }


  try {

    const controller =
      new AbortController();


    /*
     * Kill upstream request if it
     * takes too long.
     */
    const timeout = setTimeout(() => {

      controller.abort();

    }, UPSTREAM_TIMEOUT_MS);


    let upstreamResponse: Response;


    try {

      upstreamResponse =
        await fetch(
          upstreamUrl,
          {
            method: request.method,

            headers: upstreamHeaders,

            body:
              ['GET', 'HEAD'].includes(
                request.method
              )
                ? undefined
                : body,

            signal: controller.signal,

            redirect: 'manual'
          }
        );

    } finally {

      clearTimeout(timeout);

    }


    /*
     * Read upstream response.
     */
    const responseBody =
      Buffer.from(
        await upstreamResponse.arrayBuffer()
      );


    const latencyMs =
      Math.round(
        performance.now() - startedAt
      );


    /*
     * Return upstream response
     * to the client.
     */
    reply
      .code(upstreamResponse.status)
      .headers(
        copyResponseHeaders(
          upstreamResponse.headers
        )
      )
      .header(
        'x-request-id',
        requestId
      )
      .header(
        'x-gateway-latency-ms',
        String(latencyMs)
      );


    /*
     * Gateway logging.
     */
    request.log.info(
      {
        request_id: requestId,

        method: request.method,

        route: path,

        upstream: upstreamUrl,

        status:
          upstreamResponse.status,

        latency_ms: latencyMs

      },
      'request proxied'
    );


    return reply.send(
      responseBody
    );

  } catch (error) {

    const latencyMs =
      Math.round(
        performance.now() - startedAt
      );


    const isTimeout =
      error instanceof Error &&
      error.name === 'AbortError';


    request.log.error(
      {
        request_id: requestId,

        method: request.method,

        route: path,

        upstream: upstreamUrl,

        latency_ms: latencyMs,

        error:
          error instanceof Error
            ? error.message
            : String(error)

      },
      'upstream request failed'
    );


    /*
     * 504 = upstream timeout
     *
     * 502 = gateway couldn't
     * communicate with upstream.
     */
    reply
      .code(
        isTimeout
          ? 504
          : 502
      )
      .header(
        'content-type',
        'application/json'
      )
      .header(
        'x-request-id',
        requestId
      );


    return reply.send({

      error:
        isTimeout
          ? 'upstream_timeout'
          : 'bad_gateway',

      message:
        isTimeout
          ? 'The upstream service did not respond in time.'
          : 'The gateway could not reach the upstream service.',

      request_id: requestId

    });

  }

});


/*
 * Start gateway.
 */
app.listen({
  host: '0.0.0.0',
  port: PORT

})
.then(() => {

  app.log.info(
    `MeterGate listening on http://localhost:${PORT}`
  );

  app.log.info(
    `Proxy target: ${UPSTREAM_URL}`
  );

})
.catch((error) => {

  app.log.error(error);

  process.exit(1);

});
