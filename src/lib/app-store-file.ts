import { getStore, type Store } from "@tauri-apps/plugin-store";

/** Opened in Rust (`setup` in `lib.rs`); keep both lists in sync. */
export type StoreFile = "settings.json" | "session.json" | "folder-views.json" | "recents.json";

/**
 * One of the stores Rust opens at startup.
 * The frontend can't load store files itself (no `store:allow-load`, which
 * would reach any path), so it looks the open store up by name.
 */
export class AppStoreFile {
  private store: Promise<Store> | undefined;

  constructor(private readonly name: StoreFile) {}

  private open(): Promise<Store> {
    this.store ??= getStore(this.name).then((s) => {
      if (!s) throw new Error(`store ${this.name} is not open`);
      return s;
    });
    return this.store;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.open()).get<T>(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    await (await this.open()).set(key, value);
  }

  async onKeyChange<T>(key: string, cb: (value: T | undefined) => void): Promise<() => void> {
    return (await this.open()).onKeyChange<T>(key, cb);
  }
}
