import type React from "react"
import "@/styles/globals.css"
import { Inter } from "next/font/google"
import { Toaster } from "sonner"

// Inter font for the application.
const inter = Inter({ subsets: ["latin"] })

// Root layout for the application.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {children}
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  )
}



import './globals.css'

// Metadata for the application.
export const metadata = {
      generator: 'v0.dev'
    };
