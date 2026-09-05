export class RoomDispatchDrain {
  private active = false;
  private pending: Array<{
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  begin(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  isActive(): boolean {
    return this.active;
  }

  defer<T>(run: () => Promise<T>): Promise<T> {
    if (!this.active) return run();
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  release(): number {
    this.active = false;
    const pending = this.pending.splice(0);
    for (const item of pending) {
      void item.run().then(item.resolve, item.reject);
    }
    return pending.length;
  }

  pendingCount(): number {
    return this.pending.length;
  }
}
