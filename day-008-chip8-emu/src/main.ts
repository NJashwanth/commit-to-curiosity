import "./style.css";
import { App } from "./ui";

const app = new App();

// Handy from the browser console: inspect or poke the running machine.
(window as unknown as { chip8: App }).chip8 = app;
