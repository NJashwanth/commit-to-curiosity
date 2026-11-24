// Browser playground: a textarea editor with line numbers, a Run button, output and error
// panels, and a dropdown of example programs. It runs the same interpreter as the CLI.

import { CurioRuntimeError, CurioSyntaxError } from "./errors.js";
import { Interpreter } from "./interpreter.js";

import closures from "../examples/closures.curio?raw";
import fib from "../examples/fib.curio?raw";
import fizzbuzz from "../examples/fizzbuzz.curio?raw";
import quicksort from "../examples/quicksort.curio?raw";
import wordcount from "../examples/wordcount.curio?raw";

const EXAMPLES: { id: string; label: string; source: string }[] = [
  { id: "fizzbuzz", label: "FizzBuzz", source: fizzbuzz },
  { id: "fibonacci", label: "Fibonacci", source: fib },
  { id: "closures", label: "Closures", source: closures },
  { id: "quicksort", label: "Quicksort", source: quicksort },
  { id: "wordcount", label: "Word count", source: wordcount },
];

/** Stops endless loops from freezing the tab. */
const MAX_STEPS = 5_000_000;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const code = $<HTMLTextAreaElement>("code");
const gutter = $<HTMLElement>("gutter");
const output = $<HTMLElement>("output");
const errors = $<HTMLElement>("errors");
const select = $<HTMLSelectElement>("examples");
const runButton = $<HTMLButtonElement>("run");

output.dataset.empty = "Run a program to see what it prints.";
errors.dataset.empty = "No errors.";

function updateGutter(): void {
  const lines = code.value.split("\n").length;
  gutter.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n");
  gutter.scrollTop = code.scrollTop;
}

function run(): void {
  const source = code.value;
  let printed = "";
  output.textContent = "";
  errors.textContent = "";
  try {
    new Interpreter({ out: (t) => (printed += t), maxSteps: MAX_STEPS }).runSource(source);
  } catch (e) {
    if (e instanceof CurioSyntaxError || e instanceof CurioRuntimeError) {
      errors.textContent = e.format(source, "playground.curio");
    } else {
      errors.textContent = `Internal error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  output.textContent = printed;
}

function loadExample(id: string): void {
  const example = EXAMPLES.find((x) => x.id === id) ?? EXAMPLES[0]!;
  select.value = example.id;
  code.value = example.source;
  updateGutter();
  run();
  try {
    localStorage.setItem("curio-example", example.id);
  } catch {
    /* storage can be unavailable (private windows); the playground works without it */
  }
}

for (const x of EXAMPLES) select.add(new Option(x.label, x.id));

select.addEventListener("change", () => loadExample(select.value));
runButton.addEventListener("click", run);
code.addEventListener("input", updateGutter);
code.addEventListener("scroll", () => (gutter.scrollTop = code.scrollTop));
code.addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
    ev.preventDefault();
    run();
  } else if (ev.key === "Tab" && !ev.shiftKey) {
    // Keep focus in the editor and indent with two spaces.
    ev.preventDefault();
    code.setRangeText("  ", code.selectionStart, code.selectionEnd, "end");
    updateGutter();
  }
});

let initial = "closures";
try {
  initial = localStorage.getItem("curio-example") ?? initial;
} catch {
  /* ignore */
}
loadExample(initial);
