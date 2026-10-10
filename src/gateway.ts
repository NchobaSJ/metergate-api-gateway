import Fastify from 'fastify';
import crypto from 'node:crypto';

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
