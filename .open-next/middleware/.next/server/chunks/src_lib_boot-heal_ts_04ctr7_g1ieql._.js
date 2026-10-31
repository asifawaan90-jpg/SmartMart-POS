module.exports=[94662,e=>{"use strict";var t=e.i(22734),s=e.i(14747),n=e.i(33405);let a=s.default.join(process.cwd(),"backups"),o=s.default.join(process.cwd(),"db","custom.db"),i=s.default.join(a,"HEAL.log");function r(e){let s=`${new Date().toISOString()} ${e}`;try{console.log("[boot-heal]",e)}catch{}try{t.default.appendFileSync(i,s+"\n")}catch{}}function l(e){let t=`
import json, sqlite3
db = sqlite3.connect(${JSON.stringify(e)})
out = {"ok": True}
try:
    out["businesses"] = db.execute("SELECT COUNT(*) FROM Business").fetchone()[0]
    out["sales"] = db.execute("SELECT COUNT(*) FROM Sale").fetchone()[0]
    out["rows"] = [{"name": r[0], "email": (r[1] or "").lower()} for r in
                   db.execute("SELECT name, email FROM Business")]
except Exception as e:
    out = {"ok": False, "error": str(e)}
print(json.dumps(out))
`;return JSON.parse((0,n.execFileSync)("python3",["-c",t],{encoding:"utf8",timeout:2e4}).trim().split("\n").at(-1))}e.s(["bootHeal",0,function(){try{if(!t.default.existsSync(o))return void r("no database file yet — nothing to heal");let e=t.default.statSync(o),n=(Date.now()-e.birthtimeMs)/6e4,i=(Date.now()-e.mtimeMs)/6e4;if(!(20>Math.min(n,i)))return;let u=function(){try{let e=t.default.readdirSync(a).filter(e=>/^custom-\d{8}-\d{6}\.db$/.test(e)).sort();return e.length?s.default.join(a,e[e.length-1]):null}catch{return null}}();if(!u)return void r("db file is fresh but no snapshot exists — nothing to restore");let d=l(o);if(!d.ok)return void r(`current db unreadable (${d.error}) — leaving it for the app to report`);let c=l(u);if(!c.ok)return void r(`snapshot unreadable, refusing to heal: ${c.error}`);let f=new Set([...d.rows.map(e=>e.email),...d.rows.map(e=>e.name.toLowerCase())]),h=c.rows.filter(e=>e.email&&!f.has(e.email)||!e.email&&!f.has(e.name.toLowerCase()));if(0===h.length)return void r(`fresh db but no businesses missing vs ${s.default.basename(u)} (db=${d.businesses}, snapshot=${c.businesses}) — no heal needed`);let b=`${o}.preheal-${Date.now()}`,m=`${o}.healing-${Date.now()}`;t.default.copyFileSync(o,b),t.default.copyFileSync(u,m);let p=l(m);if(!p.ok||p.businesses<c.businesses){try{t.default.unlinkSync(m)}catch{}r("snapshot failed re-verification — aborting heal, current db untouched");return}t.default.renameSync(m,o),r(`HEALED: db was fresh/empty (age ${n.toFixed(1)}min, ${d.businesses} businesses, ${d.sales} sales) — restored ${s.default.basename(u)} (${p.businesses} businesses, ${p.sales} sales). Missing businesses that triggered the heal: ${h.slice(0,5).map(e=>e.name).join(", ")}${h.length>5?` +${h.length-5} more`:""}. Previous file kept as ${s.default.basename(b)}`)}catch(e){r(`heal skipped due to error: ${e.message}`)}}])}];

//# sourceMappingURL=src_lib_boot-heal_ts_04ctr7_g1ieql._.js.map