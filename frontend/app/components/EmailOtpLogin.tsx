'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../utils/supabase'
import { completeLogin } from '../utils/postLogin'

const RESEND_COOLDOWN_SECONDS = 60
const CODE_LENGTH = 6

export default function EmailOtpLogin() {
  const router = useRouter()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const sendCode = async () => {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { shouldCreateUser: true },
    })
    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    setEmail(trimmed)
    setCode('')
    setStep('code')
    setCooldown(RESEND_COOLDOWN_SECONDS)
  }

  const verifyCode = async (token: string) => {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    })
    if (error || !data.user) {
      setLoading(false)
      setError(error?.message || 'Invalid or expired code')
      setCode('')
      return
    }
    await completeLogin(data.user)
    router.push('/dashboard')
  }

  const onCodeChange = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, CODE_LENGTH)
    setCode(digits)
    if (digits.length === CODE_LENGTH && !loading) {
      void verifyCode(digits)
    }
  }

  const inputClass =
    'w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-[#8302AE] focus:outline-none focus:ring-1 focus:ring-[#8302AE] disabled:opacity-60'
  const primaryButtonClass =
    'w-full rounded-md bg-[#8302AE] px-4 py-2 text-sm font-medium text-white hover:bg-[#6a4bc4] transition-colors disabled:opacity-50 disabled:pointer-events-none'

  return (
    <div className="w-[250px] space-y-2">
      {step === 'email' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void sendCode()
          }}
          className="space-y-2"
        >
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            className={inputClass}
          />
          <button type="submit" disabled={loading || !email.trim()} className={primaryButtonClass}>
            {loading ? 'Sending…' : 'Email me a sign-in code'}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (code.length === CODE_LENGTH) void verifyCode(code)
          }}
          className="space-y-2"
        >
          <p className="text-xs text-gray-600">
            Enter the 6-digit code sent to <span className="font-medium text-gray-800">{email}</span>
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={CODE_LENGTH}
            placeholder="123456"
            autoFocus
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            disabled={loading}
            className={`${inputClass} text-center text-lg tracking-[0.5em]`}
          />
          <button
            type="submit"
            disabled={loading || code.length !== CODE_LENGTH}
            className={primaryButtonClass}
          >
            {loading ? 'Verifying…' : 'Sign in'}
          </button>
          <div className="flex justify-between text-xs">
            <button
              type="button"
              onClick={() => {
                setStep('email')
                setError(null)
                setCode('')
              }}
              className="text-gray-500 hover:text-[#8302AE]"
            >
              Use a different email
            </button>
            <button
              type="button"
              onClick={() => void sendCode()}
              disabled={loading || cooldown > 0}
              className="text-[#8302AE] hover:underline disabled:text-gray-400 disabled:no-underline"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </button>
          </div>
        </form>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
