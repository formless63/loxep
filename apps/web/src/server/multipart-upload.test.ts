import { describe, expect, test } from 'bun:test';
import {
  MULTIPART_METADATA_ALLOWANCE_BYTES,
  parseLimitedMultipartFormData
} from './multipart-upload.ts';

const BOUNDARY = 'loxep-test-boundary';

function multipartBody(fileBytes: number): Uint8Array {
  const prefix =
    `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="upload.png"\r\n' +
    'Content-Type: image/png\r\n\r\n';
  const suffix = `\r\n--${BOUNDARY}--\r\n`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const suffixBytes = new TextEncoder().encode(suffix);
  const body = new Uint8Array(prefixBytes.byteLength + fileBytes + suffixBytes.byteLength);
  body.set(prefixBytes);
  body.fill(1, prefixBytes.byteLength, prefixBytes.byteLength + fileBytes);
  body.set(suffixBytes, prefixBytes.byteLength + fileBytes);
  return body;
}

function requestForBody(
  body: BodyInit | Uint8Array,
  options: { contentLength?: number; contentType?: string } = {}
): Request {
  const headers = new Headers({
    'content-type': options.contentType ?? `multipart/form-data; boundary=${BOUNDARY}`
  });
  if (options.contentLength !== undefined) {
    headers.set('content-length', String(options.contentLength));
  }
  return new Request('http://loxep.test/api/upload', {
    method: 'POST',
    headers,
    body: body as BodyInit
  });
}

describe('parseLimitedMultipartFormData', () => {
  test('rejects an oversized Content-Length before touching the body or formData parser', async () => {
    const request = requestForBody(new Uint8Array([1]), {
      contentLength: 1 + MULTIPART_METADATA_ALLOWANCE_BYTES + 1
    });
    let bodyReads = 0;
    let formDataCalls = 0;
    Object.defineProperty(request, 'body', {
      configurable: true,
      get() {
        bodyReads += 1;
        throw new Error('body must not be inspected on the header fast-reject path');
      }
    });
    request.formData = () => {
      formDataCalls += 1;
      throw new Error('formData must not run on the header fast-reject path');
    };

    const result = await parseLimitedMultipartFormData(request, 1);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the request to be rejected');
    expect(result.response.status).toBe(413);
    expect(await result.response.json()).toEqual({
      error: 'request-too-large',
      message: 'Upload request is too large'
    });
    expect(bodyReads).toBe(0);
    expect(formDataCalls).toBe(0);
  });

  test('caps a streamed body when Content-Length is absent', async () => {
    const body = multipartBody(MULTIPART_METADATA_ALLOWANCE_BYTES + 2);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 16 * 1024, body.byteLength);
        controller.enqueue(body.slice(offset, end));
        offset = end;
      }
    });

    const result = await parseLimitedMultipartFormData(requestForBody(stream), 1);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the request to be rejected');
    expect(result.response.status).toBe(413);
  });

  test('parses a valid multipart body through the capped stream', async () => {
    const body = multipartBody(5);
    const result = await parseLimitedMultipartFormData(requestForBody(body), 5);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the request to parse');
    const file = result.formData.get('file');
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error('expected a file part');
    expect(file.size).toBe(5);
    expect(file.type).toBe('image/png');
  });

  test('cancels and releases the request body when the parser rejects before consuming', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      }
    });
    const request = {
      headers: new Headers({ 'content-type': 'text/plain' }),
      body
    } as Request;
    const result = await parseLimitedMultipartFormData(request, 1024);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the request to be rejected');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      error: 'invalid-request',
      message: 'Expected a multipart/form-data upload'
    });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});
