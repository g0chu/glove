/** Per-message gateway revisions protect asynchronous REST observations. */
export class MessageObservations {
  private readonly versions = new Map<string, number>();

  /** Mark a newer create, edit, reaction change, or deletion. */
  note(id: string): void {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
  }

  /** Fetch a complete message, discarding results and failures superseded by an event. */
  async fetch<T>(id: string, request: () => Promise<T>): Promise<T | null> {
    const version = this.versions.get(id);
    try {
      const result = await request();
      return this.versions.get(id) === version ? result : null;
    } catch (err) {
      if (this.versions.get(id) !== version) return null;
      throw err;
    }
  }
}
