import './test-host.ts';
import { assertEquals } from './assert.ts';
import { getProfile } from './profiles.ts';
import { clientIp, quotaMessage, releaseSlot, resetSlots, skipQuota, takeSlot } from './quota.ts';

const now = Date.parse('2026-08-16T12:00:00Z');
const ip = '203.0.113.10';

Deno.test('skipQuota is true only for a loopback peer without CF', () => {
  const req = new Request('http://example.com/', { method: 'POST' });
  assertEquals(skipQuota('127.0.0.1', req), true);
  assertEquals(skipQuota('::1', req), true);
});

Deno.test('skipQuota ignores a localhost Host when the peer is not loopback', () => {
  const req = new Request('http://localhost:8002/', { method: 'POST' });
  assertEquals(skipQuota('8.8.8.8', req), false);
});

Deno.test('skipQuota is false for loopback behind Cloudflare', () => {
  const req = new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  });
  assertEquals(skipQuota('127.0.0.1', req), false);
});

Deno.test('clientIp uses the socket peer and ignores x-forwarded-for', () => {
  const req = new Request('http://example.com/', {
    headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' },
  });
  assertEquals(clientIp(ip, req), ip);
});

Deno.test('clientIp uses cf-connecting-ip only when the peer is loopback', () => {
  const req = new Request('http://example.com/', {
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '9.9.9.9' },
  });
  assertEquals(clientIp('127.0.0.1', req), '203.0.113.9');
  assertEquals(clientIp('198.51.100.2', req), '198.51.100.2');
});

Deno.test('takeSlot is one inflight and perDay on that profile', () => {
  resetSlots();
  const vinylator = getProfile('image');
  assertEquals(takeSlot(vinylator, ip, now), 'ok');
  assertEquals(takeSlot(vinylator, ip, now), 'busy');
  releaseSlot(vinylator, ip);
  assertEquals(takeSlot(vinylator, ip, now), 'ok');
  releaseSlot(vinylator, ip);
  takeSlot(vinylator, ip, now);
  releaseSlot(vinylator, ip);
  takeSlot(vinylator, ip, now);
  releaseSlot(vinylator, ip);
  assertEquals(takeSlot(vinylator, ip, now), 'quota');
});

Deno.test('profile quotas do not share a bucket', () => {
  resetSlots();
  const vinylator = getProfile('image');
  const mermaid = getProfile('chat');
  assertEquals(takeSlot(vinylator, ip, now), 'ok');
  releaseSlot(vinylator, ip);
  takeSlot(vinylator, ip, now);
  releaseSlot(vinylator, ip);
  takeSlot(vinylator, ip, now);
  releaseSlot(vinylator, ip);
  takeSlot(vinylator, ip, now);
  releaseSlot(vinylator, ip);
  assertEquals(takeSlot(vinylator, ip, now), 'quota');
  assertEquals(takeSlot(mermaid, ip, now), 'ok');
  releaseSlot(mermaid, ip);
});

Deno.test('quotaMessage names the profile handle', () => {
  assertEquals(quotaMessage(getProfile('image')), "Enjoying image? You've reached today's limit");
});
