import { createDb } from "./db.js";
import { checkIntegrity } from "./integrity.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);
const report = await checkIntegrity(db);
console.log(JSON.stringify({ level: report.ok ? "info" : "error", msg: "integrity check", ...report }));
await db.destroy();
process.exit(report.ok ? 0 : 1);
