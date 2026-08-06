// @ccshare/protocol — the single source of truth for every payload that crosses
// a boundary (DESIGN.md §3). Apps import from here; nobody redefines shapes.

export const PROTOCOL_VERSION = 1;

export * from "./broadcast";
export * from "./control";
export * from "./events";
export * from "./reducer";
