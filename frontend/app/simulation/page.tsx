"use client";

import React, { useEffect, useState, useRef, useCallback, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Save, Download, HelpCircle, Sparkles, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "../utils/supabase";
import { analyzeSampleBalance, defaultProportions, solveEdgeFlows, flowGraphToSteps } from "../utils/stepGraph";
import { useAuth } from "../hooks/useAuth";
import { useExperimentProgress } from "../hooks/useExperimentProgress";
import AuthLoading from "../components/auth-loading";
import AppLayout from "../components/layout/AppLayout";
import SubHeader from "../components/layout/SubHeader";
import ReactFlowApp, { ReactFlowRef } from "../components/react-flow";
import { Node, Edge } from "@xyflow/react";
import Spinner from "../components/ui/spinner";
import IntroductionSelectionModal from "@/app/components/IntroductionSelectionModal";
import AddMeasureModal from "../components/AddMeasureModal";
import type { Measure, MeasureDraft } from "../types/measure";
import { createMeasure, mapMeasureRow } from "../utils/measures";
import { toast } from "sonner";
import Link from "next/link";
import CreditsBanner from "../components/CreditsBanner";
import { useCredits } from "../hooks/useCredits";
import { canRun, estimateRunCredits, formatCredits, runsLeft } from "../utils/credits";

type Sample = {
  id: string; // Changed to string for UUID
  name: string; // Changed from label to name to match Supabase
  desc: string;
  user_id?: string;
  created_at?: string;
  attributes?: any;
  persona?: string;
};

// Samples are now fetched from Supabase dynamically

interface UserData {
  user_email: string;
  user_id: string;
  pic_url: string;
}



/**
 * A step in the process graph. `id`/`previous`/`next`/`sample_proportion`
 * describe the branching structure; steps saved before branching existed have
 * none of them and are read back as a straight chain at 100%.
 */
interface Step {
  id: string;
  previous: string[];
  next: string[];
  sample_proportion: number;
  label: string;
  instructions: string;
  temperature: number;
  measures: Measure[];
  /** `measure` marks a scale put to the persona; an ordinary step has none. */
  kind?: string;
  measure_id?: string | null;
}

// Helper: should we restore simulation fields from localStorage? (only when not modify/new and on client)
function readSimulationFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return !params.get('modify') && params.get('new') !== 'true';
}

function SimulationPageContent() {
  const searchParams = useSearchParams();
  const modifyExperimentId = searchParams.get('modify');
  const isNewSimulation = searchParams.get('new') === 'true';
  const folderIdParam = searchParams.get('folder');
  const { user, isLoading, isAuthenticated } = useAuth();
  const { credits, refresh: refreshCredits } = useCredits(isAuthenticated);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [processDescription, setProcessDescription] = useState(() =>
    readSimulationFromStorage() ? (localStorage.getItem('simulation-description') ?? '') : ''
  );
  const [processTitle, setProcessTitle] = useState(() =>
    readSimulationFromStorage() ? (localStorage.getItem('simulation-title') ?? '') : ''
  );
  const [studyIntroduction, setStudyIntroduction] = useState(() =>
    readSimulationFromStorage() ? (localStorage.getItem('simulation-introduction') ?? '') : ''
  );
  const [selectedSample, setSelectedSample] = useState(() =>
    readSimulationFromStorage() ? (localStorage.getItem('simulation-sample') ?? '') : ''
  );
  const [selectedModel, setSelectedModel] = useState(() =>
    // There is no localStorage while this renders on the server; the model
    // the user last picked is read back once it reaches the browser.
    (typeof window === 'undefined' ? null : localStorage.getItem('simulation-model')) ?? 'gemini'
  );
  const [sampleSizeInput, setSampleSizeInput] = useState<string>(() => {
    if (!readSimulationFromStorage()) return '10';
    const saved = localStorage.getItem('simulation-sample-size');
    if (saved === null) return '10';
    const num = parseInt(saved, 10);
    const clamped = Number.isNaN(num) ? 10 : Math.min(50, Math.max(10, num));
    return String(clamped);
  });
  const [sampleSize, setSampleSize] = useState<number>(() => {
    if (!readSimulationFromStorage()) return 10;
    const saved = localStorage.getItem('simulation-sample-size');
    if (saved === null) return 10;
    const num = parseInt(saved, 10);
    return Number.isNaN(num) ? 10 : Math.min(50, Math.max(10, num));
  });
  const [sampleSizeError, setSampleSizeError] = useState<string>("");
  const [isSampleSizeFocused, setIsSampleSizeFocused] = useState(false);
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [selectedColor, setSelectedColor] = useState<string>('#ffffff');
  const [colorArmed, setColorArmed] = useState<boolean>(false); // Track if a color is ready to be applied
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [loadingMeasures, setLoadingMeasures] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [contentLoaded, setContentLoaded] = useState(false);
  const [isLoadingExperiment, setIsLoadingExperiment] = useState(false);
  const [isGeneratingSteps, setIsGeneratingSteps] = useState(false);
  const [simulationTaskId, setSimulationTaskId] = useState<string | null>(null);
  const [simulationProgress, setSimulationProgress] = useState<number | null>(null);
  const [isSimulationRunning, setIsSimulationRunning] = useState(false);
  const [showIntroductionModal, setShowIntroductionModal] = useState(false);
  // The shared "add measure" form, opened from a measure node on the canvas.
  const [showAddMeasureModal, setShowAddMeasureModal] = useState(false);
  const [pendingMeasureNodeId, setPendingMeasureNodeId] = useState<string | null>(null);
  const [generatedIntroduction, setGeneratedIntroduction] = useState<string>("");
  const [titleError, setTitleError] = useState<string>("");
  const [showNoMeasuresConfirm, setShowNoMeasuresConfirm] = useState(false);
  const [showSubmittedModal, setShowSubmittedModal] = useState(false);
  const router = useRouter();

  const progressState = useExperimentProgress(
    simulationTaskId,
    user?.user_id ?? null,
    isSimulationRunning && !!simulationTaskId
  );
  const reactFlowRef = useRef<ReactFlowRef>(null);
  const hasInitiallyLoadedRef = useRef(false);
  const loadedModifyExperimentIdRef = useRef<string | null>(null);
  const originalExperimentDataRef = useRef<any>(null); // Store original experiment data for comparison
  const [simulationHasBeenRun, setSimulationHasBeenRun] = useState(false);

  const getUserData = async (userId: string) => {
    const { data, error } = await supabase
      .from("user_emails")
      .select("user_email, user_id, pic_url")
      .eq("user_id", userId)
      .single();

    if (error) {
      console.error("Error fetching user data:", error);
    } else {
      setUserData(data);
    }
  };

  const getMeasures = async (userId: string) => {
    setLoadingMeasures(true);
    try {
      const { data, error } = await supabase
        .from("measures")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error fetching measures:", error);
        setMeasures([]);
        return;
      }

      const formattedMeasures: Measure[] = data.map((measure: any) => mapMeasureRow(measure));

      setMeasures(formattedMeasures);
    } catch (error) {
      console.error("Error processing measures data:", error);
      setMeasures([]);
    } finally {
      setLoadingMeasures(false);
      setContentLoaded(true);
    }
  };

  const getSamples = async (userId: string) => {
    setLoadingSamples(true);
    try {
      const { data, error } = await supabase
        .from("samples")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error fetching samples:", error);
        setSamples([]);
        return;
      }

      // Transform Supabase data to match our interface
      const formattedSamples: Sample[] = data.map((sample: any) => ({
        id: sample.id,
        name: sample.name,
        desc: `Sample created on ${new Date(sample.created_at).toLocaleDateString()} with ${Array.isArray(sample.attributes) ? sample.attributes.length : 0} attribute(s)`,
        user_id: sample.user_id,
        created_at: sample.created_at,
        attributes: sample.attributes,
        persona: sample.persona || ""
      }));

      setSamples(formattedSamples);
    } catch (error) {
      console.error("Error processing samples data:", error);
      setSamples([]);
    } finally {
      setLoadingSamples(false);
    }
  };

  const handleGenerateSteps = async () => {
    const requestId = `frontend-${Date.now()}`;
    
    // Validate that process description is provided
    if (!processDescription || processDescription.trim() === '') {
      console.warn(`[${requestId}] Validation failed: process description is empty`);
      alert("Please enter a study description before generating steps.");
      return;
    }

    setIsGeneratingSteps(true);
    
    try {
      // Get the user's Supabase access token
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError) {
        console.error(`[${requestId}] Error getting session:`, sessionError);
        throw new Error(`Session error: ${sessionError.message}`);
      }
      
      const accessToken = session?.access_token;
      if (!accessToken) {
        console.error(`[${requestId}] No access token found`);
        throw new Error("No Supabase access token found");
      }

      // Define backend URL based on environment
      const prod = process.env.NEXT_PUBLIC_DEV || "production";
      const url =
        prod === "development"
          ? "http://127.0.0.1:5000/api/generate-steps"
          : "https://cognition-backend-81313456654.us-west1.run.app/api/generate-steps";

      // Call the backend API
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ 
          prompt: processDescription,
          title: processTitle || '',
          introduction: studyIntroduction || ''
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[${requestId}] Response not OK. Status: ${response.status}, Body:`, errorText);
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }

      const result = await response.json();

      if (result.status === "success" && result.data) {
        
        // Convert the backend response to the format expected by convertStepsToFlow
        const stepsData = result.data;
        
        // Extract generated introduction if present
        const newIntroduction = stepsData.introduction || "";
        
        const convertedSteps: any[] = [];

        // Extract all step keys (step01, step02, etc.) and sort them
        const stepKeys = Object.keys(stepsData)
          .filter(key => key.startsWith('step'))
          .sort((a, b) => {
            // Extract numbers from step01, step02, etc. and sort numerically
            const numA = parseInt(a.replace('step', '')) || 0;
            const numB = parseInt(b.replace('step', '')) || 0;
            return numA - numB;
          });

        // Keep only the steps we can actually build a node from, then map the
        // backend's "step01" keys onto the numeric node ids the canvas uses.
        const usableKeys = stepKeys.filter((stepKey) => {
          const step = stepsData[stepKey];
          if (step && step.title && step.instructions) return true;
          console.warn(`[${requestId}] Skipping invalid step ${stepKey}:`, step);
          return false;
        });
        const nodeIdByKey = new Map<string, string>(
          usableKeys.map((stepKey, index) => [stepKey, `${index + 1}`])
        );

        // A branching design arrives with "next" on the steps; without it the
        // steps are a straight line and are chained in order.
        const isBranching = usableKeys.some(
          (stepKey) => Array.isArray(stepsData[stepKey].next) && stepsData[stepKey].next.length > 0
        );

        usableKeys.forEach((stepKey, index) => {
          const step = stepsData[stepKey];
          const nodeId = nodeIdByKey.get(stepKey)!;

          const nextIds = isBranching
            ? ((step.next || []) as string[])
                .map((target: string) => nodeIdByKey.get(target))
                .filter((target): target is string => Boolean(target))
            : (index < usableKeys.length - 1 ? [`${index + 2}`] : []);

          convertedSteps.push({
            id: nodeId,
            next: nextIds,
            // normalize_graph on the backend fills `previous` in from `next`;
            // convertStepsToFlow does the same when rebuilding the canvas.
            previous: [],
            sample_proportion: typeof step.sample_proportion === 'number'
              ? step.sample_proportion
              : null,
            label: step.title,
            instructions: step.instructions,
            temperature: 0.5, // Default temperature
            measures: [], // Empty measures array - user can add measures later
          });
        });

        // A branching design the model didn't put proportions on falls back to
        // an even split at every branch, so the whole sample is always used.
        const generatedEdges = convertedSteps.flatMap((step) =>
          (step.next as string[]).map((target) => ({ source: step.id as string, target }))
        );
        const evenSplit = defaultProportions(
          convertedSteps.map((step) => step.id as string),
          generatedEdges
        );
        convertedSteps.forEach((step) => {
          if (typeof step.sample_proportion !== 'number') {
            step.sample_proportion = evenSplit.get(step.id) ?? 100;
          }
        });

        if (convertedSteps.length > 0) {
          // Convert steps to flow nodes and edges
          const { nodes, edges } = convertStepsToFlow(convertedSteps);
          
          // Update the React Flow
          if (reactFlowRef.current) {
            reactFlowRef.current.setNodesAndEdges(nodes, edges);
          }
          
          setFlowNodes(nodes);
          setFlowEdges(edges);

          // Handle introduction
          if (newIntroduction) {
            if (studyIntroduction && studyIntroduction.trim()) {
              // Show modal to choose between old and new introduction
              setGeneratedIntroduction(newIntroduction);
              setShowIntroductionModal(true);
            } else {
              // No existing introduction, just set the new one
              setStudyIntroduction(newIntroduction);
            }
          }

          // When title box is empty, use generated title from backend or fallback from context
          if (!processTitle || !processTitle.trim()) {
            const generatedTitle = (stepsData.title || '').trim();
            if (generatedTitle) {
              setProcessTitle(generatedTitle);
            } else if (stepsData.study_context_and_instructions?.context) {
              const context = stepsData.study_context_and_instructions.context;
              const suggestedTitle = context.split('.')[0].trim().substring(0, 50);
              if (suggestedTitle) {
                setProcessTitle(suggestedTitle);
              }
            }
          }

          // Clear the study description text box after successful generation
          setProcessDescription("");

          alert(`Successfully generated ${convertedSteps.length} step(s)!`);
        } else {
          console.warn(`[${requestId}] No valid steps were generated`);
          alert("No valid steps were generated. Please try again with a more detailed description.");
        }
      } else {
        console.error(`[${requestId}] Response indicates failure:`, result);
        throw new Error(result.message || 'Failed to generate steps');
      }
    } catch (error) {
      console.error(`[${requestId}] Error generating steps:`, error);
      if (error instanceof Error) {
        console.error(`[${requestId}] Error name: ${error.name}`);
        console.error(`[${requestId}] Error message: ${error.message}`);
        console.error(`[${requestId}] Error stack:`, error.stack);
      }
      alert(`Error generating steps: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsGeneratingSteps(false);
    }
  };

  // Check if a simulation name already exists (case-insensitive)
  const checkSimulationNameExists = async (name: string, excludeExperimentId?: string): Promise<boolean> => {
    if (!user || !name.trim()) return false;
    
    try {
      // Query all experiments for the user and check for matching titles
      const { data, error } = await supabase
        .from("experiments")
        .select("experiment_id, experiment_data")
        .eq("user_id", user.user_id);

      if (error) {
        console.error("Error checking for duplicate names:", error);
        return false; // Allow operation to proceed if check fails
      }

      const normalizedName = name.trim().toLowerCase();
      return (data || []).some(exp => {
        const expTitle = (exp.experiment_data?.title || "").toLowerCase();
        return expTitle === normalizedName && exp.experiment_id !== excludeExperimentId;
      });
    } catch (error) {
      console.error("Error in name check:", error);
      return false;
    }
  };

  // Generate a unique "Untitled Simulation", "Untitled Simulation 1", "Untitled Simulation 2", ... name
  const getUniqueUntitledName = async (excludeExperimentId?: string): Promise<string> => {
    const base = "Untitled";
    if (!await checkSimulationNameExists(base, excludeExperimentId)) return base;
    let counter = 1;
    while (await checkSimulationNameExists(`${base}-${counter}`, excludeExperimentId)) {
      counter++;
    }
    return `${base}-${counter}`;
  };

  const handleCopySimulation = async () => {
    if (!user || !modifyExperimentId) return;
    try {
      const { data, error } = await supabase
        .from("experiments")
        .select("*")
        .eq("experiment_id", modifyExperimentId)
        .single();
      if (error || !data) { alert("Error loading simulation for copy. Please try again."); return; }
      const expData = data.experiment_data || {};
      const originalTitle = (expData.title || expData.simulation_name || "Simulation").trim() || "Simulation";
      let copyName = `${originalTitle} (Copy)`;
      let counter = 1;
      while (await checkSimulationNameExists(copyName)) {
        counter++;
        copyName = `${originalTitle} (Copy ${counter})`;
      }
      const { error: insertError } = await supabase.from("experiments").insert({
        experiment_id: crypto.randomUUID(),
        user_id: user.user_id,
        experiment_data: { ...expData, title: copyName, ...(typeof expData.simulation_name !== "undefined" ? { simulation_name: copyName } : {}) },
        status: "Draft",
        sample_name: data.sample_name ?? "",
        folder_id: data.folder_id ?? null,
        created_at: new Date().toISOString(),
      });
      if (insertError) { alert("Error creating copy. Please try again."); return; }
      alert("Copy created and saved as a draft. Open it from the dashboard to edit or run.");
    } catch (err) {
      alert(`Error copying simulation: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  // Handle study title change with validation
  const handleStudyTitleChange = async (title: string) => {
    setProcessTitle(title);
    
    // Check for duplicate title if not empty
    if (title.trim()) {
      const isDuplicate = await checkSimulationNameExists(title, modifyExperimentId || undefined);
      if (isDuplicate) {
        setTitleError(`A simulation with the name "${title.trim()}" already exists.`);
      } else {
        setTitleError("");
      }
    } else {
      setTitleError("");
    }
  };

  const handleSaveDraft = async () => {
    try {
      // Get the user from auth (only requirement for saving a draft)
      if (!user || !isAuthenticated) {
        alert("Please log in to save drafts.");
        return;
      }

      const excludeId = modifyExperimentId || undefined;
      let titleToSave = (processTitle || "").trim();

      if (!titleToSave) {
        // Auto-generate unique untitled name
        titleToSave = await getUniqueUntitledName(excludeId);
      } else {
        // Enforce unique simulation name (case-insensitive); exclude current experiment when updating
        const nameExists = await checkSimulationNameExists(titleToSave, excludeId);
        if (nameExists) {
          setTitleError(`A simulation with the name "${titleToSave}" already exists. Please choose a different name.`);
          alert(`A simulation with the name "${titleToSave}" already exists. Please choose a different name.`);
          return;
        }
      }
      setTitleError("");

      // Drafts can be incomplete: no sample, no steps, or empty title is allowed.
      const selectedSampleDetails = getSelectedSampleDetails();

      // Convert React Flow nodes to the expected format
      const orderedSteps = convertFlowNodesToSteps(flowNodes, flowEdges);

      // Build draft payload; sample is optional (include only if selected)
      const experimentData: Record<string, unknown> = {
        seed: "no-seed",
        steps: orderedSteps,
        iters: Math.min(50, Math.max(10, sampleSize)),
        temperature: 0.5,
        user_id: user.user_id,
        title: titleToSave,
        description: processDescription || "",
        study_introduction: studyIntroduction || "",
        model: selectedModel,
      };
      if (selectedSampleDetails) {
        experimentData.sample = {
          id: selectedSampleDetails.id,
          name: selectedSampleDetails.name,
          user_id: selectedSampleDetails.user_id,
          created_at: selectedSampleDetails.created_at,
          attributes: selectedSampleDetails.attributes,
          persona: selectedSampleDetails.persona
        };
      }

      let data, error;

      // If we're modifying an existing experiment, update it; otherwise create a new draft
      if (modifyExperimentId) {
        // Check if the experiment exists and is a draft
        const { data: existingExperiment } = await supabase
          .from("experiments")
          .select("status")
          .eq("experiment_id", modifyExperimentId)
          .eq("user_id", user.user_id)
          .single();

        if (existingExperiment && existingExperiment.status === "Draft") {
          // Update existing draft (experiments table has no updated_at column)
          const result = await supabase
            .from("experiments")
            .update({
              experiment_data: experimentData,
              sample_name: selectedSampleDetails?.name ?? "",
            })
            .eq("experiment_id", modifyExperimentId)
            .eq("user_id", user.user_id)
            .select()
            .single();

          data = result.data;
          error = result.error;
        } else {
          // Create a new draft (the existing experiment is not a draft)
          const draftId = crypto.randomUUID();
          const result = await supabase
            .from("experiments")
            .insert({
              experiment_id: draftId,
              user_id: user.user_id,
              experiment_data: experimentData,
              status: "Draft",
              sample_name: selectedSampleDetails?.name ?? "",
              folder_id: folderIdParam || null,
              created_at: new Date().toISOString()
            })
            .select()
            .single();

          data = result.data;
          error = result.error;
        }
      } else {
        // Create a new draft
        const draftId = crypto.randomUUID();
        const result = await supabase
          .from("experiments")
          .insert({
            experiment_id: draftId,
            user_id: user.user_id,
            experiment_data: experimentData,
            status: "Draft",
            sample_name: selectedSampleDetails?.name ?? "",
            folder_id: folderIdParam || null,
            created_at: new Date().toISOString()
          })
          .select()
          .single();

        data = result.data;
        error = result.error;
      }

      if (error) {
        console.error("Error saving draft:", error);
        alert(`Error saving draft: ${error.message}`);
        return;
      }

      alert("Draft saved successfully!");
    } catch (error) {
      console.error("Error saving draft:", error);
      alert(`Error saving draft: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleClearAll = () => {
    // Clear form fields
    setProcessDescription("");
    setProcessTitle("");
    setStudyIntroduction("");
    setSelectedSample("");
    setSampleSizeInput("10");
    setSampleSize(10);
    setSampleSizeError("");
    setTitleError("");
    
    // Clear React Flow
    if (reactFlowRef.current) {
      reactFlowRef.current.clearFlow();
    }
    
    // Clear localStorage
    localStorage.removeItem('simulation-flow');
    localStorage.removeItem('simulation-title');
    localStorage.removeItem('simulation-description');
    localStorage.removeItem('simulation-introduction');
    localStorage.removeItem('simulation-sample');
    localStorage.removeItem('simulation-sample-size');
    localStorage.removeItem('last-loaded-modify-experiment-id');
    
    // Reset the modify experiment ref
    loadedModifyExperimentIdRef.current = null;
  };

  const convertFlowNodesToSteps = (nodes: Node[], edges: Edge[]): Step[] =>
    flowGraphToSteps(nodes, edges, (selectedMeasureIds) =>
      measures.filter(measure => selectedMeasureIds.includes(measure.id))
    ) as Step[];

  // Rough credit estimate for the current design (samples × steps).
  const stepCount = useMemo(() => {
    try {
      return convertFlowNodesToSteps(flowNodes, flowEdges).length;
    } catch {
      return 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowNodes, flowEdges, measures]);
  const runEstimate = useMemo(
    () => (credits ? estimateRunCredits(Math.min(50, Math.max(10, sampleSize)), stepCount, credits) : null),
    [credits, sampleSize, stepCount]
  );
  const hasEnoughCredits = canRun(credits);

  // Helper function to compare two experiment data objects
  // Returns true if they are identical (same title, sample.id, and steps)
  const areExperimentsIdentical = (original: any, newData: any): boolean => {
    // Compare title
    if ((original.title || '') !== (newData.title || '')) {
      return false;
    }

    // Compare sample ID
    if ((original.sample?.id || '') !== (newData.sample?.id || '')) {
      return false;
    }

    // Compare steps (label, instructions, temperature)
    const originalSteps = original.steps || [];
    const newSteps = newData.steps || [];

    if (originalSteps.length !== newSteps.length) {
      return false;
    }

    for (let i = 0; i < originalSteps.length; i++) {
      const origStep = originalSteps[i];
      const newStep = newSteps[i];

      const sameBranching =
        JSON.stringify(origStep.previous || []) === JSON.stringify(newStep.previous || []) &&
        JSON.stringify(origStep.next || []) === JSON.stringify(newStep.next || []) &&
        (origStep.sample_proportion ?? 100) === (newStep.sample_proportion ?? 100);

      if (
        (origStep.label || '') !== (newStep.label || '') ||
        (origStep.instructions || '') !== (newStep.instructions || '') ||
        (origStep.temperature || 0) !== (newStep.temperature || 0) ||
        (origStep.kind || '') !== (newStep.kind || '') ||
        (origStep.measure_id || '') !== (newStep.measure_id || '') ||
        !sameBranching
      ) {
        return false;
      }
    }

    return true;
  };

  // Does every step's share of the sample add up? The canvas highlights the
  // steps that don't, and the run button stays greyed out until they do.
  const sampleBalance = useMemo(
    () =>
      analyzeSampleBalance(
        flowNodes.map(node => ({
          id: node.id,
          sampleProportion:
            typeof node.data?.sampleProportion === 'number' ? node.data.sampleProportion : 100,
        })),
        flowEdges.map(edge => ({ source: edge.source, target: edge.target }))
      ),
    [flowNodes, flowEdges]
  );
  const sampleIsUnbalanced = flowNodes.length > 0 && !sampleBalance.isBalanced;

  const validateFlow = () => {
    const errors: string[] = [];
    
    // Check if there are any nodes
    if (flowNodes.length === 0) {
      errors.push("Please add at least one node to your flow");
      return { isValid: false, errors };
    }
    
    // 1. Check that all steps have title and description. A measure node has
    // neither - it carries a measure, checked on its own below.
    const stepNodes = flowNodes.filter(node => node.type !== 'measure');
    const measureNodes = flowNodes.filter(node => node.type === 'measure');
    const measureById = new Map(measures.map(measure => [measure.id, measure]));

    const nodesWithoutTitle = stepNodes.filter(node => !node.data?.title || (node.data.title as string).trim() === '');
    const nodesWithoutDescription = stepNodes.filter(node => !node.data?.description || (node.data.description as string).trim() === '');
    
    if (nodesWithoutTitle.length > 0) {
      errors.push(`Node(s) are missing titles`);
    }
    
    if (nodesWithoutDescription.length > 0) {
      errors.push(`Node(s) are missing descriptions`);
    }

    // 1b. Every measure node needs a measure that still exists and has items.
    for (const node of measureNodes) {
      const measureId = (node.data?.measureId as string) || null;
      const name = ((node.data?.title as string) || '').trim();
      const nodeName = name || `Measure "${node.id}"`;

      if (!measureId) {
        errors.push(
          `${nodeName} has no measure selected. Choose one, or delete the node. `
        );
        continue;
      }

      const measure = measureById.get(measureId);
      if (!measure) {
        errors.push(
          `${nodeName} points at a measure that no longer exists. Choose another one. `
        );
        continue;
      }

      if (!measure.items || measure.items.length === 0) {
        errors.push(
          `"${measure.title}" has no items, so there is nothing for a persona to answer. ` +
          "Add items to the measure on the Measures page. "
        );
      }
    }
    
    // 2. Check the graph: one first step, everything reachable, no loops, and
    // sample proportions that add up.
    const getNodeLabel = (node: Node) => {
      const name = (node.data?.title as string)?.trim();
      if (name) return name;
      if (node.type === 'measure') {
        const measure = measureById.get((node.data?.measureId as string) || '');
        return measure ? measure.title : `Measure "${node.id}"`;
      }
      return `"${node.id}"`;
    };

    // Results are keyed by node name, so two nodes answering to the same one
    // would land in the same column.
    const labelCounts = new Map<string, Node[]>();
    for (const node of flowNodes) {
      const label = getNodeLabel(node);
      labelCounts.set(label, [...(labelCounts.get(label) || []), node]);
    }
    for (const [label, sharing] of labelCounts.entries()) {
      if (sharing.length > 1) {
        errors.push(
          `${sharing.length} nodes are called ${label}. Give each one its own name so their results can be told apart. `
        );
      }
    }
    const nodeById = new Map(flowNodes.map(node => [node.id, node]));
    const proportionOf = (nodeId: string) => {
      const value = nodeById.get(nodeId)?.data?.sampleProportion;
      return typeof value === 'number' ? value : 100;
    };

    const childrenOf = new Map<string, string[]>(flowNodes.map(node => [node.id, []]));
    const parentsOf = new Map<string, string[]>(flowNodes.map(node => [node.id, []]));
    for (const edge of flowEdges) {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
      childrenOf.get(edge.source)!.push(edge.target);
      parentsOf.get(edge.target)!.push(edge.source);
    }

    const startingNodes = flowNodes.filter(node => parentsOf.get(node.id)!.length === 0);

    if (flowNodes.length > 1) {
      if (startingNodes.length === 0) {
        errors.push(
          "Flow must have one first step with no arrow pointing into it. " +
          "Right now every step has an arrow coming in, so there’s no clear start. "
        );
      } else if (startingNodes.length > 1) {
        const names = startingNodes.slice(0, 5).map(getNodeLabel).join(", ");
        const more = startingNodes.length > 5 ? ` and ${startingNodes.length - 5} more` : "";
        errors.push(
          `There are ${startingNodes.length} steps with no arrow pointing into them (${names}${more}). ` +
          "A simulation must have exactly one first step - connect the extras into the flow. "
        );
      } else {
        // Traverse from the starting node to check every step is reachable
        const visited = new Set<string>();
        const queue = [startingNodes[0].id];

        while (queue.length > 0) {
          const currentNodeId = queue.shift()!;
          if (visited.has(currentNodeId)) continue;
          visited.add(currentNodeId);
          for (const childId of childrenOf.get(currentNodeId)!) {
            if (!visited.has(childId)) queue.push(childId);
          }
        }

        const unvisitedNodes = flowNodes.filter(node => !visited.has(node.id));
        if (unvisitedNodes.length > 0) {
          const labels = unvisitedNodes.slice(0, 5).map(getNodeLabel).join(", ");
          const more = unvisitedNodes.length > 5 ? ` and ${unvisitedNodes.length - 5} more` : "";
          errors.push(
            `${unvisitedNodes.length} step(s) cannot be reached: ${labels}${more}. ` +
            "Every step must be reachable by following arrows from the first step. "
          );
        }
      }
    }

    // 3. How the samples are split across the steps
    const sampleTotal = Math.min(50, Math.max(10, sampleSize));
    /** A step's share of the sample, read back as whole samples. */
    const samplesIn = (percent: number) => Math.round((percent * sampleTotal) / 100);
    const formatSamples = (count: number) => `${count} ${count === 1 ? 'sample' : 'samples'}`;

    if (startingNodes.length === 1 && Math.abs(proportionOf(startingNodes[0].id) - 100) > 0.01) {
      errors.push(
        `The first step (${getNodeLabel(startingNodes[0])}) must use all ` +
        `${formatSamples(sampleTotal)}, but is set to ` +
        `${formatSamples(samplesIn(proportionOf(startingNodes[0].id)))}. `
      );
    }

    for (const node of flowNodes) {
      const proportion = proportionOf(node.id);
      if (proportion <= 0 || proportion > 100) {
        errors.push(
          `${getNodeLabel(node)} is set to ${formatSamples(samplesIn(proportion))}. ` +
          `Every step must get at least one sample and at most all ${sampleTotal}. `
        );
      }
    }

    // Solve the actual flow along each arrow, exactly as the backend does, so
    // the canvas never accepts a design the backend would reject.
    const { unusedSupply, unmetDemand } = solveEdgeFlows(
      flowNodes.map(node => ({ id: node.id, sampleProportion: proportionOf(node.id) })),
      flowEdges.map(edge => ({ source: edge.source, target: edge.target }))
    );

    for (const [nodeId, leftover] of unusedSupply.entries()) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const names = childrenOf.get(nodeId)!.map(id => getNodeLabel(nodeById.get(id)!)).join(", ");
      errors.push(
        `The steps after ${getNodeLabel(node)} (${names}) take ` +
        `${formatSamples(samplesIn(proportionOf(nodeId) - leftover))}, but ` +
        `${getNodeLabel(node)} passes on ${formatSamples(samplesIn(proportionOf(nodeId)))}. ` +
        `${formatSamples(samplesIn(leftover))} have nowhere to go - raise the count on one of the arrows leaving it. `
      );
    }

    for (const [nodeId, shortfall] of unmetDemand.entries()) {
      if (unusedSupply.has(nodeId)) continue;
      const node = nodeById.get(nodeId);
      if (!node) continue;
      errors.push(
        `${getNodeLabel(node)} is set to ${formatSamples(samplesIn(proportionOf(nodeId)))} but only ` +
        `${formatSamples(samplesIn(proportionOf(nodeId) - shortfall))} reach it from the steps before it. ` +
        "Lower the count on the arrow into it, or raise the steps feeding into it. "
      );
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  };

  const handleSubmitSimulation = async () => {
    
    // Validate the flow
    const validation = validateFlow();
    
    if (!validation.isValid) {
      const diagnosis = validation.errors.length === 1
        ? validation.errors[0]
        : "Several issues need fixing:\n\n" + validation.errors.map((e, i) => `${i + 1}. ${e}`).join("\n\n");
      alert("Can’t run simulation\n\n" + diagnosis);
      return;
    }

    // Validate that a sample is selected
    if (!selectedSample) {
      alert("Please select a sample before submitting the simulation.");
      return;
    }

    // Check if any measures are selected across all nodes - a measure node
    // carries one of its own, so a flow of scales counts.
    const hasMeasures = flowNodes.some((node: Node) => {
      if (node.type === 'measure') return !!node.data?.measureId;
      const selectedMeasures = (node.data?.selectedMeasures as string[]) || [];
      return selectedMeasures.length > 0;
    });

    // If no measures are selected, show confirmation modal
    if (!hasMeasures) {
      setShowNoMeasuresConfirm(true);
      return;
    }

    // Proceed with submission if measures are selected or user confirmed
    await proceedWithSubmission();
  };

  const proceedWithSubmission = async () => {
    setShowNoMeasuresConfirm(false);

    // Credit check (the backend enforces this too and returns 402).
    const latestCredits = await refreshCredits();
    if (latestCredits && !canRun(latestCredits)) {
      toast.error("Not enough credits", {
        description: `You need at least ${formatCredits(latestCredits.min_balance_usd, latestCredits)} credits to run a simulation.`,
        action: { label: "Buy credits", onClick: () => router.push("/account?tab=billing") },
      });
      return;
    }

    // Validate sample size (10-50) – use current input when focused, else committed value
    const rawSize = isSampleSizeFocused ? parseInt(sampleSizeInput.trim(), 10) : sampleSize;
    const isEmpty = sampleSizeInput.trim() === "";
    const size = isEmpty || Number.isNaN(rawSize) ? 10 : Math.min(50, Math.max(10, rawSize));
    if (isEmpty || Number.isNaN(rawSize) || rawSize < 10 || rawSize > 50) {
      if (isSampleSizeFocused) setIsSampleSizeFocused(false);
      setSampleSizeError(isEmpty ? "Sample size is required." : rawSize < 10 ? "Sample size must be at least 10." : rawSize > 50 ? "Sample size must be at most 50." : "Enter a valid sample size (10–50).");
      alert("Please enter a valid sample size between 10 and 50.");
      return;
    }

    // Validate title is not empty
    const titleToUse = (processTitle || "").trim();
    if (!titleToUse) {
      alert("Please enter a simulation title before running.");
      return;
    }

    // Check for duplicate title right before running (in case state was stale or another sim was created)
    const isDuplicate = await checkSimulationNameExists(titleToUse, modifyExperimentId || undefined);
    if (isDuplicate) {
      setTitleError(`A simulation with the name "${titleToUse}" already exists.`);
      alert(`A simulation with the name "${titleToUse}" already exists. Please choose a different title.`);
      return;
    }
    setTitleError("");

    // Optimistic update: show running state and popup immediately (backend may be cold on Cloud Run)
    // Reuse the draft's experiment ID so the draft row gets updated instead of creating a duplicate
    const uuid = modifyExperimentId || crypto.randomUUID();

    // Get the user from local storage
    let parsedUser = null;
    const storedUser = localStorage.getItem("supabaseUser");
    if (storedUser) {
      try {
        parsedUser = JSON.parse(storedUser);
      } catch (e) {
        console.error("Error parsing user:", e);
      }
    }

    if (!parsedUser?.id) {
      alert("User session missing. Please refresh and try again.");
      return;
    }

    const selectedSampleDetails = getSelectedSampleDetails();
    if (!selectedSampleDetails) {
      alert("Selected sample not found. Please refresh and try again.");
      return;
    }

    const orderedSteps = convertFlowNodesToSteps(flowNodes, flowEdges);
    const jsonData = {
      seed: "no-seed",
      steps: orderedSteps,
      iters: Math.min(50, Math.max(10, sampleSize)),
      temperature: 0.5,
      user_id: parsedUser?.id,
      title: processTitle || "Simulation Flow",
      study_introduction: studyIntroduction || "",
      model: selectedModel,
      sample: {
        id: selectedSampleDetails.id,
        name: selectedSampleDetails.name,
        user_id: selectedSampleDetails.user_id,
        created_at: selectedSampleDetails.created_at,
        attributes: selectedSampleDetails.attributes,
        persona: selectedSampleDetails.persona
      }
    };

    // Set state and localStorage immediately so dashboard can show the simulation right away
    setIsSimulationRunning(true);
    setSimulationProgress(0);
    setSimulationTaskId(uuid);
    localStorage.setItem('simulation-task-id', uuid);
    const pendingInfo = {
      taskId: uuid,
      title: titleToUse,
      sample_name: selectedSampleDetails.name,
      created_at: new Date().toISOString()
    };
    localStorage.setItem('simulation-pending', JSON.stringify(pendingInfo));

    // Show popup immediately so user can go straight to dashboard
    setShowSubmittedModal(true);

    // Fire backend request in background (do not block; server may need to warm up)
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (!accessToken) {
          throw new Error("No Supabase access token found");
        }

        const prod = process.env.NEXT_PUBLIC_DEV || "production";
        const url =
          prod === "development"
            ? "http://127.0.0.1:5000/api/evaluate"
            : "https://cognition-backend-81313456654.us-west1.run.app/api/evaluate";

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ id: uuid, data: jsonData }),
        });

        const result = await response.json().catch(() => ({}));

        if (response.status === 402) {
          const err = new Error(result.message || "Not enough credits to run this simulation.");
          (err as any).insufficientCredits = true;
          throw err;
        }
        if (result.status !== "started") {
          throw new Error(result.message || "Simulation failed to start");
        }

        // Success: tell the user how many free runs they have left.
        const after = await refreshCredits();
        if (after) {
          const est = estimateRunCredits(jsonData.iters, orderedSteps.length, after);
          const freeAfterUsd = Math.max(0, after.free_usd - after.reserved_usd);
          toast.success("Simulation started", {
            description:
              after.free_usd > 0
                ? `Estimated ~${est.expected} credits. About ${runsLeft(freeAfterUsd, after)} free runs left (${formatCredits(freeAfterUsd, after)} free credits).`
                : `Estimated ~${est.expected} credits, charged from your purchased credits when the run finishes.`,
          });
        }
      } catch (error) {
        setIsSimulationRunning(false);
        setSimulationProgress(null);
        setSimulationTaskId(null);
        setShowSubmittedModal(false);
        localStorage.removeItem('simulation-task-id');
        localStorage.removeItem('simulation-pending');
        if ((error as any)?.insufficientCredits) {
          void refreshCredits();
          toast.error("Not enough credits", {
            description: (error as Error).message,
            action: { label: "Buy credits", onClick: () => router.push("/account?tab=billing") },
          });
        } else {
          alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    })();
  };

  const handleFlowDataChange = (nodes: Node[], edges: Edge[]) => {
    setFlowNodes(nodes);
    setFlowEdges(edges);
  };

  // Handle completion/failure from Realtime progress updates
  const hasHandledCompletionRef = useRef(false);
  useEffect(() => {
    if (!progressState.isComplete && !progressState.isFailed) return;
    if (hasHandledCompletionRef.current) return;
    hasHandledCompletionRef.current = true;

    setIsSimulationRunning(false);
    setSimulationTaskId(null);
    setSimulationProgress(null);
    localStorage.removeItem("simulation-task-id");
    localStorage.removeItem("simulation-pending");
    // The charge is applied just after the run is marked Completed.
    setTimeout(() => void refreshCredits(), 3000);

    if (progressState.isFailed) {
      alert("Simulation failed. Please check your experiment settings and try again.");
    } else {
      alert("Simulation completed successfully! You can view the results in the Dashboard.");
    }
  }, [progressState.isComplete, progressState.isFailed]);

  // Reset completion handler when starting a new simulation
  useEffect(() => {
    if (isSimulationRunning && simulationTaskId) {
      hasHandledCompletionRef.current = false;
    }
  }, [isSimulationRunning, simulationTaskId]);

  const getSelectedSampleDetails = () => {
    return samples.find(sample => sample.id === selectedSample);
  };

  const handleNodeDelete = useCallback((nodeId: string) => {
    setFlowNodes((nds: Node[]) => nds.filter((node: Node) => node.id !== nodeId));
    setFlowEdges((eds: Edge[]) => eds.filter((edge: Edge) => edge.source !== nodeId && edge.target !== nodeId));
  }, []);

  const handleTitleChange = useCallback((nodeId: string, title: string) => {
    setFlowNodes((nds: Node[]) =>
      nds.map((node: Node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, title } } : node
      )
    );
  }, []);

  const handleDescriptionChange = useCallback((nodeId: string, description: string) => {
    setFlowNodes((nds: Node[]) =>
      nds.map((node: Node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, description } } : node
      )
    );
  }, []);

  const handleSliderChange = useCallback((nodeId: string, value: number) => {
    setFlowNodes((nds: Node[]) =>
      nds.map((node: Node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, sliderValue: value } } : node
      )
    );
  }, []);

  const handleMeasuresChange = useCallback((nodeId: string, selectedMeasures: string[]) => {
    setFlowNodes((nds: Node[]) =>
      nds.map((node: Node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, selectedMeasures } } : node
      )
    );
  }, []);

  const handleMeasureNodeSelect = useCallback((nodeId: string, measureId: string | null) => {
    setFlowNodes((nds: Node[]) =>
      nds.map((node: Node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, measureId } } : node
      )
    );
  }, []);

  /**
   * Save a measure created from the canvas, and give it to the node that
   * asked. The canvas re-reads `measures` on the next render, so the new one
   * shows up in every dropdown without any further wiring.
   */
  const handleAddMeasureFromCanvas = useCallback(async (draft: MeasureDraft) => {
    if (!userData?.user_id) {
      console.error("No user found");
      return;
    }

    try {
      const measure = await createMeasure(userData.user_id, draft);
      if (!measure) return;

      setMeasures(prev => [measure, ...prev]);
      if (pendingMeasureNodeId) {
        reactFlowRef.current?.selectMeasureForNode(pendingMeasureNodeId, measure.id);
        handleMeasureNodeSelect(pendingMeasureNodeId, measure.id);
      }
    } catch (error) {
      console.error("Error adding measure from the canvas:", error);
      alert(`Could not save the measure.\n\n${(error as Error).message}`);
    }
    setPendingMeasureNodeId(null);
  }, [userData, pendingMeasureNodeId, handleMeasureNodeSelect]);

  /** A measure node asked for a measure that doesn't exist yet. */
  const handleRequestAddMeasure = useCallback((nodeId: string) => {
    setPendingMeasureNodeId(nodeId);
    setShowAddMeasureModal(true);
  }, []);

  const convertStepsToFlow = (steps: any[]): { nodes: Node[], edges: Edge[] } => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    if (!steps || steps.length === 0) return { nodes, edges };

    const nodeWidth = 400; // Default node width
    const gapBetweenNodes = 50; // Gap between nodes to show arrows
    const nodeSpacing = nodeWidth + gapBetweenNodes; // Total spacing (450 pixels)
    const rowSpacing = 700; // Vertical gap between parallel branches
    const startY = 200; // Y position for the first branch
    const startX = 100; // Starting X position

    // Steps saved before branching existed carry no graph keys, so read them
    // back as the straight chain they were.
    const hasGraph = steps.some(
      (step) => step?.id !== undefined && step?.id !== null
    );

    const idFor = (step: any, index: number) =>
      hasGraph ? String(step.id) : `${index + 1}`;

    const stepIds = steps.map(idFor);
    const knownIds = new Set(stepIds);

    const parentsOf = new Map<string, string[]>();
    const childrenOf = new Map<string, string[]>();
    for (const id of stepIds) {
      parentsOf.set(id, []);
      childrenOf.set(id, []);
    }

    const addEdgeBetween = (sourceId: string, targetId: string) => {
      if (!knownIds.has(sourceId) || !knownIds.has(targetId)) return;
      if (childrenOf.get(sourceId)!.includes(targetId)) return;
      childrenOf.get(sourceId)!.push(targetId);
      parentsOf.get(targetId)!.push(sourceId);
    };

    steps.forEach((step, index) => {
      const nodeId = stepIds[index];
      if (hasGraph) {
        // Read both directions; either one alone is enough to rebuild an edge.
        for (const parentId of (step.previous || [])) addEdgeBetween(String(parentId), nodeId);
        for (const childId of (step.next || [])) addEdgeBetween(nodeId, String(childId));
      } else if (index < steps.length - 1) {
        addEdgeBetween(nodeId, stepIds[index + 1]);
      }
    });

    // Lay out by depth: each step sits one column right of its deepest parent,
    // and parallel branches stack vertically.
    const depthOf = new Map<string, number>();
    const indegree = new Map<string, number>(
      stepIds.map(id => [id, parentsOf.get(id)!.length])
    );
    const queue = stepIds.filter(id => indegree.get(id) === 0);
    queue.forEach(id => depthOf.set(id, 0));
    const visitOrder: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      visitOrder.push(current);
      for (const childId of childrenOf.get(current)!) {
        depthOf.set(childId, Math.max(depthOf.get(childId) ?? 0, (depthOf.get(current) ?? 0) + 1));
        indegree.set(childId, indegree.get(childId)! - 1);
        if (indegree.get(childId) === 0) queue.push(childId);
      }
    }

    const rowInDepth = new Map<number, number>();
    steps.forEach((step, index) => {
      const nodeId = stepIds[index];
      const depth = depthOf.get(nodeId) ?? 0;
      const row = rowInDepth.get(depth) ?? 0;
      rowInDepth.set(depth, row + 1);

      const sampleProportion =
        typeof step.sample_proportion === 'number' ? step.sample_proportion : 100;
      // A measure node saved a `kind`; anything without one is an ordinary
      // step, which is how every experiment saved before scales reads back.
      const isMeasure = step.kind === 'measure' || step.kind === 'scale';

      nodes.push({
        id: nodeId,
        type: isMeasure ? 'measure' : 'custom',
        position: { x: startX + (depth * nodeSpacing), y: startY + (row * rowSpacing) },
        data: isMeasure
          ? {
              title: step.label || '',
              measureId: step.measure_id ?? step.measures?.[0]?.id ?? null,
              sampleProportion,
              measures: measures,
              loadingMeasures: loadingMeasures,
              onDelete: handleNodeDelete,
              onTitleChange: handleTitleChange,
              onMeasureNodeSelect: handleMeasureNodeSelect,
            }
          : {
              title: step.label || '',
              description: step.instructions || '',
              sliderValue: (step.temperature || 0.5) * 100,
              sampleProportion,
              numDescriptionsChars: 500,
              selectedMeasures: step.measures?.map((m: any) => m.id) || [],
              measures: measures,
              loadingMeasures: loadingMeasures,
              onDelete: handleNodeDelete,
              onTitleChange: handleTitleChange,
              onDescriptionChange: handleDescriptionChange,
              onSliderChange: handleSliderChange,
              onMeasuresChange: handleMeasuresChange,
            }
      });
    });

    for (const [sourceId, targets] of childrenOf.entries()) {
      for (const targetId of targets) {
        edges.push({
          id: `edge-${sourceId}-${targetId}`,
          source: sourceId,
          target: targetId,
          style: { stroke: '#3b82f6', strokeWidth: 2 },
          markerEnd: {
            type: 'ArrowClosed' as any,
            color: '#3b82f6',
          },
        });
      }
    }

    return { nodes, edges };
  };

  const handleIntroductionSelect = useCallback((introduction: string) => {
    setStudyIntroduction(introduction);
    setShowIntroductionModal(false);
    setGeneratedIntroduction("");
  }, []);

  const handleRealign = useCallback(() => {
    if (flowNodes.length === 0) return;

    const nodeWidth = 400; // Default node width
    const gapBetweenNodes = 50; // Gap between nodes to show arrows
    const nodeSpacing = nodeWidth + gapBetweenNodes; // Total spacing (450 pixels)
    const rowSpacing = 700; // Vertical gap between parallel branches
    const startY = 200; // Y position for the first branch
    const startX = 100; // Starting X position

    // Lay out by depth so parallel branches sit in their own rows rather than
    // being stacked on top of each other.
    const childrenOf = new Map<string, string[]>(flowNodes.map(node => [node.id, []]));
    const indegree = new Map<string, number>(flowNodes.map(node => [node.id, 0]));
    for (const edge of flowEdges) {
      if (!childrenOf.has(edge.source) || !indegree.has(edge.target)) continue;
      childrenOf.get(edge.source)!.push(edge.target);
      indegree.set(edge.target, indegree.get(edge.target)! + 1);
    }

    const depthOf = new Map<string, number>();
    const queue = flowNodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
    queue.forEach(id => depthOf.set(id, 0));
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const childId of childrenOf.get(current)!) {
        depthOf.set(childId, Math.max(depthOf.get(childId) ?? 0, (depthOf.get(current) ?? 0) + 1));
        indegree.set(childId, indegree.get(childId)! - 1);
        if (indegree.get(childId) === 0) queue.push(childId);
      }
    }

    const rowInDepth = new Map<number, number>();
    const realignedNodes = [...flowNodes]
      .sort((a, b) => (depthOf.get(a.id) ?? 0) - (depthOf.get(b.id) ?? 0))
      .map((node) => {
        const depth = depthOf.get(node.id) ?? 0;
        const row = rowInDepth.get(depth) ?? 0;
        rowInDepth.set(depth, row + 1);
        return {
          ...node,
          position: { x: startX + (depth * nodeSpacing), y: startY + (row * rowSpacing) }
        };
      });

    // Update nodes state
    setFlowNodes(realignedNodes);

    // Center the view after realignment using the ReactFlow ref
    setTimeout(() => {
      if (reactFlowRef.current) {
        reactFlowRef.current.setNodesAndEdges(realignedNodes, flowEdges);
      }
    }, 100);
  }, [flowNodes, flowEdges]);

  const loadExperimentForModification = async (experimentId: string) => {
    setIsLoadingExperiment(true);
    try {
      // Clear any running simulation state when modifying an experiment
      setIsSimulationRunning(false);
      setSimulationTaskId(null);
      setSimulationProgress(null);
      localStorage.removeItem('simulation-task-id');
      localStorage.removeItem('simulation-pending');

      const { data, error } = await supabase
        .from("experiments")
        .select("*")
        .eq("experiment_id", experimentId)
        .single();

      if (error) {
        console.error("Error fetching experiment:", error);
        alert("Error loading experiment for modification");
        return;
      }

      let experimentData = data.experiment_data;
      if (typeof experimentData === "string") {
        try {
          experimentData = JSON.parse(experimentData);
        } catch {
          experimentData = {};
        }
      }
      if (!experimentData || typeof experimentData !== "object") {
        experimentData = {};
      }

      // If simulation has already been run (not a draft), show read-only mode
      const status = (data.status || "").toString().toLowerCase();
      const isDraft = status === "draft";
      setSimulationHasBeenRun(!isDraft);

      // Store original experiment data for comparison when submitting
      originalExperimentDataRef.current = JSON.parse(JSON.stringify(experimentData));

      // Prepopulate form fields
      setProcessTitle(experimentData.title || "");
      setProcessDescription(experimentData.description || experimentData.process_description || "");
      setStudyIntroduction(experimentData.study_introduction || experimentData.introduction || "");

      // Import sample: prefer experiment_data.sample.id, else resolve by sample name from row or payload
      let sampleId = experimentData.sample?.id || experimentData.sample_id || "";
      if (!sampleId && (data.sample_name || experimentData.sample?.name)) {
        const name = (data.sample_name || experimentData.sample?.name) as string;
        const match = samples.find((s) => s.name === name);
        if (match) sampleId = match.id;
      }
      setSelectedSample(sampleId);

      // Restore model selection
      if (experimentData.model && typeof experimentData.model === 'string') {
        setSelectedModel(experimentData.model);
      }

      // Import sample size (iters) with fallbacks and clamp 10–50
      const rawIters = experimentData.iters ?? experimentData.sample_size ?? (data as any).sample_size;
      const itersNum =
        typeof rawIters === "number" && !Number.isNaN(rawIters)
          ? Math.min(50, Math.max(10, rawIters))
          : 10;
      setSampleSizeInput(String(itersNum));
      setSampleSize(itersNum);
      setSampleSizeError("");
      
      // Convert steps to flow nodes and edges
      if (experimentData.steps && experimentData.steps.length > 0) {
        const { nodes, edges } = convertStepsToFlow(experimentData.steps);
        
        // Update the React Flow
        if (reactFlowRef.current) {
          reactFlowRef.current.setNodesAndEdges(nodes, edges);
        }
        
        setFlowNodes(nodes);
        setFlowEdges(edges);
      }
      
    } catch (error) {
      console.error("Error loading experiment:", error);
      alert("Error loading experiment for modification");
    } finally {
      setIsLoadingExperiment(false);
    }
  };

  useEffect(() => {
    if (user && isAuthenticated && !hasInitiallyLoadedRef.current) {
      hasInitiallyLoadedRef.current = true;
      getUserData(user.user_id);
      getMeasures(user.user_id);
      getSamples(user.user_id);
    } else if (!user || !isAuthenticated) {
      // Reset the ref when user logs out
      hasInitiallyLoadedRef.current = false;
      setMeasures([]);
      setSamples([]);
      setContentLoaded(false);
    }
  }, [user?.user_id, isAuthenticated]);

  // Clear form and flow when starting a new simulation (cache is only cleared on Clear All)
  useEffect(() => {
    if (isNewSimulation && !modifyExperimentId) {
      setProcessDescription("");
      setProcessTitle("");
      setStudyIntroduction("");
      setSelectedSample("");
      setSimulationHasBeenRun(false);
      if (reactFlowRef.current) {
        reactFlowRef.current.clearFlow();
      }
      loadedModifyExperimentIdRef.current = null;
      const url = new URL(window.location.href);
      url.searchParams.delete('new');
      window.history.replaceState({}, '', url.toString());
    }
  }, [isNewSimulation, modifyExperimentId]);

  // Reset read-only state when no longer modifying an experiment
  useEffect(() => {
    if (!modifyExperimentId) {
      setSimulationHasBeenRun(false);
    }
  }, [modifyExperimentId]);

  // Load title, description, introduction, and sample size from localStorage on mount (only if not in modify mode and not new simulation)
  useEffect(() => {
    if (!modifyExperimentId && !isNewSimulation) {
      const savedTitle = localStorage.getItem('simulation-title');
      if (savedTitle) {
        setProcessTitle(savedTitle);
      }
      const savedDescription = localStorage.getItem('simulation-description');
      if (savedDescription !== null) {
        setProcessDescription(savedDescription);
      }
      const savedIntroduction = localStorage.getItem('simulation-introduction');
      if (savedIntroduction !== null) {
        setStudyIntroduction(savedIntroduction);
      }
      const savedSampleSize = localStorage.getItem('simulation-sample-size');
      if (savedSampleSize !== null) {
        const num = parseInt(savedSampleSize, 10);
        const clamped = Number.isNaN(num) ? 10 : Math.min(50, Math.max(10, num));
        setSampleSizeInput(String(clamped));
        setSampleSize(clamped);
        setSampleSizeError("");
      }
    }
  }, [modifyExperimentId, isNewSimulation]);

  // Save to localStorage when we have values; never remove here so refresh doesn't wipe cache
  // (clear only on "new simulation" or "clear all")
  useEffect(() => {
    if (processTitle) {
      localStorage.setItem('simulation-title', processTitle);
    }
  }, [processTitle]);

  useEffect(() => {
    if (studyIntroduction) {
      localStorage.setItem('simulation-introduction', studyIntroduction);
    }
  }, [studyIntroduction]);

  useEffect(() => {
    if (processDescription) {
      localStorage.setItem('simulation-description', processDescription);
    }
  }, [processDescription]);

  useEffect(() => {
    if (sampleSize >= 10 && sampleSize <= 50) {
      localStorage.setItem('simulation-sample-size', String(sampleSize));
    }
  }, [sampleSize]);

  // When samples load, validate selectedSample (from lazy init or localStorage) and clear if invalid
  useEffect(() => {
    if (!modifyExperimentId && !isNewSimulation && samples.length > 0) {
      const savedSample = localStorage.getItem('simulation-sample');
      if (savedSample) {
        const sampleExists = samples.some(sample => sample.id === savedSample);
        if (sampleExists) {
          setSelectedSample(savedSample);
        } else {
          localStorage.removeItem('simulation-sample');
          setSelectedSample('');
        }
      }
    }
  }, [modifyExperimentId, isNewSimulation, samples.length]);

  // Save selected sample to localStorage when set; never remove here so refresh doesn't wipe cache
  useEffect(() => {
    if (selectedSample) {
      localStorage.setItem('simulation-sample', selectedSample);
    }
  }, [selectedSample]);

  // Load experiment data when in modify mode (only once per experiment ID per session)
  // Use in-memory ref only so that a full page refresh re-loads from Supabase and restores title/description
  useEffect(() => {
    if (modifyExperimentId && user && isAuthenticated && samples.length > 0 && measures.length > 0 && !isLoadingExperiment) {
      if (loadedModifyExperimentIdRef.current !== modifyExperimentId) {
        loadedModifyExperimentIdRef.current = modifyExperimentId;
        loadExperimentForModification(modifyExperimentId);
      }
    } else if (!modifyExperimentId) {
      loadedModifyExperimentIdRef.current = null;
      originalExperimentDataRef.current = null;
      localStorage.removeItem('last-loaded-modify-experiment-id');
    }
  }, [modifyExperimentId, user, isAuthenticated, samples.length, measures.length]);

  // Load simulation task_id from localStorage on mount (only if not in modify mode)
  useEffect(() => {
    if (user && isAuthenticated && !modifyExperimentId) {
      const savedTaskId = localStorage.getItem('simulation-task-id');
      if (savedTaskId) {
        setSimulationTaskId(savedTaskId);
        setIsSimulationRunning(true);
        setSimulationProgress(0);
      }
    }
  }, [user, isAuthenticated, modifyExperimentId]);

  if (isLoading) {
    return <AuthLoading message="Loading simulation..." />;
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <AppLayout 
      currentPage="simulation" 
      headerTitle=""
      userData={userData}
    >
      {!simulationHasBeenRun && <CreditsBanner credits={credits} />}
      {simulationHasBeenRun && (
        <div className="w-full bg-red-400/85 text-white px-2 py-1 text-center text-xs font-medium">
          This simulation has already been run and cannot be modified. You can copy the simulation from the dashboard and then edit the copy.
        </div>
      )}
      <SubHeader
        title="Simulation Whiteboard"
        description="Design and visualize your simulation flow"
      >
        <div className="flex items-center gap-3">
          {!simulationHasBeenRun && sampleIsUnbalanced && (
            <span className="text-xs text-red-600 max-w-[16rem] text-right leading-tight">
              The steps don’t use exactly 100% of the sample.
            </span>
          )}
          {!simulationHasBeenRun && credits && !hasEnoughCredits && (
            <span className="text-xs text-red-600 max-w-[16rem] text-right leading-tight">
              You need at least {formatCredits(credits.min_balance_usd, credits)} credits to run.{" "}
              <Link href="/account?tab=billing" className="underline font-medium">Buy credits</Link>
            </span>
          )}
          {!simulationHasBeenRun && runEstimate && stepCount > 0 && (
            <span
              className="text-xs text-gray-500 text-right leading-tight whitespace-nowrap"
              title={`Rough estimate for ${Math.min(50, Math.max(10, sampleSize))} samples × ${stepCount} steps, including the run fee. Actual cost depends on response length.`}
            >
              Est. cost: ~{runEstimate.expected} credits
              <span className="text-gray-400"> ({runEstimate.low}–{runEstimate.high})</span>
            </span>
          )}
          <Button
            type="button"
            onClick={handleSaveDraft}
            variant="outline"
            className="flex items-center gap-2"
            disabled={simulationHasBeenRun}
          >
            <Save className="w-4 h-4" />
            Save Draft
          </Button>
          {simulationHasBeenRun ? (
            <Button
              type="button"
              onClick={handleCopySimulation}
              className="bg-gray-900 hover:bg-gray-700 text-white flex items-center gap-2"
            >
              Make a Copy
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleSubmitSimulation}
              disabled={
                isSimulationRunning ||
                (!!credits && !hasEnoughCredits) ||
                !!titleError ||
                sampleIsUnbalanced ||
                (isSampleSizeFocused
                  ? sampleSizeInput.trim() === "" ||
                    Number.isNaN(parseInt(sampleSizeInput.trim(), 10)) ||
                    parseInt(sampleSizeInput.trim(), 10) < 10 ||
                    parseInt(sampleSizeInput.trim(), 10) > 50
                  : !!sampleSizeError)
              }
              title={
                sampleIsUnbalanced
                  ? "The steps don't use the whole sample. Fix the sample counts on the arrows to run the simulation."
                  : credits && !hasEnoughCredits
                  ? `You need at least ${formatCredits(credits.min_balance_usd, credits)} credits to run a simulation.`
                  : undefined
              }
              className="bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              {isSimulationRunning
                ? `Simulation in progress: ${Math.round(progressState.progress ?? simulationProgress ?? 0)}%`
                : "Submit for Simulation"
              }
            </Button>
          )}
        </div>
      </SubHeader>

      <div className="flex h-full">
        {!contentLoaded ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-3 text-gray-500">
              <Spinner size="lg" />
              <span>Loading simulation tools...</span>
            </div>
          </div>
        ) : (
          <>
            {/* Left Sidebar - Tools */}
            <div className={`w-56 bg-white border-r border-gray-200 p-4 space-y-6 transition-opacity duration-500 overflow-y-auto ${contentLoaded ? 'opacity-100' : 'opacity-0'}`}>
          {/* Describe Your Study */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">
              Describe Your Study
            </h3>
            <textarea
              placeholder="Describe the study you want to simulate..."
              value={processDescription}
              onChange={(e) => setProcessDescription(e.target.value)}
              disabled={isGeneratingSteps || simulationHasBeenRun}
              readOnly={simulationHasBeenRun}
              className="w-full h-32 px-3 py-2 text-sm bg-white border border-gray-200 rounded resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed mb-2"
            />
            <Button 
              onClick={handleGenerateSteps}
              disabled={isGeneratingSteps || simulationHasBeenRun}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              {isGeneratingSteps ? (
                <>
                  <Spinner size="sm" />
                  <span>Generating...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate Design
                </>
              )}
            </Button>
          </div>

          {/* Colors Section */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm font-semibold text-gray-700">Colors</h3>
              <div className="relative group">
                <Info className="w-4 h-4 text-gray-400 cursor-help" />
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                  Color selection is for visual organization and does not affect simulation functionality
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[
                { color: '#3b82f6', name: 'blue' },
                { color: '#ef4444', name: 'red' },
                { color: '#10b981', name: 'green' },
                { color: '#eab308', name: 'yellow' },
                { color: '#8b5cf6', name: 'purple' },
                { color: '#ec4899', name: 'pink' },
                { color: '#6b7280', name: 'gray' },
                { color: '#ffffff', name: 'remove', isRemove: true },
              ].map((colorOption) => (
                <div
                  key={colorOption.color}
                  onClick={() => {
                    setSelectedColor(colorOption.color);
                    setColorArmed(true); // Arm the color for application
                  }}
                  className={`w-6 h-6 rounded cursor-pointer border-2 flex items-center justify-center ${
                    colorArmed && selectedColor === colorOption.color
                      ? 'border-blue-500 ring-2 ring-blue-300' 
                      : selectedColor === colorOption.color 
                      ? 'border-gray-400 ring-2 ring-gray-300' 
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                  style={{ backgroundColor: colorOption.color }}
                  title={colorArmed && selectedColor === colorOption.color 
                    ? `Click a node to apply ${colorOption.isRemove ? 'no color' : colorOption.name}` 
                    : colorOption.isRemove ? 'Remove color' : `Select ${colorOption.name}`}
                >
                  {colorOption.isRemove && (
                    <div className="text-red-500 font-bold text-sm leading-none">×</div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                className="flex-1 text-xs"
                onClick={handleClearAll}
                disabled={simulationHasBeenRun}
              >
                Clear All
              </Button>
              <Button 
                variant="outline" 
                className="flex-1 text-xs"
                onClick={handleRealign}
                disabled={simulationHasBeenRun}
              >
                Realign
              </Button>
            </div>
            {/* Undo/Redo buttons - commented out until functionality is implemented */}
            {/* <div className="flex gap-1">
              <Button 
                variant="outline" 
                size="sm" 
                className="flex-1 p-1"
                onClick={() => reactFlowRef.current?.undo()}
                disabled={!reactFlowRef.current?.canUndo()}
                title="Undo"
              >
                <RotateCcw className="w-3 h-3" />
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                className="flex-1 p-1"
                onClick={() => reactFlowRef.current?.redo()}
                disabled={!reactFlowRef.current?.canRedo()}
                title="Redo"
              >
                <RotateCw className="w-3 h-3" />
              </Button>
            </div> */}
          </div>

          {/* Model Selection */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Model:</h3>
            <select
              className={`w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm ${simulationHasBeenRun ? 'cursor-not-allowed opacity-80' : ''}`}
              value={selectedModel}
              onChange={(e) => {
                setSelectedModel(e.target.value);
                localStorage.setItem('simulation-model', e.target.value);
              }}
              disabled={simulationHasBeenRun}
            >
              <option value="gemini">Gemini</option>
            </select>
          </div>

          {/* Pick Sample Section */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-semibold text-gray-700">Sample:</h3>
            </div>
            {loadingSamples ? (
              <div className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm flex items-center justify-center">
                <Spinner size="sm" />
                <span className="ml-2 text-gray-500">Loading samples...</span>
              </div>
            ) : (
              <select 
                className={`w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm ${simulationHasBeenRun ? 'cursor-not-allowed opacity-80' : ''}`}
                value={selectedSample}
                onChange={(e) => setSelectedSample(e.target.value)}
                disabled={simulationHasBeenRun}
                >
                <option value="">Select a sample</option>
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            {!loadingSamples && samples.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">No samples found. Create samples in the Samples page.</p>
            )}

            {/* Sample size input - under sample selection */}
            <div className="mt-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Sample size</label>
              <input
                type="number"
                min={10}
                max={50}
                value={sampleSizeInput}
                onChange={(e) => setSampleSizeInput(e.target.value)}
                onFocus={() => setIsSampleSizeFocused(true)}
                readOnly={simulationHasBeenRun}
                disabled={simulationHasBeenRun}
                onBlur={() => {
                  setIsSampleSizeFocused(false);
                  const raw = sampleSizeInput.trim();
                  if (raw === "") {
                    setSampleSizeInput("10");
                    setSampleSize(10);
                    setSampleSizeError("Sample size is required.");
                    return;
                  }
                  const num = parseInt(raw, 10);
                  if (Number.isNaN(num)) {
                    setSampleSizeInput("10");
                    setSampleSize(10);
                    setSampleSizeError("Enter a valid number.");
                    return;
                  }
                  if (num < 10) {
                    setSampleSizeInput("10");
                    setSampleSize(10);
                    setSampleSizeError("Sample size must be at least 10.");
                  } else if (num > 50) {
                    setSampleSizeInput("50");
                    setSampleSize(50);
                    setSampleSizeError("Sample size must be at most 50.");
                  } else {
                    setSampleSizeInput(String(num));
                    setSampleSize(num);
                    setSampleSizeError("");
                  }
                }}
                className={`w-full px-3 py-2 bg-white border rounded text-sm focus:outline-none focus:ring-2 focus:border-transparent ${simulationHasBeenRun ? 'bg-gray-100 cursor-not-allowed' : ''} ${
                  !isSampleSizeFocused && sampleSizeError
                    ? "border-red-500 focus:ring-red-500"
                    : "border-gray-200 focus:ring-blue-500"
                }`}
              />
              {!isSampleSizeFocused && sampleSizeError && (
                <p className="mt-1 text-xs text-red-600">{sampleSizeError}</p>
              )}
              <p className="mt-0.5 text-xs text-gray-500">Min 10, max 50</p>
            </div>

            {selectedSample && getSelectedSampleDetails() && (
              <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs">
                {Array.isArray(getSelectedSampleDetails()?.attributes) && getSelectedSampleDetails()!.attributes.length > 0 && (
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {getSelectedSampleDetails()!.attributes.map((attr: any, index: number) => (
                      <div key={index} className="text-blue-600">
                        <span className="font-medium">{attr.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col">
          {/* Form Section - Title and Introduction */}
          <div className="bg-gray-50 p-3 border-b border-gray-200 flex-shrink-0">
            <div className="w-full">
              <div className="flex flex-row gap-4">
                {/* Title of Study */}
                <div className="w-[20%]">
                  <h3 className="text-sm font-semibold text-gray-900 mb-1.5">
                    Title of Study
                  </h3>
                  <input
                    type="text"
                    placeholder="Enter study title..."
                    value={processTitle}
                    onChange={(e) => handleStudyTitleChange(e.target.value)}
                    readOnly={simulationHasBeenRun}
                    disabled={simulationHasBeenRun}
                    className={`w-full px-3 py-2 bg-white border rounded-lg focus:outline-none focus:ring-2 focus:border-transparent text-sm h-[58px] ${simulationHasBeenRun ? 'bg-gray-100 cursor-not-allowed' : ''} ${
                      titleError
                        ? 'border-red-500 focus:ring-red-500'
                        : 'border-gray-200 focus:ring-blue-500'
                    }`}
                  />
                  {titleError && (
                    <p className="mt-1 text-xs text-red-600">{titleError}</p>
                  )}
                </div>

                {/* Study Introduction */}
                <div className="w-[80%]">
                  <h3 className="text-sm font-semibold text-gray-900 mb-1.5">
                    Study Introduction
                  </h3>
                  <textarea
                    placeholder="Enter study introduction..."
                    value={studyIntroduction}
                    onChange={(e) => setStudyIntroduction(e.target.value)}
                    readOnly={simulationHasBeenRun}
                    disabled={simulationHasBeenRun}
                    className={`w-full px-3 py-2 bg-white border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm ${simulationHasBeenRun ? 'bg-gray-100 cursor-not-allowed' : ''}`}
                    rows={2}
                  />
                </div>
              </div>
            </div>
          </div>

            {/* Whiteboard Canvas Area */}
            <div className="flex-1 relative overflow-hidden p-6">
              <div className="absolute inset-6">
                <ReactFlowApp 
                  ref={reactFlowRef}
                  onFlowDataChange={handleFlowDataChange} 
                  selectedColor={selectedColor}
                  colorArmed={colorArmed}
                  onColorApplied={() => setColorArmed(false)}
                  measures={measures}
                  loadingMeasures={loadingMeasures}
                  readOnly={simulationHasBeenRun}
                  sampleSize={sampleSize}
                  onRequestAddMeasure={handleRequestAddMeasure}
                />
              </div>
            </div>
          </div>
          </>
        )}
      </div>

      {/* No Measures Confirmation Modal */}
      {showNoMeasuresConfirm && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-yellow-100 rounded-full flex items-center justify-center">
                <Info className="w-5 h-5 text-yellow-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">No Measures Selected</h3>
              </div>
            </div>
            <p className="text-gray-700 mb-6">
              It looks like you haven't chosen any measures for your simulation. Would you still like to continue?
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={() => setShowNoMeasuresConfirm(false)}
                variant="outline"
                className="px-4 py-2"
              >
                Cancel
              </Button>
              <Button
                onClick={proceedWithSubmission}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white"
              >
                Continue
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Introduction Selection Modal */}
      <IntroductionSelectionModal
        isOpen={showIntroductionModal}
        onClose={() => {
          setShowIntroductionModal(false);
          setGeneratedIntroduction("");
        }}
        oldIntroduction={studyIntroduction}
        newIntroduction={generatedIntroduction}
        onSelect={handleIntroductionSelect}
      />

      {/* The same form the Measures page uses, opened from a measure node */}
      <AddMeasureModal
        isOpen={showAddMeasureModal}
        onClose={() => {
          setShowAddMeasureModal(false);
          setPendingMeasureNodeId(null);
        }}
        onAdd={handleAddMeasureFromCanvas}
        checkNameExists={(title: string) =>
          measures.some(measure => measure.title.trim().toLowerCase() === title.trim().toLowerCase())
        }
      />

      {/* Submitted modal: show immediately so user can go straight to dashboard (backend may be warming up) */}
      {showSubmittedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Simulation submitted</h3>
            <p className="text-sm text-gray-600 mb-4">
              Your simulation is in the queue. The server may be warming up—you can go to the Dashboard now to see it and track progress.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowSubmittedModal(false)}>
                Stay
              </Button>
              <Button
                className="bg-blue-600 hover:bg-blue-700 text-white"
                onClick={() => {
                  setShowSubmittedModal(false);
                  router.push("/dashboard");
                }}
              >
                Go to Dashboard
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

export default function SimulationPage() {
  return (
    <Suspense fallback={<AuthLoading message="Loading simulation..." />}>
      <SimulationPageContent />
    </Suspense>
  );
}