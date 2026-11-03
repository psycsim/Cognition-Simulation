"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Play, Trash2, Folder, FolderPlus, FileUp } from "lucide-react";
import { createPortal } from "react-dom";
import { supabase } from "../utils/supabase";
import { flowGraphToSteps } from "../utils/stepGraph";
import { mapMeasureRow } from "../utils/measures";
import { useAuth } from "../hooks/useAuth";
import { useExperimentsProgress } from "../hooks/useExperimentsProgress";
import AuthLoading from "../components/auth-loading";
import { Button } from "../components/ui/button";
import AppLayout from "../components/layout/AppLayout";
import SubHeader from "../components/layout/SubHeader";
import ProjectsTable from "../components/ProjectsTable";
import Spinner from "../components/ui/spinner";
import PDFImportModal, { ParsedStudy } from "../components/PDFImportModal";
import { toSampleAttributesJson } from "../data/attributeCatalog";

interface SimulationHistoryItem {
  created_at: string;
  name: string;
  url: string;
  sample_name?: string;
  status?: string;
}

type Sample = {
  id: string;
  name: string;
  desc: string;
  user_id?: string;
  created_at?: string;
  attributes?: any;
  persona?: string;
};

interface Download {
  date: string;
  id: number;
  url?: string;
  filename?: string;
  created_at?: string;
  sample_size?: number;
  sample_name?: string;
  text_model?: string;
  evaluations_model?: string;
}

interface SimulationStep {
  label: string;
  instructions: string;
  temperature: number;
  measures?: Array<{ id: string; title: string; description: string; range: string }>;
}

interface Folder {
  folder_id: string;
  folder_name: string;
  created_at: string;
  project_count?: number;
}

interface Project {
  name: string;
  sample_name: string;
  sample_size?: number; // Sample size for the simulation
  status: string;
  progress?: number; // Progress percentage for running simulations
  downloads: Download[];
  steps: SimulationStep[];
  created_at?: string;
  id?: string;
  experiment_id?: string; // Backend experiment ID for polling
  configKey?: string; // Configuration key for grouping experiments
  folder_id?: string | null; // Folder ID if project is in a folder
  text_model?: string;
  evaluations_model?: string;
}

interface UserData {
  user_email: string;
  user_id: string;
  pic_url: string;
}

// Mock data for demonstration - replace with real data


export default function DashboardHistory() {
  const router = useRouter();
  const { user, isLoading, isAuthenticated } = useAuth();
  const [history, setHistory] = useState<SimulationHistoryItem[]>([]);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
  const [contentLoaded, setContentLoaded] = useState(false);
  const [projectToRename, setProjectToRename] = useState<{ id: string; name: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [isReplicating, setIsReplicating] = useState(false);
  const [showRunAgainConfirm, setShowRunAgainConfirm] = useState(false);
  const [projectToRunAgain, setProjectToRunAgain] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showPDFImportModal, setShowPDFImportModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [showMoveToFolderModal, setShowMoveToFolderModal] = useState(false);
  const [projectToMove, setProjectToMove] = useState<string | null>(null);
  const [showRenameFolderModal, setShowRenameFolderModal] = useState(false);
  const [folderToRename, setFolderToRename] = useState<{ id: string; name: string } | null>(null);
  const [newFolderRename, setNewFolderRename] = useState("");
  const [showDeleteFolderConfirm, setShowDeleteFolderConfirm] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null);
  const [isDeletingFolder, setIsDeletingFolder] = useState(false);
  const [showDeleteSuccess, setShowDeleteSuccess] = useState(false);
  const [deletedItemName, setDeletedItemName] = useState<string>("");
  const hasInitiallyLoadedRef = useRef(false); // Add this ref to track initial load

  // Replicate modal state
  const [showReplicateModal, setShowReplicateModal] = useState(false);
  const [replicateProjectId, setReplicateProjectId] = useState<string | null>(null);
  const [replicateOriginalData, setReplicateOriginalData] = useState<any>(null);
  const [replicateSamples, setReplicateSamples] = useState<Sample[]>([]);
  const [replicateSampleId, setReplicateSampleId] = useState<string>("");
  const [replicateSampleSize, setReplicateSampleSize] = useState<number>(10);
  const [replicateSampleSizeStr, setReplicateSampleSizeStr] = useState<string>("10");
  const [replicateTextModel, setReplicateTextModel] = useState<string>("gemini");
  const [replicateEvalModel, setReplicateEvalModel] = useState<string>("gemini");
  const [replicateLoadingSamples, setReplicateLoadingSamples] = useState(false);

  // Cache prompt state
  const [showCachePrompt, setShowCachePrompt] = useState(false);
  const [pendingFolderId, setPendingFolderId] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);

  // Helper function to check if a project was created within the last 20 minutes
  const isRecentProject = (createdAt: string | undefined): boolean => {
    if (!createdAt) return false;
    const createdTime = new Date(createdAt).getTime();
    const now = Date.now();
    const twentyMinutesAgo = now - 20 * 60 * 1000;
    return createdTime >= twentyMinutesAgo;
  };

  // Running experiment IDs for Realtime progress subscription
  const runningExperimentIds = projects
    .filter(
      (p) =>
        p.experiment_id &&
        p.status === "Running" &&
        (p.progress === undefined || (typeof p.progress === "number" && p.progress < 100)) &&
        isRecentProject(p.created_at)
    )
    .map((p) => p.experiment_id as string);

  const handleProgressUpdate = useCallback(
    (
      experimentId: string,
      update: {
        progress: number;
        status: string;
        url: string | null;
        isComplete: boolean;
        isFailed: boolean;
        id?: number;
        created_at?: string;
        experiment_data?: { title?: string; simulation_name?: string };
      }
    ) => {
      setProjects((prev) =>
        prev.map((project) => {
          if (project.experiment_id !== experimentId) return project;
          const status = update.isFailed ? "Failed" : update.isComplete ? "Completed" : "Running";
          const progress = update.isComplete || update.isFailed ? undefined : update.progress;
          const updated: Project = { ...project, status, progress };
          if ((update.isComplete || update.isFailed) && update.url) {
            const expData = update.experiment_data || {};
            const newDownload: Download = {
              date: update.created_at ? new Date(update.created_at).toLocaleString() : new Date().toLocaleString(),
              id: update.id ?? 0,
              url: update.url,
              filename: expData.title || expData.simulation_name || project.name,
              created_at: update.created_at,
            };
            const existing = project.downloads || [];
            const alreadyAdded = existing.some((d) => d.id === newDownload.id || d.url === newDownload.url);
            const combined = alreadyAdded
              ? existing
              : [...existing, newDownload].sort((a, b) => {
                  const tA = new Date(a.created_at || a.date).getTime();
                  const tB = new Date(b.created_at || b.date).getTime();
                  return tB - tA;
                });
            updated.downloads = combined;
          }
          return updated;
        })
      );
    },
    []
  );

  useExperimentsProgress(
    runningExperimentIds,
    user?.user_id ?? null,
    handleProgressUpdate
  );

  const getHistory = async (userId: string) => {
    const { data, error } = await supabase.from("dashboard").select("created_at, name, url").eq("user_id", userId);
    if (error) {
      console.error("Error fetching history:", error);
    } else {
      setHistory(data);
    }
  };

  const getUserData = async (userId: string) => {
    const { data, error } = await supabase
      .from("user_emails")
      .select("user_email, user_id, pic_url")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Error fetching user data:", error);
      setUserData(null);
    } else {
      setUserData(data ?? null);
    }
  };

  const getFolders = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from("folders")
        .select("*")
        .eq("user_id", userId)
        .eq("folder_type", "dashboard")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error fetching folders:", error);
        setFolders([]);
        return;
      }

      // Count projects in each folder
      const foldersWithCounts = await Promise.all(
        (data || []).map(async (folder) => {
          const { count, error: countError } = await supabase
            .from("experiments")
            .select("*", { count: "exact", head: true })
            .eq("folder_id", folder.folder_id)
            .eq("user_id", userId);
          
          if (countError) {
            console.error("Error counting projects in folder:", countError);
          }
          
          return {
            ...folder,
            project_count: count || 0
          };
        })
      );

      setFolders(foldersWithCounts);
    } catch (error) {
      console.error("Error processing folders data:", error);
      setFolders([]);
    }
  };

  // Check if a folder name already exists (case-insensitive)
  const isFolderNameTaken = (name: string, excludeFolderId?: string): boolean => {
    const normalizedName = name.trim().toLowerCase();
    return folders.some(folder => 
      folder.folder_name.toLowerCase() === normalizedName && 
      folder.folder_id !== excludeFolderId
    );
  };

  // Check if a simulation name already exists (case-insensitive)
  const isSimulationNameTaken = (name: string, excludeProjectId?: string): boolean => {
    const normalizedName = name.trim().toLowerCase();
    return projects.some(project => 
      project.name.toLowerCase() === normalizedName && 
      project.experiment_id !== excludeProjectId
    );
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !user || isCreatingFolder) {
      return;
    }

    // Check for duplicate folder name
    if (isFolderNameTaken(newFolderName)) {
      alert(`A folder with the name "${newFolderName.trim()}" already exists. Please choose a different name.`);
      return;
    }

    setIsCreatingFolder(true);
    try {
      const folderId = crypto.randomUUID();
      const { error } = await supabase
        .from("folders")
        .insert({
          folder_id: folderId,
          folder_name: newFolderName.trim(),
          user_id: user.user_id,
          folder_type: "dashboard"
        });

      if (error) {
        console.error("Error creating folder:", error);
        alert("Error creating folder. Please try again.");
        return;
      }

      // Refresh folders list
      await getFolders(user.user_id);
      
      // Close modal and reset
      setShowNewFolderModal(false);
      setNewFolderName("");
    } catch (error) {
      console.error("Error in folder creation:", error);
      alert("Error creating folder. Please try again.");
    } finally {
      setIsCreatingFolder(false);
    }
  };

  // Pick a name that isn't already used, appending a numeric suffix if needed.
  // `taken` holds lowercased names and is updated so a single import batch
  // doesn't collide with itself.
  const claimUniqueName = (base: string, taken: Set<string>): string => {
    const fallback = base.trim() || "Untitled";
    let candidate = fallback;
    let counter = 1;
    while (taken.has(candidate.toLowerCase())) {
      counter++;
      candidate = `${fallback} (${counter})`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  };

  // Turn the studies reviewed in the PDF import modal into real records: one
  // dashboard folder, plus a sample, a set of measures, and a draft simulation
  // per study. Samples and measures are written as their own rows so the
  // imported drafts open in the simulation editor with everything wired up.
  const handlePDFImport = async (importFolderName: string, studies: ParsedStudy[]) => {
    if (!user) return;
    const userId = user.user_id;

    try {
      const [sampleRowsResult, measureRowsResult] = await Promise.all([
        supabase.from("samples").select("name").eq("user_id", userId),
        supabase.from("measures").select("title").eq("user_id", userId),
      ]);

      const takenSampleNames = new Set(
        (sampleRowsResult.data || []).map((row: { name: string }) => (row.name || "").toLowerCase())
      );
      const takenMeasureTitles = new Set(
        (measureRowsResult.data || []).map((row: { title: string }) => (row.title || "").toLowerCase())
      );
      const takenFolderNames = new Set(folders.map((folder) => folder.folder_name.toLowerCase()));
      const takenSimulationNames = new Set(projects.map((project) => project.name.toLowerCase()));

      const folderName = claimUniqueName(importFolderName || "Imported Studies", takenFolderNames);
      const folderId = crypto.randomUUID();

      const { error: folderError } = await supabase.from("folders").insert({
        folder_id: folderId,
        folder_name: folderName,
        user_id: userId,
        folder_type: "dashboard",
      });

      if (folderError) {
        console.error("Error creating folder for PDF import:", folderError);
        alert("Error creating the folder for this import. Please try again.");
        return;
      }

      const failedStudies: string[] = [];
      let importedCount = 0;

      for (const study of studies) {
        try {
          // 1. Sample row - attributes use the shape the samples page writes
          const sampleName = claimUniqueName(
            study.sample.name || `${study.title} Sample`,
            takenSampleNames
          );
          const { data: sampleRow, error: sampleError } = await supabase
            .from("samples")
            .insert({
              name: sampleName,
              user_id: userId,
              attributes: toSampleAttributesJson(study.sample.attributes),
            })
            .select()
            .single();

          if (sampleError || !sampleRow) {
            throw sampleError || new Error("Sample could not be created");
          }

          // 2. Measure rows - keyed by the id the parser used inside this study
          const measuresByParsedId = new Map<
            string,
            { id: string; title: string; description: string; range: string; desiredValues: Array<{ value: number; label: string }> }
          >();

          for (const measure of study.measures) {
            if (!measure.title.trim()) continue;

            const measureTitle = claimUniqueName(measure.title, takenMeasureTitles);
            const { data: measureRow, error: measureError } = await supabase
              .from("measures")
              .insert({
                user_id: userId,
                title: measureTitle,
                definition: measure.definition,
                min: measure.minValue,
                max: measure.maxValue,
                desired_values: measure.valueAnchors,
              })
              .select()
              .single();

            if (measureError || !measureRow) {
              throw measureError || new Error("Measure could not be created");
            }

            measuresByParsedId.set(measure.id, mapMeasureRow(measureRow));
          }

          // 3. Draft simulation referencing the rows created above
          const simulationTitle = claimUniqueName(study.title, takenSimulationNames);
          const experimentData = {
            seed: "no-seed",
            // Imported studies are linear, so chain the steps and give every
            // one the whole sample.
            steps: study.steps.map((step, stepIndex) => ({
              id: `${stepIndex + 1}`,
              previous: stepIndex > 0 ? [`${stepIndex}`] : [],
              next: stepIndex < study.steps.length - 1 ? [`${stepIndex + 2}`] : [],
              sample_proportion: 100,
              label: step.label,
              instructions: step.instruction,
              // The review slider uses the 1-100 scale of the step editor;
              // experiment_data stores temperature as a 0-1 fraction.
              temperature: (step.temperature ?? 50) / 100,
              measures: step.measureIds
                .map((measureId) => measuresByParsedId.get(measureId))
                .filter(Boolean),
            })),
            iters: 10,
            temperature: 0.5,
            user_id: userId,
            title: simulationTitle,
            description: study.briefDescription,
            study_introduction: study.studyIntroduction,
            model: "gemini",
            sample: {
              id: sampleRow.id,
              name: sampleRow.name,
              user_id: sampleRow.user_id,
              created_at: sampleRow.created_at,
              attributes: sampleRow.attributes,
              persona: sampleRow.persona || "",
            },
          };

          const { error: experimentError } = await supabase.from("experiments").insert({
            experiment_id: crypto.randomUUID(),
            user_id: userId,
            experiment_data: experimentData,
            status: "Draft",
            sample_name: sampleRow.name,
            folder_id: folderId,
            created_at: new Date().toISOString(),
          });

          if (experimentError) {
            throw experimentError;
          }

          importedCount++;
        } catch (studyError) {
          console.error(`Error importing study "${study.title}":`, studyError);
          failedStudies.push(study.title);
        }
      }

      await Promise.all([getProjects(userId), getFolders(userId)]);

      if (failedStudies.length > 0) {
        alert(
          `Imported ${importedCount} of ${studies.length} studies into "${folderName}".\n\n` +
            `These could not be imported:\n${failedStudies.join("\n")}`
        );
      }
    } catch (error) {
      console.error("Error importing studies from PDF:", error);
      alert(
        `Error importing studies: ${error instanceof Error ? error.message : "Unknown error"}. Please try again.`
      );
    }
  };

  const handleRenameFolder = (folderId: string, currentName: string) => {
    setFolderToRename({ id: folderId, name: currentName });
    setNewFolderRename(currentName);
    setShowRenameFolderModal(true);
  };

  const handleSaveRenameFolder = async () => {
    if (!folderToRename || !newFolderRename.trim() || !user) {
      return;
    }

    // Check for duplicate folder name (excluding current folder)
    if (isFolderNameTaken(newFolderRename, folderToRename.id)) {
      alert(`A folder with the name "${newFolderRename.trim()}" already exists. Please choose a different name.`);
      return;
    }

    try {
      const { error } = await supabase
        .from("folders")
        .update({ folder_name: newFolderRename.trim() })
        .eq("folder_id", folderToRename.id)
        .eq("user_id", user.user_id);

      if (error) {
        console.error("Error renaming folder:", error);
        alert("Error renaming folder. Please try again.");
        return;
      }

      // Refresh folders after successful update
      await getFolders(user.user_id);
      
      // Close modal
      setShowRenameFolderModal(false);
      setFolderToRename(null);
      setNewFolderRename("");
    } catch (error) {
      console.error("Error in folder rename operation:", error);
      alert("Error renaming folder. Please try again.");
    }
  };

  const handleCancelRenameFolder = () => {
    setShowRenameFolderModal(false);
    setFolderToRename(null);
    setNewFolderRename("");
  };

  const handleDeleteFolder = (folderId: string) => {
    const folder = folders.find(f => f.folder_id === folderId);
    if (folder) {
      setFolderToDelete({ id: folderId, name: folder.folder_name });
      setShowDeleteFolderConfirm(true);
    }
  };

  const confirmDeleteFolder = async () => {
    if (!folderToDelete || !user || isDeletingFolder) {
      return;
    }

    setIsDeletingFolder(true);
    try {
      // First, delete all experiments in the folder
      const { data: experiments, error: fetchError } = await supabase
        .from("experiments")
        .select("experiment_id")
        .eq("folder_id", folderToDelete.id)
        .eq("user_id", user.user_id);

      if (fetchError) {
        console.error("Error fetching experiments in folder:", fetchError);
        alert("Error fetching experiments in folder. Please try again.");
        setIsDeletingFolder(false);
        return;
      }

      // Delete all experiments in the folder
      const experimentIds = experiments ? experiments.map(exp => exp.experiment_id) : [];
      if (experimentIds.length > 0) {
        const { error: deleteExperimentsError } = await supabase
          .from("experiments")
          .delete()
          .in("experiment_id", experimentIds)
          .eq("user_id", user.user_id);

        if (deleteExperimentsError) {
          console.error("Error deleting experiments in folder:", deleteExperimentsError);
          alert("Error deleting experiments in folder. Please try again.");
          setIsDeletingFolder(false);
          return;
        }
      }

      // Then delete the folder itself
      const { error: deleteFolderError } = await supabase
        .from("folders")
        .delete()
        .eq("folder_id", folderToDelete.id)
        .eq("user_id", user.user_id);

      if (deleteFolderError) {
        console.error("Error deleting folder:", deleteFolderError);
        alert("Error deleting folder. Please try again.");
        setIsDeletingFolder(false);
        return;
      }

      // Update local state instead of refetching to avoid table flash
      // Remove projects that were in the deleted folder
      setProjects(prevProjects => 
        prevProjects.filter(p => p.folder_id !== folderToDelete.id)
      );
      
      // Remove the folder from folders state
      setFolders(prevFolders => 
        prevFolders.filter(f => f.folder_id !== folderToDelete.id)
      );
      
      // Close modal
      setShowDeleteFolderConfirm(false);
      setFolderToDelete(null);
    } catch (error) {
      console.error("Error in folder delete operation:", error);
      alert(`Error deleting folder: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`);
    } finally {
      setIsDeletingFolder(false);
    }
  };

  const cancelDeleteFolder = () => {
    setShowDeleteFolderConfirm(false);
    setFolderToDelete(null);
  };

  const handleMoveToFolder = async (projectId: string, folderId: string | null) => {
    if (!user) {
      return;
    }

    try {
      // Find the project to get its configKey and folder_id (to move all experiments in the group)
      const project = projects.find(p => p.experiment_id === projectId);
      if (!project) {
        console.error("Project not found");
        alert("Error: Project not found. Please try again.");
        return;
      }

      // Update only the specific experiment (not all in the group)
      // Handle null folderId by explicitly setting it to null (not undefined)
      const oldFolderId = project.folder_id || null;
      const updateData: { folder_id: string | null } = { folder_id: folderId };
      
      const { error: updateError } = await supabase
        .from("experiments")
        .update(updateData)
        .eq("experiment_id", projectId)
        .eq("user_id", user.user_id); // Add user_id filter for security

      if (updateError) {
        console.error("Error moving project to folder:", updateError);
        alert(`Error moving project to folder: ${updateError.message}. Please try again.`);
        return;
      }

      // Update local state instead of refreshing
      // Update projects state - match by experiment_id to move only the specific project
      setProjects(prevProjects => {
        return prevProjects.map(p => {
          // Match the specific project by experiment_id
          if (p.experiment_id === projectId) {
            return {
              ...p,
              folder_id: folderId
            };
          }
          return p;
        });
      });

      // Update folder counts locally
      setFolders(prevFolders => {
        return prevFolders.map(folder => {
          // Decrease count for old folder (if it exists)
          if (oldFolderId && folder.folder_id === oldFolderId) {
            return {
              ...folder,
              project_count: Math.max(0, (folder.project_count || 0) - 1)
            };
          }
          // Increase count for new folder (if it exists and is not null)
          if (folderId && folder.folder_id === folderId) {
            return {
              ...folder,
              project_count: (folder.project_count || 0) + 1
            };
          }
          return folder;
        });
      });
      
      setShowMoveToFolderModal(false);
      setProjectToMove(null);
    } catch (error) {
      console.error("Error in move to folder operation:", error);
      alert(`Error moving project to folder: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`);
    }
  };

  // Helper function to generate a unique key for experiment configuration
  const getExperimentConfigKey = (experimentData: any): string => {
    const title = experimentData.title || '';
    const sampleId = experimentData.sample?.id || '';
    const steps = experimentData.steps || [];
    const stepsKey = JSON.stringify(steps.map((s: any) => ({
      label: s.label,
      instructions: s.instructions,
      temperature: s.temperature,
      // Two runs that differ only in how the sample is split across branches
      // are different configurations, not replicates of the same one.
      previous: s.previous || [],
      next: s.next || [],
      sample_proportion: s.sample_proportion ?? 100
    })));
    return `${title}::${sampleId}::${stepsKey}`;
  };

  const getProjects = async (userId: string) => {
    setLoadingProjects(true);
    try {
      const { data, error } = await supabase
        .from("experiments")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error fetching projects:", error);
        setProjects([]);
        return;
      }

      // First, format all experiments
      const formattedExperiments = data.map((experiment: any, index: number) => {
        const experimentData = experiment.experiment_data || {};
        // Determine status and progress
        let status = experiment.status || "Draft";
        let progress: number | undefined = undefined;
        
        // Normalize status and check for progress
        const statusLower = status.toLowerCase();
        if (statusLower === 'running' || statusLower === 'started' || statusLower === 'in_progress') {
          status = 'Running';
          // Progress might be stored in experiment.progress, experiment.progress_percent, or calculated
          progress = experiment.progress !== undefined ? experiment.progress : 
                     experiment.progress_percent !== undefined ? experiment.progress_percent : 
                     0;
        } else if (statusLower === 'completed' || statusLower === 'done' || statusLower === 'finished') {
          status = 'Completed';
        } else if (statusLower === 'failed' || statusLower === 'error') {
          status = 'Failed';
        }
        
        const sampleName = experimentData.sample?.name || experiment.sample_name || experiment.description || "No seed";
        const configKey = getExperimentConfigKey(experimentData);
        const textModel = experimentData.text_model || experimentData.model || "gemini";
        const evaluationsModel = experimentData.evaluations_model || experimentData.model || "gemini";
        const sampleSize = experimentData.iters ?? experiment.sample_size ?? experimentData.sample_size ?? 10;

        return {
          name: experimentData.title || experiment.simulation_name || `Simulation ${index + 1}`,
          sample_name: sampleName,
          sample_size: sampleSize,
          status: status,
          progress: progress,
          created_at: experiment.created_at,
          id: experiment.experiment_id,
          experiment_id: experiment.experiment_id,
          configKey: configKey, // Add config key for grouping
          folder_id: experiment.folder_id || null, // Include folder_id
          text_model: textModel,
          evaluations_model: evaluationsModel,
          downloads: experiment.url ? [
            {
              date: new Date(experiment.created_at).toLocaleString(),
              id: experiment.id || index + 1,
              url: experiment.url,
              filename: experimentData.title || experiment.simulation_name || `simulation_${experiment.id}`,
              created_at: experiment.created_at,
              sample_size: sampleSize,
              sample_name: sampleName,
              text_model: textModel,
              evaluations_model: evaluationsModel,
            }
          ] : [],
          steps: experimentData.steps && Array.isArray(experimentData.steps) ? 
            experimentData.steps.map((step: any, stepIndex: number) => ({
              label: step.label || `Step ${stepIndex + 1}`,
              instructions: step.instructions || "No instructions provided",
              temperature: (step.temperature !== undefined && step.temperature <= 1 ? step.temperature * 100 : step.temperature) || 50,
              measures: Array.isArray(step.measures) ? step.measures.map((m: any) => ({
                id: m.id,
                title: m.title ?? "",
                description: m.description ?? "",
                range: typeof m.range === "string" ? m.range : (m.min != null && m.max != null ? `${m.min} - ${m.max}` : "")
              })) : undefined
            })) : 
            [
              {
                label: "Default Step",
                instructions: "No steps defined for this experiment",
                temperature: 50
              }
            ]
        };
      });

      // Group experiments by configuration key AND folder_id
      // This ensures projects with the same config but different folders are separate
      const groupedMap = new Map<string, typeof formattedExperiments>();
      formattedExperiments.forEach(exp => {
        // Include folder_id in the grouping key to prevent duplicates across folders
        const folderId = exp.folder_id || 'null';
        const key = `${exp.configKey}::${folderId}`;
        if (!groupedMap.has(key)) {
          groupedMap.set(key, []);
        }
        groupedMap.get(key)!.push(exp);
      });

      // Combine grouped experiments into single projects
      const formattedProjects: Project[] = Array.from(groupedMap.values()).map((group) => {
        // Sort group by created_at (newest first)
        group.sort((a, b) => {
          const dateA = new Date(a.created_at || 0).getTime();
          const dateB = new Date(b.created_at || 0).getTime();
          return dateB - dateA;
        });

        // Use the most recent experiment as the base
        const baseExperiment = group[0];
        
        // Combine all downloads from all experiments in the group
        const allDownloads: Download[] = group
          .flatMap(exp => exp.downloads)
          .sort((a, b) => {
            // Sort downloads by date (newest first)
            const dateA = new Date(a.created_at || a.date).getTime();
            const dateB = new Date(b.created_at || b.date).getTime();
            return dateB - dateA;
          });

        // Determine overall status - if any is running, show running; otherwise show most recent
        const hasRunning = group.some(exp => exp.status === 'Running');
        const overallStatus = hasRunning ? 'Running' : baseExperiment.status;
        const overallProgress = hasRunning ? group.find(exp => exp.status === 'Running')?.progress : baseExperiment.progress;

        return {
          name: baseExperiment.name,
          sample_name: baseExperiment.sample_name,
          sample_size: baseExperiment.sample_size,
          status: overallStatus,
          progress: overallProgress,
          created_at: baseExperiment.created_at, // Use most recent created_at
          id: baseExperiment.id, // Use most recent experiment ID
          experiment_id: baseExperiment.experiment_id,
          folder_id: baseExperiment.folder_id || null, // Include folder_id from base experiment
          text_model: baseExperiment.text_model,
          evaluations_model: baseExperiment.evaluations_model,
          downloads: allDownloads,
          steps: baseExperiment.steps
        };
      });

      // Sort projects by most recent created_at
      formattedProjects.sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime();
        const dateB = new Date(b.created_at || 0).getTime();
        return dateB - dateA;
      });

      // Prepend pending simulation from localStorage so it appears right away (before backend has written to Supabase)
      let projectsToSet = formattedProjects;
      if (typeof window !== "undefined") {
        try {
          const pendingRaw = localStorage.getItem("simulation-pending");
          const pending = pendingRaw ? JSON.parse(pendingRaw) as { taskId: string; title: string; sample_name: string; created_at: string } : null;
          if (pending) {
            const existingIdx = formattedProjects.findIndex((p) => p.experiment_id === pending.taskId);
            const alreadyInList = existingIdx !== -1;
            if (alreadyInList) {
              const existing = formattedProjects[existingIdx];
              if (existing.status === "Running" || existing.status === "Completed" || existing.status === "Failed") {
                // Backend has already updated the row; safe to clear pending
                localStorage.removeItem("simulation-pending");
              } else {
                // Row exists but backend hasn't updated it yet (e.g. draft → started race);
                // force it to "Running" so realtime tracks it
                formattedProjects[existingIdx] = { ...existing, status: "Running", progress: existing.progress ?? 0 };
              }
            } else {
              const placeholder: Project = {
                name: pending.title,
                sample_name: pending.sample_name,
                status: "Running",
                progress: 0,
                created_at: pending.created_at,
                id: pending.taskId,
                experiment_id: pending.taskId,
                downloads: [],
                steps: [{ label: "—", instructions: "Waiting for server…", temperature: 50 }],
              };
              projectsToSet = [placeholder, ...formattedProjects];
            }
          }
        } catch (_) {
          // ignore invalid or missing pending
        }
      }

      setProjects(projectsToSet);
    } catch (error) {
      console.error("Error processing projects data:", error);
      setProjects([]);
    } finally {
      setLoadingProjects(false);
    }
  };

  const handleDownload = async (public_url: string, filename: string) => {
    try {
      const response = await fetch(public_url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `psycsim_${filename.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.xlsx`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error downloading file:", error);
    }
  };

  const handleStartRename = (projectId: string, currentName: string) => {
    setProjectToRename({ id: projectId, name: currentName });
    setNewName(currentName);
  };

  const handleSaveRename = async () => {
    if (!projectToRename || !newName.trim()) {
      return;
    }

    // Check for duplicate simulation name (excluding current project)
    if (isSimulationNameTaken(newName, projectToRename.id)) {
      alert(`A simulation with the name "${newName.trim()}" already exists. Please choose a different name.`);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("experiments")
        .select("experiment_data")
        .eq("experiment_id", projectToRename.id)
        .single();

      if (error) {
        console.error("Error fetching experiment:", error);
        alert("Error renaming project. Please try again.");
        return;
      }

      const updatedExperimentData = {
        ...data.experiment_data,
        title: newName.trim()
      };

      const { error: updateError } = await supabase
        .from("experiments")
        .update({ experiment_data: updatedExperimentData })
        .eq("experiment_id", projectToRename.id);

      if (updateError) {
        console.error("Error updating experiment:", updateError);
        alert("Error renaming project. Please try again.");
        return;
      }

      // Refresh projects after successful update
      if (user) {
        await getProjects(user.user_id);
      }
      
      setProjectToRename(null);
      setNewName("");
    } catch (error) {
      console.error("Error in rename operation:", error);
      alert("Error renaming project. Please try again.");
    }
  };

  const handleCancelRename = () => {
    setProjectToRename(null);
    setNewName("");
  };

  const handleModify = async (projectId: string) => {
    router.push(`/simulation?modify=${projectId}`);
    return true;
  };

  const cacheKeys = [
    'simulation-flow',
    'simulation-title',
    'simulation-description',
    'simulation-introduction',
    'simulation-sample',
    'simulation-sample-size',
  ];

  const hasCachedWork = (): boolean => {
    if (typeof window === 'undefined') return false;
    const textKeys = ['simulation-title', 'simulation-description', 'simulation-introduction', 'simulation-sample'];
    if (textKeys.some((k) => (localStorage.getItem(k) ?? '').trim().length > 0)) return true;
    try {
      const flow = localStorage.getItem('simulation-flow');
      if (flow) {
        const parsed = JSON.parse(flow);
        return (parsed?.nodes?.length ?? 0) > 0;
      }
    } catch {}
    return false;
  };

  const clearSimulationCache = () => {
    cacheKeys.forEach((k) => localStorage.removeItem(k));
  };

  const handleNewSimulation = () => {
    if (hasCachedWork()) {
      setPendingFolderId(null);
      setShowCachePrompt(true);
    } else {
      clearSimulationCache();
      router.push('/simulation?new=true');
    }
  };

  const handleAddSimulationToFolder = (folderId: string) => {
    if (hasCachedWork()) {
      setPendingFolderId(folderId);
      setShowCachePrompt(true);
    } else {
      clearSimulationCache();
      router.push(`/simulation?new=true&folder=${folderId}`);
    }
  };

  const handleCacheDiscard = () => {
    setShowCachePrompt(false);
    clearSimulationCache();
    const url = pendingFolderId ? `/simulation?new=true&folder=${pendingFolderId}` : '/simulation?new=true';
    router.push(url);
  };

  const handleCacheSave = async () => {
    if (!user) {
      handleCacheDiscard();
      return;
    }
    setIsSavingDraft(true);
    try {
      const title = localStorage.getItem('simulation-title') || '';
      const description = localStorage.getItem('simulation-description') || '';
      const studyIntroduction = localStorage.getItem('simulation-introduction') || '';
      const model = localStorage.getItem('simulation-model') || 'gemini';
      const sampleSizeStr = localStorage.getItem('simulation-sample-size') || '10';
      const sampleSize = Math.min(50, Math.max(10, parseInt(sampleSizeStr, 10) || 10));

      // Convert flow nodes to steps, keeping the branching structure
      let steps: any[] = [];
      try {
        const flowData = localStorage.getItem('simulation-flow');
        if (flowData) {
          const flow = JSON.parse(flowData);
          steps = flowGraphToSteps(flow?.nodes || [], flow?.edges || []);
        }
      } catch {}

      // Resolve a unique title, appending "(copy)" if needed
      const getUniqueDraftTitle = async (base: string): Promise<string> => {
        const { data } = await supabase
          .from('experiments')
          .select('experiment_data')
          .eq('user_id', user.user_id);
        const existingTitles = new Set(
          (data || []).map((e: any) => (e.experiment_data?.title || '').toLowerCase())
        );
        if (!existingTitles.has(base.toLowerCase())) return base;
        let candidate = `${base} (copy)`;
        let counter = 2;
        while (existingTitles.has(candidate.toLowerCase())) {
          candidate = `${base} (copy ${counter})`;
          counter++;
        }
        return candidate;
      };

      const rawTitle = title.trim() || 'Untitled';
      const titleToSave = await getUniqueDraftTitle(rawTitle);
      const experimentData = {
        seed: 'no-seed',
        steps,
        iters: sampleSize,
        temperature: 0.5,
        user_id: user.user_id,
        title: titleToSave,
        description,
        study_introduction: studyIntroduction,
        model,
      };

      await supabase.from('experiments').insert({
        experiment_id: crypto.randomUUID(),
        user_id: user.user_id,
        experiment_data: experimentData,
        status: 'Draft',
        sample_name: '',
        folder_id: pendingFolderId || null,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error saving draft:', error);
    }
    setIsSavingDraft(false);
    setShowCachePrompt(false);
    clearSimulationCache();
    const url = pendingFolderId ? `/simulation?new=true&folder=${pendingFolderId}` : '/simulation?new=true';
    router.push(url);
  };

  const handleReplicate = async (projectId: string) => {
    if (!user) return true;

    setReplicateLoadingSamples(true);
    try {
      const { data: expData, error: expError } = await supabase
        .from("experiments")
        .select("*")
        .eq("experiment_id", projectId)
        .single();

      if (expError) {
        console.error("Error fetching experiment:", expError);
        alert("Error loading experiment for replication. Please try again.");
        return true;
      }

      const { data: samplesData } = await supabase
        .from("samples")
        .select("*")
        .eq("user_id", user.user_id);

      const experimentData = expData.experiment_data || {};
      setReplicateOriginalData(expData);
      setReplicateSamples(samplesData || []);
      setReplicateSampleId(experimentData.sample?.id || "");
      const initialSize = experimentData.iters || 10;
      setReplicateSampleSize(initialSize);
      setReplicateSampleSizeStr(String(initialSize));
      setReplicateTextModel(experimentData.text_model || experimentData.model || "gemini");
      setReplicateEvalModel(experimentData.evaluations_model || experimentData.model || "gemini");
      setReplicateProjectId(projectId);
      setShowReplicateModal(true);
    } catch (error) {
      console.error("Error preparing replication:", error);
      alert("Error preparing replication. Please try again.");
    } finally {
      setReplicateLoadingSamples(false);
    }
    return true;
  };

  const confirmReplicate = async () => {
    if (!user || !replicateOriginalData || isReplicating) return;

    setIsReplicating(true);
    try {
      const originalExpData = replicateOriginalData.experiment_data || {};
      const originalSampleId = originalExpData.sample?.id || "";
      const originalSampleSize = originalExpData.iters ?? 10;
      const originalTextModel = originalExpData.text_model || originalExpData.model || "gemini";
      const originalEvalModel = originalExpData.evaluations_model || originalExpData.model || "gemini";

      const sampleChanged = replicateSampleId !== "" && replicateSampleId !== originalSampleId;
      const nothingChanged =
        !sampleChanged &&
        replicateSampleSize === originalSampleSize &&
        replicateTextModel === originalTextModel &&
        replicateEvalModel === originalEvalModel;

      // Build experiment data to run
      let experimentDataToRun = originalExpData;
      if (!nothingChanged) {
        const selectedSampleObj = replicateSampleId
          ? replicateSamples.find((s) => s.id === replicateSampleId)
          : null;
        const sampleToUse = selectedSampleObj
          ? { id: selectedSampleObj.id, name: selectedSampleObj.name, attributes: selectedSampleObj.attributes, persona: selectedSampleObj.persona }
          : originalExpData.sample;
        experimentDataToRun = {
          ...originalExpData,
          iters: replicateSampleSize,
          sample: sampleToUse,
          text_model: replicateTextModel,
          evaluations_model: replicateEvalModel,
          model: replicateTextModel,
        };
      }

      // Call backend API to run the experiment immediately
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error("No Supabase access token found");

      const uuid = crypto.randomUUID();
      const prod = process.env.NEXT_PUBLIC_DEV || "production";
      const apiUrl =
        prod === "development"
          ? "http://127.0.0.1:5000/api/evaluate"
          : "https://cognition-backend-81313456654.us-west1.run.app/api/evaluate";

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ id: uuid, data: experimentDataToRun }),
      });

      const result = await response.json();
      if (result.status === "started") {
        const originalFolderId = replicateOriginalData.folder_id ?? null;
        await supabase
          .from("experiments")
          .update({ folder_id: originalFolderId })
          .eq("experiment_id", uuid);

        await getProjects(user.user_id);
        setShowReplicateModal(false);
        setReplicateProjectId(null);
        setReplicateOriginalData(null);
      } else {
        throw new Error(result.message || "Failed to start experiment");
      }
    } catch (error) {
      console.error("Error replicating experiment:", error);
      alert(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsReplicating(false);
    }
  };

  const cancelReplicate = () => {
    setShowReplicateModal(false);
    setReplicateProjectId(null);
    setReplicateOriginalData(null);
    setReplicateSampleSizeStr("10");
  };

  const handleCopy = async (projectId: string) => {
    if (!user || isReplicating) return true;

    setIsReplicating(true);
    try {
      const { data, error } = await supabase
        .from("experiments")
        .select("*")
        .eq("experiment_id", projectId)
        .single();

      if (error) {
        console.error("Error fetching experiment:", error);
        alert("Error loading experiment for copy. Please try again.");
        return true;
      }

      const expData = data.experiment_data || {};
      const originalTitle = (expData.title || expData.simulation_name || "Simulation").trim() || "Simulation";

      let copyName = `${originalTitle} (Copy)`;
      let counter = 1;
      while (isSimulationNameTaken(copyName)) {
        counter++;
        copyName = `${originalTitle} (Copy ${counter})`;
      }

      const newExperimentId = crypto.randomUUID();
      const copiedExperimentData = {
        ...expData,
        title: copyName,
        ...(typeof expData.simulation_name !== "undefined" ? { simulation_name: copyName } : {}),
      };

      const { error: insertError } = await supabase
        .from("experiments")
        .insert({
          experiment_id: newExperimentId,
          user_id: user.user_id,
          experiment_data: copiedExperimentData,
          status: "Draft",
          sample_name: data.sample_name ?? "",
          folder_id: data.folder_id ?? null,
          created_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error("Error creating copy:", insertError);
        alert("Error creating copy. Please try again.");
        return true;
      }

      await getProjects(user.user_id);
      alert("Copy created and saved as a draft. Open it from the simulation page to edit or run.");
    } catch (error) {
      console.error("Error copying experiment:", error);
      alert(`Error copying experiment: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsReplicating(false);
    }
    return true;
  };

  const handleRunAgain = async (projectId: string) => {
    setProjectToRunAgain(projectId);
    setShowRunAgainConfirm(true);
    return true;
  };

  const confirmRunAgain = async () => {
    if (!projectToRunAgain || !user || isReplicating) return;

    setIsReplicating(true);
    try {
      const { data, error } = await supabase
        .from("experiments")
        .select("*")
        .eq("experiment_id", projectToRunAgain)
        .single();

      if (error) {
        console.error("Error fetching experiment:", error);
        alert("Error loading experiment. Please try again.");
        setIsReplicating(false);
        return;
      }

      const experimentData = data.experiment_data;
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error("No Supabase access token found");
      }

      const uuid = crypto.randomUUID();
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
        body: JSON.stringify({ id: uuid, data: experimentData }),
      });

      const result = await response.json();

      if (result.status === "started") {
        const originalFolderId = data.folder_id ?? null;
        await supabase
          .from("experiments")
          .update({ folder_id: originalFolderId })
          .eq("experiment_id", uuid);

        await getProjects(user.user_id);
        setShowRunAgainConfirm(false);
        setProjectToRunAgain(null);
        alert("Experiment is running. The new simulation will appear in your list when it completes.");
      } else {
        throw new Error(result.message || "Failed to start experiment");
      }
    } catch (error) {
      console.error("Error running experiment again:", error);
      alert(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsReplicating(false);
      setShowRunAgainConfirm(false);
      setProjectToRunAgain(null);
    }
  };

  const cancelRunAgain = () => {
    setShowRunAgainConfirm(false);
    setProjectToRunAgain(null);
  };

  const handleDelete = async (projectId: string) => {
    setProjectToDelete(projectId);
    setShowDeleteConfirm(true);
    return true;
  };

  const confirmDelete = async () => {
    if (projectToDelete && user) {
      // Get the project name before deleting
      const project = projects.find(p => p.experiment_id === projectToDelete || p.id === projectToDelete);
      const projectName = project?.name || "Simulation";
      
      try {
        const { error } = await supabase
          .from("experiments")
          .delete()
          .eq("experiment_id", projectToDelete);

        if (error) {
          console.error("Error deleting project:", error);
          alert("Error deleting project. Please try again.");
        } else {
          // Refresh projects after successful deletion
          await getProjects(user.user_id);
          setDeletedItemName(projectName);
          setShowDeleteSuccess(true);
        }
      } catch (error) {
        console.error("Error in delete operation:", error);
        alert("Error deleting project. Please try again.");
      }
    }
    
    // Close modal
    setShowDeleteConfirm(false);
    setProjectToDelete(null);
  };

  const cancelDelete = () => {
    setShowDeleteConfirm(false);
    setProjectToDelete(null);
  };

  useEffect(() => {
    if (user && isAuthenticated && !hasInitiallyLoadedRef.current) {
      hasInitiallyLoadedRef.current = true;
      getUserData(user.user_id);
      // getHistory(user.user_id);
      // Wait for both projects and folders so table renders with items already in folders (no flash)
      Promise.all([
        getProjects(user.user_id),
        getFolders(user.user_id)
      ]).then(() => setContentLoaded(true));
    } else if (!user || !isAuthenticated) {
      // Reset the ref when user logs out
      hasInitiallyLoadedRef.current = false;
      setProjects([]);
      setFolders([]);
      setContentLoaded(false);
    }
  }, [user?.user_id, isAuthenticated]); // Use user?.user_id instead of user object

  // When a simulation was just submitted (pending in localStorage), refetch projects periodically so we replace placeholder with real row once backend has written
  useEffect(() => {
    if (!user || !isAuthenticated || typeof window === "undefined") return;
    const pendingRaw = localStorage.getItem("simulation-pending");
    if (!pendingRaw) return;
    const interval = setInterval(() => {
      if (!localStorage.getItem("simulation-pending")) {
        return;
      }
      getProjects(user.user_id);
    }, 4000);
    return () => clearInterval(interval);
  }, [user?.user_id, isAuthenticated]);

  // Show loading state while checking authentication
  if (isLoading) {
    return <AuthLoading message="Loading dashboard..." />;
  }

  // If not authenticated, don't render anything (will redirect)
  if (!isAuthenticated) {
    return null;
  }

  return (
    <AppLayout 
      currentPage="dashboard" 
      headerTitle=""
      userData={userData}
    >
      <SubHeader
        title="Dashboard"
        description="Manage and monitor your simulation projects"
      >
        <div className="flex gap-3">
          {/*
          <Button
            onClick={() => setShowPDFImportModal(true)}
            className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg flex items-center gap-2"
          >
            <FileUp className="w-4 h-4" />
            Import PDF
          </Button>
          */}
          <Button
            onClick={() => setShowNewFolderModal(true)}
            className="bg-gray-600 hover:bg-gray-700 text-white px-6 py-3 rounded-lg flex items-center gap-2"
          >
            <FolderPlus className="w-4 h-4" />
            New Folder
          </Button>
          <Button
            onClick={handleNewSimulation}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg flex items-center gap-2"
          >
            <Play className="w-4 h-4" />
            New Simulation
          </Button>
        </div>
      </SubHeader>

      {/* Content */}
      <div className="flex-1 p-8 bg-gray-100 overflow-y-auto">
        {loadingProjects ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex items-center gap-3 text-gray-500">
              <Spinner size="md" />
              <span>Loading projects...</span>
            </div>
          </div>
        ) : (
          <div className={`transition-opacity duration-500 ${contentLoaded ? 'opacity-100' : 'opacity-0'}`}>
            <ProjectsTable 
              projects={projects}
              folders={folders}
              onDownload={handleDownload}
              onRename={handleStartRename}
              onModify={handleModify}
              onDelete={handleDelete}
              onReplicate={handleReplicate}
              onCopy={handleCopy}
              onRunAgain={handleRunAgain}
              onMoveToFolder={(projectId) => {
                setProjectToMove(projectId);
                setShowMoveToFolderModal(true);
              }}
              onDropToFolder={(projectId, folderId) => {
                handleMoveToFolder(projectId, folderId);
              }}
              onRenameFolder={handleRenameFolder}
              onDeleteFolder={handleDeleteFolder}
              onAddSimulationToFolder={handleAddSimulationToFolder}
              renamingProjectId={projectToRename?.id ?? null}
              renameValue={newName}
              onRenameValueChange={setNewName}
              onSaveRename={handleSaveRename}
              onCancelRename={handleCancelRename}
            />
          </div>
        )}
      </div>

      {/* PDF Import Modal */}
      <PDFImportModal
        isOpen={showPDFImportModal}
        onClose={() => setShowPDFImportModal(false)}
        onImport={handlePDFImport}
      />

      {/* Replicate Modal */}
      {showReplicateModal && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Replicate Simulation</h3>
            <p className="text-sm text-gray-500 mb-5">Optionally change the sample, sample size, and models before creating the replication draft.</p>

            {/* Sample */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Sample</label>
              {replicateLoadingSamples ? (
                <div className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm text-gray-400">Loading samples...</div>
              ) : (
                <select
                  value={replicateSampleId}
                  onChange={(e) => setReplicateSampleId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">Keep original sample</option>
                  {replicateSamples.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Sample Size */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Sample Size</label>
              <input
                type="text"
                inputMode="numeric"
                value={replicateSampleSizeStr}
                onChange={(e) => {
                  const raw = e.target.value;
                  // Only allow digits (and empty string while typing)
                  if (raw === "" || /^\d+$/.test(raw)) {
                    setReplicateSampleSizeStr(raw);
                    const num = parseInt(raw, 10);
                    if (!isNaN(num)) setReplicateSampleSize(num);
                  }
                }}
                onBlur={() => {
                  const num = parseInt(replicateSampleSizeStr, 10);
                  const clamped = isNaN(num) ? 10 : Math.min(50, Math.max(10, num));
                  setReplicateSampleSize(clamped);
                  setReplicateSampleSizeStr(String(clamped));
                }}
                onKeyDown={(e) => {
                  const allowed = ["Backspace", "Delete", "Tab", "Escape", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
                  if (allowed.includes(e.key)) return;
                  if (!/^\d$/.test(e.key)) e.preventDefault();
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <p className="text-xs text-gray-400 mt-1">Enter a number between 10 and 50</p>
            </div>

            {/* Text Model */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Text Model</label>
              <select
                value={replicateTextModel}
                onChange={(e) => setReplicateTextModel(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              >
                <option value="gemini">Gemini</option>
              </select>
            </div>

            {/* Evaluations Model */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-1">Evaluations Model</label>
              <select
                value={replicateEvalModel}
                onChange={(e) => setReplicateEvalModel(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              >
                <option value="gemini">Gemini</option>
              </select>
            </div>

            <div className="flex gap-3 justify-end">
              <Button
                onClick={cancelReplicate}
                variant="outline"
                className="px-4 py-2"
                disabled={isReplicating}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmReplicate}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-2"
                disabled={isReplicating}
              >
                {isReplicating ? (
                  <>
                    <Spinner size="sm" />
                    <span>Creating...</span>
                  </>
                ) : (
                  "Replicate"
                )}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Run Again (Replicate) Confirmation Modal */}
      {showRunAgainConfirm && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                <Play className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Run experiment again</h3>
                <p className="text-sm text-gray-500">This will rerun the experiment with the same configuration</p>
              </div>
            </div>
            <p className="text-gray-700 mb-6">
              Are you sure you want to run this experiment again? The experiment will be rerun with the exact same configuration, steps, and sample. A new simulation will be created and started.
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={cancelRunAgain}
                variant="outline"
                className="px-4 py-2"
                disabled={isReplicating}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmRunAgain}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-2"
                disabled={isReplicating}
              >
                {isReplicating ? (
                  <>
                    <Spinner size="sm" />
                    <span>Starting...</span>
                  </>
                ) : (
                  "Run again"
                )}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Delete Simulation</h3>
                <p className="text-sm text-gray-500">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-gray-700 mb-6">
              Are you sure you want to delete this simulation? This will permanently remove it from your projects list.
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={cancelDelete}
                variant="outline"
                className="px-4 py-2"
              >
                Cancel
              </Button>
              <Button
                onClick={confirmDelete}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white"
              >
                Delete
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* New Folder Modal */}
      {showNewFolderModal && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Create New Folder</h3>
            <div className="mb-6">
              <label htmlFor="folder-name" className="block text-sm font-medium text-gray-700 mb-2">
                Folder Name
              </label>
              <input
                id="folder-name"
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateFolder();
                  } else if (e.key === 'Escape') {
                    setShowNewFolderModal(false);
                    setNewFolderName("");
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter folder name"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={() => {
                  setShowNewFolderModal(false);
                  setNewFolderName("");
                }}
                variant="outline"
                className="px-4 py-2"
                disabled={isCreatingFolder}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateFolder}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-2"
                disabled={!newFolderName.trim() || isCreatingFolder}
              >
                {isCreatingFolder ? (
                  <>
                    <Spinner size="sm" />
                    <span>Creating...</span>
                  </>
                ) : (
                  "Create"
                )}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Move to Folder Modal */}
      {showMoveToFolderModal && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Move to Folder</h3>
            <div className="mb-6">
              <p className="text-sm text-gray-600 mb-4">Select a folder to move this project to:</p>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {folders.map((folder) => (
                  <button
                    key={folder.folder_id}
                    onClick={() => {
                      if (projectToMove) {
                        handleMoveToFolder(projectToMove, folder.folder_id);
                      }
                    }}
                    className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors text-left"
                  >
                    <Folder className="w-4 h-4 text-blue-600" />
                    <span>{folder.folder_name}</span>
                    {folder.project_count !== undefined && (
                      <span className="ml-auto text-xs text-gray-500">
                        ({folder.project_count} {folder.project_count === 1 ? 'simulation' : 'simulations'})
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={() => {
                  setShowMoveToFolderModal(false);
                  setProjectToMove(null);
                }}
                variant="outline"
                className="px-4 py-2"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Rename Folder Modal */}
      {showRenameFolderModal && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Rename Folder</h3>
            <div className="mb-6">
              <label htmlFor="new-folder-name" className="block text-sm font-medium text-gray-700 mb-2">
                New Name
              </label>
              <input
                id="new-folder-name"
                type="text"
                value={newFolderRename}
                onChange={(e) => setNewFolderRename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveRenameFolder();
                  } else if (e.key === 'Escape') {
                    handleCancelRenameFolder();
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Enter folder name"
                autoFocus
              />
            </div>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={handleCancelRenameFolder}
                variant="outline"
                className="px-4 py-2"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveRenameFolder}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white"
                disabled={!newFolderRename.trim()}
              >
                Save
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete Folder Confirmation Modal */}
      {showDeleteFolderConfirm && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Delete Folder</h3>
                <p className="text-sm text-gray-500">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-gray-700 mb-6">
              Are you sure you want to delete the folder <strong className="font-semibold">"{folderToDelete?.name}"</strong>? <strong className="text-red-600">All projects inside this folder will be permanently deleted.</strong> This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={cancelDeleteFolder}
                variant="outline"
                className="px-4 py-2"
                disabled={isDeletingFolder}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmDeleteFolder}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white flex items-center gap-2"
                disabled={isDeletingFolder}
              >
                {isDeletingFolder ? (
                  <>
                    <Spinner size="sm" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  "Delete Folder"
                )}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Unsaved Cache Prompt */}
      {showCachePrompt && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-yellow-100 rounded-full flex items-center justify-center">
                <Play className="w-5 h-5 text-yellow-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Unsaved Changes</h3>
                <p className="text-sm text-gray-500">You have unsaved work from a previous session</p>
              </div>
            </div>
            <p className="text-gray-700 mb-6">
              Would you like to save your previous simulation as a draft, or discard it and start fresh?
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                onClick={() => setShowCachePrompt(false)}
                variant="outline"
                className="px-4 py-2"
                disabled={isSavingDraft}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCacheDiscard}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white"
                disabled={isSavingDraft}
              >
                Discard
              </Button>
              <Button
                onClick={handleCacheSave}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-2"
                disabled={isSavingDraft}
              >
                {isSavingDraft ? (
                  <>
                    <Spinner size="sm" />
                    <span>Saving...</span>
                  </>
                ) : (
                  "Save Draft"
                )}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete Success Popup */}
      {showDeleteSuccess && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[99999]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Success</h3>
              </div>
            </div>
            <p className="text-gray-700 mb-6">
              "{deletedItemName}" has been deleted successfully!
            </p>
            <div className="flex justify-end">
              <Button
                onClick={() => setShowDeleteSuccess(false)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white"
              >
                OK
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </AppLayout>
  );
}