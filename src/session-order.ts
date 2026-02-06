import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ORDER_FILE = path.join(os.homedir(), ".muxtunnel", "session-order.json");

let cachedOrder: string[] = [];

export function loadSessionOrder(): string[] {
  try {
    const raw = fs.readFileSync(ORDER_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      cachedOrder = parsed;
    } else {
      cachedOrder = [];
    }
  } catch {
    cachedOrder = [];
  }
  return cachedOrder;
}

export function getSessionOrder(): string[] {
  return cachedOrder;
}

export function saveSessionOrder(order: string[]): void {
  cachedOrder = order;
  try {
    fs.mkdirSync(path.dirname(ORDER_FILE), { recursive: true });
    fs.writeFileSync(ORDER_FILE, JSON.stringify(order, null, 2) + "\n");
  } catch (err) {
    console.error("[session-order] Failed to save:", err);
  }
}
