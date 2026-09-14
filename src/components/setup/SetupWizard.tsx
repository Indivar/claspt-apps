// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * First-run setup walkthrough, shown once per vault.
 *
 * Replaces the situation where a new vault dropped the user straight into the
 * app with nothing connected, no token to connect with, and a feature tour
 * covering the screen. The steps are: save the recovery key, say what the vault
 * is for, set up only those things, done.
 *
 * The middle is not a fixed list. `PurposeStep` decides which steps follow, so
 * someone who only wants notes sees three screens and someone who wants
 * everything sees six. Adding a use case means adding one entry to `USE_CASES`
 * and one optional step — nothing else changes.
 */
import { useCallback, useMemo, useState } from "react";
import { useVaultStore } from "@/stores/vault-store";
import { useUIStore } from "@/stores/ui-store";
import { WizardFrame } from "@/components/setup/WizardFrame";
import { WelcomeStep } from "@/components/setup/steps/WelcomeStep";
import { RecoveryKeyStep } from "@/components/setup/steps/RecoveryKeyStep";
import { PurposeStep } from "@/components/setup/steps/PurposeStep";
import { PasswordsStep } from "@/components/setup/steps/PasswordsStep";
import { AssistantStep } from "@/components/setup/steps/AssistantStep";
import { DoneStep } from "@/components/setup/steps/DoneStep";
import type { UseCaseId } from "@/components/setup/use-cases";
import { STEP_FOR } from "@/components/setup/use-cases";

/**
 * Bumping this shows the walkthrough again to vaults that have seen an older
 * one. Only raise it when the steps change enough to be worth interrupting
 * someone who has already been through it.
 */
export const SETUP_VERSION = 1;

type StepId = "welcome" | "recovery" | "purpose" | "passwords" | "assistant" | "done";

export function SetupWizard({ onFinish }: { onFinish: () => void }) {
  const recoveryKey = useVaultStore((s) => s.recoveryKey);
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<UseCaseId[]>(["passwords", "notes"]);

  // Someone who reruns this from Settings has no recovery key to show — it only
  // exists at creation — so that step is left out rather than shown empty.
  const steps = useMemo<StepId[]>(() => {
    const optional = chosen
      .map((id) => STEP_FOR[id])
      .filter((s): s is "passwords" | "assistant" => Boolean(s));
    return [
      "welcome",
      ...(recoveryKey ? (["recovery"] as StepId[]) : []),
      "purpose",
      ...optional,
      "done",
    ];
  }, [chosen, recoveryKey]);

  const current = steps[Math.min(index, steps.length - 1)] ?? "done";

  const complete = useCallback(
    async (startTour: boolean) => {
      // Record it before anything else, so a thrown tour or a closed window
      // cannot make the walkthrough reappear on the next launch.
      try {
        // Through the store rather than raw IPC: a direct write would leave the
        // store stale and the next settings save would clear the flag again.
        // Same reason the tour marks itself seen this way.
        const { config, updateConfig } = useVaultStore.getState();
        if (config) {
          await updateConfig({ ...config, setup_version_seen: SETUP_VERSION });
        }
      } catch {
        // Not fatal — at worst the walkthrough runs once more. Finishing must
        // never be blocked on recording that it finished.
      }
      onFinish();
      if (startTour) useUIStore.getState().startTour("quick");
    },
    [onFinish],
  );

  const next = useCallback(() => setIndex((i) => i + 1), []);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // The progress dots count only the steps this person will actually see.
  const frame = { stepNumber: index + 1, stepCount: steps.length };

  switch (current) {
    case "welcome":
      return (
        <WizardFrame {...frame}>
          <WelcomeStep onNext={next} onSkip={() => void complete(false)} />
        </WizardFrame>
      );
    case "recovery":
      return (
        <WizardFrame {...frame}>
          <RecoveryKeyStep recoveryKey={recoveryKey ?? ""} onNext={next} onBack={back} />
        </WizardFrame>
      );
    case "purpose":
      return (
        <WizardFrame {...frame}>
          <PurposeStep chosen={chosen} onChange={setChosen} onNext={next} onBack={back} />
        </WizardFrame>
      );
    case "passwords":
      return (
        <WizardFrame {...frame}>
          <PasswordsStep onNext={next} onBack={back} />
        </WizardFrame>
      );
    case "assistant":
      return (
        <WizardFrame {...frame}>
          <AssistantStep onNext={next} onBack={back} />
        </WizardFrame>
      );
    default:
      return (
        <WizardFrame {...frame}>
          <DoneStep chosen={chosen} onFinish={complete} />
        </WizardFrame>
      );
  }
}
