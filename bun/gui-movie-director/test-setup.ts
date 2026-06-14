import { Window } from "happy-dom";
import { beforeEach, afterEach } from "bun:test";

// Set up a fresh DOM environment before each test
let window: Window;

beforeEach(() => {
  window = new Window({ url: "http://localhost:3099" });
  // @ts-ignore
  globalThis.window = window;
  // @ts-ignore
  globalThis.document = window.document;
  // @ts-ignore
  globalThis.navigator = window.navigator;
  // @ts-ignore
  globalThis.HTMLElement = window.HTMLElement;
  // @ts-ignore
  globalThis.HTMLDivElement = window.HTMLDivElement;
  // @ts-ignore
  globalThis.HTMLImageElement = window.HTMLImageElement;
  // @ts-ignore
  globalThis.customElements = window.customElements;
  // @ts-ignore
  globalThis.Node = window.Node;
  // @ts-ignore
  globalThis.DocumentFragment = window.DocumentFragment;
  // @ts-ignore
  globalThis.MouseEvent = window.MouseEvent;
  // @ts-ignore
  globalThis.KeyboardEvent = window.KeyboardEvent;
  // Keep Bun's native fetch/Request/Response — React components don't need DOM fetch
  // @ts-ignore
  globalThis.Blob = window.Blob;
  // @ts-ignore
  globalThis.File = window.File;
  // @ts-ignore
  globalThis.FileReader = window.FileReader;
  // @ts-ignore
  globalThis.FormData = window.FormData;
  // @ts-ignore
  globalThis.URL = window.URL;
  // @ts-ignore
  globalThis.location = window.location;
  // @ts-ignore
  globalThis.localStorage = window.localStorage;
  // @ts-ignore
  globalThis.sessionStorage = window.sessionStorage;
  // @ts-ignore
  globalThis.CustomEvent = window.CustomEvent;
  // @ts-ignore
  globalThis.Event = window.Event;
  // @ts-ignore
  globalThis.EventTarget = window.EventTarget;
  window.document.body.innerHTML = "";
});

afterEach(() => {
  window?.close();
});
