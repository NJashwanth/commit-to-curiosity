import "./style.css";
import { DebuggerPanel } from "./debugger";
import { App } from "./ui";

const app = new App();
new DebuggerPanel(app);

// ?debug opens the debugger panel on load.
if (new URLSearchParams(location.search).has("debug")) {
  (document.getElementById("debugger") as HTMLDetailsElement).open = true;
}

// Handy from the browser console: inspect or poke the running machine.
(window as unknown as { chip8: App }).chip8 = app;
