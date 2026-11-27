import { rgbaToInk } from "./preprocess";

/**
 * A drawing surface for mouse, touch and pen, built on pointer events (one code path for all three).
 * White strokes with round caps on black, like the MNIST digits it will be compared with.
 */
export class DrawingPad {
  onChange: (() => void) | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  private brush: number;
  private pointerId: number | null = null;
  private last: { x: number; y: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, brush = 18) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is not available in this browser");
    this.ctx = ctx;
    this.brush = brush;
    this.clear();
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      canvas.addEventListener(type, (e) => this.up(e as PointerEvent));
    }
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  setBrush(px: number): void {
    this.brush = px;
  }

  clear(): void {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.last = null;
    this.onChange?.();
  }

  /** Current drawing as ink values in [0, 1]. */
  snapshot(): { pixels: Float32Array; width: number; height: number } {
    const { width, height } = this.canvas;
    return { pixels: rgbaToInk(this.ctx.getImageData(0, 0, width, height).data), width, height };
  }

  /** Pointer position in canvas pixels, whatever size the canvas is displayed at. */
  private point(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * this.canvas.width) / r.width, y: ((e.clientY - r.top) * this.canvas.height) / r.height };
  }

  private down(e: PointerEvent): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.last = this.point(e);
    this.dot(this.last);
    this.onChange?.();
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) this.line(this.point(ev));
    this.onChange?.();
  }

  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.last = null;
  }

  private dot(p: { x: number; y: number }): void {
    this.ctx.fillStyle = "#fff";
    this.ctx.beginPath();
    this.ctx.arc(p.x, p.y, this.brush / 2, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private line(p: { x: number; y: number }): void {
    if (!this.last) {
      this.last = p;
      this.dot(p);
      return;
    }
    this.ctx.strokeStyle = "#fff";
    this.ctx.lineWidth = this.brush;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.beginPath();
    this.ctx.moveTo(this.last.x, this.last.y);
    this.ctx.lineTo(p.x, p.y);
    this.ctx.stroke();
    this.last = p;
  }
}
