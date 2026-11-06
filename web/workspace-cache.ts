export type FileInfo = {path: string; sha: string; size: number};
export type Workspace = {head: string; base: string; shared: string; files: FileInfo[]};
type SavedFile = {content: string; sha: string};

// Bound storage per account and evict the oldest opened file first.
const MAX_CACHE_LENGTH = 1_000_000;

export class WorkspaceCache {
  private readonly key: string;
  private readonly files = new Map<string, SavedFile>();
  workspace?: Workspace;
  lastPath = '';

  constructor(account: string) {
    this.key = 'xq-workspace-v1:' + account;
    try {
      const stored = JSON.parse(localStorage.getItem(this.key) || 'null');
      if (!stored || typeof stored.workspace?.head !== 'string' || !Array.isArray(stored.workspace.files)
        || !stored.workspace.files.every((file: FileInfo) => typeof file?.path === 'string' && typeof file.sha === 'string')
        || !Array.isArray(stored.files)) return;
      this.workspace = stored.workspace;
      this.lastPath = typeof stored.lastPath === 'string' ? stored.lastPath : '';
      for (const [path, file] of stored.files) {
        if (typeof path === 'string' && typeof file?.sha === 'string' && typeof file?.content === 'string') {
          this.files.set(path, file);
        }
      }
    } catch { /* A missing or unreadable cache falls back to the server. */ }
  }

  file(path: string, sha: string | undefined): SavedFile | undefined {
    const cached = this.files.get(path);
    if (cached && cached.sha === sha) return cached;
  }

  rememberFile(path: string, file: SavedFile) {
    this.files.delete(path);
    this.files.set(path, {sha: file.sha, content: file.content});
    this.persist();
  }

  select(path: string) {
    this.lastPath = path;
    const file = this.files.get(path);
    if (file) {
      this.files.delete(path);
      this.files.set(path, file);
    }
    this.persist();
  }

  persist() {
    if (!this.workspace) return;
    const serialize = () => JSON.stringify({workspace: this.workspace, lastPath: this.lastPath, files: [...this.files]});
    let value = serialize();
    while (value.length > MAX_CACHE_LENGTH && this.files.size) {
      this.files.delete(this.files.keys().next().value!);
      value = serialize();
    }
    try {
      if (value.length <= MAX_CACHE_LENGTH) localStorage.setItem(this.key, value);
    } catch { /* Browsing and syncing still work when local storage is full. */ }
  }

  clear() {
    this.files.clear();
    this.workspace = undefined;
    this.lastPath = '';
    try { localStorage.removeItem(this.key); } catch { /* Storage may be disabled. */ }
  }
}
