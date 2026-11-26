// Saved beats in localStorage. Browsers can refuse storage altogether (private
// windows, blocked cookies, a full quota) or hand back garbage, so every
// access is wrapped. When storage fails the store keeps working in memory for
// the rest of the session and says so, instead of throwing.
import { CodecError, decodeState, encodeState, hashToState } from "./url-codec";
import type { BeatState } from "./state";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SAVES_KEY = "beat-lab:saves:v1";
export const AUTOSAVE_KEY = "beat-lab:autosave:v1";
export const MAX_SAVES = 24;

/** The browser's localStorage, or null if even touching it throws. */
export function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface SavedBeat {
  name: string;
  savedAt: number;
  /** The beat in URL-codec form, which is far smaller than JSON. */
  data: string;
}

export interface SaveResult {
  ok: boolean;
  /** True when the beat reached real storage, false when it only lives in memory. */
  persisted: boolean;
  message: string;
}

export class BeatStore {
  private memory = new Map<string, string>();
  /** False once any storage call has failed. */
  persistent: boolean;

  constructor(private readonly storage: StorageLike | null = browserStorage()) {
    this.persistent = storage !== null;
  }

  private read(key: string): string | null {
    if (this.storage && this.persistent) {
      try {
        return this.storage.getItem(key);
      } catch {
        this.persistent = false;
      }
    }
    return this.memory.get(key) ?? null;
  }

  /** Returns true if the value reached real storage. */
  private write(key: string, value: string): boolean {
    this.memory.set(key, value);
    if (this.storage && this.persistent) {
      try {
        this.storage.setItem(key, value);
        return true;
      } catch {
        this.persistent = false;
      }
    }
    return false;
  }

  /** All saved beats, newest first. Corrupt storage reads as an empty list. */
  list(): SavedBeat[] {
    const raw = this.read(SAVES_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((e): e is SavedBeat => typeof e?.name === "string" && typeof e?.data === "string" && typeof e?.savedAt === "number")
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  }

  save(name: string, state: BeatState, now = Date.now()): SaveResult {
    const clean = name.trim().slice(0, 40);
    if (!clean) return { ok: false, persisted: false, message: "Give the beat a name first." };
    let data: string;
    try {
      data = encodeState(state);
    } catch (e) {
      return { ok: false, persisted: false, message: (e as Error).message };
    }
    const others = this.list().filter((b) => b.name !== clean);
    const next = [{ name: clean, savedAt: now, data }, ...others].slice(0, MAX_SAVES);
    const persisted = this.write(SAVES_KEY, JSON.stringify(next));
    return {
      ok: true,
      persisted,
      message: persisted ? `Saved "${clean}".` : `Saved "${clean}" for this session only: the browser would not store it. Use Share to keep a link.`,
    };
  }

  /** Load a saved beat by name, or null if it is missing or no longer decodes. */
  load(name: string): BeatState | null {
    const found = this.list().find((b) => b.name === name);
    if (!found) return null;
    try {
      return decodeState(found.data);
    } catch {
      return null;
    }
  }

  remove(name: string): void {
    this.write(SAVES_KEY, JSON.stringify(this.list().filter((b) => b.name !== name)));
  }

  autosave(state: BeatState): boolean {
    try {
      return this.write(AUTOSAVE_KEY, encodeState(state));
    } catch {
      return false;
    }
  }

  loadAutosave(): BeatState | null {
    const raw = this.read(AUTOSAVE_KEY);
    if (!raw) return null;
    try {
      return decodeState(raw);
    } catch {
      return null;
    }
  }
}

export interface Initial {
  state: BeatState;
  /** Where the beat came from, for a status line. */
  source: "link" | "autosave" | "fallback";
  /** Set when a link was present but could not be used. */
  error?: string;
}

/** Pick the starting beat: a share link wins, then the last autosave, then the fallback. */
export function chooseInitial(hash: string, store: BeatStore, fallback: () => BeatState): Initial {
  let error: string | undefined;
  try {
    const fromLink = hashToState(hash);
    if (fromLink) return { state: fromLink, source: "link" };
  } catch (e) {
    error = e instanceof CodecError ? e.message : "The link could not be read.";
  }
  const auto = store.loadAutosave();
  if (auto) return { state: auto, source: "autosave", error };
  return { state: fallback(), source: "fallback", error };
}
