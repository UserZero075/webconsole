export class NavigationHistory {
  constructor(limit = 200, onChange = () => {}) {
    this.limit = Math.max(2, limit);
    this.onChange = onChange;
    this.entries = [];
    this.index = -1;
  }

  record(entry) {
    if (!entry || typeof entry.workspaceId !== 'string' || typeof entry.tabId !== 'string') return;
    const clean = {
      workspaceId: entry.workspaceId,
      tabId: entry.tabId,
      path: String(entry.path || ''),
      anchor: Math.max(0, Number(entry.anchor) || 0),
      head: Math.max(0, Number(entry.head) || 0),
      scrollTop: Math.max(0, Number(entry.scrollTop) || 0),
      mode: entry.mode || 'code',
      recordedAt: Date.now(),
    };
    const current = this.entries[this.index];
    if (current && current.tabId === clean.tabId && current.anchor === clean.anchor && current.head === clean.head
        && current.mode === clean.mode) return;
    this.entries.splice(this.index + 1);
    this.entries.push(clean);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.index = this.entries.length - 1;
    this.onChange(this);
  }

  move(direction, isValid = () => true) {
    const step = direction < 0 ? -1 : 1;
    let candidate = this.index + step;
    while (candidate >= 0 && candidate < this.entries.length) {
      if (isValid(this.entries[candidate])) {
        this.index = candidate;
        this.onChange(this);
        return this.entries[candidate];
      }
      this.entries.splice(candidate, 1);
      if (candidate <= this.index) this.index -= 1;
      if (step < 0) candidate -= 1;
    }
    this.onChange(this);
    return null;
  }

  back(isValid) { return this.move(-1, isValid); }
  forward(isValid) { return this.move(1, isValid); }
  get canBack() { return this.index > 0; }
  get canForward() { return this.index >= 0 && this.index < this.entries.length - 1; }
}
