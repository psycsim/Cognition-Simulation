"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  User,
  CreditCard,
  Pencil,
  Coins,
  Download,
  ChevronDown,
  Cpu,
} from "lucide-react";
import { supabase } from "../utils/supabase";
import { useAuth } from "../hooks/useAuth";
import AuthLoading from "../components/auth-loading";
import AppLayout from "../components/layout/AppLayout";
import SubHeader from "../components/layout/SubHeader";
import { Button } from "../components/ui/button";
import { startCheckout, verifyCheckout } from "../utils/stripe";
import {
  SimulationCharge,
  fetchSimulationCharges,
} from "../utils/billingData";
import { useCredits } from "../hooks/useCredits";
import { formatCredits, runsLeft, REFERENCE_RUN, usdToCredits } from "../utils/credits";

interface UserData {
  user_email: string;
  user_id: string;
  pic_url: string;
  credits?: number;
}

interface ProfileData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  institution: string;
  department: string;
  academicTitle: string;
  orcid: string;
  researchInterests: string;
  bio: string;
}

const emptyProfile: ProfileData = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  institution: "",
  department: "",
  academicTitle: "",
  orcid: "",
  researchInterests: "",
  bio: "",
};

interface Transaction {
  id: string;
  label: string;
  date: string; // pre-formatted for display, e.g. "Apr 5, 2026"
  amount: number; // positive = credits added
}

interface BillingData {
  balance: number;
  transactions: Transaction[];
}

// A single row in the merged Transaction History: either a credit purchase
// (positive) or a simulation charge (negative, expandable to a token breakdown).
type HistoryItem =
  | {
      kind: "purchase";
      id: string;
      label: string;
      date: string;
      amount: number;
      sortTs: number;
    }
  | {
      kind: "simulation";
      id: string;
      date: string;
      charge: SimulationCharge;
      sortTs: number;
    };

const formatDate = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// Balances come from the backend (/api/credits); `billing` only keeps the
// browser-local purchase history.
const defaultBilling: BillingData = {
  balance: 0,
  transactions: [],
};

// --- Profile persistence boundary -------------------------------------------
// For now the profile is stored in the browser (localStorage) only. When the
// backend is ready, swap these two helpers to read/write a Supabase table
// (e.g. a `profile` JSON column on `user_emails`) keyed by user_id; the rest of
// the page does not need to change.
const profileStorageKey = (userId: string) => `psycsim-profile-${userId}`;

const loadProfile = (userId: string): Partial<ProfileData> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(profileStorageKey(userId));
    return raw ? (JSON.parse(raw) as Partial<ProfileData>) : {};
  } catch {
    return {};
  }
};

const saveProfile = (userId: string, profile: ProfileData) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(profileStorageKey(userId), JSON.stringify(profile));
  } catch (error) {
    console.error("Error saving profile:", error);
  }
};

// Billing is also browser-only for now. When payments are wired up, these
// helpers become the read/write path to the real balance + transactions, and
// the "Add" buttons should hit the payment/checkout flow instead of mutating
// local state directly.
const billingStorageKey = (userId: string) => `psycsim-billing-${userId}`;

const loadBilling = (userId: string): BillingData => {
  if (typeof window === "undefined") return defaultBilling;
  try {
    const raw = localStorage.getItem(billingStorageKey(userId));
    if (!raw) return defaultBilling;
    const parsed = JSON.parse(raw) as BillingData;
    // Drop placeholder rows seeded by the old demo billing state.
    return {
      ...parsed,
      transactions: (parsed.transactions || []).filter((t) => !t.id.startsWith("seed-")),
    };
  } catch {
    return defaultBilling;
  }
};

const saveBilling = (userId: string, billing: BillingData) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(billingStorageKey(userId), JSON.stringify(billing));
  } catch (error) {
    console.error("Error saving billing:", error);
  }
};
// ----------------------------------------------------------------------------

export default function AccountPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const { credits, refresh: refreshCredits } = useCredits(isAuthenticated);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [activeTab, setActiveTab] = useState<"profile" | "billing">("profile");
  const [isEditing, setIsEditing] = useState(false);
  const [profile, setProfile] = useState<ProfileData>(emptyProfile);
  const [draft, setDraft] = useState<ProfileData>(emptyProfile);
  const [billing, setBilling] = useState<BillingData>(defaultBilling);
  const [checkoutStatus, setCheckoutStatus] = useState<"success" | "cancel" | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [pendingAmount, setPendingAmount] = useState<number | null>(null);
  const [customAmount, setCustomAmount] = useState("");
  // Per-simulation charges (token usage + cost) pulled from the tokens table.
  const [simCharges, setSimCharges] = useState<SimulationCharge[]>([]);
  const [expandedCharge, setExpandedCharge] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const loadSimCharges = async (userId: string) => {
    try {
      setSimCharges(await fetchSimulationCharges(userId));
    } catch (err) {
      console.error("Error loading simulation charges:", err);
      setSimCharges([]);
    }
  };

  // Total spent so far (informational; the server balance is already net of it).
  const simulationSpent = useMemo(
    () => simCharges.reduce((sum, c) => sum + c.totalCost, 0),
    [simCharges]
  );

  // Unified, newest-first history: credit purchases (+) and simulation debits (−).
  const historyItems = useMemo<HistoryItem[]>(() => {
    const purchases: HistoryItem[] = billing.transactions.map((t) => ({
      kind: "purchase",
      id: t.id,
      label: t.label,
      date: t.date,
      amount: t.amount,
      sortTs: new Date(t.date).getTime() || 0,
    }));
    const sims: HistoryItem[] = simCharges.map((c) => ({
      kind: "simulation",
      id: c.id,
      date: c.date,
      charge: c,
      sortTs: c.createdAt ? new Date(c.createdAt).getTime() : 0,
    }));
    return [...purchases, ...sims].sort((a, b) => b.sortTs - a.sortTs);
  }, [billing.transactions, simCharges]);

  const getUserData = async (userId: string) => {
    const { data, error } = await supabase
      .from("user_emails")
      .select("user_email, user_id, pic_url, credits")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Error fetching user data:", error);
      setUserData(null);
    } else {
      setUserData(data ?? null);
      // Credit balance is the source of truth in user_emails; mirror it into the
      // billing panel (transactions remain local history).
      if (data) {
        setBilling((prev) => ({ ...prev, balance: data.credits ?? 0 }));
      }
    }
  };

  useEffect(() => {
    if (user && isAuthenticated && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      getUserData(user.user_id);
      loadSimCharges(user.user_id);

      // Seed the form with what we already know from auth, then layer any
      // previously saved edits on top.
      const nameParts = (user.name || "").trim().split(/\s+/).filter(Boolean);
      const authDefaults: Partial<ProfileData> = {
        firstName: nameParts[0] || "",
        lastName: nameParts.length > 1 ? nameParts.slice(1).join(" ") : "",
        email: user.user_email || "",
      };
      const merged: ProfileData = {
        ...emptyProfile,
        ...authDefaults,
        ...loadProfile(user.user_id),
        // Email always reflects the authenticated account.
        email: user.user_email || "",
      };
      setProfile(merged);
      setDraft(merged);
      setBilling(loadBilling(user.user_id));
    } else if (!user || !isAuthenticated) {
      hasLoadedRef.current = false;
      setProfile(emptyProfile);
      setDraft(emptyProfile);
      setBilling(defaultBilling);
      setSimCharges([]);
      setIsEditing(false);
    }
  }, [user?.user_id, isAuthenticated]);

  const handleEdit = () => {
    setDraft(profile);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setDraft(profile);
    setIsEditing(false);
  };

  const handleSave = () => {
    if (!user) return;
    setProfile(draft);
    saveProfile(user.user_id, draft);
    setIsEditing(false);
  };

  const updateDraft = (field: keyof ProfileData, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  // Records a verified credit purchase. The balance comes from the server
  // (user_emails.credits, returned by verify); transactions remain local history.
  const recordCredits = (amount: number, serverBalance: number | null) => {
    if (!user || !(amount > 0)) return;
    const newTransaction: Transaction = {
      id: crypto.randomUUID(),
      label: "Credit purchase",
      date: formatDate(new Date()),
      amount,
    };
    // Functional update so this composes with the billing-load effect that runs
    // on the same render (avoids reading a stale `billing` from the closure).
    setBilling((prev) => {
      const next: BillingData = {
        // Prefer the authoritative server balance; fall back to a local sum only
        // if the backend couldn't return one.
        balance:
          serverBalance != null
            ? serverBalance
            : Math.round((prev.balance + amount) * 100) / 100,
        transactions: [newTransaction, ...prev.transactions],
      };
      saveBilling(user.user_id, next);
      return next;
    });
  };

  // Asks our server to create a Stripe Checkout Session for `amount` dollars,
  // then redirects to Stripe's hosted page. Works for fixed packs and the
  // custom amount alike.
  const handleAddCredits = async (amount: number) => {
    if (!user || !(amount > 0) || pendingAmount !== null) return;
    setCheckoutError(null);
    setPendingAmount(amount);
    try {
      await startCheckout(amount, { userId: user.user_id, email: user.user_email });
      // On success the browser navigates to Stripe; this line isn't reached.
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : "Could not start checkout.");
      setPendingAmount(null);
    }
  };

  const handleAddCustom = () => {
    const amount = parseFloat(customAmount);
    if (isNaN(amount) || amount <= 0) return;
    handleAddCredits(Math.round(amount * 100) / 100);
    setCustomAmount("");
  };

  // Handle the return from Stripe Checkout. On success we verify the session
  // server-side (so the credited amount comes from Stripe, not a spoofable URL)
  // before recording it. Query params are stripped so a refresh can't re-credit.
  useEffect(() => {
    if (!user || !isAuthenticated) return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    if (params.get("tab") === "billing") setActiveTab("billing");
    if (status !== "success" && status !== "cancel") return;

    setActiveTab("billing");
    window.history.replaceState({}, "", "/account");

    if (status === "cancel") {
      setCheckoutStatus("cancel");
      return;
    }

    // The session_id has already been stripped from the URL above, so this
    // verify path runs exactly once even under StrictMode's double-invoke.
    const sessionId = params.get("session_id");
    if (!sessionId) return;
    verifyCheckout(sessionId)
      .then((result) => {
        if (result.paid && result.amount > 0) {
          recordCredits(result.amount, result.balance);
          setCheckoutStatus("success");
          void refreshCredits();
        } else {
          setCheckoutError("Payment could not be verified.");
        }
      })
      .catch((err) => {
        setCheckoutError(err instanceof Error ? err.message : "Could not verify payment.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.user_id, isAuthenticated]);

  // Show loading state while checking authentication
  if (isLoading) {
    return <AuthLoading message="Loading account..." />;
  }

  // If not authenticated, don't render anything (will redirect)
  if (!isAuthenticated) {
    return null;
  }

  const values = isEditing ? draft : profile;

  const fieldClass = (editable: boolean) =>
    `w-full px-3 py-2.5 rounded-lg text-sm transition-colors ${
      editable
        ? "bg-white border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        : "bg-gray-50 border border-gray-200 text-gray-500 cursor-default"
    }`;

  // Email is tied to the login provider and is not editable here.
  const renderField = (
    label: string,
    field: keyof ProfileData,
    placeholder: string,
    options?: { editable?: boolean }
  ) => {
    const editable = isEditing && options?.editable !== false;
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
        <input
          type="text"
          value={values[field]}
          placeholder={placeholder}
          disabled={!editable}
          onChange={(e) => updateDraft(field, e.target.value)}
          className={fieldClass(editable)}
        />
      </div>
    );
  };

  return (
    <AppLayout currentPage="account" headerTitle="" userData={userData}>
      <SubHeader title="Account Settings" description="Manage your profile and billing" />

      <div className="flex-1 p-8 bg-gray-100 overflow-y-auto">
        <div className="max-w-5xl mx-auto">
          {/* Tabs */}
          <div className="flex items-center gap-2 mb-6">
            <button
              onClick={() => setActiveTab("profile")}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === "profile"
                  ? "bg-white border border-gray-200 shadow-sm text-blue-600"
                  : "text-gray-500 hover:bg-gray-200"
              }`}
            >
              <User className="w-4 h-4" />
              Profile
            </button>
            <button
              onClick={() => setActiveTab("billing")}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === "billing"
                  ? "bg-white border border-gray-200 shadow-sm text-blue-600"
                  : "text-gray-500 hover:bg-gray-200"
              }`}
            >
              <CreditCard className="w-4 h-4" />
              Billing &amp; Credits
            </button>
          </div>

          {activeTab === "profile" && (
            <>
          {/* Profile Settings header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h3 className="text-lg font-semibold text-blue-600">Profile Settings</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Manage your academic profile and contact information
              </p>
            </div>
            {isEditing ? (
              <div className="flex gap-2">
                <Button
                  onClick={handleCancel}
                  className="bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 px-4 py-2 rounded-lg"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg"
                >
                  Save Changes
                </Button>
              </div>
            ) : (
              <Button
                onClick={handleEdit}
                className="bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 px-4 py-2 rounded-lg flex items-center gap-2"
              >
                <Pencil className="w-4 h-4" />
                Edit Profile
              </Button>
            )}
          </div>

          {/* Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Personal Information */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h4 className="text-sm font-semibold text-blue-600 mb-4">Personal Information</h4>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  {renderField("First Name", "firstName", "First name")}
                  {renderField("Last Name", "lastName", "Last name")}
                </div>
                {renderField("Email Address", "email", "you@university.edu", { editable: false })}
                {renderField("Phone Number", "phone", "+1 (555) 123-4567")}
              </div>
            </div>

            {/* Academic Information */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h4 className="text-sm font-semibold text-blue-600 mb-4">Academic Information</h4>
              <div className="space-y-4">
                {renderField("Institution", "institution", "e.g. Stanford University")}
                {renderField("Department", "department", "e.g. Department of Psychology")}
                {renderField("Academic Title", "academicTitle", "e.g. Associate Professor")}
                {renderField("ORCID ID", "orcid", "0000-0002-1234-5678")}
              </div>
            </div>
          </div>

          {/* Research Profile */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 mt-6">
            <h4 className="text-sm font-semibold text-blue-600 mb-4">Research Profile</h4>
            <div className="space-y-4">
              {renderField(
                "Research Interests",
                "researchInterests",
                "e.g. Consumer behavior, cognitive modeling, decision-making under uncertainty"
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Bio</label>
                <textarea
                  rows={4}
                  value={values.bio}
                  placeholder="Tell us about your research and background..."
                  disabled={!isEditing}
                  onChange={(e) => updateDraft("bio", e.target.value)}
                  className={`${fieldClass(isEditing)} resize-none`}
                />
              </div>
            </div>
          </div>
            </>
          )}

          {activeTab === "billing" && (
            <>
              {/* Billing header */}
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-blue-600">Billing &amp; Credits</h3>
                <p className="text-sm text-gray-500 mt-0.5">Add funds and manage your credit balance</p>
              </div>

              {/* Checkout result banners */}
              {checkoutStatus === "success" && (
                <div className="mb-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                  Payment successful — your credits have been added.
                </div>
              )}
              {checkoutStatus === "cancel" && (
                <div className="mb-6 rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
                  Checkout canceled — no charge was made.
                </div>
              )}
              {checkoutError && (
                <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {checkoutError}
                </div>
              )}

              {/* Credit Balance */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <p className="text-sm text-gray-500">Available Credits</p>
                <div className="flex items-center gap-2 mt-1">
                  <Coins className="w-6 h-6 text-blue-600" />
                  <span className="text-3xl font-bold text-blue-600">
                    {credits ? formatCredits(credits.total_usd, credits) : "—"}
                  </span>
                  {credits && (
                    <span className="text-sm text-gray-400 ml-1">
                      (${credits.total_usd.toFixed(2)})
                    </span>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-3 gap-4 border-t border-gray-100 pt-4">
                  <div>
                    <p className="text-xs text-gray-400">Free credits</p>
                    <p className="text-sm font-semibold text-gray-900">
                      {credits ? formatCredits(credits.free_usd, credits) : "—"}
                    </p>
                    {credits && credits.free_usd > 0 && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        ≈ {runsLeft(credits.free_usd, credits)} free runs left
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Purchased credits</p>
                    <p className="text-sm font-semibold text-gray-900">
                      {credits ? formatCredits(credits.paid_usd, credits) : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Spent so far</p>
                    <p className="text-sm font-semibold text-red-600">
                      -{formatCredits(simulationSpent, credits)}
                    </p>
                  </div>
                </div>
                <p className="text-sm text-gray-500 mt-3">
                  $1 = {credits?.credits_per_usd ?? 100} credits. Free credits are used first. A typical run
                  ({REFERENCE_RUN.samples} samples × {REFERENCE_RUN.steps} steps) costs about{" "}
                  {credits
                    ? Math.ceil(
                        usdToCredits(
                          credits.est_per_sample_step * REFERENCE_RUN.samples * REFERENCE_RUN.steps +
                            credits.est_per_sample * REFERENCE_RUN.samples +
                            credits.run_fee_usd,
                          credits
                        )
                      )
                    : 9}{" "}
                  credits. You need at least {credits ? formatCredits(credits.min_balance_usd, credits) : 100} credits
                  to start a run.
                </p>
              </div>

              {/* Add Credits */}
              <div className="bg-white rounded-xl border border-gray-200 p-6 mt-6">
                <h4 className="text-sm font-semibold text-blue-600">Add Credits</h4>
                <p className="text-sm text-gray-500 mt-0.5 mb-5">Choose an amount to add to your balance</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* $10 */}
                  <div className="border border-gray-200 rounded-xl p-5 flex flex-col">
                    <div className="flex-1 flex items-center justify-center py-3">
                      <div className="text-center">
                        <span className="text-2xl font-bold text-gray-900">$10</span>
                        <p className="text-xs text-gray-500 mt-1">{((10) * (credits?.credits_per_usd ?? 100)).toLocaleString("en-US")} credits</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleAddCredits(10)}
                      disabled={pendingAmount !== null}
                      className="w-full flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 disabled:opacity-60 disabled:cursor-not-allowed text-gray-700 text-sm font-medium py-2.5 rounded-lg transition-colors"
                    >
                      <CreditCard className="w-4 h-4" />
                      {pendingAmount === 10 ? "Redirecting…" : "Add $10"}
                    </button>
                  </div>

                  {/* $50 - Most Popular */}
                  <div className="relative border-2 border-blue-500 rounded-xl p-5 flex flex-col">
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs font-medium px-3 py-1 rounded-full whitespace-nowrap">
                      Most Popular
                    </span>
                    <div className="flex-1 flex items-center justify-center py-3">
                      <div className="text-center">
                        <span className="text-2xl font-bold text-gray-900">$50</span>
                        <p className="text-xs text-gray-500 mt-1">{((50) * (credits?.credits_per_usd ?? 100)).toLocaleString("en-US")} credits</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleAddCredits(50)}
                      disabled={pendingAmount !== null}
                      className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                    >
                      <CreditCard className="w-4 h-4" />
                      {pendingAmount === 50 ? "Redirecting…" : "Add $50"}
                    </button>
                  </div>

                  {/* Custom */}
                  <div className="border border-gray-200 rounded-xl p-5 flex flex-col">
                    <div className="flex-1 flex items-center justify-center py-3">
                      <div className="relative w-full">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={customAmount}
                          placeholder="Amount"
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "" || /^\d*\.?\d{0,2}$/.test(v)) setCustomAmount(v);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleAddCustom();
                          }}
                          className="w-full pl-7 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                    <button
                      onClick={handleAddCustom}
                      disabled={pendingAmount !== null || !(parseFloat(customAmount) > 0)}
                      className="w-full flex items-center justify-center gap-2 bg-gray-100 hover:bg-gray-200 disabled:opacity-60 disabled:cursor-not-allowed text-gray-700 text-sm font-medium py-2.5 rounded-lg transition-colors"
                    >
                      <CreditCard className="w-4 h-4" />
                      {pendingAmount !== null && pendingAmount !== 10 && pendingAmount !== 50
                        ? "Redirecting…"
                        : "Add Custom"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Transaction History */}
              <div className="bg-white rounded-xl border border-gray-200 p-6 mt-6">
                <h4 className="text-sm font-semibold text-blue-600">Transaction History</h4>
                <p className="text-sm text-gray-500 mt-0.5 mb-2">
                  Credit purchases and simulation charges
                </p>
                {historyItems.length === 0 ? (
                  <p className="text-sm text-gray-400 py-4">No transactions yet.</p>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {historyItems.map((item) =>
                      item.kind === "purchase" ? (
                        <div
                          key={item.id}
                          className="flex items-center justify-between py-3"
                        >
                          <div>
                            <p className="text-sm font-medium text-gray-900">{item.label}</p>
                            <p className="text-xs text-gray-400 mt-0.5">{item.date}</p>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-xs font-medium text-green-600 bg-green-50 px-2.5 py-1 rounded-md">
                              +{formatCredits(item.amount)} credits (${item.amount.toFixed(2)})
                            </span>
                            <button
                              type="button"
                              title="Invoice downloads coming soon"
                              className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
                            >
                              <Download className="w-4 h-4" />
                              Invoice
                            </button>
                          </div>
                        </div>
                      ) : (
                        <SimulationRow
                          key={item.id}
                          charge={item.charge}
                          expanded={expandedCharge === item.id}
                          onToggle={() =>
                            setExpandedCharge((prev) =>
                              prev === item.id ? null : item.id
                            )
                          }
                        />
                      )
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

// A simulation charge row: collapsed shows title/date and the amount debited;
// expanded reveals the input/output token counts and the cost breakdown
// (token cost from the tokens table + flat server fee).
function SimulationRow({
  charge,
  expanded,
  onToggle,
}: {
  charge: SimulationCharge;
  expanded: boolean;
  onToggle: () => void;
}) {
  const inputTokens = charge.promptInputToken + charge.evalInputToken;
  const outputTokens = charge.promptOutputToken + charge.evalOutputToken;
  const fmtTokens = (n: number) => n.toLocaleString("en-US");
  const fmtUsd = (n: number) => `$${n.toFixed(4)}`;
  const fmtCredits = (usd: number) => {
    const c = usdToCredits(usd);
    return c >= 10 ? Math.round(c).toLocaleString("en-US") : c.toFixed(2);
  };

  return (
    <div className="py-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <ChevronDown
            className={`h-4 w-4 text-gray-400 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
          <div>
            <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
              <Cpu className="h-3.5 w-3.5 text-indigo-500" />
              {charge.title}
            </p>
            <p className="mt-0.5 text-xs text-gray-400">
              {charge.date || "Simulation"} · {fmtTokens(charge.totalTokens)} tokens
            </p>
          </div>
        </div>
        <span className="text-xs font-medium text-red-600 bg-red-50 px-2.5 py-1 rounded-md">
          -{fmtCredits(charge.totalCost)} credits
          {charge.freePortion != null && charge.freePortion > 0 && (
            <span className="text-red-400"> (free)</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 ml-6 rounded-lg border border-gray-100 bg-gray-50 p-4">
          {/* Token breakdown */}
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
            Tokens
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <span className="text-gray-500">Input tokens</span>
            <span className="text-right font-medium text-gray-900">
              {fmtTokens(inputTokens)}
            </span>
            <span className="text-gray-500">Output tokens</span>
            <span className="text-right font-medium text-gray-900">
              {fmtTokens(outputTokens)}
            </span>
            <span className="text-gray-400 pl-3 text-xs">Prompt (in / out)</span>
            <span className="text-right text-xs text-gray-400">
              {fmtTokens(charge.promptInputToken)} / {fmtTokens(charge.promptOutputToken)}
            </span>
            <span className="text-gray-400 pl-3 text-xs">Evaluation (in / out)</span>
            <span className="text-right text-xs text-gray-400">
              {fmtTokens(charge.evalInputToken)} / {fmtTokens(charge.evalOutputToken)}
            </span>
          </div>

          {/* Cost breakdown */}
          <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-gray-400">
            Cost
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <span className="text-gray-500">Cost of tokens</span>
            <span className="text-right font-medium text-gray-900">
              {fmtUsd(charge.tokenCost)}
            </span>
            {charge.serverCost > 0 && (
              <>
                <span className="text-gray-500">Server cost</span>
                <span className="text-right font-medium text-gray-900">
                  {fmtUsd(charge.serverCost)}
                </span>
              </>
            )}
            <span className="mt-1 border-t border-gray-200 pt-1.5 font-semibold text-gray-900">
              Total
            </span>
            <span className="mt-1 border-t border-gray-200 pt-1.5 text-right font-semibold text-gray-900">
              {fmtUsd(charge.totalCost)} · {fmtCredits(charge.totalCost)} credits
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
