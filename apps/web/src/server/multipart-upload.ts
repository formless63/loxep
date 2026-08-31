/**
 * Shared, bounded multipart parsing for the HTTP upload routes.
 *
 * `Request.formData()` buffers file parts. Calling it directly therefore lets
 * a request with no (or a false) Content-Length consume unbounded memory
 * before the per-file `File.size` checks can run. This module puts a byte cap
 * in front of the parser: a declared oversize is rejected without touching
 * the body, while streamed/chunked bodies are counted as the parser reads.
 */

/** Room for multipart framing, filenames, and the small scalar fields. */
export const MULTIPART_METADATA_ALLOWANCE_BYTES = 256 * 1024;

export interface MultipartParseSuccess {
  ok: true;
  formData: FormData;
}

export interface MultipartParseFailure {
  ok: false;
  response: Response;
}

export type MultipartParseResult = MultipartParseSuccess | MultipartParseFailure;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function tooLargeResponse(): Response {
  return jsonResponse(413, {
    error: 'request-too-large',
    message: 'Upload request is too large'
  });
}

function invalidMultipartResponse(): Response {
  return jsonResponse(400, {
    error: 'invalid-request',
    message: 'Expected a multipart/form-data upload'
  });
}

function requestLimitForFileLimit(maxFileBytes: number): number {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new RangeError('maxFileBytes must be a positive safe integer');
  }
  return Math.min(Number.MAX_SAFE_INTEGER, maxFileBytes + MULTIPART_METADATA_ALLOWANCE_BYTES);
}

function declaredContentLengthExceeds(request: Request, maxBytes: number): boolean {
  const value = request.headers.get('content-length');
  if (value === null || !/^\d+$/u.test(value)) return false;
  return BigInt(value) > BigInt(maxBytes);
}

function cappedBodyStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): {
  stream: ReadableStream<Uint8Array>;
  exceeded: () => boolean;
  cancel: (reason?: unknown) => Promise<void>;
} {
  const reader = body.getReader();
  let bytesRead = 0;
  let didExceed = false;
  let didReleaseReader = false;
  let cancellation: Promise<void> | null = null;

  const releaseReader = () => {
    if (didReleaseReader) return;
    didReleaseReader = true;
    reader.releaseLock();
  };

  const cancel = (reason?: unknown): Promise<void> => {
    if (didReleaseReader) return Promise.resolve();
    cancellation ??= Promise.resolve()
      .then(() => reader.cancel(reason))
      .catch(() => undefined)
      .then(releaseReader);
    return cancellation;
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseReader();
          controller.close();
          return;
        }
        if (value === undefined) return;

        if (value.byteLength > maxBytes - bytesRead) {
          didExceed = true;
          await cancel('multipart request body exceeded its byte limit');
          controller.error(new Error('multipart request body exceeded its byte limit'));
          return;
        }

        bytesRead += value.byteLength;
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancel(reason);
    }
  });

  return { stream, exceeded: () => didExceed, cancel };
}

/**
 * Parse one upload request without allowing the FormData parser to observe
 * more than `maxFileBytes` plus a small, fixed multipart metadata allowance.
 * Existing handlers still enforce MIME type and exact per-file size after
 * parsing; this is the earlier request-level memory safety boundary.
 */
export async function parseLimitedMultipartFormData(
  request: Request,
  maxFileBytes: number
): Promise<MultipartParseResult> {
  const maxRequestBytes = requestLimitForFileLimit(maxFileBytes);
  if (declaredContentLengthExceeds(request, maxRequestBytes)) {
    return { ok: false, response: tooLargeResponse() };
  }

  if (request.body === null) {
    return { ok: false, response: invalidMultipartResponse() };
  }

  const contentType = request.headers.get('content-type');
  const capped = cappedBodyStream(request.body, maxRequestBytes);
  try {
    // Response and Request share the Fetch Body/FormData parser. Supplying
    // only the capped stream here ensures `formData()` can never consume the
    // uncapped original request body, including on chunked HTTP requests.
    const formData = await new Response(capped.stream, {
      headers: contentType === null ? undefined : { 'content-type': contentType }
    }).formData();
    return { ok: true, formData };
  } catch (error) {
    // A missing/wrong Content-Type can make formData() reject before it ever
    // consumes or cancels the supplied stream. Explicitly cancel our original
    // request reader so it is neither left locked nor allowed to keep flowing.
    await capped.cancel(error);
    return {
      ok: false,
      response: capped.exceeded() ? tooLargeResponse() : invalidMultipartResponse()
    };
  }
}
