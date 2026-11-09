import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'

/**
 * Shared post-sign-in bookkeeping for every auth method (Google One Tap,
 * OAuth callback, email OTP): cache the user locally and ensure a
 * user_emails row exists (which is how new users receive free credits).
 */
export async function completeLogin(user: User): Promise<void> {
  localStorage.setItem('supabaseUser', JSON.stringify(user))

  try {
    const { error } = await supabase
      .from('user_emails')
      .upsert(
        {
          uuid: crypto.randomUUID(),
          user_email: user.email,
          user_id: user.id,
          pic_url:
            user.identities?.[0]?.identity_data?.avatar_url ||
            user.identities?.[0]?.identity_data?.picture ||
            null,
        },
        { onConflict: 'user_email' }
      )

    if (error) {
      console.error('Error inserting user data:', error)
    }
  } catch (error) {
    console.error('Error pushing user data to database:', error)
  }
}
