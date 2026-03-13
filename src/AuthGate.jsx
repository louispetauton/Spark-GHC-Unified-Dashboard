import React, { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'

const ACCESS_CODE = import.meta.env.VITE_ACCESS_CODE

const inputStyle = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  fontSize: 14,
  outline: 'none',
  fontFamily: 'DM Sans, sans-serif',
  boxSizing: 'border-box',
  color: '#1a202c',
}

const labelStyle = {
  display: 'block',
  fontSize: 13,
  fontWeight: 500,
  color: '#374151',
  marginBottom: 4,
  marginTop: 14,
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  async function handleSignIn(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSubmitting(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setSubmitting(false)
  }

  async function handleSignUp(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    if (code.toUpperCase() !== ACCESS_CODE) {
      setError('Invalid access code.')
      return
    }
    setSubmitting(true)
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setError(error.message)
    } else if (!data.session) {
      setSuccess('Account created! Check your email to confirm, then sign in.')
      setTab('signin')
    }
    setSubmitting(false)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: '#f8f9fa', fontFamily: 'DM Sans, sans-serif',
        color: '#64748b', fontSize: 14,
      }}>
        Loading…
      </div>
    )
  }

  if (session) {
    return (
      <>
        {children}
        <button
          onClick={handleSignOut}
          style={{
            position: 'fixed', bottom: 16, right: 16,
            background: '#fff', border: '1px solid #e2e8f0',
            borderRadius: 8, padding: '6px 14px', fontSize: 12,
            cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
            color: '#64748b', zIndex: 9999,
            boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          }}
        >
          Sign Out
        </button>
      </>
    )
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: '#f1f5f9',
      fontFamily: 'DM Sans, sans-serif',
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '36px 40px',
        width: 380, boxShadow: '0 4px 24px rgba(0,0,0,0.09)',
        border: '1px solid #e2e8f0',
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', letterSpacing: '-0.3px' }}>
            Ohio Hospitality
          </div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 3 }}>
            Kalibri Labs Dashboard
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', marginBottom: 24 }}>
          {[['signin', 'Sign In'], ['signup', 'Create Account']].map(([t, label]) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(''); setSuccess('') }}
              style={{
                flex: 1, padding: '8px 0', background: 'none', border: 'none',
                borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
                fontSize: 14, fontWeight: tab === t ? 600 : 400,
                color: tab === t ? '#2563eb' : '#64748b',
                cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={tab === 'signin' ? handleSignIn : handleSignUp}>
          <label style={labelStyle}>Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            style={inputStyle}
            placeholder="you@example.com"
          />

          <label style={labelStyle}>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            style={inputStyle}
            placeholder="••••••••"
          />

          {tab === 'signup' && (
            <>
              <label style={labelStyle}>Access Code</label>
              <input
                type="text"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                required
                maxLength={6}
                style={inputStyle}
                placeholder="6-character code"
                autoComplete="off"
              />
            </>
          )}

          {error && (
            <div style={{ color: '#dc2626', fontSize: 13, marginTop: 12 }}>{error}</div>
          )}
          {success && (
            <div style={{ color: '#16a34a', fontSize: 13, marginTop: 12 }}>{success}</div>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              width: '100%', background: '#2563eb', color: '#fff',
              border: 'none', borderRadius: 8, padding: '10px 0',
              fontSize: 15, fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontFamily: 'DM Sans, sans-serif',
              opacity: submitting ? 0.7 : 1,
              marginTop: 20,
            }}
          >
            {submitting ? '…' : tab === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  )
}
