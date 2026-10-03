/** Incremental JSONL framing without repeatedly copying large inline model requests. */
export class ArchiveLines {
  private parts: Buffer[] = [];
  private length = 0;

  /** Yield complete lines; retain a trailing fragment for the next read. */
  *push(input: Uint8Array): IterableIterator<Buffer> {
    // Readers may reuse their input buffer after this call.
    const bytes = Buffer.from(input);
    let start = 0;
    for (;;) {
      const end = bytes.indexOf(10, start);
      if (end === -1) break;
      const part = bytes.subarray(start, end);
      const line = this.parts.length ? Buffer.concat([...this.parts, part], this.length + part.length) : part;
      this.parts = [];
      this.length = 0;
      start = end + 1;
      yield line;
    }
    if (start < bytes.length) {
      const tail = bytes.subarray(start);
      this.parts.push(tail);
      this.length += tail.length;
    }
  }

  /** Exact unfinished tail, used only for crash quarantine. */
  tail(): Buffer { return Buffer.concat(this.parts, this.length); }
}
