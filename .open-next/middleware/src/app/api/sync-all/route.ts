import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createClient } from "@libsql/client";

function getTurso() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) throw new Error("TURSO env missing - .env check karo");
  return createClient({ url, authToken: token });
}

export async function GET() {
  try {
    const turso = getTurso();

    // 1. Turso pe tables banao
    await turso.execute(`CREATE TABLE IF NOT EXISTS sales_sync (id TEXT PRIMARY KEY, total REAL, created_at TEXT, branch TEXT)`);
    await turso.execute(`CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, size INTEGER, created_at TEXT)`);

    // 2. Local SQLite se sales lo (Al Madina ki sales)
    const localSales = await db.sale.findMany({ take: 100, orderBy: { createdAt: "desc" } }).catch(() => []);
    
    // 3. Turso pe push karo
    let pushed = 0;
    for (const s of localSales) {
      await turso.execute({
        sql: "INSERT OR REPLACE INTO sales_sync (id, total, created_at, branch) VALUES (?, ?, ?, ?)",
        args: [s.id, (s as any).total || 0, (s as any).createdAt?.toISOString() || new Date().toISOString(), "al-madina"]
      });
      pushed++;
    }

    // 4. Verify
    const check = await turso.execute("SELECT COUNT(*) as cnt FROM sales_sync");
    
    return NextResponse.json({ 
      success: true, 
      message: "Al Madina sync ho gaya!",
      localSalesFound: localSales.length,
      pushedToTurso: pushed,
      tursoTotal: (check.rows[0] as any).cnt,
      timestamp: new Date().toISOString()
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message, stack: e.stack }, { status: 500 });
  }
}
