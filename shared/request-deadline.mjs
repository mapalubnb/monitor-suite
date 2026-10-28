// Avoid AbortSignal.any(): affected Node 22 versions retain aborted composites.
// The owner must dispose both the timer and the forwarding listener.
export function createDeadlineSignal(timeoutMs, parentSignal, message = '请求超过截止时间') {
  const controller = new AbortController();
  const forward = () => controller.abort(parentSignal.reason);
  const timer = setTimeout(() => controller.abort(new DOMException(message, 'TimeoutError')), timeoutMs);
  if (parentSignal?.aborted) forward();
  else parentSignal?.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', forward);
    },
  };
}

// Transport cancellation is advisory. Independently finish the logical request,
// including its body read, even if an implementation ignores abort forever.
export async function withDeadline(operation, timeoutMs, parentSignal, message) {
  const deadline = createDeadlineSignal(timeoutMs, parentSignal, message);
  try { return await withAbortSignal(operation, deadline.signal); }
  finally { deadline.dispose(); }
}

export async function withAbortSignal(operation, signal) {
  if (!signal) return operation();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(signal);
    });
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
