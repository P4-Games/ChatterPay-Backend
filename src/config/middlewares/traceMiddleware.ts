import { randomUUID } from 'crypto';
import { get, Span, Tracer } from '@google-cloud/trace-agent';
import { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

/**
 * Middleware for tracing incoming requests with Google Cloud Trace.
 * - Ensures a valid X-Cloud-Trace-Context header is present.
 * - Creates a root span to trace the lifecycle of the request.
 * - Adds HTTP method, URL, and status code as labels to the span.
 * - Ends the span when the response is finished.
 *
 * @param {FastifyRequest} req - The incoming request object.
 * @param {FastifyReply} reply - The reply object.
 * @param {HookHandlerDoneFunction} done - Callback to signal Fastify to continue processing.
 */
export function traceMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  const tracer: Tracer = get();

  if (tracer) {
    // Ensure a valid X-Cloud-Trace-Context header
    let traceHeader = req.headers['x-cloud-trace-context'] as string | undefined;
    if (!traceHeader || !/^[a-f0-9]{32}\/\d+;o=\d+$/.test(traceHeader)) {
      const traceId = randomUUID().replace(/-/g, '').substring(0, 32);
      traceHeader = `${traceId}/0;o=1`;
      req.headers['x-cloud-trace-context'] = traceHeader; // Add to request headers
    }

    tracer.runInRootSpan(
      {
        name: `Incoming request: ${req.routerPath || req.url}`,
        traceContext: traceHeader
      },
      (rootSpan: Span | null) => {
        if (!rootSpan) {
          done();
          return;
        }

        rootSpan.addLabel('http/method', req.method);
        rootSpan.addLabel('http/url', req.url);

        reply.raw.on('finish', () => {
          rootSpan.addLabel('http/status_code', reply.statusCode);
          rootSpan.endSpan();
        });

        done();
      }
    );
  } else {
    done();
  }
}
