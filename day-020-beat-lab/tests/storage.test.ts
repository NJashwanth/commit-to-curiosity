import { describe, expect, it, vi } from "vitest";
import { PRESETS } from "../src/presets";
import { AUTOSAVE_KEY, BeatStore, MAX_SAVES, SAVES_KEY, browserStorage, chooseInitial, type StorageLike } from "../src/storage";
import { createDefaultState } from "../src/state";
import { stateToHash } from "../src/url-codec";

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}
/** Storage where every call throws, like a browser with storage blocked. */
const broken = (): StorageLike => ({
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new DOMException("quota", "QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("nope");
  },
});

const beat = () => PRESETS[0].state;

describe("saving and loading", () => {
  it("saves, lists newest first, and loads exactly", () => {
    const store = new BeatStore(new MemStorage());
    expect(store.list()).toEqual([]);
    expect(store.save("first", PRESETS[0].state, 1000).persisted).toBe(true);
    store.save("second", PRESETS[1].state, 2000);
    expect(store.list().map((b) => b.name)).toEqual(["second", "first"]);
    expect(store.load("first")).toEqual(PRESETS[0].state);
    expect(store.load("second")).toEqual(PRESETS[1].state);
    expect(store.load("nope")).toBeNull();
  });
  it("replaces a beat saved under the same name", () => {
    const store = new BeatStore(new MemStorage());
    store.save("x", PRESETS[0].state, 1);
    store.save("  x ", PRESETS[2].state, 2);
    expect(store.list()).toHaveLength(1);
    expect(store.load("x")).toEqual(PRESETS[2].state);
  });
  it("needs a name and trims and caps it", () => {
    const store = new BeatStore(new MemStorage());
    expect(store.save("   ", beat())).toMatchObject({ ok: false });
    store.save("a".repeat(100), beat());
    expect(store.list()[0].name).toHaveLength(40);
  });
  it("keeps only the newest MAX_SAVES beats", () => {
    const store = new BeatStore(new MemStorage());
    for (let i = 0; i < MAX_SAVES + 5; i++) store.save(`b${i}`, beat(), i);
    expect(store.list()).toHaveLength(MAX_SAVES);
    expect(store.list()[0].name).toBe(`b${MAX_SAVES + 4}`);
  });
  it("removes a beat", () => {
    const store = new BeatStore(new MemStorage());
    store.save("a", beat(), 1);
    store.save("b", beat(), 2);
    store.remove("a");
    expect(store.list().map((b) => b.name)).toEqual(["b"]);
  });
  it("refuses to save an invalid beat", () => {
    const store = new BeatStore(new MemStorage());
    const bad = createDefaultState();
    bad.tempo = 1;
    const r = store.save("bad", bad);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/invalid beat/);
    expect(store.list()).toEqual([]);
  });
  it("autosaves and restores", () => {
    const store = new BeatStore(new MemStorage());
    expect(store.loadAutosave()).toBeNull();
    expect(store.autosave(PRESETS[3].state)).toBe(true);
    expect(store.loadAutosave()).toEqual(PRESETS[3].state);
    const bad = createDefaultState();
    bad.swing = 99;
    expect(store.autosave(bad)).toBe(false);
  });
});

describe("storage failures fall back gracefully", () => {
  it("works in memory when every storage call throws", () => {
    const store = new BeatStore(broken());
    expect(store.persistent).toBe(true);
    const r = store.save("kept", beat(), 5);
    expect(r.ok).toBe(true);
    expect(r.persisted).toBe(false);
    expect(r.message).toMatch(/this session only/);
    expect(store.persistent).toBe(false);
    expect(store.list().map((b) => b.name)).toEqual(["kept"]);
    expect(store.load("kept")).toEqual(beat());
    expect(store.autosave(beat())).toBe(false);
    expect(store.loadAutosave()).toEqual(beat());
    store.remove("kept");
    expect(store.list()).toEqual([]);
  });
  it("survives a throwing getItem", () => {
    const store = new BeatStore(broken());
    expect(store.list()).toEqual([]);
    expect(store.loadAutosave()).toBeNull();
    expect(store.persistent).toBe(false);
  });
  it("works with no storage at all", () => {
    const store = new BeatStore(null);
    expect(store.persistent).toBe(false);
    expect(store.save("a", beat()).persisted).toBe(false);
    expect(store.list()).toHaveLength(1);
  });
  it("browserStorage returns null when localStorage access throws", () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(browserStorage()).toBeNull();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    expect(browserStorage()).toBeNull();
    if (orig) Object.defineProperty(globalThis, "localStorage", orig);
    else delete (globalThis as Record<string, unknown>).localStorage;
  });
  it("browserStorage returns the real thing when present", () => {
    const mem = new MemStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: mem });
    expect(browserStorage()).toBe(mem);
    delete (globalThis as Record<string, unknown>).localStorage;
  });
});

describe("corrupt stored data", () => {
  const withRaw = (raw: string | null) => {
    const m = new MemStorage();
    if (raw !== null) m.setItem(SAVES_KEY, raw);
    return new BeatStore(m);
  };
  it("reads garbage as an empty list", () => {
    expect(withRaw("{not json").list()).toEqual([]);
    expect(withRaw('{"a":1}').list()).toEqual([]);
    expect(withRaw("42").list()).toEqual([]);
  });
  it("skips malformed entries but keeps good ones", () => {
    const good = new BeatStore(new MemStorage());
    good.save("good", beat(), 9);
    const data = good.list()[0].data;
    const store = withRaw(JSON.stringify([{ name: 1 }, null, { name: "ok", data, savedAt: 3 }, { name: "x", data: 5, savedAt: 1 }]));
    expect(store.list().map((b) => b.name)).toEqual(["ok"]);
  });
  it("returns null for a saved beat whose data no longer decodes", () => {
    const store = withRaw(JSON.stringify([{ name: "old", data: "AAAA", savedAt: 1 }]));
    expect(store.load("old")).toBeNull();
  });
  it("ignores a corrupt autosave", () => {
    const m = new MemStorage();
    m.setItem(AUTOSAVE_KEY, "garbage!!");
    expect(new BeatStore(m).loadAutosave()).toBeNull();
  });
});

describe("chooseInitial", () => {
  const fallback = () => PRESETS[3].state;
  it("prefers a share link", () => {
    const store = new BeatStore(new MemStorage());
    store.autosave(PRESETS[1].state);
    const r = chooseInitial(stateToHash(PRESETS[2].state), store, fallback);
    expect(r.source).toBe("link");
    expect(r.state).toEqual(PRESETS[2].state);
  });
  it("then the autosave", () => {
    const store = new BeatStore(new MemStorage());
    store.autosave(PRESETS[1].state);
    const r = chooseInitial("", store, fallback);
    expect(r.source).toBe("autosave");
    expect(r.state).toEqual(PRESETS[1].state);
  });
  it("then the fallback", () => {
    const r = chooseInitial("#unrelated", new BeatStore(new MemStorage()), fallback);
    expect(r.source).toBe("fallback");
    expect(r.error).toBeUndefined();
  });
  it("reports a corrupt link and still starts", () => {
    const store = new BeatStore(new MemStorage());
    const r = chooseInitial("#b=AAAA", store, fallback);
    expect(r.source).toBe("fallback");
    expect(r.error).toMatch(/link/i);
  });
  it("a corrupt link falls back to the autosave and still reports the error", () => {
    const store = new BeatStore(new MemStorage());
    store.autosave(PRESETS[0].state);
    const r = chooseInitial("#b=!!!", store, fallback);
    expect(r.source).toBe("autosave");
    expect(r.error).toBeTruthy();
  });
  it("copes with storage that is blocked", () => {
    const spy = vi.fn(fallback);
    const r = chooseInitial("", new BeatStore(broken()), spy);
    expect(r.source).toBe("fallback");
    expect(spy).toHaveBeenCalled();
  });
});
