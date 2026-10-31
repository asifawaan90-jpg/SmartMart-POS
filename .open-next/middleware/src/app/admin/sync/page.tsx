"use client";
import { useState } from "react";
export default function SyncPage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  async function doSync() {
    setLoading(true);
    try {
      const res = await fetch("/api/sync-everything", { method: "POST" });
      const data = await res.json();
      setResult(data);
    } catch(e:any) { setResult({ success:false, error:e.message }); }
    setLoading(false);
  }
  return (
    <div style={{ padding: 40, fontFamily: "sans-serif", maxWidth: 600, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, fontWeight: "bold" }}>Al Madina - ALL IN ONE Sync</h1>
      <p>Ek click me Sales + Backup Turso pe jayega</p>
      <button onClick={doSync} disabled={loading} style={{ marginTop: 20, padding: "15px 30px", fontSize: 18, background: loading ? "gray" : "green", color: "white", border: 0, borderRadius: 10, cursor: "pointer", width: "100%" }}>
        {loading ? "Sync ho raha hai..." : "?? ABHI SYNC KARO"}
      </button>
      {result && <pre style={{ marginTop: 20, background: "#f5f5f5", padding: 15, borderRadius: 10, overflow: "auto" }}>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
