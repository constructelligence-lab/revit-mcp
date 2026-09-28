// The bridge's failure modes, against a scripted HTTP server. These messages are what a person sees when
// something is wrong at 8am before a meeting, so they are part of the interface and are tested as such.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Bridge, BridgeError, discoverToken } from '../bridge.mjs';

/** A fake add-in: records the last request and answers with whatever the test says. */
async function fakeAddin(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res, body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test('a call forwards the op, the args and the token, and returns the result', async () => {
  const addin = await fakeAddin((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { levels: 3 } }));
  });
  const bridge = new Bridge({ url: addin.url, token: 'secret-token' });

  const result = await bridge.call('levels.list', { limit: 10 });

  assert.deepEqual(result, { levels: 3 });
  assert.equal(addin.seen[0].url, '/op');
  assert.equal(addin.seen[0].headers.authorization, 'Bearer secret-token');
  assert.deepEqual(addin.seen[0].body, { op: 'levels.list', args: { limit: 10 } });
  await addin.close();
});

test('the add-in\'s own error keeps its code and message', async () => {
  const addin = await fakeAddin((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'No element with id 42 in this model.' } }));
  });
  const bridge = new Bridge({ url: addin.url });

  await assert.rejects(() => bridge.call('element.details', { element_id: 42 }), error => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'not_found');
    assert.match(error.message, /No element with id 42/);
    return true;
  });
  await addin.close();
});

test('a 401 names the token file, not just "unauthorized"', async () => {
  const addin = await fakeAddin((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { message: 'bad token' } }));
  });
  const bridge = new Bridge({ url: addin.url, token: 'wrong' });

  await assert.rejects(() => bridge.health(), error => {
    assert.equal(error.code, 'unauthorized');
    assert.match(error.message, /token/i);
    return true;
  });
  await addin.close();
});

test('a non-JSON answer is reported as such, with the status', async () => {
  const addin = await fakeAddin((req, res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>proxy error</html>'); });
  const bridge = new Bridge({ url: addin.url });

  await assert.rejects(() => bridge.health(), error => {
    assert.equal(error.code, 'bad_response');
    assert.equal(error.status, 502);
    return true;
  });
  await addin.close();
});

test('nothing listening says how to fix it, and mentions the mock', async () => {
  const bridge = new Bridge({ url: 'http://127.0.0.1:1' });

  await assert.rejects(() => bridge.health(), error => {
    assert.equal(error.code, 'unreachable');
    assert.match(error.message, /Revit/);
    assert.match(error.message, /--mock/);
    return true;
  });
});

test('a hung add-in times out with the modal-dialog explanation', async () => {
  const addin = await fakeAddin(() => { /* never answers: Revit's UI thread is blocked */ });
  const bridge = new Bridge({ url: addin.url, timeoutMs: 1000 });

  await assert.rejects(() => bridge.health(), error => {
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /modal dialog/i);
    return true;
  });
  await addin.close();
});

test('the token comes from the environment first', () => {
  assert.equal(discoverToken({ REVIT_MCP_TOKEN: '  from-env  ' }), 'from-env');
});
