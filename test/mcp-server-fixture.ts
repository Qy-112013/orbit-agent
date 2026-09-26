// Minimal stdio MCP server for client tests: newline-delimited JSON-RPC over stdin/stdout.
import { createInterface } from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'Report selected environment variables', inputSchema: { type: 'object', properties: {} } },
  { name: 'grow', description: 'Add a tool and announce the change', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Exit the process', inputSchema: { type: 'object', properties: {} } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) => ({ content: [{ type: 'text', text: value }] });

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    process.stderr.write('fixture ready\n');
    return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1.0.0' } });
  }
  if (message.method === 'tools/list') {
    // Two pages exercise nextCursor handling.
    if (message.params?.cursor === 'page-2') return reply({ tools: tools.slice(2) });
    return reply({ tools: tools.slice(0, 2), nextCursor: 'page-2' });
  }
  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    if (name === 'echo') return reply({ ...text(`echo: ${args.text}`), structuredContent: { text: args.text } });
    if (name === 'fail') return reply({ ...text('fixture failure'), isError: true });
    if (name === 'env') return reply(text(JSON.stringify({ secret: process.env.ORBIT_FIXTURE_SECRET_KEY ?? null, explicit: process.env.FIXTURE_EXPLICIT ?? null })));
    if (name === 'grow') {
      tools.push({ name: 'late', description: 'Added at runtime', inputSchema: { type: 'object', properties: {} } });
      reply(text('grown'));
      return send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    if (name === 'crash') {
      process.stderr.write('fixture crashing on purpose\n');
      process.exit(3);
    }
    if (name === 'hang') return;
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
