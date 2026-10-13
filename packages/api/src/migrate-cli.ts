import { createDb } from "./db.js";
import { migrateToLatest } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);
const applied = await migrateToLatest(db);
console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));
await db.destroy();
