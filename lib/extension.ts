/**
 * Bale bridge extension composition and orchestration layer
 * Zones: bale, pi agent, orchestration
 * Keeps runtime wiring in one place while the package entrypoint remains a thin re-export
 */

import * as AgentMessages from "./agent-messages.ts";
import * as Bindings from "./bindings.ts";
import * as BusApi from "./bus-api.ts";
import * as BusFollower from "./bus-follower.ts";
import * as BusLeader from "./bus-leader.ts";
import * as BusTransport from "./bus-transport.ts";
import * as Bus from "./bus.ts";
import * as ChannelPosts from "./channel-posts.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Commands from "./commands.ts";
import * as Config from "./config.ts";
import * as Delivery from "./delivery.ts";
import * as Inbound from "./inbound.ts";
import * as Journal from "./journal.ts";
import * as Lifecycle from "./lifecycle.ts";
import * as Locks from "./locks.ts";
import * as Logging from "./logging.ts";
import * as Media from "./media.ts";
import * as MenuQueue from "./menu-queue.ts";
import * as MenuSettings from "./menu-settings.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as Outbound from "./outbound.ts";
import * as Ownership from "./ownership.ts";
import * as Paths from "./paths.ts";
import * as Pi from "./pi.ts";
import * as Polling from "./polling.ts";
import * as Preview from "./preview.ts";
import * as ProcessIdentity from "./process-identity.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import * as Prompts from "./prompts.ts";
import * as Queue from "./queue.ts";
import * as Recovery from "./recovery.ts";
import * as Replies from "./replies.ts";
import * as Routing from "./routing.ts";
import * as Runtime from "./runtime.ts";
import * as Sections from "./sections.ts";
import * as Skills from "./skills.ts";
import * as Status from "./status.ts";
import * as Sync from "./sync.ts";
import * as Targets from "./target.ts";
import * as BaleApi from "./bale-api.ts";
import * as TextGroups from "./text-groups.ts";
import * as ThreadCleanupManager from "./thread-cleanup-manager.ts";
import * as ThreadDisplay from "./thread-display.ts";
import * as ThreadNaming from "./thread-naming.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import * as Threads from "./threads.ts";
import * as TimeInjection from "./time-injection.ts";
import * as Updates from "./updates.ts";
import * as Voice from "./voice.ts";
import * as WorkspaceAdmission from "./workspace-admission.ts";
import * as WorkspaceRetirement from "./workspace-retirement.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;

const baleBusProtocolIdentity =
  Bus.createBaleCurrentBusProtocolIdentity([
    Bus.BALE_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    Bus.BALE_BUS_CAPABILITY_QUEUE_HANDOFF,
    Bus.BALE_BUS_CAPABILITY_QUEUE_STEER,
    Bus.BALE_BUS_CAPABILITY_CONNECT_RECOVERY,
    Bus.BALE_BUS_CAPABILITY_HELD_MENU_ALIASES,
    Bus.BALE_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
    Bus.BALE_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
    Bus.BALE_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
    Bus.BALE_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT,
    Bus.BALE_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
    Bus.BALE_BUS_CAPABILITY_WORKSPACE_RESTORE,
    Bus.BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND,
    Bus.BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION,
    Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_SAVE,
    Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY,
    Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
    Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET,
    Bus.BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
  ]);

// --- Extension Runtime ---

export default function (pi: Pi.ExtensionAPI) {
  Skills.registerBaleSkillDiscovery(pi);
  const piRuntime = Pi.createExtensionApiRuntimePorts(pi);
  const {
    getActiveTools,
    getCommands,
    getThinkingLevel,
    sendUserMessage,
    setActiveTools,
    setModel,
    setThinkingLevel,
  } = piRuntime;
  const bridgeRuntime = Runtime.createBaleBridgeRuntime();
  const runtimeDiagnostics =
    Logging.createBaleRuntimeDiagnosticsRuntime<Pi.ExtensionContext>({
      sharedFile: true,
    });
  const runtimeEvents = runtimeDiagnostics.events;
  const recordRuntimeEvent = runtimeDiagnostics.recordRuntimeEvent;
  const configStore = Config.createBaleConfigStore({ recordRuntimeEvent });
  const busProcessRuntime = Bus.createCurrentBaleBusProcessRuntime({
    getActiveProfileName: configStore.getActiveProfileName,
    endpointLayout: "consolidated",
  });
  const {
    instanceId: baleInstanceId,
    processId: baleProcessId,
    processBirthId: baleQueueProcessBirthId,
    manualFollowerOwnerId: baleManualFollowerOwnerId,
    getLeaderSocketPath: getBaleBusSocketPath,
    getFollowerSocketPath: getBaleBusFollowerSocketPath,
  } = busProcessRuntime;
  const getBaleBotId = Config.createBaleConfigBotIdGetter(configStore);
  const workspaceAdmissionRuntime =
    WorkspaceAdmission.createBaleWorkspaceAdmissionRuntimeBinding({
      getProfileName: configStore.getActiveProfileName,
      getBotToken: configStore.getBotToken,
      getStatePath: Paths.resolveBaleStatePath,
      owner: {
        processId: baleProcessId,
        processBirthId: baleQueueProcessBirthId,
      },
    });
  const baleWorkspaceOperationRuntime =
    WorkspaceRetirement.createBaleWorkspaceOperationRuntime({
      getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
      onReleaseError(error, operationKind) {
        recordRuntimeEvent("bus", error, {
          phase: "workspace-admission-release",
          operationKind,
        });
      },
    });
  const getBaleActiveProfileKey =
    Config.createBaleActiveProfileKeyGetter(configStore);
  const getBaleManualFollowerProfileKey =
    BusFollower.createBaleManualFollowerProfileKeyResolver({
      getActiveProfileName: configStore.getActiveProfileName,
      manualFollowerOwnerId: baleManualFollowerOwnerId,
    });
  const baleBusAuthSecret = Bus.createBaleBusAuthSecret();
  const baleBusFollowerControlState =
    BusFollower.createBaleBusFollowerControlState();
  const baleBusFollowerRegistry = Bus.createBaleBusFollowerRegistry();
  const modelContextAvailabilityBinding =
    Prompts.createBaleModelContextAvailabilityBinding();
  const baleBusFollowerRegistrationState =
    BusFollower.createBaleBusFollowerRegistrationState({
      onAvailabilityChanged: modelContextAvailabilityBinding.reconcile,
    });
  const baleBusLeaderState =
    Threads.createBaleLeaderThreadStateRuntime();
  const baleThreadCapabilityState =
    Polling.createBaleThreadCapabilityStateRuntime();
  const baleProvisioningActivity =
    Sync.createBaleProvisioningActivityRuntime();
  const messageOwnershipRuntime =
    Ownership.createBaleBusMessageOwnershipRuntime({
      instanceId: baleInstanceId,
      getProfileKey: getBaleActiveProfileKey,
      listFollowers: baleBusFollowerRegistry.list,
    });
  const { abort, lifecycle, queue, setup, typing } = bridgeRuntime;
  const getBaleUpdateAdmissionScope =
    Journal.createBaleUpdateJournalReceiptScopeResolver({
      getProfileName: configStore.getActiveProfileName,
      getBotToken: configStore.getBotToken,
      getBotId: getBaleBotId,
    });
  const baleLeaderJournalPath =
    Locks.createBaleLeaderJournalPathResolver({
      getNamedJournalPath() {
        return lockRuntime.getJournalPath();
      },
      getSessionId() {
        return Pi.getExtensionContextSessionId(
          baleSessionContextStore.get(),
        );
      },
      getProfileName: configStore.getActiveProfileName,
    });
  const withBaleJournalSourceSerialization =
    Journal.createBaleJournalSourceSerialization();
  const baleJournalBindingRuntime =
    Journal.createBaleUpdateJournalBindingRuntime({
      base: {
        getProfileName: configStore.getActiveProfileName,
        getBotToken: configStore.getBotToken,
        getBotId: getBaleBotId,
        withSourceSerialization: withBaleJournalSourceSerialization,
        onRecovery(event) {
          recordRuntimeEvent(
            "recovery",
            event.kind === "repaired"
              ? "Bale update journal was repaired automatically."
              : "Bale update journal was reset after its damaged files were deleted.",
            {
              phase: "journal-auto-recovery",
              recoveryKind: event.kind,
              journalPath: event.path,
              revision: event.revision,
              deletedPaths: event.deletedPaths,
              reason: event.reason,
            },
          );
        },
        getQueueRuntimeIdentity() {
          return {
            instanceId: baleInstanceId,
            processId: baleProcessId,
            processBirthId: baleQueueProcessBirthId,
          };
        },
        getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
      },
      getLeaderJournalPath: baleLeaderJournalPath.resolve,
      getRuntimeDir: Paths.resolveBaleTempDir,
      getFollowerJournalPath(bindingKey, profileName, sessionId) {
        if (sessionId !== undefined)
          return Paths.resolveBaleSessionJournalPath(
            sessionId,
            bindingKey,
            undefined,
            profileName,
          );
        return Paths.resolveBaleFollowerJournalPath(
          bindingKey,
          undefined,
          profileName,
        );
      },
      getActiveFollowerBindingKey: getBaleManualFollowerProfileKey,
      getActiveFollowerSessionId() {
        return baleBusFollowerRegistrationState.getSessionId(
          Pi.getExtensionContextSessionId(baleSessionContextStore.get()),
        );
      },
      isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
    });
  const baleJournalReferenceRegistry =
    Journal.createBaleUpdateJournalReferenceRegistry();
  const resolveBaleUpdateJournalBinding =
    baleJournalBindingRuntime.resolveLeader;
  const resolveBaleFollowerJournalBinding =
    baleJournalBindingRuntime.resolveFollower;
  const getBaleQueueJournalBinding =
    baleJournalBindingRuntime.getActiveRecoveryKey;
  const isBaleBusRuntimeEnabled =
    baleThreadCapabilityState.isBusRuntimeEnabled;
  const configControls = Config.createBaleConfigControls(configStore);
  const lockRuntime = Locks.createBaleLockRuntime<Pi.ExtensionContext>({
    key: Locks.createBaleLockKeyResolver(configStore),
    statePath: Paths.resolveBaleStatePath(),
    instanceId: baleInstanceId,
    busSecret: baleBusAuthSecret,
    staleHeartbeatMs: Locks.BALE_BUS_LEADER_STALE_HEARTBEAT_MS,
    legacyLocksPath: Paths.resolveLegacyBaleOwnersPath(),
    createJournalPath() {
      return baleLeaderJournalPath.createJournalPath();
    },
  });
  const proveBaleLeaderUnresponsive =
    Bus.createBaleBusLeaderUnresponsivenessProof({
      getLeaderState: lockRuntime.getState,
      getLeaderSocketPath: getBaleBusSocketPath,
    });
  const baleSessionContextStore =
    Lifecycle.createBaleSessionContextStore<Pi.ExtensionContext>({
      getIdentity(ctx) {
        return ctx.sessionManager ?? ctx.cwd;
      },
    });
  const captureBaleStateAuthority =
    Locks.createBaleOwnedStateAuthorityCapture(
      lockRuntime,
      baleSessionContextStore,
    );
  const threadStore = Threads.createBaleTopicTargetStore({
    path: Paths.resolveBaleStatePath,
    baleProfile: function () {
      return configStore.getActiveProfileName();
    },
    canPersist: lockRuntime.owns,
    consolidated: {
      captureAuthority: captureBaleStateAuthority,
      publishIfOwned: lockRuntime.publishStateSectionIfOwned!,
    },
    getExternalReservedSlots: function () {
      return workspaceAdmissionRuntime.resolve()?.listReservedSlots() ?? [];
    },
  });
  const resolveWorkspaceRestoreStore =
    Threads.createBaleWorkspaceRestoreResolver({
      getProfileName: configStore.getActiveProfileName,
      getBotToken: configStore.getBotToken,
      threadStore,
    });
  runtimeDiagnostics.bindStorage({
    getBotToken: configStore.getBotToken,
    getProfileName: configStore.getActiveProfileName,
    canReset: lockRuntime.owns,
    commitReset: lockRuntime.commitIfOwned,
    captureAuthority: captureBaleStateAuthority,
  });
  const sessionActionAssembly = Commands.createBaleSessionActionAssembly({
    sendUserMessage,
    store: threadStore,
    getProfileName: configStore.getActiveProfileName,
    ownsPersistence: lockRuntime.owns,
    follower: {
      instanceId: baleInstanceId,
      isRegisteredFor(target) {
        const registered = baleBusFollowerRegistrationState.getTarget();
        return (
          baleBusFollowerRegistrationState.isRegistered() &&
          registered?.chatId === target.chatId &&
          registered.threadId === target.threadId
        );
      },
      async requestSessionReplacement(operation, intent) {
        const request =
          baleBusFollowerRegistration.requestSessionReplacement;
        if (!request) return false;
        return await request(operation, intent);
      },
    },
    async sendResult(target, html) {
      const delivery = await Delivery.sendBaleView(
        { text: html, parseMode: "html", replyMarkup: { inline_keyboard: [] } },
        { scope: { kind: "target", target } },
      );
      return delivery.ok
        ? { ok: true }
        : {
            ok: false,
            retryable:
              delivery.reason === "runtime-unavailable" ||
              delivery.reason === "target-unavailable" ||
              delivery.reason === "transport-retryable",
          };
    },
    handoffTtlMs: Threads.BALE_LEADER_SESSION_HANDOFF_TTL_MS,
    recordRuntimeEvent,
  });
  const sessionActionsRuntime = sessionActionAssembly.action;
  const lockOwnershipGuard =
    Locks.createBaleLockOwnershipGuard(lockRuntime);
  const getCurrentLeaderEpoch = lockRuntime.getOwnedLeaderEpoch;
  const ownsBaleDirectDelivery =
    Locks.createBaleDirectDeliveryOwnershipChecker({
      lock: lockRuntime,
      contextStore: baleSessionContextStore,
    });
  const modelContextAvailabilityRuntime =
    Prompts.createBaleModelContextAvailabilityRuntime({
      getActiveTools,
      setActiveTools,
      isAvailable() {
        return (
          ownsBaleDirectDelivery() ||
          baleBusFollowerRegistrationState.isRegistered()
        );
      },
      canReconcile() {
        const ctx = baleSessionContextStore.get();
        return !ctx || Pi.isExtensionContextIdle(ctx);
      },
    });
  modelContextAvailabilityBinding.bind(modelContextAvailabilityRuntime);
  const activeTurnRuntime = Queue.createBaleActiveTurnStore();
  const proactivePushTargetGetter =
    Config.createBaleProactivePushTargetGetter({
      getActiveTurnTarget: activeTurnRuntime.getTarget,
      getAssignedTarget() {
        return (
          baleBusFollowerRegistrationState.getTarget() ??
          baleBusLeaderState.getTarget()
        );
      },
      getAllowedUserId: configStore.getAllowedUserId,
    });
  const proactivePushChatIdGetter =
    Config.createBaleProactivePushChatIdGetter(proactivePushTargetGetter);
  const buttonActionStore = Outbound.createBaleButtonActionStore();
  const planGenerativeAppOutput = Outbound.createBaleOutboundReplyPlanner(
    buttonActionStore,
    configControls.getAssistantRenderingMode,
  );
  const modelMenuRuntime = Menu.createBaleModelMenuRuntime<ActivePiModel>();
  const sectionRegistry = Sections.createAndBindBaleSectionRegistry();

  const timeInjectionRuntime = TimeInjection.createTimeInjectionRuntime({
    getConfig: Config.createBaleTimeConfigGetter(configStore),
    recordRuntimeEvent,
  });
  Outbound.bindBaleRuntimeEventRecorder(recordRuntimeEvent);
  const getContextModel = Pi.getExtensionContextModel;
  const isIdle = Pi.isExtensionContextIdle;
  const hasPendingMessages = Pi.hasExtensionContextPendingMessages;
  const compact = Pi.compactExtensionContext;
  const mediaGroupRuntime = Media.createBaleMediaGroupController<
    BaleApi.BaleMessage,
    Pi.ExtensionContext
  >();
  const textGroupRuntime = TextGroups.createBaleTextGroupController<
    BaleApi.BaleMessage,
    Pi.ExtensionContext
  >();
  const rawBaleQueueStore =
    Queue.createBaleQueueStore<Pi.ExtensionContext>();
  const baleTransportStampRuntime =
    Queue.createBaleTransportStampRuntime({
      getProfileName: configStore.getActiveProfileName,
      getBotToken: configStore.getBotToken,
    });
  const baleQueueStore = Queue.createBaleTransportStampedQueueStore(
    rawBaleQueueStore,
    baleTransportStampRuntime.getStamp,
  );
  const captureCleanupDrain = Lifecycle.createBaleSessionDrainObserver({
    context: baleSessionContextStore,
    captureAuthority() {
      const epoch = getCurrentLeaderEpoch();
      return epoch === undefined ? undefined : {
        epoch, operator: configStore.getAllowedUserId(), stamp: baleTransportStampRuntime.getStamp(),
      };
    },
    isAuthorityActive(authority) {
      return getCurrentLeaderEpoch() === authority.epoch &&
        configStore.getAllowedUserId() === authority.operator &&
        baleTransportStampRuntime.isActive(authority.stamp);
    },
    onDrained(ctx) { inboundRouteRuntime.onDeliverySettled(ctx); },
  });
  const baleApiTargetActivityRuntime =
    BaleApi.createBaleApiTargetActivityRuntime({
      captureDrain: captureCleanupDrain,
    });
  // Retirement protection and dead-owner reclamation must inspect the same journal sources.
  const workspaceRetirementJournalPorts = {
    getActiveTurnTarget: activeTurnRuntime.getTarget,
    getQueuedItems: baleQueueStore.getQueuedItems,
    resolveLeaderJournal: resolveBaleUpdateJournalBinding,
    createFollowerJournalResolver:
      baleJournalBindingRuntime.createLegacyRecipientResolver,
    createSessionJournalResolver:
      baleJournalBindingRuntime.createRecipientResolver,
    createJournalPathResolver: baleJournalBindingRuntime.createPathResolver,
    discoverFollowerJournals() {
      return Journal.discoverBaleRecipientJournalPaths({
        directory: Paths.resolveBaleTempDir(),
        profileName: configStore.getActiveProfileName(),
      });
    },
  };
  const workspaceProtectionObserver =
    WorkspaceRetirement.createBaleWorkspaceProtectionObserver({
      listFollowers: baleBusFollowerRegistry.list,
      ...workspaceRetirementJournalPorts,
      withJournalReference(binding, operation) {
        if (!binding.recoveryKey)
          throw new Error(
            "Bale workspace journal reference identity is unavailable.",
          );
        return baleJournalReferenceRegistry.withReference(
          {
            referenceClass: "workspace-retirement",
            recoveryKey: binding.recoveryKey,
          },
          operation,
        );
      },
      inspectJournalNamespace() {
        const botToken = configStore.getBotToken();
        if (!botToken)
          throw new Error(
            "Bale namespace inspection requires current bot identity.",
          );
        return Journal.inspectBaleSessionJournalNamespace({
          directory: Paths.resolveBaleTempDir(),
          profile: configStore.getActiveProfileName() ?? "default",
          pollingPath: baleLeaderJournalPath.resolve(
            configStore.getActiveProfileName(),
          ),
          botIdentity: Journal.createBaleUpdateJournalBotIdentity({
            botToken,
            botId: getBaleBotId(),
          }),
          limits: {
            maxDirectoryEntries: 10_000,
            maxFiles: 4096,
            maxBytes: 64 * 1024 * 1024,
            maxEntries: 10_000,
            maxWork: 100_000,
          },
        });
      },
      getJournalWriterProtection(journalBindingKey) {
        const owner =
          Threads.getBaleThreadOwnerFromProfileKey(journalBindingKey);
        if (owner.kind !== "manual-follower") return "unknown";
        const liveness =
          ProcessIdentity.getBaleProcessBirthIdentityLiveness(
            owner.instanceId,
          );
        return liveness === "alive"
          ? "protected"
          : liveness === "dead"
            ? "clear"
            : "unknown";
      },
      getDeliveryAuthorityProtection(binding) {
        const retainedRestore = resolveWorkspaceRestoreStore()
          ?.list()
          .some(function (intent) {
            return (
              intent.request.binding.bindingKey === binding.bindingKey ||
              Targets.areBaleTargetsEqual(
                intent.request.binding.target,
                binding.target,
              ) ||
              Targets.areBaleTargetsEqual(
                intent.request.target,
                binding.target,
              )
            );
          });
        return retainedRestore ||
          baleApiTargetActivityRuntime.hasPendingTarget(binding.target)
          ? "protected"
          : "clear";
      },
    });
  const captureWorkspaceExternalProtection =
    workspaceProtectionObserver.capture;
  const pruneWorkspaceJournalEvidence =
    WorkspaceRetirement.createBaleWorkspaceJournalEvidencePruner({
      store: threadStore,
      getAdmission: workspaceAdmissionRuntime.resolve,
      getLeaderEpoch: getCurrentLeaderEpoch,
      runExclusive: baleWorkspaceOperationRuntime.runExclusive,
      protection: workspaceProtectionObserver,
    });
  const reclaimBaleWorkspaceDeadOwnerQueue =
    WorkspaceRetirement.createBaleWorkspaceDeadOwnerQueueReclaimer({
      getExternalProtection: captureWorkspaceExternalProtection,
      ...workspaceRetirementJournalPorts,
      withJournalReference(binding, operation) {
        if (!binding.recoveryKey)
          throw new Error(
            "Bale workspace journal reference identity is unavailable.",
          );
        return baleJournalReferenceRegistry.withReference(
          {
            referenceClass: "workspace-retirement",
            recoveryKey: binding.recoveryKey,
          },
          operation,
        );
      },
      getRecoveryOwner() {
        return {
          instanceId: baleInstanceId,
          processId: baleProcessId,
          processBirthId: baleQueueProcessBirthId,
          sessionGeneration: baleSessionContextStore.getGeneration(),
        };
      },
      getQueueOwnerLiveness: ProcessIdentity.getBaleProcessLiveness,
      onMutationError(error) {
        recordRuntimeEvent(
          "Bale dead-owner queue reclamation was refused.",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      },
      isBindingCurrent(binding) {
        return WorkspaceRetirement.isCurrentBaleWorkspaceBinding(
          threadStore,
          binding,
        );
      },
    });
  const inactiveThreadCleanupRuntime =
    ThreadCleanupManager.createBaleInactiveThreadCleanupRuntime({
      store: threadStore,
      captureAuthority() {
        const ledger = workspaceAdmissionRuntime.resolve();
        const leaderEpoch = getCurrentLeaderEpoch();
        const operator = configStore.getAllowedUserId();
        if (!ledger || leaderEpoch === undefined || operator === undefined) return undefined;
        const stamp = baleTransportStampRuntime.getStamp();
        const generation = baleSessionContextStore.getGeneration();
        return {
          profileName: configStore.getActiveProfileName() ?? "default",
          leaderEpoch, ledger,
          isCurrent() {
            return getCurrentLeaderEpoch() === leaderEpoch &&
              baleTransportStampRuntime.isActive(stamp) &&
              configStore.getAllowedUserId() === operator &&
              baleSessionContextStore.getGeneration() === generation;
          },
        };
      },
      getProtection: captureWorkspaceExternalProtection,
      getProcessLiveness: ProcessIdentity.getBaleProcessLiveness,
      runExclusive: baleWorkspaceOperationRuntime.runExclusive,
      getWorkStore(authority) {
        const profileName = authority.profileName;
        const botToken = configStore.getBotToken();
        if (!botToken)
          throw new Error(
            "Bale Thread cleanup review requires an active bot token.",
          );
        return ThreadCleanupManager.createBaleThreadCleanupWorkStore({
          ...Paths.resolveBaleServiceJournalStorage(
            "thread-cleanup",
            undefined,
            profileName,
          ),
          profileName,
          tokenSha256: Journal.createBaleUpdateJournalBotIdentity({
            botToken,
          }).tokenSha256,
          admissionProfileKey: authority.ledger.getProfileKey(),
        });
      },
      runWorkspaceOperation: baleWorkspaceOperationRuntime.run,
      deleteThread(authorize) {
        return directBaleApiRuntime.deleteWorkspaceThread(authorize);
      },
      onError(error) {
        recordRuntimeEvent("bale", error, { phase: "manual-inactive-thread-cleanup" });
      },
    });
  const updateAdmissionRuntimeBinding =
    Updates.createBaleUpdateAdmissionRuntimeBinding<Pi.ExtensionContext>({
      isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
    });
  const deferredQueueDispatchRuntime =
    Queue.createBaleDeferredQueueDispatchRuntime<Pi.ExtensionContext>({
      recordRuntimeEvent,
    });
  const pollingControllerState = Polling.createBalePollingControllerState();
  const baleSyncStateRuntime = Sync.createBaleSyncStateRuntime();
  const threadReconciliationRuntime =
    ThreadReconciler.createThreadReconciliationRuntime({
      recordRuntimeEvent,
      scheduleSnapshotPersist: runtimeDiagnostics.scheduleSnapshotPersist,
    });
  const recordThreadReconciliationPlan = threadReconciliationRuntime.recordPlan;
  const persistBaleConfigWithSync =
    Sync.createBaleConfigSyncPersister<Config.BaleConfig>({
      persist: configStore.persist,
      markConfigChange: baleSyncStateRuntime.markConfigChange,
    });
  const {
    current: currentInstanceThreadRuntime,
    status: threadStatusProjectionRuntime,
    getDisplayTitle: getThreadDisplayTitle,
  } = Threads.createBaleCurrentThreadAssembly({
    instanceId: baleInstanceId,
    listRecords: threadStore.list,
    listWorkspaceBindings: threadStore.listWorkspaceBindings,
    resolveAutomaticDisplayTitle(binding) {
      return ThreadDisplay.resolveBaleInitialWorkspaceDisplayName({
        bindings: threadStore.listWorkspaceBindings(),
        binding,
        mode: Config.resolveBaleThreadDisplayMode(configStore.get()),
      });
    },
    getFollowerDisplayTitle:
      baleBusFollowerRegistrationState.getDisplayTitle,
    getActiveTurnTarget: activeTurnRuntime.getTarget,
    getFollowerTarget: baleBusFollowerRegistrationState.getTarget,
    isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
    getFollowerSlot: baleBusFollowerRegistrationState.getSlot,
    getFollowerThreadName: baleBusFollowerRegistrationState.getThreadName,
    getLeaderIdentity: baleBusLeaderState.getIdentity,
    getLeaderTarget: baleBusLeaderState.getTarget,
    getLeaderProtocol: baleBusFollowerRegistrationState.getLeaderProtocol,
    status: {
      getThreadMode: function () {
        return threadStore.getBotState().threadMode;
      },
      isBusPollingStarted: baleThreadCapabilityState.isBusPollingStarted,
      listFollowers: baleBusFollowerRegistry.list,
      listReservations: threadStore.listReservations,
      listSyncObservations: threadStore.listSyncObservations,
      getLeaderSocketPath: getBaleBusSocketPath,
      getFollowerSocketPath: getBaleBusFollowerSocketPath,
      getTransportKind: BusTransport.getBaleBusTransportKind,
    },
  });
  const findCurrentThreadRecord = currentInstanceThreadRuntime.findRecord;
  const getCurrentInstanceThreadIdentity =
    currentInstanceThreadRuntime.getIdentity;
  const statusRuntime = Status.createBaleBridgeStatusRuntime<
    Pi.ExtensionContext,
    Queue.BaleQueueItem<Pi.ExtensionContext>
  >({
    getConfig: Status.createBaleBridgeStatusConfigGetter(configStore),
    getActiveProfileName: configStore.getActiveProfileName,
    getDiagnosticPaths: Paths.getBaleDiagnosticsDisplayPaths,
    isPollingActive: Polling.createBalePollingActivityReader(
      pollingControllerState,
    ),
    getPollingState: Polling.createBalePollingStateReader(
      pollingControllerState,
    ),
    getInboundWorkerState() {
      return updateAdmissionRuntimeBinding.getActive()?.getState();
    },
    getAcceptedThroughUpdateId() {
      return Journal.withBaleResolvedUpdateJournalReference({
        registry: baleJournalReferenceRegistry,
        resolveBinding: resolveBaleUpdateJournalBinding,
        referenceClass: "polling-cursor",
        operation(binding) {
          return binding.journal.read().acceptedThroughUpdateId;
        },
      });
    },
    getActiveSourceMessageIds: activeTurnRuntime.getSourceMessageIds,
    hasActiveTurn: activeTurnRuntime.has,
    hasDispatchPending: lifecycle.hasDispatchPending,
    isCompactionInProgress: lifecycle.isCompactionInProgress,
    getActiveToolExecutions: lifecycle.getActiveToolExecutions,
    // Status is composed before the model-switch controller; it reads the controller's state when it renders.
    hasPendingModelSwitch() {
      return modelSwitchController.hasPendingSwitch();
    },
    getQueuedItems: baleQueueStore.getQueuedItems,
    getQueuedItemCount: Queue.countExecutableBaleQueueItems,
    getRecentRuntimeEvents: runtimeEvents.getEvents,
    getRuntimeLockState: lockRuntime.getStatusLabel,
    ...threadStatusProjectionRuntime,
    getBusProtocol() {
      return baleBusProtocolIdentity;
    },
    getBusLifecyclePhase: baleBusFollowerControlState.getLifecyclePhase,
    getBotThreadMode() {
      return threadStore.getBotState();
    },
    getSyncState: baleSyncStateRuntime.getState,
    getThreadReconciliationState() {
      return threadReconciliationRuntime.getState();
    },
  });
  runtimeDiagnostics.bindStatus({
    instanceId: baleInstanceId,
    updateStatus: statusRuntime.updateStatus,
    getStatusState: statusRuntime.getStatusState,
    session: baleSessionContextStore,
    async persistSnapshot(snapshot) {
      threadStore.setStatusSnapshot(snapshot);
      await threadStore.persistStatus();
    },
  });
  const updateStatus = runtimeDiagnostics.updateStatus;
  const getStatusLines = runtimeDiagnostics.getStatusLines;
  const inboundHandlerRuntime = Inbound.createBaleInboundHandlerRuntime({
    getHandlers: configStore.getInboundHandlers,
    execCommand: CommandTemplates.execCommandTemplate,
    getCwd: Pi.getExtensionContextCwd,
    recordRuntimeEvent,
  });

  // --- Bale API ---

  const directBaleApiRuntime =
    BaleApi.createDefaultBaleBridgeApiRuntime({
      getBotToken: configStore.getBotToken,
      isThreadedMode() {
        return threadStore.getBotState().threadMode === "enabled" ||
          baleBusFollowerRegistrationState.getTarget()?.threadId !== undefined ||
          baleBusLeaderState.getTarget()?.threadId !== undefined;
      },
      getBotScope() {
        const config = configStore.get();
        return (
          config.botUsername ??
          (config.botId === undefined ? undefined : String(config.botId))
        );
      },
      recordRuntimeEvent,
      targetActivity: baleApiTargetActivityRuntime,
      workspaceAdmission: workspaceAdmissionRuntime.resolve,
      captureRequestErrorHandler(body) {
        return Sync.captureBaleStaleTargetRequestRecovery(body, {
          ...staleTopicApiErrorRecoveryDeps,
          getCurrentLeaderEpoch,
          getSessionGeneration: baleSessionContextStore.getGeneration,
          getProfileName: configStore.getActiveProfileName,
          onRecovered: runtimeDiagnostics.scheduleSnapshotPersist,
        });
      },
    });
  const baleBusFollowerClients =
    BusFollower.createBaleBusFollowerClientRuntime<
      Pi.ExtensionContext,
      Updates.BaleMessageReactionUpdated,
      Routing.BaleRoutedCallbackQuery,
      Routing.BaleRoutedMessage
    >({
      socketPath: getBaleBusSocketPath,
      instanceId: baleInstanceId,
      getApiAuthSecret: baleBusFollowerControlState.getActiveAuthSecret,
      getForwardingAuthSecret() {
        return baleBusAuthSecret;
      },
      getRegistrationGeneration:
        baleBusFollowerRegistrationState.getGeneration,
      waitForRegistrationGeneration:
        baleBusFollowerRegistrationState.waitForGeneration,
      getForwardCommentBatchPosition:
        textGroupRuntime.getPreparedForwardingPosition,
      validateForwardOwnership: Bus.createBaleBusForwardOwnershipValidator(
        baleBusFollowerRegistry,
      ),
      recordRuntimeEvent,
    });
  const baleApiRuntime = BusApi.createBaleBusAwareApiRuntime({
    directRuntime: directBaleApiRuntime,
    ownsDirect() {
      return lockRuntime.owns();
    },
    getDefaultTarget: proactivePushTargetGetter,
    callFollowerApi: baleBusFollowerClients.callApi,
  });
  const {
    call: callBaleApi,
    callMultipart,
    deleteWebhook,
    getUpdates,
    setMyCommands,
    sendTypingAction,
    sendChatAction,
    sendRecordVoiceAction,
    sendMessageDraft,
    sendMessage,
    sendRichMessage,
    sendRichMessageDraft,
    downloadFile: downloadBaleBridgeFile,
    editMessageText: editBaleMessageText,
    editMessageReplyMarkup: editBaleMessageReplyMarkup,
    answerCallbackQuery,
    answerGuestQuery,
    deleteMessage: deleteBaleMessage,
    prepareTempDir,
  } = baleApiRuntime;

  // --- Message Delivery ---

  const sendGuestReply = Replies.createGuestMarkdownReplySender({
    answerGuestQuery,
  });

  // Answer guest queries immediately and replace the ACK with the final text.
  const answerGuestQueryForInlineMessage =
    baleApiRuntime.answerGuestQueryForInlineMessage;
  const editGuestReply = Replies.createGuestMarkdownReplyEditor({
    editGuestInlineMessage: baleApiRuntime.editGuestInlineMessage,
  });
  // Rotate the guest placeholder frames until the final replacement stops them.
  const guestPlaceholderRuntime = Replies.createBaleGuestPlaceholderRuntime(
    {
      editGuestInlineMessage: baleApiRuntime.editGuestInlineMessage,
      recordRuntimeEvent,
    },
  );

  const promptDispatchRuntime = Runtime.createBalePromptDispatchRuntime({
    lifecycle,
    typing,
    failureLog: runtimeDiagnostics.createFailureLog({
      category: "typing",
      failurePhase: "typing-presence",
      outcomePhase: "typing-presence-recovered",
      label: "typing presence",
    }),
    getDefaultChatId: proactivePushChatIdGetter,
    isThreadedMode() {
      return deliveryTargetPolicyRuntime.getTargetPolicyView().threaded === true;
    },
    sendTypingAction,
    updateStatus,
    isContextActive: baleSessionContextStore.isCurrent,
    getSessionGeneration: baleSessionContextStore.getGeneration,
    getTransportAuthority() {
      if (ownsBaleDirectDelivery()) {
        const epoch = getCurrentLeaderEpoch();
        return epoch === undefined ? undefined : `direct:${epoch}`;
      }
      if (!baleBusFollowerRegistrationState.isRegistered())
        return undefined;
      const generation = baleBusFollowerRegistrationState.getGeneration();
      return generation ? `follower:${generation}` : undefined;
    },
    recordRuntimeEvent,
  });
  const currentModelRuntime = Model.createCurrentModelRuntime({
    getContextModel,
    updateStatus,
  });

  // --- Reply Runtime & Preview ---

  const replyRuntime = Replies.createBaleRenderedMessageDeliveryRuntime({
    recordOwnership: messageOwnershipRuntime.recordLocal,
    sendMessage,
    sendRichMessage,
    getAssistantRenderingMode: configControls.getAssistantRenderingMode,
    editMessage: editBaleMessageText,
  });
  const {
    replyTransport,
    editInteractiveMessage,
    sendInteractiveMessage,
    sendSectionRichMessage,
  } = replyRuntime;
  const deliveryTargetPolicyRuntime =
    Delivery.createBaleDeliveryTargetPolicyRuntime({
      ownsDirect: lockRuntime.owns,
      isThreadedMode() {
        return threadStore.getBotState().threadMode === "enabled" ||
          baleBusFollowerRegistrationState.getTarget()?.threadId !== undefined ||
          baleBusLeaderState.getTarget()?.threadId !== undefined;
      },
      isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
      getAllowedChatId: configStore.getAllowedUserId,
      getFollowerTarget: baleBusFollowerRegistrationState.getTarget,
      getLeaderTarget: baleBusLeaderState.getTarget,
      listThreadRecords: threadStore.list,
      getActiveTurnTarget: activeTurnRuntime.getTarget,
      getActiveGuestQueryId: activeTurnRuntime.getGuestQueryId,
    });
  const deliveryGenerationSeed =
    Delivery.createBaleDeliveryGenerationSeed(baleInstanceId);
  const deliveryLifecycleRuntime =
    Delivery.createBaleBridgeDeliveryLifecycleHooks({
      generationSeed: deliveryGenerationSeed,
      captureDrain: captureCleanupDrain,
      getTargetPolicyView: deliveryTargetPolicyRuntime.getTargetPolicyView,
      getTransportStamp: baleTransportStampRuntime.getStamp,
      isTransportStampActive: baleTransportStampRuntime.isActive,
      getActiveTurnTarget: deliveryTargetPolicyRuntime.getActiveTurnTarget,
      api: baleApiRuntime,
      recordOwnership: messageOwnershipRuntime.recordLocal,
      recordFailure(operation, error, target) {
        recordRuntimeEvent("delivery", error, {
          operation,
          scope: target?.threadId === undefined ? "aggregate" : "thread",
        });
      },
    });
  const { sendTextReply, sendMarkdownReply } =
    Outbound.createBaleOutboundTextReplyRuntime({
      sendTextReply: replyRuntime.sendTextReply,
      sendMarkdownReply: replyRuntime.sendMarkdownReply,
      execCommand: CommandTemplates.execCommandTemplate,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
    });
  const generativeAppLiveSurfaceBinding =
    Bindings.createBaleGenerativeAppLiveSurfaceBinding();
  const invokeGenerativeAppBoundButtonAction =
    Bindings.createBaleGenerativeAppBoundButtonActionInvoker({
      agentDir: Paths.resolveAgentDir(),
      assertExecutionCurrent: Updates.assertBaleUpdateExecutionCurrent,
      getExecutionFence: Updates.getBaleUpdateExecutionFence,
      getActiveProfileName: configStore.getActiveProfileName,
      getLiveSurfaceRuntime: generativeAppLiveSurfaceBinding.get,
      planOutput: planGenerativeAppOutput,
      sendMarkdownReply,
      editInteractiveMessage,
      recordRuntimeEvent,
    });
  const nativeMarkdownDraftSender =
    BaleApi.createBaleAssistantDraftSender({
      getAssistantRenderingMode: configControls.getAssistantRenderingMode,
      renderMarkdownToHtmlDraft: Replies.renderBaleMarkdownToHtmlDraft,
      sendMessageDraft,
      sendRichMessageDraft,
    });
  const previewRuntime = Preview.createBaleAssistantPreviewRuntime({
    getActiveTurn: activeTurnRuntime.get,
    isAssistantMessage: Replies.isAssistantAgentMessage,
    getMessageText: Replies.getAgentMessageText,
    getDefaultReplyToMessageId: activeTurnRuntime.getReplyToMessageId,
    sendDraft: nativeMarkdownDraftSender,
    canSend: configControls.areDraftPreviewsEnabled,
    sendMarkdownReply,
    recordRuntimeEvent,
    ...replyTransport,
  });
  const {
    activityRuntime,
    activityVerbosityRuntime,
    assistantOutputRuntime,
    publicationRuntime,
  } = Bindings.createBaleActivityBindingRuntime({
    generation: deliveryGenerationSeed,
    captureDrain: captureCleanupDrain,
    assistantOutput: {
      prepareBalePreview: previewRuntime.preparePublication,
      authority: {
        getPreferredTarget: proactivePushTargetGetter,
        getFallbackChatId: proactivePushChatIdGetter,
        getTransportStamp: baleTransportStampRuntime.getStamp,
        isTransportStampActive: baleTransportStampRuntime.isActive,
        ownsDirect: lockRuntime.owns,
        getDirectEpoch: lockRuntime.getOwnedLeaderEpoch,
        isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
        getFollowerGeneration:
          baleBusFollowerRegistrationState.getGeneration,
      },
      sender: {
        recordOwnership: messageOwnershipRuntime.recordLocal,
        sendMessage,
        sendRichMessage,
        editMessage: editBaleMessageText,
        getAssistantRenderingMode: configControls.getAssistantRenderingMode,
        planButtonReply:
          Outbound.createBaleButtonReplyPlanner(buttonActionStore),
        execCommand: CommandTemplates.execCommandTemplate,
        getHandlers: configStore.getOutboundHandlers,
        recordRuntimeEvent,
      },
      recordRuntimeEvent,
    },
    activityVerbosity: {
      getActivityMode: configControls.getActivityVerbosity,
      refreshActivityMode: configControls.refreshActivityVerbosity,
      resolveTarget(event) {
        return event.target ?? proactivePushTargetGetter();
      },
      sendMessage,
      sendRichMessage,
      editMessageText: editBaleMessageText,
    },
  });
  const {
    mutation: queueMutationRuntime,
    dispatchNext: dispatchNextQueuedBaleTurn,
    requestNextDispatchAnnouncement,
    cancelNextDispatchAnnouncement,
    watchdog: queueDispatchWatchdogRuntime,
    onTurnEnd: onSteerTurnEnd,
  } = Bindings.createBaleQueueBindingRuntime({
    store: baleQueueStore,
    queue,
    lifecycle,
    activeTurn: activeTurnRuntime,
    admission: updateAdmissionRuntimeBinding,
    transportStamp: baleTransportStampRuntime,
    deferredDispatch: deferredQueueDispatchRuntime,
    promptDispatch: promptDispatchRuntime,
    isIdle,
    hasPendingMessages,
    isContextCurrent: baleSessionContextStore.isCurrent,
    isContextAborted: Pi.isExtensionContextAbortRequested,
    updateStatus,
    sendTextReply,
    sendUserMessage,
    reconcileNextDispatchAnnouncementReplyOwnership(item) {
      Replies.preserveTransportReplyDedupOnNextReset(
        item.chatId,
        item.replyToMessageId,
        item.target,
      );
    },
    recordRuntimeEvent,
  });
  const { finalizeMarkdownPreview, preparePreviewDelivery } =
    Outbound.createBaleOutboundTextPreviewRuntime({
      finalizeMarkdownPreview: previewRuntime.finalizeMarkdown,
      preparePreviewDelivery: previewRuntime.prepareDelivery,
      execCommand: CommandTemplates.execCommandTemplate,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
    });

  // --- Model And Menu Setup ---

  const modelSwitchController =
    Model.createBaleModelSwitchControllerRuntime({
      isIdle,
      getActiveTurn: activeTurnRuntime.get,
      getAbortHandler: abort.getHandler,
      hasAbortHandler: abort.hasHandler,
      getActiveToolExecutions: lifecycle.getActiveToolExecutions,
      allocateItemOrder: queue.allocateItemOrder,
      allocateControlOrder: queue.allocateControlOrder,
      appendQueuedItem: queueMutationRuntime.append,
      updateStatus,
    });
  const getQueueItemCount =
    Queue.createBaleQueueItemCountGetter(baleQueueStore);
  const getPromptTemplateCommands =
    PromptTemplates.createBalePromptTemplateCommandGetter({
      getCommands,
      getReservedCommandNames: Commands.getBaleReservedCommandNames,
    });
  const getQueueMenuState = Menu.createBaleModelMenuStateBuilder({
    runtime: modelMenuRuntime,
    createSettingsManager: Pi.createSettingsManager,
    getActiveModel: currentModelRuntime.get,
  });
  const menuActionPorts = {
    getModelMenuState: getQueueMenuState,
    getActiveModel: currentModelRuntime.get,
    getThinkingLevel,
    getQueueItemCount,
    getPendingCancellationCount() {
      return getCurrentLeaderEpoch() === undefined
        ? 0
        : (updateAdmissionRuntimeBinding.getActive()?.getState()
            ?.abandoningClaimCount ?? 0);
    },
    buildStatusHtml: Commands.createBaleAppMenuHtmlBuilder({
      buildStatusHtml: Status.createBaleStatusHtmlBuilder({
        getActiveModel: currentModelRuntime.get,
        isCompactionInProgress: lifecycle.isCompactionInProgress,
        getBridgeStatusLineState: statusRuntime.getStatusState,
      }),
      getPromptTemplateCommands,
    }),
    storeModelMenuState: modelMenuRuntime.storeState,
    isIdle,
    canOfferInFlightModelSwitch: modelSwitchController.canOfferInFlightSwitch,
    sectionRegistry,

    // Menu/status UI uses this to reflect whether the active Bale turn expects voice delivery.
    isVoiceReplyActive: function () {
      const turn = activeTurnRuntime.get();
      return Voice.isVoiceTurn(turn);
    },
  };
  const menuActions = Menu.createBaleMenuActionRuntime({
    ...menuActionPorts,
    sendTextReply,
    editInteractiveMessage,
    sendInteractiveMessage,
  });

  // --- Queue And Settings Menus ---
  const queueMenuRuntime = MenuQueue.createBaleQueueMenuRuntime({
    hasPendingDispatch: lifecycle.hasDispatchPending,
    baleQueueStore,
    queueMutationRuntime,
    sendInteractiveMessage,
    editInteractiveMessage,
    answerCallbackQuery,
    getModelMenuState: getQueueMenuState,
    getStoredModelMenuState: modelMenuRuntime.getState,
    storeModelMenuState: modelMenuRuntime.storeState,
    updateStatusMessage: menuActions.updateStatusMessage,
    updateStatus,
    dismissGuestPlaceholder: guestPlaceholderRuntime.dismiss,
  });
  const threadDisplaySettingsRuntime =
    ThreadDisplay.createBaleThreadDisplaySettingsRuntime({
      getTarget() {
        return (
          baleBusFollowerRegistrationState.getTarget() ??
          baleBusLeaderState.getTarget()
        );
      },
      getBinding(target) {
        return threadStore.getWorkspaceBindingByTarget(target);
      },
      apply(mode) {
        return ThreadDisplay.applyBaleThreadDisplaySetting(mode, {
          getProfileKey: configStore.getActiveProfileName,
          ownsLeader() {
            return getCurrentLeaderEpoch() !== undefined;
          },
          getLeaderSetter() {
            return baleBusLeaderRuntime.setThreadDisplayMode;
          },
          getFollowerSetter() {
            return baleBusFollowerRegistration.setThreadDisplayMode;
          },
          reloadConfig: configStore.load,
        });
      },
      reset(target) {
        return baleThreadDisplayNameResetBinding.reset(target);
      },
    });
  const settingsMenuRuntime = MenuSettings.createBaleSettingsMenuRuntime(
    {
      reloadConfig: configStore.load,
      getModelMenuState: getQueueMenuState,
      getStoredModelMenuState: modelMenuRuntime.getState,
      storeModelMenuState: modelMenuRuntime.storeState,
      editInteractiveMessage,
      sendInteractiveMessage,
      answerCallbackQuery,
      ...configControls,
      reviewInactiveThreads: inactiveThreadCleanupRuntime.review,
      cleanInactiveThreads: inactiveThreadCleanupRuntime.clean,
      getThreadDisplayMode() {
        return threadStore.getBotState().threadMode === "enabled"
          ? Config.resolveBaleThreadDisplayMode(configStore.get())
          : undefined;
      },
      isThreadDisplayCustom: threadDisplaySettingsRuntime.isCustom,
      async setThreadDisplayMode(mode) {
        try {
          await threadDisplaySettingsRuntime.setMode(mode);
        } catch (error) {
          recordRuntimeEvent("bus", error, { phase: "thread-display-setting" });
          throw error;
        }
      },
    },
    sectionRegistry,
  );

  // --- Polling ---

  const foreignOwnedUpdateForwarder =
    baleBusFollowerClients.foreignOwnedUpdateForwarder;
  const workspaceRestoreFollowerController =
    Bus.createBaleBusWorkspaceRestoreController({
      getFollower: baleBusFollowerRegistry.get,
      localProtocolIdentity: baleBusProtocolIdentity,
      createRequestId: baleBusFollowerClients.createRequestId,
      getAuthSecret() {
        return baleBusAuthSecret;
      },
    });
  const liveRebindFollowerController =
    Bus.createBaleBusLiveRebindController({
      getFollower: baleBusFollowerRegistry.get,
      localProtocolIdentity: baleBusProtocolIdentity,
      createRequestId: baleBusFollowerClients.createRequestId,
      getAuthSecret() {
        return baleBusAuthSecret;
      },
    });
  const liveFollowerPorts = {
    getJournalBindingKey(follower: Bus.BaleBusFollowerView) {
      if (!follower.profileKey || !follower.sessionId) return undefined;
      return baleJournalBindingRuntime.createRecipientResolver(
        follower.profileKey,
        follower.sessionId,
      )()?.recoveryKey;
    },
    isSelectedCommandAvailable(
      follower: Readonly<Bus.BaleBusFollowerView>,
      name: string,
    ): boolean {
      return (
        Bus.hasBaleBusSharedCapabilities(
          baleBusProtocolIdentity,
          follower.protocol,
          [
            ...Bus.BALE_BUS_LIVE_REBIND_CAPABILITIES,
            ...Bus.getBaleBusHeldCommandCapabilities(name),
          ],
        ) &&
        typeof selectedMenuDelivery === "function" &&
        typeof inboundRouteRuntime.prepareHeldCommand === "function" &&
        typeof inboundRouteRuntime.canPrepareHeldCommand === "function" &&
        inboundRouteRuntime.canPrepareHeldCommand(name, {
          showStatus: menuActions.sendStatusMessage,
          sendTextReply,
        }) &&
        !!captureBaleStateAuthority() &&
        !!workspaceAdmissionRuntime.resolve() &&
        !!resolveWorkspaceRestoreStore()
      );
    },
    run: liveRebindFollowerController,
  };
  const observedThreadTargetBinding =
    Polling.createBaleThreadTargetObservationBinding<Pi.ExtensionContext>();
  const topicLifecycleSync =
    Sync.createBaleObservedTopicLifecycleSyncHandler({
      topicTargetStore: threadStore,
      isBusEnabled: isBaleBusRuntimeEnabled,
      callApi: callBaleApi,
      isTopicProvisioningActive: baleProvisioningActivity.isActive,
      getCurrentLeaderEpoch,
      getThreadReconciliationMachineState: threadReconciliationRuntime.getState,
      recordThreadReconciliationPlan,
      runWorkspaceOperation: baleWorkspaceOperationRuntime.run,
      assertExecutionCurrent(message) {
        Updates.assertBaleUpdateExecutionCurrent(message);
      },
      getSyncState: baleSyncStateRuntime.getState,
      setSyncState: baleSyncStateRuntime.setState,
      recordEvent: recordRuntimeEvent,
    });
  const inboundBusProjectionRuntime =
    Routing.createBaleInboundBusProjectionRuntime({
      instanceId: baleInstanceId,
      listFollowers: baleBusFollowerRegistry.list,
      listThreadRecords: threadStore.list,
      getLeaderTarget: baleBusLeaderState.getTarget,
      isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
      getFollowerTarget: baleBusFollowerRegistrationState.getTarget,
      getCurrentIdentity: getCurrentInstanceThreadIdentity,
    });
  const baleThreadDisplayNameRenameBinding =
    Commands.createBaleThreadDisplayNameRenameBinding();
  const baleThreadDisplayNameResetBinding =
    Commands.createBaleThreadDisplayNameResetBinding();
  const observeLiveTargetWork = Bindings.createBaleLiveTargetWorkObserver({
    queue: baleQueueStore,
    activeTurn: activeTurnRuntime,
    lifecycle: bridgeRuntime.lifecycle,
    isIdle,
    hasPendingMessages,
    hasPendingControl: modelSwitchController.hasPendingSwitch,
    publication: publicationRuntime,
    activity: activityRuntime,
    delivery: deliveryLifecycleRuntime,
    api: baleApiTargetActivityRuntime,
  });
  const prepareTemporaryThreadJournalInspection = function (
    target: Targets.BaleTarget,
    requiredJournalBindingKeys: readonly string[],
    ownInputs?: readonly Threads.BaleTemporaryThreadInput[],
  ): Parameters<typeof Journal.isBaleThreadCleanupJournalNamespaceClear>[0] | undefined {
    const binding = resolveBaleUpdateJournalBinding();
    const botToken = configStore.getBotToken();
    if (!binding || !botToken) return undefined;
    const profile = configStore.getActiveProfileName() ?? "default";
    const botIdentity = Journal.createBaleUpdateJournalBotIdentity({ botToken, botId: getBaleBotId() });
    return {
      directory: Paths.resolveBaleTempDir(), profile, botIdentity,
      pollingPath: baleLeaderJournalPath.resolve(configStore.getActiveProfileName()),
      requiredJournalBindingKeys: [binding.recoveryKey, ...requiredJournalBindingKeys],
      ...(target.threadId !== undefined && ownInputs
        ? { cleanup: { target: { chatId: target.chatId, threadId: target.threadId }, ownInputs } } : {}),
      limits: { maxDirectoryEntries: 10_000, maxFiles: 4096, maxBytes: 64 * 1024 * 1024,
        maxEntries: 10_000, maxWork: 100_000 },
      withSourceReference(path, operation) {
        return baleJournalReferenceRegistry.withReference({
          referenceClass: "operator-disposition",
          recoveryKey: Journal.createBaleUpdateJournalBindingKey({ path, profileName: profile, botIdentity }),
        }, operation);
      },
    };
  };
  const inboundRouteRuntime = Routing.createBaleInboundRouteRuntime({
    configStore,
    callApi: callBaleApi,
    getCurrentInstanceId() {
      return baleInstanceId;
    },
    getAdmissionScope: getBaleUpdateAdmissionScope,
    getAdmissionJournalBinding: getBaleQueueJournalBinding,
    getCommandReplyTarget(message) {
      if (
        message.chat.type !== "private" ||
        "business_connection_id" in message ||
        !Updates.getBaleUpdateExecutionFence(message) ||
        lockRuntime.owns()
      ) return undefined;
      Updates.assertBaleUpdateExecutionCurrent(message);
      const binding = resolveBaleFollowerJournalBinding();
      const target = baleBusFollowerRegistrationState.getTarget();
      if (
        !baleBusFollowerRegistrationState.isRegistered() ||
        !binding ||
        binding.recoveryKey !==
          followerAdmissionLifecycleRuntime.getJournalBindingKey() ||
        !target ||
        (threadStore.getBotState().threadMode === "enabled" &&
          target.threadId === undefined)
      ) throw new Error("Bale command reply lost its registered recipient.");
      return { ...target };
    },
    beginCommandEffectWork: publicationRuntime.beginWork,
    getMessageOwnership: messageOwnershipRuntime.getForwardOwnership,
    recordMessageOwnership: messageOwnershipRuntime.recordRouted,
    ...inboundBusProjectionRuntime,
    getDisplayTitle: getThreadDisplayTitle,
    getCurrentLeaderEpoch,
    setCurrentLeaderIdentity: baleBusLeaderState.set,
    getThreadReconciliationMachineState: threadReconciliationRuntime.getState,
    recordThreadReconciliationPlan,
    handleBaleTopicLifecycleUpdate: topicLifecycleSync,
    handleBaleThreadTargetObserved(_target, ctx) {
      return observedThreadTargetBinding.handle(ctx);
    },
    foreignOwnedUpdateForwarder,
    workspaceRestoreRecipient: {
      getSessionId: Pi.getExtensionContextSessionId,
      getCwd: Pi.getExtensionContextCwd,
      getLeaderIdentity: baleBusLeaderState.getIdentity,
      observeLeaderWork: observeLiveTargetWork,
      followerRegistry: baleBusFollowerRegistry,
      runFollower: workspaceRestoreFollowerController,
      liveFollower: liveFollowerPorts,
    },
    getWorkspaceRestoreStore: resolveWorkspaceRestoreStore,
    captureWorkspaceExternalProtection,
    inspectRestoreSourceCompletion(expected) {
      return baleJournalReferenceRegistry.withReference(
        {
          referenceClass: "operator-disposition",
          recoveryKey: expected.journalBindingKey,
        },
        function () {
          const observed =
            baleJournalBindingRuntime.inspectSourceCompletion(
              expected.journalBindingKey,
              {
                updateId: expected.updateId,
                sourceSha256: expected.sourceSha256,
                completionSha256: expected.completionSha256,
              },
            );
          return (
            observed && {
              journalBindingKey: expected.journalBindingKey,
              ...observed,
            }
          );
        },
      );
    },
    inspectRestoreQueuedReceipt(expected) {
      return baleJournalReferenceRegistry.withReference(
        {
          referenceClass: "operator-disposition",
          recoveryKey: expected.journalBindingKey,
        },
        function () {
          return baleJournalBindingRuntime.inspectQueuedReceipt(
            expected.journalBindingKey,
            {
              queueKind: expected.queueKind,
              receiptId: expected.receiptId,
              sourceUpdateIds: [...expected.sourceUpdateIds],
              queueOwner: { ...expected.queueOwner },
            },
          );
        },
      );
    },
    inspectRestoreSourceAbandonment(updateId, journalBindingKey) {
      return baleJournalReferenceRegistry.withReference(
        {
          referenceClass: "operator-disposition",
          recoveryKey: journalBindingKey,
        },
        function () {
          return baleJournalBindingRuntime.inspectSourceAbandonment(
            journalBindingKey,
            updateId,
          );
        },
      );
    },
    inspectRoutingInputGroupExpiry(input) {
      return baleJournalReferenceRegistry.withReference(
        {
          referenceClass: "operator-disposition",
          recoveryKey: input.journalBindingKey,
        },
        function () {
          return baleJournalBindingRuntime.inspectSourceGroupExpiry(
            input.journalBindingKey,
            input.updateIds,
          );
        },
      );
    },
    inspectTemporaryThreadSources(target, requiredJournalBindingKeys, ownInputs) {
      const input = prepareTemporaryThreadJournalInspection(target, requiredJournalBindingKeys, ownInputs);
      if (!input) return undefined;
      return withBaleJournalSourceSerialization(function () {
        return Journal.isBaleThreadCleanupJournalNamespaceClear(input) ? [] : undefined;
      });
    },
    recoverTemporaryThreadDeadQueueOwners(target, requiredJournalBindingKeys, ownInputs, isCurrent) {
      const input = prepareTemporaryThreadJournalInspection(target, requiredJournalBindingKeys, ownInputs);
      if (!input || !isCurrent()) return 0;
      return Journal.recoverBaleThreadCleanupDeadQueueOwners({
          ...input, isCurrent, withSourceSerialization: withBaleJournalSourceSerialization,
          recoveryOwner: {
            instanceId: baleInstanceId, processId: baleProcessId,
            processBirthId: baleQueueProcessBirthId,
            sessionGeneration: baleSessionContextStore.getGeneration(),
          },
        });
    },
    hasWorkspaceRestoreAuthority() {
      return (
        lockRuntime.owns() &&
        Bus.hasBaleBusCapability(
          baleBusProtocolIdentity,
          Bus.BALE_BUS_CAPABILITY_WORKSPACE_RESTORE,
        )
      );
    },
    canUsePreDispatchRebind(recipient) {
      return lockRuntime.owns() && baleBusFollowerRegistry.list().every(function (follower) {
        return Bus.hasBaleBusCapability(follower.protocol, Bus.BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND);
      }) && (recipient?.kind !== "follower" || Bus.hasBaleBusCapability(
        baleBusFollowerRegistry.get(recipient.instanceId)?.protocol,
        Bus.BALE_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION,
      ));
    },
    hasWorkspaceLiveRebindAuthority() {
      return (
        lockRuntime.owns() &&
        Bus.hasBaleBusCapability(
          baleBusProtocolIdentity,
          Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_SAVE,
        ) &&
        Bus.hasBaleBusCapability(
          baleBusProtocolIdentity,
          Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY,
        ) &&
        Bus.hasBaleBusCapability(
          baleBusProtocolIdentity,
          Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
        )
      );
    },
    getSessionGeneration: baleSessionContextStore.getGeneration,
    bridgeRuntime,
    requestNewSession(source) {
      const updateId =
        Updates.getBaleUpdateExecutionFence(source)?.updateId;
      if (updateId === undefined) {
        throw new Error(
          "Bale session replacement requires durable update authority.",
        );
      }
      const callbackMessage =
        source && typeof source === "object" && "message" in source
          ? (source as { message?: unknown }).message
          : source;
      const messageTarget = callbackMessage as
        | {
            chat?: { id?: unknown };
            message_id?: unknown;
            message_thread_id?: unknown;
          }
        | undefined;
      const target =
        typeof messageTarget?.chat?.id === "number" &&
        typeof messageTarget.message_id === "number"
          ? {
              chatId: messageTarget.chat.id,
              messageId: messageTarget.message_id,
              ...(typeof messageTarget.message_thread_id === "number"
                ? { threadId: messageTarget.message_thread_id }
                : {}),
            }
          : undefined;
      if (!target) {
        throw new Error("Bale session replacement target is unavailable.");
      }
      if (!sessionActionsRuntime.scheduleAfterUpdate(updateId, target)) {
        throw new Error("A Bale session replacement is already pending.");
      }
    },
    activeTurnRuntime,
    mediaGroupRuntime,
    textGroupRuntime,
    baleQueueStore,
    queueMutationRuntime,
    modelMenuRuntime,
    currentModelRuntime,
    modelSwitchController,
    menuActions,
    isVoiceReplyActive: menuActionPorts.isVoiceReplyActive,
    updateSettingsMenuMessage: settingsMenuRuntime.updateSettingsMenuMessage,
    openQueueMenu: queueMenuRuntime.openQueueMenu,
    queueMenuCallbackHandler: queueMenuRuntime.handleCallbackQuery,
    openSettingsMenu: settingsMenuRuntime.openSettingsMenu,
    settingsMenuCallbackHandler: settingsMenuRuntime.handleCallbackQuery,
    sectionRegistry,
    sendSectionRichMessage,
    buttonActionStore,
    invokeBoundButtonAction: invokeGenerativeAppBoundButtonAction,
    inboundHandlerRuntime,
    threadStore,
    runWorkspaceOperation: baleWorkspaceOperationRuntime.run,
    liveRebindCleanupSchedule: Routing.BALE_LIVE_REBIND_CLEANUP_SCHEDULE,
    liveRebindCommandCompletionTimeoutMs: 8_000,
    updateStatus,
    isContextActive: baleSessionContextStore.isCurrent,
    dispatchNextQueuedBaleTurn,
    requestNextDispatchAnnouncement,
    cancelNextDispatchAnnouncement,
    requestDeferredDispatchNextQueuedBaleTurn:
      deferredQueueDispatchRuntime.request,
    hasDeferredDispatchContext: deferredQueueDispatchRuntime.isBound,
    startTypingLoop: promptDispatchRuntime.startTypingLoop,
    stopTypingLoop: typing.stop,
    answerCallbackQuery,
    editInteractiveMessage,
    editMessageReplyMarkup: editBaleMessageReplyMarkup,
    sendInteractiveMessage,
    deleteMessage: deleteBaleMessage,
    answerGuestQuery,
    answerGuestQueryForInlineMessage,
    startGuestPlaceholder: guestPlaceholderRuntime.start,
    sendTextReply,
    setMyCommands,
    captureThreadNameRecipientAuthority(target, ctx) {
      // Ordinary follower/classic dialogs keep their unguarded policy; closures are leader-local only.
      if (
        baleBusFollowerRegistrationState.isRegistered() ||
        target.threadId === undefined
      )
        return undefined;
      // Pi creates a fresh context object per event and command, so authority follows the session, not the object.
      const sessionGeneration = baleSessionContextStore.getGeneration();
      return Threads.createBaleWorkspaceThreadRenameRecipient({
        store: threadStore,
        instanceId: baleInstanceId,
        target,
        assertAuthority() {
          if (!baleSessionContextStore.isCurrent(ctx, sessionGeneration))
            throw new Error("Bale Thread name dialog lost Pi context.");
        },
        getAuthority: threadNameRecipientAuthority.getAuthority,
      }).assertAuthority;
    },
    validateThreadName(threadName) {
      return ThreadNaming.getBaleManualThreadDisplayNameValidationError(
        threadName,
      );
    },
    renameCurrentThread: baleThreadDisplayNameRenameBinding.rename,
    resetCurrentThreadName: baleThreadDisplayNameResetBinding.reset,
    getCommands,
    downloadFile: downloadBaleBridgeFile,
    resolveTimeLine: timeInjectionRuntime.resolveLine,
    getThinkingLevel,
    setThinkingLevel,
    persistScopedModelPatterns: Pi.createScopedModelPatternPersister({
      createSettingsManager: Pi.createSettingsManager,
      clearCachedModelMenuInputs: modelMenuRuntime.clearCachedInputs,
    }),
    setModel,
    sendUserMessage,
    isIdle,
    hasPendingMessages,
    compact,
    recordRuntimeEvent,
  });
  const queueHandoffReconciliationBinding =
    Updates.createBaleQueueHandoffReconciliationBinding<Pi.ExtensionContext>(
      function (error) {
        recordRuntimeEvent("inbound-worker", error, {
          phase: "queue-handoff-reconcile",
        });
      },
    );
  const staleTopicApiErrorRecoveryDeps = {
    topicTargetStore: threadStore,
    getSyncState: baleSyncStateRuntime.getState,
    setSyncState: baleSyncStateRuntime.setState,
    recordEvent: recordRuntimeEvent,
    getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
  };
  const recoverStaleBaleTopicApiError =
    Sync.createBaleStaleTopicApiErrorRecoveryRuntime(
      staleTopicApiErrorRecoveryDeps,
    );
  const {
    owner: updateWorkerOwnerRuntime,
    leader: updateAdmissionLifecycleRuntime,
    follower: followerAdmissionLifecycleRuntime,
  } = Updates.createBaleUpdateAdmissionRuntimeAssembly<
    Parameters<typeof inboundRouteRuntime.handleUpdate>[0] &
      Journal.BaleJournaledUpdate,
    Pi.ExtensionContext
  >({
    runtimeBinding: updateAdmissionRuntimeBinding,
    acquireSourceReference(role, binding) {
      return baleJournalReferenceRegistry.acquire({
        referenceClass:
          role === "leader" ? "leader-lifecycle" : "follower-lifecycle",
        recoveryKey: binding.recoveryKey,
      });
    },
    owner: {
      instanceId: baleInstanceId,
      processId: baleProcessId,
      processBirthId: baleQueueProcessBirthId,
      getSessionGeneration: baleSessionContextStore.getGeneration,
      isContextCurrent: baleSessionContextStore.isCurrent,
      dispatchNext: dispatchNextQueuedBaleTurn,
      requestQueueHandoffReconciliation:
        queueHandoffReconciliationBinding.request,
      afterQueueReceiptCommitted: inboundRouteRuntime.onQueueReceiptCommitted,
      afterUpdateCompleted(updateId, ctx, journalBindingKey) {
        sessionActionsRuntime.onUpdateCompleted(updateId);
        inboundRouteRuntime.onUpdateCompleted(updateId, ctx, journalBindingKey);
      },
    },
    worker: {
      expireRoutingInput: inboundRouteRuntime.expireRoutingInput,
      beforeQueueReceiptPublished:
        inboundRouteRuntime.beforeQueueReceiptPublished,
      onQueueReceiptCompleted: inboundRouteRuntime.onQueueReceiptCompleted,
      defaultHandle: inboundRouteRuntime.handleUpdate,
      async shouldReviewHistoricalInput(entry, ctx, signal) {
        if (signal.aborted || !baleSessionContextStore.isCurrent(ctx)) {
          throw new Error("Workspace Restore source generation ended.");
        }
        const verdict = await inboundRouteRuntime.shouldReviewHistoricalInput(
          entry,
          ctx,
          signal,
        );
        if (signal.aborted || !baleSessionContextStore.isCurrent(ctx)) {
          throw new Error("Workspace Restore source generation ended.");
        }
        if (verdict === "retain") return verdict;
        const journalBindingKey = getBaleQueueJournalBinding();
        if (
          journalBindingKey &&
          resolveWorkspaceRestoreStore()
            ?.list()
            .some(function (intent) {
              return (
                intent.request.source.journalBindingKey === journalBindingKey &&
                intent.request.source.updateIds.includes(entry.updateId)
              );
            })
        )
          return true;
        return verdict;
      },
      spendHistoricalInput: true,
      onHeldSourcesPrepared(input): Promise<void> {
        return inboundRouteRuntime
          .forgetPreviousWorld(
            input,
            lockedPollingRuntime.captureTransportAuthority,
          )
          .then(function () {});
      },
      async shouldHoldPendingInput(entry, ctx, signal) {
        if (signal.aborted || !baleSessionContextStore.isCurrent(ctx)) {
          throw new Error("Temporary Thread source generation ended.");
        }
        return inboundRouteRuntime.shouldHoldPendingInput(entry, ctx, signal);
      },
      onStateChange: runtimeDiagnostics.scheduleSnapshotPersist,
      settleTerminalExecutionFailure(error) {
        return Sync.settleStaleBaleTopicExecutionFailure(
          error,
          staleTopicApiErrorRecoveryDeps,
        );
      },
    },
    leader: {
      resolveBinding: resolveBaleUpdateJournalBinding,
      hasAuthority: lockRuntime.owns,
    },
    follower: {
      resolveBinding: resolveBaleFollowerJournalBinding,
      isRegistered: baleBusFollowerRegistrationState.isRegistered,
      getGeneration: baleBusFollowerRegistrationState.getGeneration,
      prepareBinding(binding) {
        baleJournalBindingRuntime.prepareActiveFollowerSuccession(
          function () {
            return binding.hasAuthority?.() === true;
          },
        );
      },
      prepareUpdateForExecution(update) {
        return BusFollower.prepareBaleBusFollowerJournaledUpdateForExecution(
          update,
          textGroupRuntime.prepareForwardedMessage,
        );
      },
    },
    recordRuntimeEvent,
  });
  const queueHandoffStagingRuntime =
    Queue.createBaleQueueHandoffStagingRuntime({
      liveStore: baleQueueStore,
      createControlExecution:
        Updates.createBaleQueueHandoffControlExecutionFactory({
          isContextCurrent: baleSessionContextStore.isCurrent,
          showStatus: menuActions.sendStatusMessage,
          openModelMenu: menuActions.openModelMenu,
        }),
    });
  const acceptStagedQueueHandoff =
    Updates.createBaleQueueHandoffRecipientRuntime({
      staging: queueHandoffStagingRuntime,
      getRecipientOwner: updateWorkerOwnerRuntime.getQueueOwnerIdentity,
      getLifecycleForBinding:
        updateAdmissionRuntimeBinding.getLifecycleForJournalBinding,
      isTransportStampActive: baleTransportStampRuntime.isActive,
      dispatchNext: dispatchNextQueuedBaleTurn,
    });
  const followerDurableAdmissionRuntime =
    BusFollower.createBaleBusFollowerDurableAdmissionRuntime({
      journal: {
        appendBatch(updates) {
          return followerAdmissionLifecycleRuntime.appendBatch(updates);
        },
      },
      signalWorker() {
        followerAdmissionLifecycleRuntime.signal();
      },
    });
  const promoteBaleBusFollowerToLeader: BusFollower.BaleBusFollowerPromotionHandler<Pi.ExtensionContext> =
    BusFollower.createBaleBusFollowerPromotionHandler<Pi.ExtensionContext>({
      topicTargetStore: threadStore,
      instanceId: baleInstanceId,
      getActiveProfileName: configStore.getActiveProfileName,
      getSessionId: Pi.getExtensionContextSessionId,
      getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
      async startLeader(ctx, election, onAcquired): Promise<boolean> {
        const result = await lockedPollingRuntime.start(ctx, {
          election,
          onAcquired,
        });
        return result.ok;
      },
      recordRuntimeEvent,
    });
  const agentMessageRuntime = AgentMessages.createBaleAgentMessageRuntime({
    instanceId: baleInstanceId,
    getAllowedChatId: configStore.getAllowedUserId,
    getLeaderTarget: baleBusLeaderState.getTarget,
    getLeaderThreadName() {
      return findCurrentThreadRecord()?.threadName;
    },
    followerRegistry: baleBusFollowerRegistry,
    getDisplayTitle: getThreadDisplayTitle,
    getContext: baleSessionContextStore.get,
    handleUpdate: inboundRouteRuntime.handleUpdate,
  });
  const agentMessageToolRoutingRuntime =
    Bindings.createBaleAgentMessageToolRoutingRuntime({
      ownsLeader: lockRuntime.owns,
      ownsDirectDelivery: ownsBaleDirectDelivery,
      isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
      getSourceTarget: proactivePushTargetGetter,
      getSourceThreadName() {
        return findCurrentThreadRecord()?.threadName;
      },
      local: agentMessageRuntime,
      follower: baleBusFollowerClients.agentMessages,
    });
  const followerWorkspaceTargetContextPorts = {
    isContextCurrent: baleSessionContextStore.isCurrent,
    getSessionId: Pi.getExtensionContextSessionId,
    getCwd: Pi.getExtensionContextCwd,
    getGeneration: baleSessionContextStore.getGeneration,
    getProfileBindingKey() {
      return workspaceAdmissionRuntime.resolve()?.getProfileKey();
    },
    getOperatorUserId: configStore.getAllowedUserId,
    getLeaderState: lockRuntime.getState,
    getAuthenticatedSecret: baleBusFollowerControlState.getActiveAuthSecret,
    getLeaderProtocol: baleBusFollowerRegistrationState.getLeaderProtocol,
  };
  const followerWorkspaceTargetOwnerPorts = {
    instanceId: baleInstanceId,
    readRestoreIntent(operationId: string, profileBindingKey: string) {
      if (
        profileBindingKey !==
        workspaceAdmissionRuntime.resolve()?.getProfileKey()
      )
        return undefined;
      return resolveWorkspaceRestoreStore()
        ?.list()
        .find(function (intent) {
          return intent.request.operationId === operationId;
        });
    },
    readLiveRebindIntent(operationId: string, profileBindingKey: string) {
      if (
        profileBindingKey !==
        workspaceAdmissionRuntime.resolve()?.getProfileKey()
      )
        return undefined;
      return resolveWorkspaceRestoreStore()
        ?.listLiveRebindings()
        .find(function (intent) {
          return intent.request.operationId === operationId;
        });
    },
    topicTargetStore: threadStore,
    registrationState: baleBusFollowerRegistrationState,
    getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
    recordRuntimeEvent,
  };
  const followerWorkspaceRestore =
    BusFollower.createBaleBusFollowerWorkspaceRestoreHandler({
      ...followerWorkspaceTargetOwnerPorts,
      getContextAuthority:
        BusFollower.createBaleBusFollowerRestoreContextGetter(
          followerWorkspaceTargetContextPorts,
        ),
    });
  const followerLiveRebindTarget =
    BusFollower.createBaleBusFollowerWorkspaceRestoreHandler({
      ...followerWorkspaceTargetOwnerPorts,
      getContextAuthority:
        BusFollower.createBaleBusFollowerRestoreContextGetter({
          ...followerWorkspaceTargetContextPorts,
          capability: Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY,
        }),
    });
  const selectedMenuCaller =
    BusFollower.createBaleBusFollowerSelectedMenuCaller({
      client: {
        socketPath: getBaleBusSocketPath,
        instanceId: baleInstanceId,
        createRequestId: baleBusFollowerClients.createRequestId,
        getAuthSecret: baleBusFollowerControlState.getActiveAuthSecret,
        getRegistrationGeneration:
          baleBusFollowerRegistrationState.getGeneration,
      },
      protocolIdentity: baleBusProtocolIdentity,
      recipient: {
        getContextAuthority:
          BusFollower.createBaleBusFollowerRestoreContextGetter({
            ...followerWorkspaceTargetContextPorts,
            // Wire recipient identity is the registered profile key, not the admission namespace.
            getProfileBindingKey: getBaleManualFollowerProfileKey,
            capability: Bus.BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
          }),
        getJournalBindingKey:
          followerAdmissionLifecycleRuntime.getJournalBindingKey,
        getProcessIdentity() {
          return {
            processId: baleProcessId,
            processBirthId: baleQueueProcessBirthId,
          };
        },
        registrationState: baleBusFollowerRegistrationState,
      },
    });
  const followerLiveRebindRuntime =
    BusFollower.createBaleBusFollowerLiveRebindRuntime({
      getAdmission(ctx: Pi.ExtensionContext) {
        return baleSessionContextStore.isCurrent(ctx)
          ? followerAdmissionLifecycleRuntime
          : undefined;
      },
      applyTarget: followerLiveRebindTarget,
      getCommandOwner(input, ctx) {
        if (
          !Bus.hasBaleBusCapability(
            baleBusProtocolIdentity,
            Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET,
          ) ||
          !Bus.hasBaleBusCapability(
            baleBusProtocolIdentity,
            Bus.BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
          ) ||
          !input.selectedCommand ||
          !baleSessionContextStore.isCurrent(ctx) ||
          followerAdmissionLifecycleRuntime.getJournalBindingKey() !==
            input.recipientBindingKey
        )
          return undefined;
        const recipient = followerLiveRebindTarget.prepareLiveCommandRecipient(
          {
            operationId: input.operationId,
            registrationGeneration: input.recipientRegistrationGeneration,
            sessionId: input.recipientSessionId,
            sourceUpdateIds: input.updates.map(function sourceUpdateId(update) {
              return update.update_id;
            }),
            target: input.selectedCommand.target,
          },
          ctx,
        );
        return (
          recipient &&
          Bindings.createBaleFollowerSelectedCommandBinding({
            ctx,
            operationId: input.operationId,
            registrationGeneration: input.recipientRegistrationGeneration,
            name: input.selectedCommand.name,
            target: input.selectedCommand.target,
            recipient,
            command: inboundRouteRuntime,
            menu: menuActionPorts,
            recordOwnership: messageOwnershipRuntime.recordLocal,
            deliver(effect, assertAuthority) {
              return selectedMenuCaller({
                ctx,
                operationId: input.operationId,
                registrationGeneration: input.recipientRegistrationGeneration,
                effect,
                assertAuthority,
              });
            },
          })
        );
      },
      observeWork: observeLiveTargetWork,
    });
  const baleBusFollowerAssembly: BusFollower.BaleBusFollowerRuntimeAssembly<Pi.ExtensionContext> =
    BusFollower.createBaleBusFollowerRuntimeAssembly<Pi.ExtensionContext>({
      instanceId: baleInstanceId,
      failureLog: runtimeDiagnostics.createFailureLog({
        category: "bus",
        failurePhase: "follower-heartbeat",
        outcomePhase: "follower-heartbeat-recovered",
        label: "follower heartbeat",
      }),
      registrationState: baleBusFollowerRegistrationState,
      recordRuntimeEvent,
      receiver: {
        socketPath: getBaleBusFollowerSocketPath,
        getContext: baleSessionContextStore.get,
        getAuthSecret: baleBusFollowerControlState.getActiveAuthSecret,
        getRecipientBindingKey: getBaleManualFollowerProfileKey,
        getLiveRebindJournalBindingKey:
          followerAdmissionLifecycleRuntime.getJournalBindingKey,
        getSessionId() {
          return baleBusFollowerAssembly.getReadySessionId();
        },
        getLeaderProtocol:
          baleBusFollowerRegistrationState.getLeaderProtocol,
        getLocalProtocol() {
          return baleBusProtocolIdentity;
        },
        isLiveRebindSaveEnabled() {
          return Bus.hasBaleBusCapability(
            baleBusProtocolIdentity,
            Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_SAVE,
          );
        },
        isLiveRebindApplyEnabled() {
          return Bus.hasBaleBusCapability(
            baleBusProtocolIdentity,
            Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY,
          );
        },
        isLiveRebindSettleEnabled() {
          return Bus.hasBaleBusCapability(
            baleBusProtocolIdentity,
            Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
          );
        },
        isLiveRebindCommandSetEnabled() {
          return (
            Bus.hasBaleBusCapability(
              baleBusProtocolIdentity,
              Bus.BALE_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET,
            ) &&
            Bus.hasBaleBusCapability(
              baleBusProtocolIdentity,
              Bus.BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
            )
          );
        },
        handleLiveRebindSave: followerLiveRebindRuntime.save,
        handleLiveRebindApply: followerLiveRebindRuntime.apply,
        handleLiveRebindSettle: followerLiveRebindRuntime.settle,
        durableAdmission: followerDurableAdmissionRuntime,
        handleQueueHandoff: acceptStagedQueueHandoff,
        handleWorkspaceRestore: followerWorkspaceRestore,
        isWorkspaceRestoreEnabled() {
          return (
            Bus.hasBaleBusCapability(
              baleBusProtocolIdentity,
              Bus.BALE_BUS_CAPABILITY_WORKSPACE_RESTORE,
            ) &&
            Bus.hasBaleBusCapability(
              baleBusFollowerRegistrationState.getLeaderProtocol(),
              Bus.BALE_BUS_CAPABILITY_WORKSPACE_RESTORE,
            )
          );
        },
      },
      recovery: {
        getLeaderState: lockRuntime.getState,
        proveLeaderUnresponsive: proveBaleLeaderUnresponsive,
        async isThreadModeDisabled() {
          await threadStore.refresh?.();
          return threadStore.getBotState().threadMode === "disabled";
        },
        setLifecyclePhase: baleBusFollowerControlState.setLifecyclePhase,
        updateStatus,
        promoteToLeader: promoteBaleBusFollowerToLeader,
        getActiveContext: baleSessionContextStore.get,
      },
      registration: {
        protocolIdentity: baleBusProtocolIdentity,
        getFollowerBusSocketPath: getBaleBusFollowerSocketPath,
        getLeaderSocketPath: getBaleBusSocketPath,
        isContextActive: baleSessionContextStore.isCurrent,
        createRequestId: baleBusFollowerClients.createRequestId,
        setActiveAuthSecret:
          baleBusFollowerControlState.setActiveAuthSecret,
        getProfileKey: getBaleManualFollowerProfileKey,
        getThreadName() {
          return baleThreadCapabilityState.getRequestedThreadName();
        },
        getProcessBirthId() {
          return baleQueueProcessBirthId;
        },
        getSessionId: Pi.getExtensionContextSessionId,
        getSessionGeneration: baleSessionContextStore.getGeneration,
        async onRegistered(ctx) {
          await followerAdmissionLifecycleRuntime.onTransportChanged(ctx);
          queueHandoffReconciliationBinding.request(ctx);
        },
        onDisplayTitleChanged: updateStatus,
      },
    });
  const baleBusFollowerRegistration =
    baleBusFollowerAssembly.registration;
  const { admission: pollingAdmissionRuntime } =
    Polling.createBaleDurablePollingRuntimeAssembly<
      BaleApi.BaleUpdate,
      Pi.ExtensionContext
    >({
      state: pollingControllerState,
      canStart(ctx) {
        return (
          baleSessionContextStore.isCurrent(ctx) && lockRuntime.owns(ctx)
        );
      },
      onPersistentConflict(ctx, count): Promise<void> {
        return lockedPollingRuntime.onPersistentConflict(ctx, count);
      },
      getConfig: configStore.get,
      hasBotToken: configStore.hasBotToken,
      deleteWebhook,
      getUpdates,
      persistConfig: persistBaleConfigWithSync,
      prepareUpdateBatch: textGroupRuntime.prepareUpdateBatch,
      journal: {
        appendBatch(updates, acceptedThroughUpdateId) {
          return updateAdmissionLifecycleRuntime.appendBatch(
            updates as Journal.BaleJournaledUpdate[],
            acceptedThroughUpdateId,
          );
        },
        getAcceptedThroughUpdateId() {
          return Journal.withBaleResolvedUpdateJournalReference({
            registry: baleJournalReferenceRegistry,
            resolveBinding: resolveBaleUpdateJournalBinding,
            referenceClass: "polling-cursor",
            operation(binding) {
              return binding.journal.read().acceptedThroughUpdateId;
            },
          });
        },
        async prepareCursorCutover() {
          const cutover = Journal.withBaleResolvedUpdateJournalReference({
            registry: baleJournalReferenceRegistry,
            resolveBinding: resolveBaleUpdateJournalBinding,
            referenceClass: "polling-cursor",
            operation(binding) {
              return Polling.cutOverBalePollingCursor({
                getLegacyCursor: configStore.getLegacyPollingCursor,
                readJournal: binding.journal.read,
                publishJournalCursor(acceptedThroughUpdateId) {
                  binding.journal.appendBatch([], acceptedThroughUpdateId);
                },
                async removeLegacyCursor() {
                  configStore.removeLegacyPollingCursor();
                  await persistBaleConfigWithSync();
                },
              });
            },
          });
          if (!cutover)
            throw new Error("Bale update journal binding is unavailable.");
          await cutover;
        },
        getEntryCount: updateAdmissionLifecycleRuntime.getJournalEntryCount,
        signalWorker: updateAdmissionLifecycleRuntime.signal,
        getBootstrapEntryCount() {
          return (
            Journal.withBaleResolvedUpdateJournalReference({
              registry: baleJournalReferenceRegistry,
              resolveBinding: resolveBaleUpdateJournalBinding,
              referenceClass: "polling-bootstrap",
              operation(binding) {
                return binding.journal.read().entries.length;
              },
            }) ?? 0
          );
        },
        onSessionStart: updateAdmissionLifecycleRuntime.onSessionStart,
      },
      stopTypingLoop: typing.stop,
      updateStatus,
      onPollingStateChange: runtimeDiagnostics.scheduleSnapshotPersist,
      recordRuntimeEvent,
    });
  const authorizeFollowerApiCall = Bus.createBaleFollowerApiCallAuthorizer({
    isMessageOwned: messageOwnershipRuntime.isOwnedByFollower,
  });
  const selectedMenuDelivery =
    BusLeader.createBaleBusSelectedMenuDeliveryHandler({
      followerRegistry: baleBusFollowerRegistry,
      protocolIdentity: baleBusProtocolIdentity,
      workspace: {
        getScopeKey() {
          return workspaceAdmissionRuntime.resolve()?.getProfileKey();
        },
        captureAuthority() {
          const isCurrent = captureBaleStateAuthority(),
            epoch = lockRuntime.getOwnedLeaderEpoch(),
            operatorUserId = configStore.getAllowedUserId();
          return isCurrent &&
            epoch !== undefined &&
            operatorUserId !== undefined
            ? {
                executor: {
                  instanceId: baleInstanceId,
                  leaderEpoch: String(epoch),
                },
                operatorUserId,
                isCurrent,
              }
            : undefined;
        },
        getStore: resolveWorkspaceRestoreStore,
        threadStore,
        getJournalBindingKey: liveFollowerPorts.getJournalBindingKey,
        run: baleWorkspaceOperationRuntime.run,
      },
      api: {
        runtime: directBaleApiRuntime,
        authorize: authorizeFollowerApiCall,
        record(record, assertCurrent) {
          assertCurrent();
          messageOwnershipRuntime.recordFollower(record);
          assertCurrent();
          return messageOwnershipRuntime.isOwnedByFollower(record);
        },
      },
    });
  const baleSessionFolderSweeper =
    Recovery.createBaleSessionFolderSweeper({
      getSessionsDir: Paths.resolveBaleSessionsDir,
      getProfileName: configStore.getActiveProfileName,
      getKeptSessionIds() {
        return [
          ...threadStore
            .listWorkspaceBindings()
            .map(function bindingSession(binding) {
              return binding.sessionId;
            }),
          ...baleBusFollowerRegistry
            .list()
            .map(function followerSession(follower) {
              return follower.sessionId;
            }),
          Pi.getExtensionContextSessionId(baleSessionContextStore.get()),
        ];
      },
    });
  const baleBusLeaderRuntime =
    BusLeader.createBaleBusLeaderRuntimeAssembly<Pi.ExtensionContext>({
      runtime: {
        socketPath: getBaleBusSocketPath,
        commitEndpointPublication(commit) {
          return lockRuntime.commitIfOwned(commit);
        },
        followerRegistry: baleBusFollowerRegistry,
        authSecret: baleBusAuthSecret,
        protocolIdentity: baleBusProtocolIdentity,
        requiresPreDispatchRebindReader() { return threadStore.hasPreDispatchRebindEvidence(); },
        selectedMenuDelivery,
        startPolling: pollingAdmissionRuntime.start,
        stopPolling: pollingAdmissionRuntime.stop,
        authorizeFollowerApiCall,
        resolveAgentTarget(follower, selector) {
          return agentMessageRuntime.resolveTarget(selector, follower.target);
        },
        routeAgentMessage(follower, message) {
          return agentMessageRuntime.route({
            sourceTarget: follower.target,
            sourceThreadName: follower.threadName,
            message,
          });
        },
        isFollowerProcessAlive: ProcessIdentity.isProcessAlive,
        afterFollowerPrune() {
          baleSessionFolderSweeper.sweep();
        },
        shouldCleanupConfirmedDeadFollower:
          configControls.resolveAutomaticThreadCleanupEnabled,
        recordFollowerMessageOwnership(record) {
          messageOwnershipRuntime.recordFollower(record);
        },
        onWorkspaceRestoreRecipientObserved(follower, isCurrent) {
          return inboundRouteRuntime.onWorkspaceRestoreRecipientObserved(
            follower,
            isCurrent,
            baleSessionContextStore.get(),
          );
        },
      },
      getAllowedUserId: configStore.getAllowedUserId,
      instanceId: baleInstanceId,
      getCwd: Pi.getExtensionContextCwd,
      getSessionId: Pi.getExtensionContextSessionId,
      getBaleProfile: configStore.getActiveProfileName,
      getThreadDisplayMode() {
        return Config.resolveBaleThreadDisplayMode(configStore.get());
      },
      persistThreadDisplayMode(mode, isCurrent) {
        return Config.setBaleThreadDisplayMode(
          configStore,
          mode,
          isCurrent,
        );
      },
      onThreadDisplayChanged() {
        const ctx = baleSessionContextStore.get();
        if (ctx) updateStatus(ctx);
      },
      shouldForceFreshUnnamed:
        baleThreadCapabilityState.shouldForceFreshLeaderThread,
      getRequestedThreadName:
        baleThreadCapabilityState.getRequestedThreadName,
      topicTargetStore: threadStore,
      getWorkspaceAdmission: workspaceAdmissionRuntime.resolve,
      runWorkspaceOperation: baleWorkspaceOperationRuntime.run,
      captureWorkspaceExternalProtection,
      workspaceRotation: {
        getAdmission: workspaceAdmissionRuntime.resolve,
        runExclusive: baleWorkspaceOperationRuntime.runExclusive,
        deleteThread: directBaleApiRuntime.deleteWorkspaceThread,
        pruneJournalEvidence: pruneWorkspaceJournalEvidence,
        reclaimDeadOwnerQueuedWork(binding, isCurrent) {
          return baleWorkspaceOperationRuntime.run(
            {
              operationId:
                WorkspaceAdmission.createBaleWorkspaceAdmissionOperationId(),
              operationKind: "workspace.reclaim-dead-owner-queue",
              scopes: [{ kind: "target", target: binding.target }],
            },
            reclaimBaleWorkspaceDeadOwnerQueue.bind(
              undefined,
              binding,
              isCurrent,
            ),
          );
        },
      },
      callApi(method, body, options) {
        return directBaleApiRuntime.call(method, body, options);
      },
      callMultipart: directBaleApiRuntime.callMultipart,
      downloadFile: directBaleApiRuntime.downloadFile,
      recoverStaleTargetError: recoverStaleBaleTopicApiError,
      getCurrentLeaderEpoch,
      getThreadReconciliationMachineState: threadReconciliationRuntime.getState,
      recordThreadReconciliationPlan,
      getSyncState: baleSyncStateRuntime.getState,
      setSyncState: baleSyncStateRuntime.setState,
      setLeaderTarget: baleBusLeaderState.set,
      onProvisioningStart: baleProvisioningActivity.start,
      onProvisioningEnd: baleProvisioningActivity.end,
      recordRuntimeEvent,
    });
  queueHandoffReconciliationBinding.set(
    Updates.createBaleQueueHandoffReconciliationRuntimeAssembly({
      hasPendingDispatch: lifecycle.hasDispatchPending,
      canHandoffSteerWithRecipient(recipient) {
        const live = baleBusFollowerRegistry.get(recipient.instanceId);
        return live?.registrationGeneration === recipient.registrationGeneration &&
          [baleBusProtocolIdentity, live?.protocol,
            ...(baleBusFollowerRegistrationState.isRegistered() ? [baleBusFollowerRegistrationState.getLeaderProtocol()] : [])]
            .every(Bus.hasBaleBusSteerQueueHandoffCapability);
      },
      ownsDirect: lockRuntime.owns,
      isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
      isBusEnabled: isBaleBusRuntimeEnabled,
      canHandoffWithLeader() {
        return Bus.hasBaleBusCapability(
          baleBusFollowerRegistrationState.getLeaderProtocol(),
          Bus.BALE_BUS_CAPABILITY_QUEUE_HANDOFF,
        );
      },
      listFollowers: baleBusFollowerRegistry.list,
      createRecipientJournalResolver:
        baleJournalBindingRuntime.createRecipientResolver,
      queueStore: baleQueueStore,
      admission: updateAdmissionRuntimeBinding,
      createHandoffToken: Journal.createBaleUpdateQueueHandoffToken,
      createRequestId: baleBusFollowerClients.createRequestId,
      donorInstanceId: baleInstanceId,
      authSecret: baleBusAuthSecret,
      stageThroughFollower: baleBusFollowerClients.queueHandoff,
      routeThroughLeader: baleBusLeaderRuntime.routeQueueHandoff,
      recordRuntimeEvent,
    }),
  );
  const baleLeaderHealthRuntime = Sync.createBaleLeaderHealthRuntime({
    callGetMe() {
      return directBaleApiRuntime.call("getMe", {});
    },
    getSyncState: baleSyncStateRuntime.getState,
    setSyncState: baleSyncStateRuntime.setState,
    recordEvent: recordRuntimeEvent,
  });
  const baleThreadCapabilityRuntime =
    Polling.createBaleThreadCapabilityOrchestration<
      Pi.ExtensionContext,
      Locks.BaleLockEntry
    >({
      state: baleThreadCapabilityState,
      failureLog: runtimeDiagnostics.createFailureLog({
        category: "bus",
        failurePhase: "capability-monitor",
        outcomePhase: "capability-monitor-recovered",
        label: "Threaded Mode capability probe",
      }),
      getAllowedUserId: configStore.getAllowedUserId,
      callApi: callBaleApi,
      topicTargetStore: threadStore,
      isBusRuntimeEnabled: isBaleBusRuntimeEnabled,
      ownsLock: lockRuntime.owns,
      isFollowerRegistered: baleBusFollowerRegistrationState.isRegistered,
      startClassicPolling: pollingAdmissionRuntime.start,
      stopClassicPolling: pollingAdmissionRuntime.stop,
      startBusLeaderPolling: baleBusLeaderRuntime.startPolling,
      stopBusLeaderPolling: baleBusLeaderRuntime.stopPolling,
      startLeaderHealth: baleLeaderHealthRuntime.start,
      stopLeaderHealth: baleLeaderHealthRuntime.stop,
      registerFollowerWithLeader:
        baleBusFollowerRegistration.registerWithLeader,
      restoreFollowerWithLeader(ctx, owner) {
        return baleBusFollowerRegistration.registerWithLeader(ctx, owner, {
          restoreWorkspace: true,
        });
      },
      hasRememberedWorkspaceBinding(ctx) {
        return threadStore.hasWorkspaceBinding(
          Pi.getExtensionContextCwd(ctx),
          Pi.getExtensionContextSessionId(ctx),
        );
      },
      suspendLiveThreadTarget: baleBusLeaderState.clear,
      stopFollowerRegistration: baleBusFollowerRegistration.stop,
      isTopicModeUnavailableError: Threads.isBaleTopicModeUnavailableError,
      updateStatus,
      recordEvent: recordRuntimeEvent,
    });
  const baleThreadCapabilityMonitor =
    baleThreadCapabilityRuntime.monitor;
  observedThreadTargetBinding.set(
    baleThreadCapabilityRuntime.observeTarget,
  );
  const threadAwarePollingPorts = baleThreadCapabilityRuntime.pollingPorts;
  const lockedPollingRuntime = Locks.createBaleLockedPollingRuntime({
    lock: lockRuntime,
    proveOwnerUnresponsive: proveBaleLeaderUnresponsive,
    resetDamagedState() {
      return Locks.resetDamagedBaleRuntimeState(
        Paths.resolveBaleStatePath(),
        function (profile, sections) {
          Threads.parseBaleWorkspaceStateSection(
            sections.workspace,
            profile,
          );
          WorkspaceAdmission.assertBaleConsolidatedAdmissionSection(
            sections.admission,
            profile,
          );
        },
      );
    },
    transportMonitor: baleThreadCapabilityMonitor,
    hasBotToken: configStore.hasBotToken,
    getBotTokenDiagnostic: configStore.getBotTokenDiagnostic,
    canStartPolling: Pi.canStartPollingInExtensionContext,
    isContextCurrent: baleSessionContextStore.isCurrent,
    formatStartBlockedMessage: Pi.formatPollingStartBlockedByRunMode,
    startPolling: threadAwarePollingPorts.startPolling,
    stopPolling: threadAwarePollingPorts.stopPolling,
    registerFollowerWithOwner:
      threadAwarePollingPorts.registerFollowerWithOwner,
    restoreFollowerWithOwner: threadAwarePollingPorts.restoreFollowerWithOwner,
    stopFollowerRegistration: threadAwarePollingPorts.stopFollowerRegistration,
    onTransportAvailabilityChanged() {
      modelContextAvailabilityRuntime.reconcile();
      const ctx = baleSessionContextStore.get();
      if (ctx) queueHandoffReconciliationBinding.request(ctx);
    },
    updateStatus,
    recordRuntimeEvent,
  });
  const {
    disconnect: disconnectBaleAndDeleteCurrentThread,
    cleanupForSessionRestart: cleanupBaleThreadForSessionRestart,
  } = Sync.createBaleThreadDisconnectAssembly({
    instanceId: baleInstanceId,
    getCurrentThreadRecord: findCurrentThreadRecord,
    topicTargetStore: threadStore,
    callApi: callBaleApi,
    getCurrentLeaderEpoch,
    getLeaderTarget: baleBusLeaderState.getTarget,
    clearLeaderTarget: baleBusLeaderState.clear,
    disconnectFollowerThread:
      baleBusFollowerRegistration.disconnectFromLeader,
    getSyncState: baleSyncStateRuntime.getState,
    setSyncState: baleSyncStateRuntime.setState,
    stopPolling: lockedPollingRuntime.stop,
    captureStopPolling: lockedPollingRuntime.captureStop,
    suspendPolling: lockedPollingRuntime.suspend,
    recordRuntimeEvent,
    runWorkspaceOperation: baleWorkspaceOperationRuntime.run,
  });
  const prepareThreadPreservationOnQuit =
    Sync.createBalePreservedLeaderQuitHandler({
      instanceId: baleInstanceId,
      topicTargetStore: threadStore,
      getCurrentLeaderEpoch,
      getProfileName: configStore.getActiveProfileName,
      isPollingSuspended: lockedPollingRuntime.isSuspended,
      resolveAutomaticThreadCleanupEnabled:
        configControls.resolveAutomaticThreadCleanupEnabled,
      runWorkspaceOperation: baleWorkspaceOperationRuntime.run,
    });
  const connectionIntent = Lifecycle.createBaleConnectionIntentRuntime();
  const connectionLifecycle = Lifecycle.createBaleConnectionLifecycle({
    intent: connectionIntent,
    getGeneration: baleSessionContextStore.getGeneration,
    isCurrent: baleSessionContextStore.isCurrent,
    getProfileName: configStore.getActiveProfileName,
    isConnected() {
      return (
        lockRuntime.owns() ||
        baleBusFollowerRegistrationState.isRegistered()
      );
    },
    async activateProfile(profileName, isCurrent) {
      await configStore.load();
      if (!isCurrent()) return false;
      return (
        configStore.activateProfile(profileName) && configStore.hasBotToken()
      );
    },
    start(ctx) {
      return lockedPollingRuntime.start(ctx);
    },
    recordError(error) {
      recordRuntimeEvent("connection", error, { phase: "resume-connect" });
    },
  });
  const baleBridgeSessionLifecycleDeps =
    Lifecycle.createBaleBridgeSessionLifecycleDeps({
      contextStore: baleSessionContextStore,
      queue: {
        getCurrentModel: getContextModel,
        loadConfig: configStore.load,
        setQueuedItems: baleQueueStore.setQueuedItems,
        setCurrentModel: currentModelRuntime.set,
        setPendingModelSwitch: modelSwitchController.clearPendingSwitch,
        syncCounters: queue.syncCounters,
        syncFlags: lifecycle.syncFlags,
        bindDeferredDispatchContext: deferredQueueDispatchRuntime.bind,
        prepareTempDir() {
          Recovery.removeBaleLegacyRecoveryStorage(
            Paths.resolveBaleTempDir(),
          );
          return prepareTempDir();
        },
        updateStatus,
        unbindDeferredDispatchContext: deferredQueueDispatchRuntime.unbind,
        discardQueuedItems: queueMutationRuntime.clear,
        clearModelMenuState: modelMenuRuntime.clear,
        getActiveTurnChatId: activeTurnRuntime.getChatId,
        getActiveTurnTarget: activeTurnRuntime.getTarget,
        clearPreview: previewRuntime.clear,
        clearActiveTurn: activeTurnRuntime.clear,
        clearAbort: abort.clearHandler,
        recordRuntimeEvent,
      },
      follower: {
        registrationState: baleBusFollowerRegistrationState,
        registrationRuntime: baleBusFollowerRegistration,
        instanceId: baleInstanceId,
        suspendPolling: lockedPollingRuntime.suspend,
        isLeader: lockRuntime.owns,
        getLeaderBinding: currentInstanceThreadRuntime.getRestorationIdentity,
        getActiveContext: baleSessionContextStore.get,
        getActiveProfileName: configStore.getActiveProfileName,
        getLeaderState: lockRuntime.getState,
        updateStatus,
        recordRuntimeEvent,
      },
      services: {
        mediaGroup: {
          resume: mediaGroupRuntime.resume,
          suspend: mediaGroupRuntime.suspend,
        },
        textGroup: {
          resume: textGroupRuntime.resume,
          suspend: textGroupRuntime.suspend,
        },
        delivery: deliveryLifecycleRuntime,
        polling: lockedPollingRuntime,
        connection: connectionLifecycle,
        inboundWorker: {
          onSessionShutdown: updateAdmissionRuntimeBinding.onSessionShutdown,
        },
        capabilityMonitor: baleThreadCapabilityMonitor,
        queueWatchdog: queueDispatchWatchdogRuntime,
        guestPlaceholder: { stopAll: guestPlaceholderRuntime.stopAll },
        prepareThreadPreservationOnQuit,
      },
    });
  const sessionLifecycleRuntime =
    Lifecycle.createBaleBridgeSessionLifecycleAssembly(
      baleBridgeSessionLifecycleDeps,
    );

  // --- Extension API Bindings ---

  const threadNameRecipientAuthority = {
    getAuthority(): Threads.BaleWorkspaceThreadRenameAuthority {
      const ctx = baleSessionContextStore.get();
      return {
        context: ctx,
        sessionId: Pi.getExtensionContextSessionId(ctx),
        sessionGeneration: baleSessionContextStore.getGeneration(),
        cwd: ctx && Pi.getExtensionContextCwd(ctx),
        profileName: configStore.getActiveProfileName(),
        botToken: configStore.getBotToken(),
        operatorUserId: configStore.getAllowedUserId(),
        leaderEpoch: getCurrentLeaderEpoch(),
        ownsDirectDelivery: ownsBaleDirectDelivery(),
        followerRegistered: baleBusFollowerRegistrationState.isRegistered(),
        localTarget: baleBusLeaderState.getTarget(),
        localSlot: baleBusLeaderState.getIdentity()?.slot,
      };
    },
  };
  baleThreadDisplayNameRenameBinding.bind(
    {
      async rename(
        expectedTarget: Parameters<Commands.BaleThreadDisplayNameRenamePort>[0],
        threadName: string,
        options?: Parameters<Commands.BaleThreadDisplayNameRenamePort>[2],
      ) {
        try {
          const assertCaller = options?.assertAuthority;
          assertCaller?.();
          if (baleBusFollowerRegistrationState.isRegistered()) {
            if (assertCaller)
              return {
                ok: false,
                message:
                  "Guarded follower Workspace Thread rename is unavailable.",
              };
            if (typeof expectedTarget.threadId !== "number") {
              return {
                ok: false,
                message: "Bale Workspace Thread target is unavailable.",
              };
            }
            const renamedThreadName =
              await baleBusFollowerRegistration.renameThread?.(
                {
                  chatId: expectedTarget.chatId,
                  threadId: expectedTarget.threadId,
                },
                threadName,
              );
            if (!renamedThreadName) {
              return {
                ok: false,
                message:
                  "Bale follower Workspace Thread rename is unavailable.",
              };
            }
            return {
              ok: true,
              threadName: renamedThreadName,
            };
          }
          if (!ownsBaleDirectDelivery()) {
            return {
              ok: false,
              message:
                "Bale Workspace Thread rename requires an active leader or follower connection.",
            };
          }
          if (typeof expectedTarget.threadId !== "number") {
            return {
              ok: false,
              message: "Bale Workspace Thread target is unavailable.",
            };
          }
          const target = {
            chatId: expectedTarget.chatId,
            threadId: expectedTarget.threadId,
          };
          const recipient = assertCaller
            ? Threads.createBaleWorkspaceThreadRenameRecipient({
                store: threadStore,
                instanceId: baleInstanceId,
                target,
                assertAuthority: assertCaller,
                getAuthority: threadNameRecipientAuthority.getAuthority,
              })
            : undefined;
          const renamed =
            await baleBusLeaderRuntime.renameLeaderThreadAdmitted(
              threadName,
              target,
              recipient?.assertAuthority,
            );
          recipient?.assertResult(renamed);
          baleBusLeaderState.set({
            target: renamed.target,
            slot: renamed.slot,
            threadName: renamed.manualThreadName ?? renamed.threadName,
          });
          recipient?.assertResult(renamed);
          return {
            ok: true,
            threadName: renamed.manualThreadName,
          };
        } catch (error) {
          return {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Bale Workspace Thread rename failed.",
          };
        }
      },
    }.rename,
  );
  baleThreadDisplayNameResetBinding.bind(
    {
      async reset(
        expectedTarget: Parameters<Commands.BaleThreadDisplayNameResetPort>[0],
        options?: Parameters<Commands.BaleThreadDisplayNameResetPort>[1],
      ) {
        try {
          const assertCaller = options?.assertAuthority;
          assertCaller?.();
          const wasFollower =
            baleBusFollowerRegistrationState.isRegistered();
          if (wasFollower && assertCaller)
            return {
              ok: false,
              message:
                "Guarded follower Workspace Thread reset is unavailable.",
            };
          if (typeof expectedTarget.threadId !== "number") {
            return {
              ok: false,
              message: "Bale Workspace Thread target is unavailable.",
            };
          }
          const target = {
            chatId: expectedTarget.chatId,
            threadId: expectedTarget.threadId,
          };
          const recipient = assertCaller
            ? Threads.createBaleWorkspaceThreadResetRecipient({
                store: threadStore,
                instanceId: baleInstanceId,
                target,
                assertAuthority: assertCaller,
                getAuthority: threadNameRecipientAuthority.getAuthority,
              })
            : undefined;
          const result = wasFollower
            ? await baleBusFollowerRegistration.resetThreadName?.(target)
            : (
                await (recipient
                  ? baleBusLeaderRuntime.resetLeaderThreadName(
                      target,
                      recipient.assertAuthority,
                    )
                  : baleBusLeaderRuntime.resetLeaderThreadName(target))
              ).threadName;
          if (!result) {
            return {
              ok: false,
              message: "Thread display name reset is unavailable.",
            };
          }
          recipient?.assertResult(result);
          const leaderTarget = baleBusLeaderState.getTarget();
          if (!wasFollower && leaderTarget) {
            baleBusLeaderState.set({
              target: leaderTarget,
              threadName: result,
              ...(recipient
                ? { slot: baleBusLeaderState.getIdentity()?.slot }
                : {}),
            });
          }
          recipient?.assertResult(result);
          return {
            ok: true,
            threadName: result,
          };
        } catch (error) {
          return {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Thread display name reset failed.",
          };
        }
      },
    }.reset,
  );
  Bindings.registerBaleCommandsAndTools({
    pi,
    handleInternalAction: sessionActionsRuntime.handleInternalAction,
    agentDir: Paths.resolveAgentDir(),
    configStore,
    persistConfig: persistBaleConfigWithSync,
    setup,
    activeTurnRuntime,
    lockedPollingRuntime,
    stopPolling: disconnectBaleAndDeleteCurrentThread,
    // Consolidated envelope failures remain protective; legacy whole-file recovery cannot reset sibling authority.
    getDisconnectThreadName() {
      const record = findCurrentThreadRecord();
      if (!record?.target.threadId) return undefined;
      return record.threadName ?? "current Bale thread";
    },
    onTransportChanged() {
      deliveryLifecycleRuntime.onSessionStart();
      activityVerbosityRuntime.reset();
      modelContextAvailabilityRuntime.reconcile();
    },
    getStatusLines,
    isContextCurrent: baleSessionContextStore.isCurrent,
    getSessionGeneration: baleSessionContextStore.getGeneration,
    connectionIntent,
    buttonActionStore,
    sendMarkdownReply,
    async sendChannelMarkdownMessage(channel, markdown, options) {
      if (!lockRuntime.owns()) {
        throw new Error(
          "Bale channel delivery requires direct leader transport ownership.",
        );
      }
      const profileName = configStore.getActiveProfileName() ?? "default";
      const botToken = configStore.getBotToken();
      if (!botToken)
        throw new Error(
          "Bale channel delivery requires an active bot token.",
        );
      const store = ChannelPosts.openBaleChannelPostJournalStore({
        profileName,
        botToken,
      });
      const record = await ChannelPosts.publishBaleChannelPost({
        store,
        operationId: options.operationId,
        channel: channel as ChannelPosts.BaleChannelPostAddress,
        markdown,
        async observeChannel(channelAddress) {
          return baleApiRuntime.call("getChat", {
            chat_id: channelAddress,
          });
        },
        async send(channelAddress, body) {
          const sent = await baleApiRuntime.call<
            BaleApi.BaleSentMessage & {
              chat: { id: number; type: string };
            }
          >("sendRichMessage", {
            chat_id: channelAddress,
            rich_message: { markdown: body },
            ...(options.replyMarkup
              ? { reply_markup: options.replyMarkup }
              : {}),
          });
          return { messageId: sent.message_id, chat: sent.chat };
        },
      });
      return record.state === "published" ? record.messageId : undefined;
    },
    async sendChannelMediaMessage(channel, mediaPath, markdown, options) {
      if (!lockRuntime.owns()) {
        throw new Error(
          "Bale channel media delivery requires direct leader transport ownership.",
        );
      }
      const profileName = configStore.getActiveProfileName() ?? "default";
      const botToken = configStore.getBotToken();
      if (!botToken)
        throw new Error(
          "Bale channel media delivery requires an active bot token.",
        );
      const media =
        await ChannelPosts.inspectBaleChannelPostMedia(mediaPath);
      const caption = Replies.renderBaleMarkdownToHtmlDraft(markdown);
      ChannelPosts.assertBaleChannelPostCaptionWithinLimit(caption);
      const store = ChannelPosts.openBaleChannelPostJournalStore({
        profileName,
        botToken,
      });
      const record = await ChannelPosts.publishBaleChannelPost({
        store,
        operationId: options.operationId,
        channel: channel as ChannelPosts.BaleChannelPostAddress,
        markdown,
        media,
        async observeChannel(channelAddress) {
          return baleApiRuntime.call("getChat", {
            chat_id: channelAddress,
          });
        },
        async send(channelAddress) {
          const sent = await baleApiRuntime.callMultipart<
            BaleApi.BaleSentMessage & {
              chat: { id: number; type: string };
            }
          >(
            media.kind === "photo" ? "sendPhoto" : "sendVideo",
            {
              chat_id: String(channelAddress),
              caption,
              parse_mode: "HTML",
              ...(options.replyMarkup
                ? { reply_markup: JSON.stringify(options.replyMarkup) }
                : {}),
            },
            media.kind === "photo" ? "photo" : "video",
            mediaPath,
            media.fileName,
          );
          return { messageId: sent.message_id, chat: sent.chat };
        },
      });
      return record.state === "published" ? record.messageId : undefined;
    },
    listChannelPosts(input) {
      const profileName = configStore.getActiveProfileName() ?? "default";
      const botToken = configStore.getBotToken();
      if (!botToken)
        throw new Error("Bale channel posts require an active bot token.");
      return ChannelPosts.openBaleChannelPostJournalStore({
        profileName,
        botToken,
      }).list(input);
    },
    async mutateChannelPost(input) {
      if (!lockRuntime.owns())
        throw new Error(
          "Bale channel post mutation requires direct leader ownership.",
        );
      const profileName = configStore.getActiveProfileName() ?? "default";
      const botToken = configStore.getBotToken();
      if (!botToken)
        throw new Error(
          "Bale channel post mutation requires an active bot token.",
        );
      const store = ChannelPosts.openBaleChannelPostJournalStore({
        profileName,
        botToken,
      });
      if (input.action === "edit") {
        if (!input.markdown)
          throw new Error("Bale channel post edit requires markdown.");
        const current = store.get(input.operationId);
        const caption = current?.media
          ? Replies.renderBaleMarkdownToHtmlDraft(input.markdown)
          : undefined;
        if (caption !== undefined) {
          ChannelPosts.assertBaleChannelPostCaptionWithinLimit(caption);
        }
        const begun = store.beginEdit({
          operationId: input.operationId,
          mutationId: input.mutationId,
          markdown: input.markdown,
        });
        if (!begun.began) {
          if (
            begun.record.state === "published" &&
            begun.record.lastMutationId === input.mutationId
          )
            return begun.record;
          throw new Error(
            "Bale channel post edit outcome is unknown; refusing automatic replay.",
          );
        }
        if (begun.record.state !== "edit-outcome-unknown")
          throw new Error("Bale channel post edit authority is invalid.");
        if (begun.record.media) {
          if (caption === undefined) {
            throw new Error(
              "Bale channel post media caption edit requires retained media identity.",
            );
          }
          await baleApiRuntime.call("editMessageCaption", {
            chat_id: begun.record.channelId,
            message_id: begun.record.messageId,
            caption,
            parse_mode: "HTML",
          });
        } else {
          await baleApiRuntime.call("editMessageText", {
            chat_id: begun.record.channelId,
            message_id: begun.record.messageId,
            text: Replies.renderBaleMarkdownToHtmlDraft(input.markdown),
            parse_mode: "HTML",
          });
        }
        return store.confirmEdited({
          operationId: input.operationId,
          mutationId: input.mutationId,
        }).record;
      }
      if (input.markdown !== undefined)
        throw new Error(
          "Bale channel post deletion does not accept markdown.",
        );
      const begun = store.beginDelete({
        operationId: input.operationId,
        mutationId: input.mutationId,
      });
      if (!begun.began) {
        if (
          begun.record.state === "deleted" &&
          begun.record.mutationId === input.mutationId
        )
          return begun.record;
        throw new Error(
          "Bale channel post deletion outcome is unknown; refusing automatic replay.",
        );
      }
      if (begun.record.state !== "delete-outcome-unknown")
        throw new Error("Bale channel post deletion authority is invalid.");
      await baleApiRuntime.call("deleteMessage", {
        chat_id: begun.record.channelId,
        message_id: begun.record.messageId,
      });
      return store.confirmDeleted({
        operationId: input.operationId,
        mutationId: input.mutationId,
      }).record;
    },
    callMultipart,
    getDefaultChatId: proactivePushChatIdGetter,
    getDefaultTarget: proactivePushTargetGetter,
    ...agentMessageToolRoutingRuntime,
    setGenerativeAppLiveSurfaceRuntime: generativeAppLiveSurfaceBinding.set,
    updateStatus,
    recordRuntimeEvent,
  });

  // --- Lifecycle Hooks ---

  Bindings.registerBaleLifecycleRuntimeHooks({
    pi,
    sessionLifecycleRuntime: {
      ...sessionLifecycleRuntime,
      onModelSelect: currentModelRuntime.onModelSelect,
    },
    activityRuntime,
    activityVerbosityRuntime,
    diagnostics: runtimeDiagnostics,
    assistantOutputRuntime,
    publicationRuntime,
    configStore,
    abort,
    typing,
    lifecycle,
    activeTurnRuntime,
    baleQueueStore,
    modelSwitchController,
    previewRuntime,
    promptDispatchRuntime,
    deferredQueueDispatchRuntime,
    modelContextAvailabilityRuntime,
    disconnectOnQuit: cleanupBaleThreadForSessionRestart,
    shutdownGenerativeAppLiveSurfaces: generativeAppLiveSurfaceBinding.shutdown,
    resolveAutomaticThreadCleanupEnabled:
      configControls.resolveAutomaticThreadCleanupEnabled,
    onSessionStarted(_event, ctx) {
      sessionActionAssembly.settlement.onSessionStart(ctx);
    },
    buttonActionStore,
    callMultipart,
    sendChatAction,
    sendRecordVoiceAction,
    sendMarkdownReply,
    sendTextReply,
    dispatchNextQueuedBaleTurn,
    onSteerTurnEnd,
    onPromptHandedOff(turn, ctx) {
      updateAdmissionRuntimeBinding
        .getSettlement()
        ?.onPromptHandedOff(turn, ctx);
    },
    answerGuestQuery,
    deleteMessage: deleteBaleMessage,
    sendGuestReply,
    editGuestReply,
    editGuestInlineMessage: baleApiRuntime.editGuestInlineMessage,
    stopGuestPlaceholder: guestPlaceholderRuntime.stop,
    finalizeMarkdownPreview,
    preparePreviewDelivery,
    proactivePushTargetGetter,
    getAssistantRenderingMode: configControls.getAssistantRenderingMode,
    recordMessageOwnership: messageOwnershipRuntime.recordLocal,
    canSendAgentActivity(ctx) {
      return (
        lockOwnershipGuard.ownsContext(ctx) ||
        baleBusFollowerRegistrationState.isRegistered()
      );
    },
    isSessionContextActive(ctx) {
      return baleSessionContextStore.isCurrent(ctx);
    },
    getSessionGeneration: baleSessionContextStore.getGeneration,
    isTurnTransportActive(turn) {
      return baleTransportStampRuntime.isActive(turn.transportStamp);
    },
    updateStatus,
    recordRuntimeEvent,
    onSessionSettled: inboundRouteRuntime.onSessionSettled,
  });
}
