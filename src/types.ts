export type PetAsset = {
  id: string;
  name: string;
  relativePath: string;
  url: string;
  size: number;
  createdAt: string;
};

export type AnimationMap = {
  idle: string;
  walk: string;
  fall: string;
  land: string;
  drag: string;
  sleep: string;
};

export type SpineBundle = {
  skelUrl: string;
  atlasUrl: string;
  textureUrl: string;
  folder: string;
  animations: string[];
  animationDurations?: Record<string, number>;
};

export type SpinePartKind = "skeleton" | "atlas" | "texture";

export type SpineStagedPart = PetAsset & {
  kind: SpinePartKind;
};

export type BoneRoleMap = Partial<
  Record<
    | "root"
    | "hip"
    | "spine"
    | "chest"
    | "head"
    | "leftUpperLeg"
    | "leftLowerLeg"
    | "leftFoot"
    | "rightUpperLeg"
    | "rightLowerLeg"
    | "rightFoot"
    | "leftUpperArm"
    | "leftLowerArm"
    | "rightUpperArm"
    | "rightLowerArm",
    string
  >
>;

export type ActionBindings = Record<string, string>;

export type PetRenderConfig = {
  displayWidth: number;
  displayHeight: number;
  visualWidth?: number;
  visualHeight?: number;
  hitboxWidth: number;
  hitboxHeight: number;
  hitboxOffsetX: number;
  hitboxOffsetY: number;
  offsetX: number;
  offsetY: number;
};

export type PetModulePlugins = {
  voiceProfileId?: string;
  aiModuleId?: string;
  custom?: {
    source: "voice" | "ai" | "training";
    itemId: string;
  };
};

export type PetProfile = {
  id: string;
  name: string;
  title: string;
  description: string;
  accent: string;
  secondary: string;
  scale: number;
  greeting: string;
  avatarUrl?: string;
  assets: PetAsset[];
  animationMap: AnimationMap;
  spine?: SpineBundle;
  boneMap?: BoneRoleMap;
  actionBindings?: ActionBindings;
  modulePlugins?: PetModulePlugins;
  renderConfig?: PetRenderConfig;
  createdAt: string;
  updatedAt: string;
};

export type CharacterProfile = {
  name: string;
  role: string;
  personality: string;
  speakingStyle: string;
  worldview: string;
  likes: string;
  dislikes: string;
  boundaries: string;
  initiative: number;
  temperature: number;
  relationship: number;
  mood: string;
  energy: number;
};

export type TrainingDocument = {
  id: string;
  title: string;
  kind: "story" | "note" | "voice-transcript";
  content: string;
  createdAt: string;
};

export type MemoryRecord = {
  id: string;
  title: string;
  content: string;
  importance: number;
  createdAt: string;
};

export type VoiceProfile = {
  id: string;
  name: string;
  samples: PetAsset[];
  voiceId: string;
  engineType?: "api" | "local" | "gpt-sovits";
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  localModelPath?: string;
  referenceText?: string;
  status?: "draft" | "analyzing" | "ready";
  createdAt: string;
};

export type AiModule = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "training" | "ready";
  sourceProfileId?: string;
  skillPrompt?: string;
  training?: {
    baseModel?: string;
    datasetPath?: string;
    configPath?: string;
    logPath?: string;
    outputPath?: string;
    progress?: number;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type TrainingProfile = {
  id: string;
  name: string;
  petId?: string;
  status: "draft" | "training" | "ready";
  character: CharacterProfile;
  documents: TrainingDocument[];
  memories: MemoryRecord[];
  voiceProfileIds: string[];
  aiModuleIds: string[];
  trainingConfig?: {
    baseModel: string;
    epochs: number;
    learningRate: number;
    batchSize: number;
    maxLength: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type AuxiliaryWindowConfig = {
  id: string;
  name: string;
  title: string;
  body: string;
  width: number;
  height: number;
  enabled: boolean;
};

export type ServiceConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  voiceId?: string;
};

export type ThemeName = "default" | "violet" | "azure" | "jade";

export type AppSettings = {
  appearance: {
    theme: ThemeName;
  };
  overlay: {
    visibleOnStart: boolean;
    alwaysOnTop: boolean;
    includeTaskbarArea: boolean;
    gravity: number;
    walkSpeed: number;
    scale: number;
    sleepAfterSeconds: number;
    idleActionEnabled: boolean;
    idleActionIntervalSeconds: number;
    idleActionChance: number;
    friction: number;
    bounce: number;
    wallBounce: number;
    groundBounce: number;
    gravityLocked: boolean;
    passThroughChance: number;
  };
  services: {
    llm: ServiceConfig;
    asr: ServiceConfig;
    tts: ServiceConfig;
  };
};

export type ActivityRecord = {
  id: string;
  type: string;
  text: string;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  source?: string;
  warning?: string;
};

export type WellbeingEvent = {
  id: string;
  type: string;
  text: string;
  createdAt: string;
};

export type WellbeingState = {
  energy: number;
  initiative: number;
  relationship: number;
  mood: string;
  moodScore: number;
  lastSimulatedAt: string;
  lastInteractionAt: string;
  lastPetAt: string;
  todayKey: string;
  today: {
    energyDelta: number;
    initiativeDelta: number;
    relationshipDelta: number;
    interactions: number;
    petCount: number;
  };
  recentEvents: WellbeingEvent[];
};

export type AppState = {
  version: number;
  activePetId: string;
  summonedPetIds: string[];
  activeView: string;
  pets: PetProfile[];
  character: CharacterProfile;
  wellbeing: WellbeingState;
  documents: TrainingDocument[];
  memories: MemoryRecord[];
  conversations: ChatMessage[];
  voiceProfiles: VoiceProfile[];
  aiModules: AiModule[];
  trainingProfiles: TrainingProfile[];
  activeTrainingProfileId: string;
  auxiliaryWindows: AuxiliaryWindowConfig[];
  settings: AppSettings;
  activity: ActivityRecord[];
  stats: {
    wakeCount: number;
    releaseCount: number;
    chatCount: number;
    createdAt: string;
  };
};

export type DisplayMetrics = {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  scaleFactor: number;
};

export type OverlayCommand =
  | { type: "release"; petId?: string; origin?: { x: number; y: number } }
  | { type: "wake"; petId?: string }
  | { type: "sleep"; petId?: string }
  | { type: "rest"; petId?: string }
  | { type: "action"; petId?: string; name?: string }
  | { type: "home" }
  | { type: "walk" }
  | { type: "drop" }
  | { type: "show" };

export type ChatResult = {
  ok: boolean;
  text: string;
  source: string;
  action?: string;
  warning?: string;
};

export type TestResult = {
  ok: boolean;
  error?: string;
  data?: unknown;
};

export type VoiceResult = {
  ok: boolean;
  audioDataUrl?: string;
  error?: string;
};

export type DeskPetApi = {
  getState: () => Promise<AppState>;
  updateState: (patch: Partial<AppState> | Record<string, unknown>) => Promise<AppState>;
  updateStateSync: (
    patch: Partial<AppState> | Record<string, unknown>
  ) => AppState;
  replaceState: (state: AppState) => Promise<AppState>;
  getDisplayMetrics: () => Promise<DisplayMetrics>;
  getControlBounds: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  showControl: () => Promise<boolean>;
  hideControl: () => Promise<boolean>;
  quit: () => Promise<boolean>;
  overlayCommand: (command: OverlayCommand) => Promise<AppState>;
  hideOverlay: () => Promise<boolean>;
  setOverlayMouseIgnore: (ignore: boolean) => void;
  openAuxiliary: (id: string) => Promise<boolean>;
  importPetAssets: (petId: string) => Promise<{
    canceled: boolean;
    assets?: PetAsset[];
    state?: AppState;
  }>;
  importSpine: (petId: string) => Promise<{
    canceled: boolean;
    spine?: SpineBundle;
    state?: AppState;
  }>;
  selectSpinePart: (
    kind: SpinePartKind,
    draftId: string
  ) => Promise<{
    canceled: boolean;
    part?: SpineStagedPart;
  }>;
  createPetFromSpine: (
    draftId: string,
    parts: Record<SpinePartKind, SpineStagedPart>,
    name?: string
  ) => Promise<{
    ok: boolean;
    petId?: string;
    state?: AppState;
    error?: string;
  }>;
  importVoiceSample: () => Promise<{
    canceled: boolean;
    samples?: PetAsset[];
    state?: AppState;
  }>;
  importTrainingAudio: () => Promise<{
    canceled: boolean;
    ok?: boolean;
    text?: string;
    error?: string;
  }>;
  testService: (service: "llm" | "asr" | "tts") => Promise<TestResult>;
  chat: (messages: Array<{ role: "user" | "assistant"; content: string }>) => Promise<ChatResult>;
  speak: (
    text: string,
    voiceId?: string,
    config?: {
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      voiceId?: string;
      voiceProfileId?: string;
      engineType?: "api" | "local" | "gpt-sovits";
      referenceText?: string;
    }
  ) => Promise<VoiceResult>;
  startTraining: (profileId: string) => Promise<{
    ok: boolean;
    moduleId?: string;
    logPath?: string;
    outputPath?: string;
    error?: string;
  }>;
  openTrainingFolder: (moduleId: string) => Promise<boolean>;
  getDataPaths: () => Promise<{
    dataPath: string;
    statePath: string;
    assetsPath: string;
    petStorePath: string;
  }>;
  syncPetStore: () => Promise<{ ok: boolean; count: number }>;
  openPetStore: () => Promise<boolean>;
  openDataFolder: () => Promise<boolean>;
  exportBackup: () => Promise<{ canceled: boolean; folder?: string }>;
  importBackup: () => Promise<{ canceled: boolean; state?: AppState }>;
  onStateChanged: (callback: (state: AppState) => void) => () => void;
  onOverlayCommand: (callback: (command: OverlayCommand) => void) => () => void;
  onOverlayMode: (callback: (mode: OverlayCommand["type"]) => void) => () => void;
  onOverlaySettings: (
    callback: (settings: AppSettings["overlay"]) => void
  ) => () => void;
  onDisplayChanged: (callback: (metrics: DisplayMetrics) => void) => () => void;
};
