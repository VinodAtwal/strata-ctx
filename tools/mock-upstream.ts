import { createServer } from 'node:http';

/**
 * A mock provider (A-11).
 *
 * Exists so the gateway, the eval harness and the CI contract can all be tested
 * without an API key, without network access, and -- more usefully -- with a
 * *known* token count. Every cost number strata-ctx claims has to be
 * attributable, and you cannot attribute cost to a provider that does not
 * report it.
 *
 * It echoes back what it received, so a round trip through the gateway is
 * visible: if a constraint disappears between agent and provider, it shows up
 * in the echo.
 */

export interface MockOptions {
  readonly port: number;
  /** Report usage in the Anthropic shape so adapters are exercised honestly. */
  readonly reportUsage?: boolean;
  readonly stream?: boolean;
}

const countTokens = (s: string): number => Math.ceil(s.length / 4);

const bodyText = (body: Record<string, unknown>): string => JSON.stringify(body);

export function startMockProvider(opts: MockOptions) {
  const received: { count: number; bytes: number; last: unknown } = {
    count: 0,
    bytes: 0,
    last: null,
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/__mock/stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(received));
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad json' }));
        return;
      }

      received.count += 1;
      received.bytes += raw.length;
      received.last = body;

      const inputTokens = countTokens(raw);

      if (opts.stream !== false && body.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        const frames = [
          { type: 'message_start', message: { id: 'msg_mock', role: 'assistant', usage: { input_tokens: inputTokens, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mock reply' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 4 },
          },
          { type: 'message_stop' },
        ];
        for (const f of frames) res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: body.model ?? 'mock',
          content: [{ type: 'text', text: 'mock reply', ...(opts.reportUsage === false ? {} : {}) }],
          stop_reason: 'end_turn',
          // The echo is the point: whatever the gateway forwarded is what the
          // provider received, verbatim and inspectable.
          _echo: body,
          ...(opts.reportUsage === false ? {} : { usage: { input_tokens: inputTokens, output_tokens: 4 } }),
        }),
      );
    });
  });

  server.listen(opts.port, '127.0.0.1');
  return { server, received, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

export { bodyText };
