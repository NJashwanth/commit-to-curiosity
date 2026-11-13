/**
 * The COSMAC VIP hex keypad and its usual keyboard mapping. Physical key
 * positions (KeyboardEvent.code) are used, so the grid stays the same on
 * AZERTY or Dvorak layouts.
 *
 *   Keypad        Keyboard
 *   1 2 3 C       1 2 3 4
 *   4 5 6 D       Q W E R
 *   7 8 9 E       A S D F
 *   A 0 B F       Z X C V
 */
export const KEYPAD_LAYOUT: readonly number[] = [
  0x1, 0x2, 0x3, 0xc,
  0x4, 0x5, 0x6, 0xd,
  0x7, 0x8, 0x9, 0xe,
  0xa, 0x0, 0xb, 0xf,
];

const KEYBOARD_CODES = [
  "Digit1", "Digit2", "Digit3", "Digit4",
  "KeyQ", "KeyW", "KeyE", "KeyR",
  "KeyA", "KeyS", "KeyD", "KeyF",
  "KeyZ", "KeyX", "KeyC", "KeyV",
];

/** KeyboardEvent.code -> CHIP-8 key. */
export const KEYMAP: ReadonlyMap<string, number> = new Map(
  KEYBOARD_CODES.map((code, k) => [code, KEYPAD_LAYOUT[k]]),
);

/** The keyboard key printed on each keypad button, e.g. key 0x4 -> "Q". */
export function keyboardLabel(key: number): string {
  const code = KEYBOARD_CODES[KEYPAD_LAYOUT.indexOf(key)];
  return code.replace(/^(Digit|Key)/, "");
}

export interface KeyHandlers {
  down(key: number): void;
  up(key: number): void;
}

interface KeyLike {
  code: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

/** Keys typed into these elements belong to the element, not the emulator. */
export function isTextEntry(target: EventTarget | null | undefined): boolean {
  const el = target as { tagName?: string; type?: string } | null | undefined;
  if (!el?.tagName) return false;
  if (el.tagName === "SELECT" || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && ["text", "number", "search"].includes(el.type ?? "text");
}

/** Route mapped keys to the keypad. Returns a function that unbinds. */
export function bindKeyboard(target: EventTarget, handlers: KeyHandlers): () => void {
  const onKey = (event: Event) => {
    const e = event as unknown as KeyLike;
    if (e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
    const key = KEYMAP.get(e.code);
    if (key === undefined) return;
    e.preventDefault();
    if (event.type === "keydown") {
      if (!e.repeat) handlers.down(key);
    } else {
      handlers.up(key);
    }
  };
  target.addEventListener("keydown", onKey);
  target.addEventListener("keyup", onKey);
  return () => {
    target.removeEventListener("keydown", onKey);
    target.removeEventListener("keyup", onKey);
  };
}

/** Build the on-screen 4x4 keypad. Pointer events cover mouse, touch and pen. */
export function buildTouchKeypad(container: HTMLElement, handlers: KeyHandlers): HTMLButtonElement[] {
  const buttons: HTMLButtonElement[] = [];
  for (const key of KEYPAD_LAYOUT) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key";
    button.dataset.key = String(key);
    button.innerHTML = `<span class="key-hex">${key.toString(16).toUpperCase()}</span><span class="key-kbd">${keyboardLabel(key)}</span>`;
    button.setAttribute("aria-label", `Key ${key.toString(16).toUpperCase()}`);
    let held = false;
    const release = () => {
      if (!held) return;
      held = false;
      handlers.up(key);
    };
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      button.setPointerCapture?.(e.pointerId);
      held = true;
      handlers.down(key);
    });
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    button.addEventListener("contextmenu", (e) => e.preventDefault());
    container.append(button);
    buttons[key] = button;
  }
  return buttons;
}
