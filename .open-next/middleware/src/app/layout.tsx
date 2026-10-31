import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SmartMart POS — Grocery & Mini Mart Management",
  description:
    "Offline-first POS, inventory, barcode, khata and reporting application for grocery shops, mini marts and convenience stores.",
  applicationName: "SmartMart POS",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "SmartMart POS" },
};

export const viewport: Viewport = {
  themeColor: "#0c59d8",
  width: "device-width",
  initialScale: 1,
  // maximumScale 1 stops iOS Safari auto-zooming the whole page when an input
  // is focused (the classic "POS zooms and doesn't fit on iPhone" bug).
  // Pinch-zoom stays available in Safari 10+; user-scalable is ignored there.
  maximumScale: 1,
  userScalable: false,
  // Android Chrome 108+: the on-screen keyboard RESIZES the layout viewport
  // instead of covering it — dvh areas and the POS quick-bar stay reachable.
  interactiveWidget: "resizes-content",
};

// Belt-and-suspenders hydration guard: browser extensions (Grammarly, Dark Reader,
// password managers...) inject attributes onto <html>/<body> before React hydrates,
// causing "server rendered HTML didn't match" console errors. This inline script runs
// during HTML parsing — before the React bundle hydrates — and strips those
// extension-injected attributes so the DOM matches the server HTML exactly.
const stripExtensionAttributes = `(function () {
  try {
    var strip = function (el) {
      if (!el || !el.attributes) return;
      var names = [];
      for (var i = 0; i < el.attributes.length; i++) names.push(el.attributes[i].name);
      for (var j = 0; j < names.length; j++) {
        var n = names[j];
        if (n.indexOf('data-gr-') === 0 || n.indexOf('data-new-gr-') === 0 || n === 'data-gr-ext-installed') {
          el.removeAttribute(n);
        }
      }
    };
    strip(document.documentElement);
    if (document.body) strip(document.body);
  } catch (e) {}
})();`;

// Task 45 — self-heal for stale code chunks. When an app update is deployed
// while a phone is offline or mid-session, screens can crash on missing
// chunks ("Failed to fetch dynamically imported module", Chrome; "Importing a
// module script failed", Safari) — the user saw this as "POS error, not open
// POS". This script — registered before ANY framework code via
// next/script beforeInteractive — detects those failures, wipes the stale
// caches and reloads ONCE so the device transparently lands on the new build.
// The sessionStorage guard keeps it to one repair attempt per minute (no
// reload loops when the server itself is down).
const selfHeal = `(function () {
  var KEY = 'sm-selfheal-at';
  function heal(reason) {
    try {
      var last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 60000) return;
      sessionStorage.setItem(KEY, String(Date.now()));
      var wipe = ('caches' in window)
        ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k) })) })
        : Promise.resolve();
      wipe.then(function () { console.warn('[self-heal] stale cache cleared — reloading:', reason); location.reload(); })
        .catch(function () { location.reload(); });
    } catch (e) { try { location.reload(); } catch (_) {} }
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) heal('resource:' + String(t.src || t.href || '').slice(-80));
  }, true);
  window.addEventListener('error', function (e) {
    var m = e && e.message ? String(e.message) : '';
    if (/chunk|dynamically imported module|Importing a module script failed|Loading CSS chunk/i.test(m)) heal('error:' + m.slice(0, 80));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var m = r ? String(r && r.message ? r.message : r) : '';
    if (/chunk|dynamically imported module|Importing a module script failed|Loading CSS chunk/i.test(m)) heal('rejection:' + m.slice(0, 80));
  });
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning data-theme="classic">
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <script dangerouslySetInnerHTML={{ __html: stripExtensionAttributes }} />
        <Script id="sm-selfheal" strategy="beforeInteractive">{selfHeal}</Script>
        {children}
        <Toaster />
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', function() {
  var hadController = !!navigator.serviceWorker.controller;
  var refreshing = false;
  // updateViaCache:'none' — the sw.js file itself must ALWAYS revalidate
  // (iOS PWAs can otherwise reuse a cached worker script for up to 24h and
  // keep running the previous app build after a deploy).
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(function(){});
  // Belt-and-suspenders: an explicit update check every 15 minutes plus one
  // every time the app comes back to the foreground (the moment iOS PWAs
  // are most likely to have skipped the automatic check).
  function swUpdate() {
    navigator.serviceWorker.getRegistration().then(function(r) {
      if (r && r.update) r.update().catch(function(){});
    }).catch(function(){});
  }
  setInterval(swUpdate, 15 * 60 * 1000);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') swUpdate();
  });
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    // A NEW service worker took over while an OLD one was controlling this
    // page (skipWaiting + clients.claim in sw.js make this immediate).
    // Reload once so the page actually runs the new bundle — phones no
    // longer stay stuck on an old cached version until the user closes
    // every tab. First-ever visit (no controller before) just claims quietly.
    if (!hadController || refreshing) return;
    refreshing = true;
    location.reload();
  });
  // Task 50 — iOS bfcache restore. When an iPhone suspends the PWA and later
  // re-shows it from the back/forward page cache, the ENTIRE page (old DOM +
  // old React state) is restored without executing a single line of JS, so
  // the screen can show yesterday's data. A persisted pageshow means the page
  // was frozen — reload once to land on live data. Guarded against loops.
  window.addEventListener('pageshow', function(e) {
    if (!e.persisted) return;
    try {
      var KEY = 'sm-bfrestore-at';
      var last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 30000) return;
      sessionStorage.setItem(KEY, String(Date.now()));
      console.warn('[bf-restore] page restored from cache — reloading for fresh data');
    } catch (err) { /* private mode — still reload */ }
    location.reload();
  });
}); }`,
          }}
        />
      </body>
    </html>
  );
}
