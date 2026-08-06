// @ccshare/protocol — the single source of truth for every payload that crosses
// a boundary (DESIGN.md §3). Apps import from here; nobody redefines shapes.

export const PROTOCOL_VERSION = 1;

export * from "./broadcast.js";
export * from "./control.js";
export * from "./events.js";
export * from "./reducer.js";
