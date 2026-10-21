import Fastify from 'fastify';

const app = Fastify({
  logger: true
});

const PORT = Number(process.env.PORT ?? 4000);


/*
 * Simple GET endpoint
 */
app.get('/hello', async (request) => {

  return {

    message:
      'Hello from the upstream API!',

    method:
      request.method,

    received_request_id:
      request.headers[
        'x-request-id'
      ] ?? null,

    gateway_header:
      request.headers[
        'x-metergate-request'
      ] ?? null,

    tenant_header_seen_by_upstream:
      request.headers[
        'x-tenant-id'
      ] ?? null

  };

});


/*
 * POST endpoint
 */
app.post('/echo', async (request) => {

  return {

    message:
      'POST reached the upstream through MeterGate',

    body:
      request.body,

    received_request_id:
      request.headers[
        'x-request-id'
      ] ?? null

  };

});


/*
 * Slow endpoint for testing
 * gateway timeout handling.
 */
app.get('/slow', async () => {

  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        7000
      )
  );

  return {

    message:
      'You should not normally see this before the gateway timeout.'

  };

});


/*
 * Allows us to test arbitrary
 * upstream HTTP status codes.
 *
 * Example:
 *
 * /status/404
 * /status/500
 * /status/418
 */
app.get(
  '/status/:code',
  async (
    request,
    reply
  ) => {

    const code =
      Number(
        (
          request.params as {
            code: string
          }
        ).code
      );


    return reply
      .code(code)
      .send({

        upstream_status:
          code

      });

  }
);


/*
 * Start mock API.
 */
app.listen({
  host: '0.0.0.0',
  port: PORT

})
.then(() => {

  app.log.info(
    `Mock upstream listening on http://localhost:${PORT}`
  );

})
.catch((error) => {

  app.log.error(error);

  process.exit(1);

});
