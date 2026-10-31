'use client'
export default function Page() {
  return (
    <div style={{padding:30, fontFamily:'monospace', whiteSpace:'pre-wrap'}}>
      <h2>ENV CHECK</h2>
      <p>NEXT_PUBLIC check: {process.env.NEXT_PUBLIC_TEST || 'not set'}</p>
      <button onClick={async()=>{
        const res = await fetch('/api/debug-env');
        const data = await res.json();
        alert(JSON.stringify(data, null, 2));
      }}>Check Server ENV</button>
    </div>
  )
}
