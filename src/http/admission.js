// Reserve independently for data and management so a slow data client cannot
// consume the recovery endpoint. Byte budgets cover buffered input and tool
// result text; they are not estimates of V8's total heap.
export const DEFAULT_CONCURRENCY = 8;
const MiB = 1024 * 1024;
export function httpAdmission(settings) {
  let ordinary = 0,
    admin = 0,
    bodyBytes = 0,
    resultBytes = 0;
  return (management) => {
    if (management ? admin >= 2 : ordinary >= (settings.maxConcurrent ?? DEFAULT_CONCURRENCY))
      return;
    if (management) admin++;
    else ordinary++;
    let input = 0,
      output = 0;
    return {
      takeBody(bytes) {
        if (management) return true; // separate, fixed 16 KiB per admin request
        if (bodyBytes + bytes > Math.max(32 * MiB, settings.maxBodyBytes)) return false;
        bodyBytes += bytes;
        input += bytes;
        return true;
      },
      takeResult(maxResponseBytes = 8 * MiB) {
        // Allow envelopes and base64 encoding while bounding combined live outputs.
        const limit = Math.max(256 * 1024, 2 * maxResponseBytes);
        if (resultBytes + limit > 128 * MiB) return 0;
        resultBytes += limit;
        output = limit;
        return limit;
      },
      release() {
        bodyBytes -= input;
        resultBytes -= output;
        if (management) admin--;
        else ordinary--;
      },
    };
  };
}
