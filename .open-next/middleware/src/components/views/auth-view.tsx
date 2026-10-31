'use client'

import { useEffect, useState } from 'react'
import { useAuthStore, type AuthUser, type SubInfo } from '@/stores/auth'
import { api, errMsg, ApiClientError } from '@/lib/client'
import { matchOfflineLogin, rememberOfflineLogin, hasSavedOfflineLogin } from '@/lib/offline-auth'
import { applyTheme } from '@/stores/theme'
import { useT, applyDocumentLang } from '@/stores/lang'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Store, ShieldCheck, Wifi, WifiOff } from 'lucide-react'

const BIZ_TYPES = ['grocery', 'general_store', 'mini_mart', 'super_mart', 'convenience', 'kiryana']

export default function AuthView() {
  const { setSession, restoreOfflineSession } = useAuthStore()
  const t = useT()
  // The login screen honors the chosen language too (RTL incl.) — before sign-in.
  useEffect(() => { applyDocumentLang(t.lang) }, [t.lang])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [online, setOnline] = useState(true)

  // Real connection state for the badge. Task 60 — the login card no longer
  // lists "Saved on this device" accounts (removed at the user's request);
  // the device still keeps saved sign-ins internally so OFFLINE sign-in keeps
  // working — it just isn't advertised on the page anymore.
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // login
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPw, setLoginPw] = useState('')
  const [remember, setRemember] = useState(true)

  // register
  const [reg, setReg] = useState({ businessName: '', name: '', email: '', phone: '', password: '', bizType: 'grocery' })

  // forgot
  const [fpStep, setFpStep] = useState<'request' | 'reset'>('request')
  const [fpEmail, setFpEmail] = useState('')
  const [fpCode, setFpCode] = useState('')
  const [fpPw, setFpPw] = useState('')
  // Dev code shown when SMTP isn't configured — lets the user tap-to-fill.
  const [fpDevCode, setFpDevCode] = useState('')
  // Brief highlight of the Reset card when "Forgot password?" takes you there.
  const [flashReset, setFlashReset] = useState(false)

  const goToResetCard = () => {
    setError(''); setInfo('')
    // They usually just typed their email in the login form — carry it over.
    if (loginEmail && !fpEmail) setFpEmail(loginEmail)
    const el = document.getElementById('reset-card')
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFlashReset(true)
      setTimeout(() => setFlashReset(false), 2400)
      setTimeout(() => {
        (document.getElementById('reset-email') as HTMLInputElement | null)?.focus({ preventScroll: true })
      }, 500)
    }
  }

  // Login requests can hang instead of failing fast on flaky networks
  // (captive portals, half-open WiFi) — cap them so the offline path kicks in.
  const LOGIN_TIMEOUT_MS = 8000
  const reqSignal = (): AbortSignal | undefined => {
    try { return AbortSignal.timeout(LOGIN_TIMEOUT_MS) } catch { return undefined }
  }

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setInfo(''); setBusy(true)
    try {
      const data = await api<{ token: string; user: AuthUser; subscription: SubInfo | null }>('/api/auth/login', {
        method: 'POST', body: { email: loginEmail, password: loginPw, remember },
        signal: reqSignal(),
      })
      setSession(data)
      // Remember this sign-in so the device can sign in WITHOUT internet next
      // time (salted password hash + session snapshot, password never stored).
      try {
        const s = useAuthStore.getState()
        await rememberOfflineLogin(loginEmail, loginPw, {
          token: data.token,
          user: data.user,
          subscription: data.subscription ?? null,
          business: s.business,
          settings: s.settings,
        })
      } catch { /* best effort */ }
    } catch (err) {
      if (err instanceof ApiClientError) {
        // The server answered and refused — a real rejection.
        setError(errMsg(err))
      } else {
        // Network unreachable (or hung) → OFFLINE sign-in with credentials
        // this device has verified before.
        const snap = await matchOfflineLogin(loginEmail, loginPw).catch(() => null)
        if (snap) {
          restoreOfflineSession(snap)
          const theme = (snap.settings as { theme?: string } | undefined)?.theme
          if (theme) applyTheme(theme as never)
          setInfo(`Signed in offline as ${snap.user.name} — showing your data from the last online session. Everything updates automatically the moment internet returns.`)
        } else if (hasSavedOfflineLogin(loginEmail)) {
          setError('Incorrect password for the saved offline account on this device. Connect to the internet if you need to reset it.')
        } else {
          setError(
            'No internet right now, and this device has no saved sign-in for that email. '
            + 'Connect once and sign in — after that this device can sign in offline, even with no internet.'
          )
        }
      }
    } finally { setBusy(false) }
  }

  const doRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setInfo(''); setBusy(true)
    try {
      const data = await api<{ token: string; user: AuthUser }>('/api/auth/register', {
        method: 'POST', body: reg,
        signal: reqSignal(),
      })
      setSession(data)
      try {
        await rememberOfflineLogin(reg.email, reg.password, {
          token: data.token,
          user: data.user,
          subscription: null,
          business: null,
          settings: {},
        })
      } catch { /* best effort */ }
      setInfo('Welcome! Your 7-day free trial has started.')
    } catch (err) {
      if (err instanceof ApiClientError) setError(errMsg(err))
      else setError('Registering a new business needs internet. Already-registered devices keep working offline.')
    } finally { setBusy(false) }
  }

  const doForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setInfo(''); setBusy(true)
    try {
      if (fpStep === 'request') {
        const r = await api<{ message: string; devCode?: string; mailError?: string }>('/api/auth/forgot-password', { method: 'POST', body: { email: fpEmail } })
        if (r.devCode) {
          // Code could not be emailed — hand it to the user directly (honest about
          // why) and let them tap-to-fill it below.
          setFpDevCode(r.devCode)
          setInfo(r.mailError
            ? `We couldn't email the code — ${r.mailError} Meanwhile, here is your reset code: ${r.devCode}`
            : `Email delivery isn't set up on this server, so here is your reset code: ${r.devCode}`)
        } else {
          setFpDevCode('')
          setInfo(r.message)
        }
        setFpStep('reset')
      } else {
        const r = await api<{ message: string }>('/api/auth/reset-password', {
          method: 'POST', body: { email: fpEmail, code: fpCode, password: fpPw },
        })
        setInfo(`${r.message} You can sign in above.`)
        setFpStep('request')
        setFpDevCode('')
        setFpCode(''); setFpPw('')
        // Make "sign in" one step: carry the verified email into the login form.
        setLoginEmail(fpEmail)
      }
    } catch (err) {
      if (err instanceof ApiClientError) setError(errMsg(err))
      else setError('Password reset needs internet. Please connect and try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-dvh flex flex-col lg:flex-row">
      {/* Left brand panel */}
      <div className="hidden lg:flex lg:w-[42%] bg-sidebar text-sidebar-foreground flex-col justify-between p-10">
        <div className="flex items-center gap-3">
          <img src="/brand/logo-512.png" alt="SmartMart POS logo" className="h-14 w-14 rounded-2xl shadow-lg ring-1 ring-white/20" />
          <span className="text-xl font-bold">SmartMart POS</span>
        </div>
        <div className="space-y-6 max-w-md">
          <h2 className="text-3xl font-bold leading-tight">Run your grocery store like a pro — even without internet.</h2>
          <ul className="space-y-3 text-sm opacity-90">
            {[
              'Lightning-fast POS billing with barcode scanning',
              'Inventory, purchases & supplier management',
              'Khata / credit ledger with payment reminders',
              'Works offline — syncs automatically when online',
              'PDF / thermal receipts, Excel & CSV exports',
              '7 professional themes your staff will love',
            ].map(f => (
              <li key={f} className="flex items-start gap-2"><ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-sidebar-primary" />{f}</li>
            ))}
          </ul>
        </div>
        <div className="text-xs opacity-60">7-day free trial · No card required · PKR 3,000/month after trial</div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md space-y-4">
          <div className="flex items-center justify-between">
            <div className="lg:hidden flex items-center gap-2">
              <img src="/brand/logo-512.png" alt="SmartMart POS logo" className="h-9 w-9 rounded-lg shadow-sm" />
              <span className="font-bold">SmartMart POS</span>
            </div>
            <span className={`ml-auto flex items-center gap-1 text-[11px] font-semibold ${online ? 'text-emerald-600' : 'text-amber-600'}`}>
              {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {online ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
          {!online ? (
            <div className="text-[11px] text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-2.5 py-1.5 space-y-1.5">
              <p>
                {t('auth.offlineHint')}
              </p>
            </div>
          ) : null}

          <Tabs defaultValue="login">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="login">{t('auth.signIn')}</TabsTrigger>
              <TabsTrigger value="register">{t('auth.registerBiz')}</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{t('auth.welcomeBack')}</CardTitle>
                  <CardDescription>{t('auth.signInSub')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={doLogin} className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="login-email">{t('auth.email')}</Label>
                      <Input id="login-email" type="email" required placeholder="you@shop.com" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} autoComplete="email" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="login-pw">{t('auth.password')}</Label>
                      <PasswordInput id="login-pw" required value={loginPw} onChange={e => setLoginPw(e.target.value)} autoComplete="current-password" />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="accent-[var(--primary)]" />
                      {t('auth.remember')}
                    </label>
                    {/* Task 60 — no "Saved on this device" list here anymore
                        (removed at the user's request). Offline sign-in still
                        works by typing the same email + password. */}
                    {error ? <p className="text-sm text-red-600">{error}</p> : null}
                    {info ? <p className="text-sm text-emerald-600">{info}</p> : null}
                    <Button type="submit" className="w-full" disabled={busy}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Store className="h-4 w-4" />} {t('auth.signIn')}
                    </Button>
                    <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={goToResetCard}>
                      {t('auth.forgot')}
                    </button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="register">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{t('auth.createTitle')}</CardTitle>
                  <CardDescription>{t('auth.createSub')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={doRegister} className="space-y-3">
                    <div className="space-y-1.5">
                      <Label>{t('auth.bizName')}</Label>
                      <Input required placeholder="Al-Madina Mini Mart" value={reg.businessName} onChange={e => setReg({ ...reg, businessName: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>{t('auth.ownerName')}</Label>
                        <Input required placeholder="Ahmed Raza" value={reg.name} onChange={e => setReg({ ...reg, name: e.target.value })} />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('auth.phone')}</Label>
                        <Input placeholder="0300-1234567" value={reg.phone} onChange={e => setReg({ ...reg, phone: e.target.value })} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>{t('auth.email')}</Label>
                      <Input type="email" required placeholder="you@shop.com" value={reg.email} onChange={e => setReg({ ...reg, email: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>{t('auth.password')}</Label>
                        <PasswordInput required minLength={6} value={reg.password} onChange={e => setReg({ ...reg, password: e.target.value })} />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t('auth.bizType')}</Label>
                        <Select value={reg.bizType} onValueChange={v => setReg({ ...reg, bizType: v })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {BIZ_TYPES.map(bt => <SelectItem key={bt} value={bt} className="capitalize">{bt.replace('_', ' ')}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {error ? <p className="text-sm text-red-600">{error}</p> : null}
                    {info ? <p className="text-sm text-emerald-600">{info}</p> : null}
                    <Button type="submit" className="w-full" disabled={busy}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Store className="h-4 w-4" />} {t('auth.startTrial')}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Forgot password */}
          <Card id="reset-card" className={`transition-shadow ${flashReset ? 'ring-2 ring-amber-400 dark:ring-amber-500' : ''}`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t('auth.resetTitle')}</CardTitle>
              <CardDescription>{t('auth.resetSub')}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={doForgot} className="space-y-3">
                <div className="space-y-1.5">
                  <Label>{t('auth.acctEmail')}</Label>
                  <Input id="reset-email" type="email" required value={fpEmail} onChange={e => setFpEmail(e.target.value)} placeholder="you@shop.com" />
                </div>
                {fpStep === 'reset' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>{t('auth.resetCode')}</Label>
                      <Input required value={fpCode} onChange={e => setFpCode(e.target.value)} placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" />
                      {fpDevCode ? (
                        <button type="button" className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 underline" onClick={() => setFpCode(fpDevCode)}>
                          Use code {fpDevCode}
                        </button>
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      <Label>{t('auth.newPassword')}</Label>
                      <PasswordInput required minLength={6} value={fpPw} onChange={e => setFpPw(e.target.value)} />
                    </div>
                  </div>
                ) : null}
                {fpDevCode ? (
                  <p className="text-[11px] text-muted-foreground">
                    Want codes emailed instead? Platform owner: sign in, then open <b>Platform Owner Panel → Email</b> to connect a mailbox (Gmail app password).
                  </p>
                ) : null}
                {info ? <p className="text-xs text-emerald-600">{info}</p> : null}
                {error ? <p className="text-xs text-red-600">{error}</p> : null}
                <Button type="submit" variant="outline" size="sm" disabled={busy}>
                  {fpStep === 'request' ? t('auth.sendCode') : t('auth.setNewPw')}
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="text-center text-[11px] text-muted-foreground">
            <p>SmartMart POS — offline-first grocery billing</p>
          </div>
        </div>
      </div>
    </div>
  )
}
