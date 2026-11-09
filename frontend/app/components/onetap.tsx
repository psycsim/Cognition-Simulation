'use client'

import Script from 'next/script'
import type { accounts, CredentialResponse } from 'google-one-tap'
import { useRouter } from 'next/navigation'
import { supabase } from '../utils/supabase'
import { completeLogin } from '../utils/postLogin'

declare const google: { accounts: accounts }

// generate nonce to use for google id token sign-in
const generateNonce = async (): Promise<string[]> => {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  const encoder = new TextEncoder()
  const encodedNonce = encoder.encode(nonce)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encodedNonce)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashedNonce = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')

  return [nonce, hashedNonce]
}

const OneTapComponent = () => {
  const router = useRouter()

  const initializeGoogleOneTap = async () => {
    const [nonce, hashedNonce] = await generateNonce()

    /* global google */
    google.accounts.id.initialize({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      callback: async (response: CredentialResponse) => {
        try {
          // send id token returned in response.credential to supabase
          const { data, error } = await supabase.auth.signInWithIdToken({
            provider: 'google',
            token: response.credential,
            nonce,
          })

          if (error) throw error

          if (data.user) {
            await completeLogin(data.user)
          }

          // redirect to protected page
          router.push('/dashboard')
        } catch (error) {
          console.error('Error logging in with Google One Tap', error)
        }
      },
      nonce: hashedNonce,
      // with chrome's removal of third-party cookies, we need to use FedCM instead (https://developers.google.com/identity/gsi/web/guides/fedcm-migration)
      use_fedcm_for_prompt: true,
    })

    // Render the Google sign-in button
    const buttonElement = document.getElementById('googleSignInButton')
    if (buttonElement) {
      google.accounts.id.renderButton(buttonElement, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        logo_alignment: 'left',
        width: 250,
      })
    }

    // Display the One Tap UI
    google.accounts.id.prompt()
  }

  return (
    <div className="flex flex-col items-center space-y-4">
      <div id="googleSignInButton"></div>
      <Script onReady={() => void initializeGoogleOneTap()} src="https://accounts.google.com/gsi/client" />
    </div>
  )
}

export default OneTapComponent