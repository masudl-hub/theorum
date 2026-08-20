import { TheorumError } from './error.ts';

const HTTP_BAD = 400;
const HTTP_BUSY = 429;
const HTTP_ERR = 500;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function caughtStatus(err: unknown): number {
  if (err instanceof TheorumError) {
    return HTTP_BAD;
  }
  return HTTP_ERR;
}

export { caughtStatus, HTTP_BUSY, HTTP_METHOD, HTTP_NOT_FOUND, HTTP_OK, json };
