import { describe, expect, it, vi } from "vitest";
import { KEYMAP, KEYPAD_LAYOUT, bindKeyboard, isTextEntry, keyboardLabel } from "../src/input";

function keyEvent(type: "keydown" | "keyup", init: Record<string, unknown>): Event {
  return Object.assign(new Event(type, { cancelable: true }), init);
}

describe("keymap", () => {
  it("covers all 16 keys exactly once", () => {
    expect([...KEYPAD_LAYOUT].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, k) => k));
    expect(new Set(KEYMAP.values()).size).toBe(16);
  });

  it("maps 1234/QWER/ASDF/ZXCV onto the COSMAC VIP grid", () => {
    const rows = [
      ["Digit1", "Digit2", "Digit3", "Digit4"],
      ["KeyQ", "KeyW", "KeyE", "KeyR"],
      ["KeyA", "KeyS", "KeyD", "KeyF"],
      ["KeyZ", "KeyX", "KeyC", "KeyV"],
    ];
    const mapped = rows.map((row) => row.map((code) => KEYMAP.get(code)!.toString(16).toUpperCase()).join(""));
    expect(mapped).toEqual(["123C", "456D", "789E", "A0BF"]);
  });

  it("labels each keypad key with its keyboard key", () => {
    expect(keyboardLabel(0x1)).toBe("1");
    expect(keyboardLabel(0xc)).toBe("4");
    expect(keyboardLabel(0x4)).toBe("Q");
    expect(keyboardLabel(0x0)).toBe("X");
    expect(keyboardLabel(0xf)).toBe("V");
  });
});

describe("bindKeyboard", () => {
  function setup() {
    const target = new EventTarget();
    const down = vi.fn();
    const up = vi.fn();
    const unbind = bindKeyboard(target, { down, up });
    return { target, down, up, unbind };
  }

  it("sends mapped key presses and releases", () => {
    const { target, down, up } = setup();
    const press = keyEvent("keydown", { code: "KeyW" });
    target.dispatchEvent(press);
    target.dispatchEvent(keyEvent("keyup", { code: "KeyW" }));
    expect(down).toHaveBeenCalledWith(0x5);
    expect(up).toHaveBeenCalledWith(0x5);
    expect(press.defaultPrevented).toBe(true);
  });

  it("ignores unmapped keys and leaves them alone", () => {
    const { target, down } = setup();
    const e = keyEvent("keydown", { code: "KeyP" });
    target.dispatchEvent(e);
    expect(down).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("ignores auto-repeat", () => {
    const { target, down } = setup();
    target.dispatchEvent(keyEvent("keydown", { code: "KeyQ" }));
    target.dispatchEvent(keyEvent("keydown", { code: "KeyQ", repeat: true }));
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("leaves browser shortcuts alone", () => {
    const { target, down } = setup();
    target.dispatchEvent(keyEvent("keydown", { code: "KeyR", metaKey: true }));
    target.dispatchEvent(keyEvent("keydown", { code: "KeyR", ctrlKey: true }));
    target.dispatchEvent(keyEvent("keydown", { code: "KeyR", altKey: true }));
    expect(down).not.toHaveBeenCalled();
  });

  it("ignores typing in form fields", () => {
    const { target, down } = setup();
    // Event.target is read-only, so wrap the event to fake one.
    const e = keyEvent("keydown", { code: "KeyQ" });
    Object.defineProperty(e, "target", { value: { tagName: "SELECT" } });
    target.dispatchEvent(e);
    expect(down).not.toHaveBeenCalled();
  });

  it("unbinds", () => {
    const { target, down, unbind } = setup();
    unbind();
    target.dispatchEvent(keyEvent("keydown", { code: "KeyQ" }));
    expect(down).not.toHaveBeenCalled();
  });
});

describe("isTextEntry", () => {
  it.each([
    [{ tagName: "SELECT" }, true],
    [{ tagName: "TEXTAREA" }, true],
    [{ tagName: "INPUT", type: "text" }, true],
    [{ tagName: "INPUT", type: "number" }, true],
    [{ tagName: "INPUT" }, true],
    [{ tagName: "INPUT", type: "range" }, false],
    [{ tagName: "INPUT", type: "checkbox" }, false],
    [{ tagName: "BUTTON" }, false],
    [null, false],
    [{}, false],
  ])("%j -> %s", (el, expected) => {
    expect(isTextEntry(el as unknown as EventTarget)).toBe(expected);
  });
});
