import "dotenv/config";
import { getDb } from "./index";

const db = getDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("DB initialized. Tables:");
for (const t of tables as { name: string }[]) {
  console.log("  -", t.name);
}
