"use client"
// Home page for the application.
// It displays a welcome message and a description of the platform.
// It also displays the name of the user who is logged in.
// It is used in the app/page.tsx file.

import type React from "react"

import { useState, useEffect } from "react"
import { useRouter } from 'next/navigation'
import Image from "next/image"
import Link from "next/link"
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { LogOut, MousePointer, Check, Lock, Brain, Users, Laptop, LineChart, Shield, Server, FileText, Edit, Trash2  } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import OneTapComponent from "./components/onetap"
import EmailOtpLogin from "./components/EmailOtpLogin"
import { supabase } from "./utils/supabase"
import { useAuth } from "./hooks/useAuth"

// Type declarations for Google API
declare global {
  interface Window {
    google: {
      accounts: {
        id: {
          initialize: (config: any) => void;
          renderButton: (element: HTMLElement, options: any) => void;
          disableAutoSelect: () => void;
          revoke: (id: string, callback: () => void) => void;
        };
      };
    };
  }
}

interface Draft {
  experiment_id: string;
  title: string;
  created_at: string;
  sample_name: string;
}

export default function Home() {
  const router = useRouter()
  const { user, isLoading, isAuthenticated, signOut } = useAuth()
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loadingDrafts, setLoadingDrafts] = useState(false)

  // Handle sign out.
  const handleSignOut = async () => {
    await signOut()
  }

  // Fetch drafts for the authenticated user
  const fetchDrafts = async (userId: string) => {
    setLoadingDrafts(true)
    try {
      const { data, error } = await supabase
        .from("experiments")
        .select("experiment_id, experiment_data, created_at")
        .eq("user_id", userId)
        .eq("status", "Draft")
        .order("created_at", { ascending: false })
        .limit(10)

      if (error) {
        console.error("Error fetching drafts:", error)
        setDrafts([])
        return
      }

      const formattedDrafts: Draft[] = (data || []).map((experiment: any) => {
        const experimentData = experiment.experiment_data || {}
        return {
          experiment_id: experiment.experiment_id,
          title: experimentData.title || "Untitled Simulation",
          created_at: experiment.created_at,
          sample_name: experimentData.sample?.name || "No sample"
        }
      })

      setDrafts(formattedDrafts)
    } catch (error) {
      console.error("Error processing drafts:", error)
      setDrafts([])
    } finally {
      setLoadingDrafts(false)
    }
  }

  // Delete a draft
  const handleDeleteDraft = async (experimentId: string) => {
    if (!confirm("Are you sure you want to delete this draft?")) {
      return
    }

    if (!user) return

    try {
      const { error } = await supabase
        .from("experiments")
        .delete()
        .eq("experiment_id", experimentId)
        .eq("user_id", user.user_id)

      if (error) {
        console.error("Error deleting draft:", error)
        alert(`Error deleting draft: ${error.message}`)
        return
      }

      // Refresh drafts list
      fetchDrafts(user.user_id)
    } catch (error) {
      console.error("Error deleting draft:", error)
      alert(`Error deleting draft: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Push user data to user_emails table when user is authenticated
  useEffect(() => {
    const pushUserToDatabase = async () => {
      if (user && isAuthenticated) {
        try {
          const { error: insertError } = await supabase
            .from('user_emails')
            .upsert({
              uuid: crypto.randomUUID(),
              user_email: user.user_email,
              user_id: user.user_id,
              pic_url: user.pic_url
            }, {
              onConflict: 'user_email'
            })
          
          if (insertError) {
            console.error('Error inserting user data:', insertError)
          }
        } catch (insertError) {
          console.error('Error pushing user data to database:', insertError)
        }
      }
    }
    
    pushUserToDatabase()
  }, [user, isAuthenticated])

  // Fetch drafts when user is authenticated
  useEffect(() => {
    if (user && isAuthenticated) {
      fetchDrafts(user.user_id)
    } else {
      setDrafts([])
    }
  }, [user, isAuthenticated])

  // Return the home page.
  return (
    <>

      {/* Main content */}
      <div className="max-w-6xl mx-auto p-6 space-y-8">

        <main className="space-y-8">

          {/* Authentication banner */}
          <section className="max-w-7xl mx-auto px-6 py-16 grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
            <div>
              <h1 className="text-4xl md:text-5xl font-bold text-[#8302AE] mb-6">Welcome to Psycsim Portal!</h1>
              <p className="text-gray-700 mb-8 max-w-lg">
                Your gateway to cutting-edge cognitive simulations powered by artificial intelligence. Experience the future
                of social scientific experimentation today.
              </p>
              {isAuthenticated && user ? (
                <div className="flex gap-3">
                  <Link href="/dashboard">
                    <button
                      className="bg-gradient-to-r from-[#8302AE] to-[#6a4bc4] text-white font-bold py-3 px-6 rounded-lg shadow-md hover:from-[#6a4bc4] hover:to-[#8302AE] transition-all"
                    >
                      Go to Dashboard
                    </button>
                  </Link>
                  <Link href="/simulation?new=true">
                    <Button
                      variant="outline"
                      className="border-[#8302AE] text-[#8302AE] font-bold py-3 px-6 rounded-lg hover:bg-[#8302AE] hover:text-white transition-all"
                    >
                      Start New Simulation
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="text-gray-500 flex flex-col items-start gap-4">
                  <OneTapComponent />
                  <div className="flex w-[250px] items-center gap-3 text-xs text-gray-400">
                    <div className="h-px flex-1 bg-gray-200" />
                    or
                    <div className="h-px flex-1 bg-gray-200" />
                  </div>
                  <EmailOtpLogin />
                </div>
              )}
            </div>
            <div className="flex justify-center">
              <img
                src="https://imgproxy.gamma.app/resize/quality:80/resizing_type:fit/width:1200/https://cdn.gamma.app/wbxlv1atbikacw4/generated-images/JRfwHX2FKaUmHiSNNnGGT.png"
                alt="Neural network visualization"
                className="rounded-lg shadow-lg"
              />
            </div>
          </section>

         
          
           
          

      


       


       

  

      {/* Footer */}




        </main>
      </div>
    </>
  );
}
