"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Activity, Users, BarChart3, LineChart, ChevronDown, LogOut, Settings } from "lucide-react";
import { useAuth } from "../../hooks/useAuth";

interface UserData {
  user_email: string;
  user_id: string;
  pic_url: string;
}

interface SidebarProps {
  currentPage: 'dashboard' | 'simulation' | 'measures' | 'samples' | 'analysis' | 'account';
  userData?: UserData | null;
}

export default function Sidebar({ currentPage, userData }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  const collapseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pathname = usePathname();
  const wasNavigatingRef = useRef(false);
  const { signOut } = useAuth();
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      alert("Error signing out. Please try again.");
      console.error("Sign out error:", error);
    }
  };

  const navItems = [
    { id: 'dashboard', href: '/dashboard', icon: Home, label: 'Dashboard' },
    { id: 'samples', href: '/samples', icon: Users, label: 'Samples' },
    { id: 'measures', href: '/measures', icon: BarChart3, label: 'Measures' },
    { id: 'simulation', href: '/simulation', icon: Activity, label: 'Simulation' },
    // { id: 'analysis', href: '/analysis', icon: LineChart, label: 'Analysis' },
  ];

  // Keep sidebar open when navigating via sidebar links
  useEffect(() => {
    // When pathname changes (navigation occurred), keep sidebar open if we were navigating
    if (wasNavigatingRef.current) {
      setIsCollapsed(false);
      wasNavigatingRef.current = false;
    }
    
    // Clear any pending collapse timeout
    if (collapseTimeoutRef.current) {
      clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }
  }, [pathname]);

  const handleMouseEnter = () => {
    // Clear any pending collapse timeout
    if (collapseTimeoutRef.current) {
      clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }
    setIsCollapsed(false);
  };

  const handleMouseLeave = () => {
    // Add a small delay before collapsing to allow for link clicks
    collapseTimeoutRef.current = setTimeout(() => {
      setIsCollapsed(true);
      collapseTimeoutRef.current = null;
    }, 300);
  };

  const handleLinkClick = () => {
    // Mark that we're navigating via sidebar link
    wasNavigatingRef.current = true;
    // Keep sidebar open when clicking a link
    if (collapseTimeoutRef.current) {
      clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }
    setIsCollapsed(false);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (collapseTimeoutRef.current) {
        clearTimeout(collapseTimeoutRef.current);
      }
    };
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setProfileDropdownOpen(false);
      }
    };

    if (profileDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [profileDropdownOpen]);

  return (
    <div 
      className={`bg-gray-100 border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out relative ${
        isCollapsed ? 'w-20' : 'w-64'
      }`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Logo */}
      <div className={`bg-gray-100 border-b border-gray-200 overflow-hidden transition-all duration-300 ${
        isCollapsed ? 'px-4 py-7' : 'px-8 py-7'
      }`}>
        <h1 className={`text-2xl font-bold text-blue-600 whitespace-nowrap transition-opacity duration-300 ${
          isCollapsed ? 'opacity-0 w-0 h-0 overflow-hidden' : 'opacity-100'
        }`}>
          Psycsim
        </h1>
        {isCollapsed && (
          <div className="flex items-center justify-center">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">P</span>
            </div>
          </div>
        )}
      </div>
      
      {/* Navigation */}
      <nav className={`flex-1 pt-4 transition-all duration-300 ${
        isCollapsed ? 'px-2' : 'px-4'
      }`}>
        <div className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            
            return (
              <Link key={item.id} href={item.href} onClick={handleLinkClick}>
                <div className={`flex items-center rounded-lg transition-all duration-200 ${
                  isCollapsed ? 'justify-center px-3' : 'gap-3 px-4'
                } py-3 ${
                  isActive 
                    ? 'text-white bg-blue-600' 
                    : 'text-gray-700 hover:bg-gray-200'
                }`}>
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  <span className={`${isActive ? 'font-medium' : ''} whitespace-nowrap transition-opacity duration-300 ${
                    isCollapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100'
                  }`}>
                    {item.label}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </nav>
      
      {/* Account Section */}
      {userData && (
        <div className={`border-t border-gray-300 transition-all duration-300 ${
          isCollapsed ? 'p-2' : 'p-4'
        }`}>
          <div className="relative" ref={dropdownRef}>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setProfileDropdownOpen(!profileDropdownOpen);
              }}
              className={`flex items-center w-full gap-3 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 rounded-lg transition-colors ${
                isCollapsed ? 'justify-center' : ''
              }`}
            >
              {/* Profile Picture */}
              <div className="w-8 h-8 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
                {userData?.pic_url ? (
                  <img 
                    src={userData.pic_url} 
                    alt="Profile" 
                    className="w-8 h-8 rounded-full object-cover"
                  />
                ) : (
                  <span>
                    {(userData?.user_email?.split('@')[0]?.charAt(0) || 'U').toUpperCase()}
                  </span>
                )}
              </div>
              
              {!isCollapsed && (
                <>
                  <div className="flex-1 text-left min-w-0">
                    <div className="font-medium text-gray-900 truncate">
                      {userData?.user_email?.split('@')[0] || 'User'}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {userData?.user_email || 'Loading...'}
                    </div>
                  </div>
                  
                  <ChevronDown className={`w-4 h-4 flex-shrink-0 transition-transform ${profileDropdownOpen ? 'rotate-180' : ''}`} />
                </>
              )}
            </button>
            
            {profileDropdownOpen && !isCollapsed && (
              <div className="absolute bottom-full left-0 mb-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                <div className="py-1">
                  <Link
                    href="/account"
                    onClick={() => setProfileDropdownOpen(false)}
                    className="flex items-center gap-3 w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <Settings className="w-4 h-4" />
                    Account Settings
                  </Link>
                  <div className="my-1 border-t border-gray-100" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSignOut();
                    }}
                    className="flex items-center gap-3 w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className={`border-t border-gray-300 overflow-hidden transition-all duration-300 ${
        isCollapsed ? 'p-2' : 'p-4'
      }`}>
        <div className={`text-sm text-gray-600 whitespace-nowrap transition-opacity duration-300 ${
          isCollapsed ? 'opacity-0 h-0' : 'opacity-100'
        }`}>
          © {new Date().getFullYear()} Psycsim
        </div>
      </div>
    </div>
  );
}