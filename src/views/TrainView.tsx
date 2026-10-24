import {
  AudioLines,
  BookOpen,
  Brain,
  Copy,
  FilePlus2,
  MessageCircle,
  Mic,
  Package,
  Plus,
  Radio,
  Save,
  Send,
  Trash2,
  UserRound,
  Volume2
} from "lucide-react";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { makeId } from "../lib/id";
import { makeUniqueName } from "../lib/id";
import { ModelManagerView } from "../components/ModelView";
import { VoiceModuleView } from "../components/VoiceView";
import {
  appendWellbeingEvent,
  recordWellbeingInteraction,
  RELATIONSHIP_MAX
} from "../lib/wellbeing";
import { ensurePetVitals } from "../lib/petVitals";
import { useAppState } from "../state";
import type {
  AppSettings,
  CharacterProfile,
  ChatMessage,
  TrainingDocument,
  TrainingProfile
} from "../types";

type TrainingTab =
  | "profile"
  | "documents"
  | "memories"
  | "chat"
  | "voice"
  | "models"
  | "modules";

const tabs: Array<{ id: TrainingTab; label: string; icon: typeof UserRound }> = [
  { id: "profile", label: "角色档案", icon: Brain },
  { id: "chat", label: "文字对话", icon: MessageCircle },
  { id: "voice", label: "声音模块", icon: AudioLines },
  { id: "models", label: "模型管理", icon: Package }
];

export function TrainingView() {
  const { state, updateState } = useAppState();
  const [activeTab, setActiveTab] = useState<TrainingTab>("profile");
  const [documentTitle, setDocumentTitle] = useState("");
  const [documentText, setDocumentText] = useState("");
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [audioSrc, setAudioSrc] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceTestText, setVoiceTestText] = useState(
    "你好，我正在测试这个声音模块。"
  );
  const [serviceResults, setServiceResults] = useState<Record<string, string>>(
    {}
  );
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [profileNameError, setProfileNameError] = useState("");
  const [selectedVoiceProfileId, setSelectedVoiceProfileId] = useState("");

  if (!state) return null;
  const currentState = state;
  const trainingProfiles = currentState.trainingProfiles || [];
  const activeProfile =
    trainingProfiles.find(
      (profile) => profile.id === currentState.activeTrainingProfileId
    ) ||
    trainingProfiles[0];
  const selectedVoiceProfile =
    currentState.voiceProfiles.find(
      (profile) => profile.id === selectedVoiceProfileId
    ) ||
    currentState.voiceProfiles[0];
  const profileCharacter = activeProfile?.character || currentState.character;
  const profileDocuments = activeProfile?.documents || currentState.documents;
  const profileMemories = activeProfile?.memories || currentState.memories;
  const promptPet =
    currentState.pets.find((pet) => pet.id === currentState.activePetId) ||
    currentState.pets[0];
  const promptVitals = promptPet
    ? ensurePetVitals(promptPet, currentState.character)
    : null;
    const promptEnergy = Math.max(0, Math.min(100, Number(promptVitals?.energy ?? 0)));
    const promptInitiative = Math.max(0, Math.min(100, Number(promptVitals?.initiative ?? 0)));
    const promptRelationship = Math.max(0, Math.min(RELATIONSHIP_MAX, Number(promptVitals?.relationship ?? 0)));
    const promptEnergyRatio = Math.round((promptEnergy / 100) * 100) / 100;
    const promptInitiativeRatio = Math.round((promptInitiative / 100) * 100) / 100;
    const promptRelationshipRatio =
      Math.round((promptRelationship / RELATIONSHIP_MAX) * 100) / 100;
    const promptEnergyBand =
      promptEnergyRatio >= 0.7
        ? "high"
        : promptEnergyRatio >= 0.4
          ? "steady"
          : promptEnergyRatio >= 0.2
            ? "tired"
            : promptEnergyRatio > 0
              ? "very_low"
              : "exhausted";
    const promptInitiativeBand =
      promptInitiativeRatio >= 0.75
        ? "high"
        : promptInitiativeRatio >= 0.5
          ? "medium"
          : promptInitiativeRatio >= 0.3
            ? "low"
            : "passive";
    const promptRelationshipBand =
      promptRelationshipRatio >= 0.8
        ? "deep_trust"
        : promptRelationshipRatio >= 0.5
          ? "trusted"
          : promptRelationshipRatio >= 0.3
            ? "close"
            : promptRelationshipRatio >= 0.15
              ? "familiarizing"
              : "distant";
  const runtimePromptPreview = promptVitals
    ? [
          "<runtime_state>",
          JSON.stringify(
            {
              energy: {
                raw: Math.round(promptEnergy),
                normalized: promptEnergyRatio,
                band: promptEnergyBand
              },
              initiative: {
                raw: Math.round(promptInitiative),
                normalized: promptInitiativeRatio,
                band: promptInitiativeBand
              },
              relationship: {
                raw: Math.round(promptRelationship),
                normalized: promptRelationshipRatio,
                max: RELATIONSHIP_MAX,
                band: promptRelationshipBand
              },
              mood: promptVitals.mood || "平静"
            },
            null,
            2
          ),
          "</runtime_state>",
          "<runtime_policy>",
          JSON.stringify(
            {
              reply_length:
                promptEnergyBand === "high"
                  ? "normal"
                  : promptEnergyBand === "steady"
                    ? "normal_to_short"
                    : promptEnergyBand === "tired"
                      ? "short"
                      : promptEnergyBand === "very_low"
                        ? "very_short"
                        : "minimal",
              proactivity: promptInitiativeBand,
              question_budget:
                promptInitiativeBand === "high"
                  ? 2
                  : promptInitiativeBand === "medium"
                    ? 1
                    : 0,
              warmth: promptRelationshipBand,
              initiative_behavior:
                promptInitiativeBand === "high"
                  ? "may_initiate_topic_or_suggestion"
                  : promptInitiativeBand === "medium"
                    ? "respond_and_occasionally_follow_up"
                    : "respond_without_pushing_topic",
              energy_behavior:
                promptEnergyBand === "exhausted"
                  ? "necessary_reply_only"
                  : promptEnergyBand === "very_low"
                    ? "avoid_enthusiasm_and_long_explanation"
                    : promptEnergyBand === "tired"
                      ? "reduce_detail_and_slow_down"
                      : "normal_expression",
              state_visibility: "hidden"
            },
            null,
            2
          ),
          "</runtime_policy>"
      ].join("\n")
    : "当前没有可用于生成运行时 Prompt 的桌宠。";
    const previewSkill = {
      skill_version: 1,
      identity: {
        name: profileCharacter.name || activeProfile?.name || "桌宠",
        role: profileCharacter.role || "桌面伙伴",
        personality:
          profileCharacter.personality || "自然、敏锐、有自己的判断。",
        worldview:
          profileCharacter.worldview || "生活在用户桌面中的长期伙伴。",
        cares_about:
          profileCharacter.likes || "重要的人和事。",
        aversions_and_weaknesses:
          profileCharacter.dislikes || "被误解、失去重要联系、无法掌握局面。"
      },
      style: {
        speaking_style:
          profileCharacter.speakingStyle || "短句为主，自然，偶尔反问。",
        conversation_mode: "real_time_first_person_chat",
        variability: "自然变化，不要每次使用相同热情、礼貌或句式。"
      },
      social: {
        user_relationship_rule:
          profileCharacter.boundaries || "把用户视为长期相处的伙伴。",
        familiarity_source: "runtime_state.relationship"
      }
    };
  const activeSkillPrompt = [
      "<role_skill>",
      JSON.stringify(previewSkill, null, 2),
      "</role_skill>",
    "",
      "<output_contract>",
      "priority=output_contract>role_skill.identity>role_skill.style>runtime_policy>memory",
      "reply_channel=visible_dialogue_only",
      "default_sentence_count=1..3",
      "forbidden=markdown|bullet_list|analysis|meta_commentary|assistant_voice",
      "state_values_visibility=hidden",
      "profile_visibility=hidden",
      "speech_marker=[[SPEECH]]",
      "</output_contract>"
  ].join("\n");

  async function saveProfilePatch(patch: Partial<TrainingProfile>) {
    if (!activeProfile) return;
    const now = new Date().toISOString();
    const nextProfile: TrainingProfile = {
      ...activeProfile,
      ...patch,
      updatedAt: now
    };
    const nextProfiles = trainingProfiles.map((profile) =>
      profile.id === activeProfile.id ? nextProfile : profile
    );
    await updateState({
      trainingProfiles: nextProfiles,
      activeTrainingProfileId: nextProfile.id,
      ...(patch.character ? { character: nextProfile.character } : {}),
      ...(patch.documents ? { documents: nextProfile.documents } : {}),
      ...(patch.memories ? { memories: nextProfile.memories } : {})
    });
  }

  async function saveService(
    service: "llm" | "asr" | "tts",
    patch: Partial<AppSettings["services"]["llm"]>
  ) {
    await updateState({
      settings: {
        ...currentState.settings,
        services: {
          ...currentState.settings.services,
          [service]: {
            ...currentState.settings.services[service],
            ...patch
          }
        }
      }
    });
  }

  async function testService(service: "llm" | "asr" | "tts") {
    setServiceResults((current) => ({ ...current, [service]: "正在连接..." }));
    const result = await window.deskPet.testService(service);
    setServiceResults((current) => ({
      ...current,
      [service]: result.ok ? "连接正常" : result.error || "无法连接"
    }));
  }

  async function saveTrainingConfig(
    patch: Partial<NonNullable<TrainingProfile["trainingConfig"]>>
  ) {
    if (!activeProfile) return;
    await saveProfilePatch({
      trainingConfig: {
        baseModel:
          activeProfile.trainingConfig?.baseModel ||
          "Qwen/Qwen2.5-7B-Instruct",
        epochs: activeProfile.trainingConfig?.epochs || 3,
        learningRate: activeProfile.trainingConfig?.learningRate || 0.0002,
        batchSize: activeProfile.trainingConfig?.batchSize || 1,
        maxLength: activeProfile.trainingConfig?.maxLength || 1024,
        ...patch
      }
    });
  }

  async function startTraining() {
    if (!activeProfile || trainingBusy) return;
    setTrainingBusy(true);
    try {
      const result = await window.deskPet.startTraining(activeProfile.id);
      if (!result.ok) {
        window.alert(result.error || "训练启动失败。");
      }
    } finally {
      setTrainingBusy(false);
    }
  }

  async function importVoiceModule() {
    const result = await window.deskPet.importVoiceSample();
    if (!result.state) return;
    setAudioSrc("");
    if (!activeProfile) return;
    const latestId = (result.state.voiceProfiles || []).at(-1)?.id;
    if (!latestId) return;
    setSelectedVoiceProfileId(latestId);
    await saveProfilePatch({
      voiceProfileIds: [
        ...new Set([...(activeProfile.voiceProfileIds || []), latestId])
      ]
    });
  }

  async function createVoiceModuleFromCharacter() {
    if (!activeProfile) return;
    const source =
      (activeProfile.voiceProfileIds || [])
        .map((id) =>
          currentState.voiceProfiles.find((profile) => profile.id === id)
        )
        .find(Boolean) || currentState.voiceProfiles[0];
    if (!source) {
        window.alert("当前角色档案还没有可用作声音来源的角色声音档案。");
      return;
    }
    const now = new Date().toISOString();
    const nextVoice = {
      ...source,
      id: makeId("voice"),
      name: `${activeProfile.name} 声音模块`,
      createdAt: now
    };
    await updateState({
      voiceProfiles: [nextVoice, ...currentState.voiceProfiles],
      trainingProfiles: trainingProfiles.map((profile) =>
        profile.id === activeProfile.id
          ? {
              ...profile,
              voiceProfileIds: [
                ...new Set([...(profile.voiceProfileIds || []), nextVoice.id])
              ],
              updatedAt: now
            }
          : profile
      )
    });
    setSelectedVoiceProfileId(nextVoice.id);
    setActiveTab("voice");
  }

  async function deleteVoiceModule() {
    if (!selectedVoiceProfile) return;
    if (!window.confirm(`确定删除声音模块“${selectedVoiceProfile.name}”吗？`)) {
      return;
    }
    await updateState({
      voiceProfiles: currentState.voiceProfiles.filter(
        (profile) => profile.id !== selectedVoiceProfile.id
      ),
      trainingProfiles: trainingProfiles.map((profile) => ({
        ...profile,
        voiceProfileIds: (profile.voiceProfileIds || []).filter(
          (id) => id !== selectedVoiceProfile.id
        )
      }))
    });
    setSelectedVoiceProfileId("");
  }

  async function updateVoiceProfile(
    voiceProfileId: string,
    patch: Partial<(typeof currentState.voiceProfiles)[number]>
  ) {
    await updateState({
      voiceProfiles: currentState.voiceProfiles.map((profile) =>
        profile.id === voiceProfileId ? { ...profile, ...patch } : profile
      )
    });
  }

  async function saveCharacter(patch: Partial<CharacterProfile>) {
    await saveProfilePatch({
      character: { ...profileCharacter, ...patch }
    });
  }

  async function addDocument(document: Omit<TrainingDocument, "id" | "createdAt">) {
    if (!document.content.trim()) return;
    await saveProfilePatch({
      documents: [
        {
          ...document,
          id: makeId("document"),
          createdAt: new Date().toISOString()
        },
        ...profileDocuments
      ]
    });
  }

  async function importTextFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setDocumentTitle(file.name.replace(/\.[^.]+$/, ""));
    setDocumentText(content);
    event.target.value = "";
  }

  async function addMemory() {
    if (!memoryText.trim()) return;
    await saveProfilePatch({
      memories: [
        {
          id: makeId("memory"),
          title: memoryTitle.trim() || "未命名记忆",
          content: memoryText.trim(),
          importance: 3,
          createdAt: new Date().toISOString()
        },
        ...profileMemories
      ]
    });
    setMemoryTitle("");
    setMemoryText("");
  }

  async function selectTrainingProfile(profile: TrainingProfile) {
    await updateState({
      activeTrainingProfileId: profile.id,
      character: profile.character,
      documents: profile.documents,
      memories: profile.memories
    });
    setActiveTab("profile");
  }

  async function createTrainingProfile() {
    const now = new Date().toISOString();
    const nextProfile: TrainingProfile = {
      id: makeId("training"),
      name: "新角色档案",
      petId: currentState.activePetId,
      status: "draft",
      localModelId: "",
      character: {
        ...currentState.character,
        name: "新角色"
      },
      documents: [],
      memories: [],
      voiceProfileIds: [],
      aiModuleIds: [],
      createdAt: now,
      updatedAt: now
    };
    await updateState({
      trainingProfiles: [nextProfile, ...trainingProfiles],
      activeTrainingProfileId: nextProfile.id,
      character: nextProfile.character,
      documents: [],
      memories: []
    });
    setActiveTab("profile");
  }

  async function duplicateTrainingProfile() {
    if (!activeProfile) return;
    const now = new Date().toISOString();
    const copy: TrainingProfile = {
      ...activeProfile,
      id: makeId("training"),
      name: `${activeProfile.name} 副本`,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      documents: activeProfile.documents.map((document) => ({
        ...document,
        id: makeId("document")
      })),
      memories: activeProfile.memories.map((memory) => ({
        ...memory,
        id: makeId("memory")
      }))
    };
    await updateState({
      trainingProfiles: [copy, ...trainingProfiles],
      activeTrainingProfileId: copy.id,
      character: copy.character,
      documents: copy.documents,
      memories: copy.memories
    });
    setActiveTab("profile");
  }

  async function deleteTrainingProfile() {
    if (!activeProfile) return;
    if (!window.confirm(`确定删除“${activeProfile.name}”吗？`)) return;
    const remaining = trainingProfiles.filter(
      (profile) => profile.id !== activeProfile.id
    );
    const nextActive = remaining[0] || null;
    await updateState({
      trainingProfiles: remaining,
      activeTrainingProfileId: nextActive?.id || "",
      character: nextActive?.character || currentState.character,
      documents: nextActive?.documents || [],
      memories: nextActive?.memories || []
    });
    setActiveTab("profile");
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = draftMessage.trim();
    if (!content || chatBusy) return;

    const userMessage: ChatMessage = {
      id: makeId("chat"),
      role: "user",
      content,
      createdAt: new Date().toISOString()
    };
    const assistantMessage: ChatMessage = {
      id: makeId("chat"),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString()
    };
    const nextMessages = [...messages, userMessage];
    setMessages([...nextMessages, assistantMessage]);
    setDraftMessage("");
    setChatBusy(true);
    const requestId = makeId("chatreq");
    const unsubscribe = window.deskPet.onChatStream(
      ({ delta, requestId: incomingId }) => {
        if (!delta) return;
        if (incomingId && incomingId !== requestId) return;
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, content: `${message.content}${delta}` }
              : message
          )
        );
      }
    );

    try {
      const response = await window.deskPet.chatStream(
        nextMessages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        activeProfile?.id,
          requestId,
          currentState.activePetId
      );
      const completedAssistant: ChatMessage = {
        ...assistantMessage,
        content: response.text,
        source: response.source,
        warning: response.warning,
        speech: response.speech,
        createdAt: new Date().toISOString()
      };
      const completed = [...nextMessages, completedAssistant];
      setMessages(completed);
      const interactionTime = Date.now();
      const chatPet =
        currentState.pets.find(
          (item) => item.id === currentState.activePetId
        ) || currentState.pets[0];
      if (chatPet) {
        const nextVitals = appendWellbeingEvent(
          recordWellbeingInteraction(
            ensurePetVitals(chatPet, profileCharacter),
            profileCharacter,
            "chat",
            interactionTime
          ),
          "chat",
          "完成了一次角色对话，关系与主动性有所提升。",
          interactionTime
        );
        await window.deskPet.applyPetPatch(chatPet.id, {
          vitals: nextVitals
        });
      }
      await updateState({
        conversations: [
          ...currentState.conversations,
          userMessage,
          completedAssistant
        ].slice(-80),
        stats: {
          ...currentState.stats,
          chatCount: currentState.stats.chatCount + 1
        }
      });
    } finally {
      unsubscribe();
      setChatBusy(false);
    }
  }

  async function playVoice(
    text: string,
    targetVoice = (activeProfile?.voiceProfileIds || [])
      .map((id) =>
        currentState.voiceProfiles.find((profile) => profile.id === id)
      )
      .find(Boolean) || currentState.voiceProfiles[0]
  ) {
    if (!text.trim() || voiceBusy) return;
    setVoiceBusy(true);
    try {
      const result = await window.deskPet.speak(
        text,
        targetVoice?.voiceId,
        targetVoice
          ? {
              baseUrl: targetVoice.baseUrl,
              model: targetVoice.model,
              apiKey: targetVoice.apiKey,
              voiceId: targetVoice.voiceId,
              voiceProfileId: targetVoice.id,
              engineType: targetVoice.engineType,
              referenceText: targetVoice.referenceText
            }
          : undefined
      );
      if (result.ok && result.audioDataUrl) {
        setAudioSrc(result.audioDataUrl);
      } else {
        window.alert(result.error || "声音服务没有返回音频。");
      }
    } finally {
      setVoiceBusy(false);
    }
  }

  return (
    <div className="training-layout">
      <div className="training-tabs" role="tablist" aria-label="AI 训练区域">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              className={activeTab === tab.id ? "training-tab training-tab--active" : "training-tab"}
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={18} />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="training-workspace">
        <aside className="training-profile-panel">
          <div className="panel-heading">
            <Brain size={18} />
            <h3>模块库</h3>
          </div>
          <div className="training-profile-list">
            <div className="module-library-section-title">角色档案</div>
            {trainingProfiles
              .filter((profile) => profile.status !== "draft")
              .map((profile) => (
              <button
                className={
                  profile.id === activeProfile?.id
                    ? "pet-list-item pet-list-item--active"
                    : "pet-list-item"
                }
                key={profile.id}
                type="button"
                onClick={() => void selectTrainingProfile(profile)}
              >
                <span
                  className="pet-dot"
                  style={{
                    background:
                      profile.status === "ready"
                        ? "#2b9a67"
                        : profile.status === "training"
                          ? "#f59f38"
                          : "#8c98aa"
                  }}
                />
                <div>
                  <strong>{profile.name}</strong>
                  <span>
                    {profile.documents.length} 份资料 ·{" "}
                    {profile.memories.length} 条记忆
                  </span>
                </div>
                <span
                  className={
                    profile.status === "ready"
                      ? "summoned-dot summoned-dot--active"
                      : "summoned-dot"
                  }
                />
              </button>
              ))}
            {trainingProfiles.filter((profile) => profile.status !== "draft")
              .length === 0 && (
                <p className="empty-copy">还没有保存到库的角色档案。</p>
            )}
            <div className="module-library-section-title">声音模块</div>
            {currentState.voiceProfiles.map((profile) => (
              <button
                className={
                  profile.id === selectedVoiceProfileId
                    ? "pet-list-item pet-list-item--active"
                    : "pet-list-item"
                }
                key={profile.id}
                type="button"
                onClick={async () => {
                  setSelectedVoiceProfileId(profile.id);
                  setActiveTab("voice");
                  await updateState({
                    pets: currentState.pets.map((pet) =>
                      pet.id === currentState.activePetId
                        ? { ...pet, modulePlugins: { ...pet.modulePlugins, voiceProfileId: profile.id } }
                        : pet
                    )
                  });
                }}
              >
                <span className="pet-dot" style={{ background: "#4f88b8" }} />
                <div>
                  <strong>{profile.name}</strong>
                  <span>{profile.samples.length} 个声音样本</span>
                </div>
                <span className="summoned-dot" />
              </button>
            ))}
            {currentState.voiceProfiles.length === 0 && (
              <p className="empty-copy">还没有声音模块。</p>
            )}
          </div>
        </aside>

        <section className="training-main">
          {activeTab === "profile" && profileEditorOpen && (
            <div className="profile-editor-backdrop">
              <section className="profile-editor-dialog">
                <div className="profile-editor-dialog-header">
                  <div>
                    <span className="section-kicker">角色专属档案</span>
                      <h2>{activeProfile?.name || "角色档案"}</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setProfileEditorOpen(false)}
                  >
                    关闭
                  </button>
                </div>
                <div className="form-section">
              <div className="section-heading">
                  <span className="section-kicker">角色档案</span>
                  <h2>制作角色档案</h2>
                <p>
                    角色档案负责稳定的身份、性格和语言方式，相当于角色 Skill。精力、主动性、关系属于运行时状态，会在每次文字/语音对话时动态追加为 Prompt，并且不会覆盖角色档案。
                </p>
              </div>
              <div className="form-grid">
                <label>
                  <span>角色名</span>
                  <input
                    key={`${profileCharacter.name}-name`}
                    defaultValue={profileCharacter.name}
                    onBlur={(event) => saveCharacter({ name: event.target.value })}
                  />
                </label>
                <label>
                  <span>身份</span>
                  <input
                    key={`${profileCharacter.role}-role`}
                    defaultValue={profileCharacter.role}
                    onBlur={(event) => saveCharacter({ role: event.target.value })}
                  />
                </label>
                <label className="full-field">
                  <span>性格</span>
                  <textarea
                    key={`${profileCharacter.personality}-personality`}
                    defaultValue={profileCharacter.personality}
                    rows={3}
                    onBlur={(event) => saveCharacter({ personality: event.target.value })}
                  />
                </label>
                <label className="full-field">
                  <span>说话方式</span>
                  <textarea
                    key={`${profileCharacter.speakingStyle}-style`}
                    defaultValue={profileCharacter.speakingStyle}
                    rows={3}
                    onBlur={(event) => saveCharacter({ speakingStyle: event.target.value })}
                  />
                </label>
                <label className="full-field">
                  <span>世界观与经历</span>
                  <textarea
                    key={`${profileCharacter.worldview}-world`}
                    defaultValue={profileCharacter.worldview}
                    rows={3}
                    onBlur={(event) => saveCharacter({ worldview: event.target.value })}
                  />
                </label>
                <label>
                  <span>核心在意的事情</span>
                  <input
                    key={`${profileCharacter.likes}-likes`}
                    defaultValue={profileCharacter.likes}
                    placeholder="例如：守护重要的人，维持秩序，探索未知..."
                    onBlur={(event) => saveCharacter({ likes: event.target.value })}
                  />
                </label>
                <label>
                  <span>抗拒与弱点</span>
                  <input
                    key={`${profileCharacter.dislikes}-dislikes`}
                    defaultValue={profileCharacter.dislikes}
                    placeholder="例如：害怕被抛弃，不愿承认失败..."
                    onBlur={(event) => saveCharacter({ dislikes: event.target.value })}
                  />
                </label>
                <label className="full-field">
                  <span>与用户的关系</span>
                  <textarea
                    key={`${profileCharacter.boundaries}-boundaries`}
                    defaultValue={profileCharacter.boundaries}
                    rows={3}
                    placeholder="例如：把用户当作并肩作战的搭档，但不会无条件服从..."
                    onBlur={(event) => saveCharacter({ boundaries: event.target.value })}
                  />
                </label>
              </div>
              {activeProfile && (
                <div className="profile-archive-footer">
                  <label>
                      <span>角色档案名称</span>
                    <input
                      key={`${activeProfile.id}-${activeProfile.name}`}
                      defaultValue={activeProfile.name}
                      onBlur={(event) => {
                        const name = event.target.value.trim() || "未命名档案";
                        if (name !== activeProfile.name) {
                          void saveProfilePatch({ name });
                        }
                      }}
                    />
                  </label>
                  {profileNameError && (
                    <span className="name-error">名字已存在</span>
                  )}
                  <button
                    type="button"
                    onClick={() => void duplicateTrainingProfile()}
                  >
                    <Copy size={16} />
                      复制角色档案
                  </button>
                  <button
                    className="profile-archive-delete"
                    type="button"
                    disabled={trainingProfiles.length <= 1}
                    onClick={() => void deleteTrainingProfile()}
                  >
                    <Trash2 size={16} />
                      删除角色档案
                  </button>
                </div>
              )}
              <div className="profile-editor-complete">
                <button
                  type="button"
                  onClick={() => setProfileEditorOpen(false)}
                >
                  完成并生成 Skill
                </button>
              </div>
                </div>
              </section>
            </div>
          )}

          {activeTab === "documents" && (
            <div className="form-section">
              <div className="section-heading">
                <span className="section-kicker">资料投喂</span>
                <h2>添加故事、设定和台词资料</h2>
                <p>这些资料会作为角色参考，不会在第一版直接改动模型权重。</p>
              </div>
              <div className="document-composer">
                <label>
                  <span>资料标题</span>
                  <input
                    value={documentTitle}
                    onChange={(event) => setDocumentTitle(event.target.value)}
                    placeholder="例如：角色过去的一段经历"
                  />
                </label>
                <label>
                  <span>资料内容</span>
                  <textarea
                    value={documentText}
                    onChange={(event) => setDocumentText(event.target.value)}
                    rows={8}
                    placeholder="粘贴故事、对话样本、角色背景或世界观资料..."
                  />
                </label>
                <div className="composer-actions">
                  <label className="file-button">
                    <FilePlus2 size={17} />
                    导入文本文件
                    <input
                      type="file"
                      accept=".txt,.md,.json"
                      onChange={importTextFile}
                    />
                  </label>
                  <button
                    className="primary-small"
                    type="button"
                    onClick={async () => {
                      await addDocument({
                        title: documentTitle.trim() || "未命名资料",
                        kind: "story",
                        content: documentText
                      });
                      setDocumentTitle("");
                      setDocumentText("");
                    }}
                  >
                    <Plus size={17} />
                    添加资料
                  </button>
                </div>
              </div>
              <div className="record-list">
                {profileDocuments.map((document) => (
                  <article className="record-row" key={document.id}>
                    <div>
                      <strong>{document.title}</strong>
                      <p>{document.content.slice(0, 150)}</p>
                    </div>
                    <button
                      type="button"
                      title="删除资料"
                      onClick={() =>
                        void saveProfilePatch({
                          documents: profileDocuments.filter(
                            (item) => item.id !== document.id
                          )
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                ))}
                {profileDocuments.length === 0 && (
                  <p className="empty-copy">还没有投喂资料。</p>
                )}
              </div>
            </div>
          )}

          {activeTab === "memories" && (
            <div className="form-section">
              <div className="section-heading">
                <span className="section-kicker">长期记忆</span>
                <h2>只保存值得记住的事情</h2>
                <p>这里的内容更容易进入角色上下文，建议保持精简、明确、可修改。</p>
              </div>
              <div className="memory-composer">
                <input
                  value={memoryTitle}
                  onChange={(event) => setMemoryTitle(event.target.value)}
                  placeholder="记忆标题"
                />
                <textarea
                  value={memoryText}
                  onChange={(event) => setMemoryText(event.target.value)}
                  rows={3}
                  placeholder="例如：用户不喜欢频繁弹出轻松玩笑，工作时希望桌宠安静一点。"
                />
                <button className="primary-small" type="button" onClick={addMemory}>
                  <Plus size={17} />
                  添加记忆
                </button>
              </div>
              <div className="record-list">
                {profileMemories.map((memory) => (
                  <article className="record-row" key={memory.id}>
                    <div>
                      <strong>{memory.title}</strong>
                      <p>{memory.content}</p>
                    </div>
                    <button
                      type="button"
                      title="删除记忆"
                      onClick={() =>
                        void saveProfilePatch({
                          memories: profileMemories.filter(
                            (item) => item.id !== memory.id
                          )
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                ))}
              </div>
            </div>
          )}

          {activeTab === "chat" && (
            <div className="form-section chat-test-section">
              <div className="section-heading">
                <span className="section-kicker">对话测试</span>
                <h2>检查角色是否保持自己的性格</h2>
                <p>本地模型不可用时会使用内置角色回应，方便先测试页面和记忆结构。</p>
              </div>
              <div className="chat-module-selector">
                <label>
                    <span>用于本次文字对话的角色档案</span>
                  <select
                    value={activeProfile?.id || ""}
                    onChange={(event) => {
                      const profile = trainingProfiles.find(
                        (item) => item.id === event.target.value
                      );
                      if (!profile) return;
                      setMessages([]);
                      void selectTrainingProfile(profile);
                    }}
                  >
                      <option value="">请选择角色档案</option>
                    {trainingProfiles
                      .filter((profile) => profile.status !== "draft")
                      .map((profile) => (
                        <option value={profile.id} key={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                  </select>
                </label>
                <span>
                  {activeProfile
                    ? `Skill：${activeProfile.character.name || activeProfile.name}`
                    : "保存角色档案后才会出现在这里"}
                </span>
              </div>
              <form
                className="composer-inline chat-test-composer"
                onSubmit={sendMessage}
              >
                <input
                  value={draftMessage}
                  autoFocus
                  onChange={(event) => setDraftMessage(event.target.value)}
                  placeholder="说点什么..."
                />
                <button type="submit" disabled={chatBusy || !draftMessage.trim()}>
                  <Send size={17} />
                </button>
              </form>
              <div className="conversation-panel">
                {messages.length === 0 && (
                  <div className="conversation-empty">
                    <MessageCircle size={28} />
                    <p>从一句话开始，测试角色语气、边界和主动性。</p>
                  </div>
                )}
                {messages.map((message) => (
                  <div
                    className={
                      message.role === "user"
                        ? "message-row message-row--user"
                        : "message-row"
                    }
                    key={message.id}
                  >
                    <div className="message-bubble">
                      <p>{message.content}</p>
                      <div className="message-meta">
                        <span>
                          {message.role === "user" ? "你" : profileCharacter.name}
                        </span>
                        {message.role === "assistant" && (
                          <button
                            type="button"
                            disabled={voiceBusy}
                            onClick={() => playVoice(message.content)}
                          >
                            <Volume2 size={14} />
                            播放语音
                          </button>
                        )}
                      </div>
                      {message.warning && <small>{message.warning}</small>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "voice" && (
            <VoiceModuleView
              selectedVoiceProfileId={selectedVoiceProfileId}
              onSelectVoiceProfile={setSelectedVoiceProfileId}
            />
          )}
          {activeTab === "models" && <ModelManagerView />}

          {false && activeTab === "voice" && (
            <div className="form-section">
              <div className="section-heading">
                <span className="section-kicker">声音档案</span>
                <h2>把角色声线交给本地语音引擎</h2>
                <p>
                  桌宠负责保存声音样本并调用本机 GPT-SoVITS。首次试听会自动启动 CPU
                  引擎，需要等待模型加载。
                </p>
              </div>
              {(["tts", "asr"] as const).map((service) => {
                const config = currentState.settings.services[service];
                return (
                  <div className="service-config" key={service}>
                    <div className="service-config-heading">
                      <div>
                        {service === "tts" ? (
                          <Volume2 size={18} />
                        ) : (
                          <Mic size={18} />
                        )}
                        <strong>
                          {service === "tts" ? "语音合成接口" : "语音识别接口"}
                        </strong>
                      </div>
                      <span>{serviceResults[service] || "未测试"}</span>
                    </div>
                    <div className="service-fields">
                      <label>
                        <span>服务地址</span>
                        <input
                          defaultValue={config.baseUrl}
                          key={`${service}-${config.baseUrl}`}
                          onBlur={(event) =>
                            saveService(service, {
                              baseUrl: event.target.value
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>
                          {service === "tts" ? "声线 ID" : "模型名称"}
                        </span>
                        <input
                          defaultValue={
                            service === "tts"
                              ? config.voiceId || ""
                              : config.model
                          }
                          key={`${service}-${config.model}-${config.voiceId || ""}`}
                          onBlur={(event) =>
                            saveService(
                              service,
                              service === "tts"
                                ? { voiceId: event.target.value }
                                : { model: event.target.value }
                            )
                          }
                        />
                      </label>
                      <button type="button" onClick={() => testService(service)}>
                        测试连接
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="voice-test-panel">
                <div>
                  <strong>
                    当前测试：{selectedVoiceProfile?.name || "未选择声音模块"}
                  </strong>
                  <span>
                    {selectedVoiceProfile
                      ? `${selectedVoiceProfile.samples.length} 个样本 · ${
                          selectedVoiceProfile.status === "ready"
                            ? "可用"
                            : selectedVoiceProfile.status === "analyzing"
                              ? "分析中"
                              : "草稿"
                        }`
                      : "请先在左侧选择声音模块"}
                  </span>
                </div>
                <textarea
                  value={voiceTestText}
                  onChange={(event) => setVoiceTestText(event.target.value)}
                  rows={3}
                  placeholder="输入要试听的话..."
                />
                <button
                  className="primary-small"
                  type="button"
                  disabled={!selectedVoiceProfile || voiceBusy}
                  onClick={() =>
                    void playVoice(voiceTestText, selectedVoiceProfile)
                  }
                >
                  <Volume2 size={16} />
                  {voiceBusy ? "正在合成..." : "播放试听"}
                </button>
              </div>
              <div className="voice-actions">
                <button
                  className="wide-secondary"
                  type="button"
                  onClick={() => void importVoiceModule()}
                >
                  <AudioLines size={17} />
                  导入声音样本
                </button>
                <button
                  className="wide-secondary"
                  type="button"
                  onClick={async () => {
                    const result = await window.deskPet.importTrainingAudio();
                    if (result.ok && result.text) {
                      setDocumentTitle("语音识别文本");
                      setDocumentText(result.text);
                      setActiveTab("documents");
                    } else if (!result.canceled) {
                      window.alert(result.error || "语音识别失败。");
                    }
                  }}
                >
                  <Mic size={17} />
                  用本地语音识别转写
                </button>
              </div>
              <div className="voice-profile-list">
                {currentState.voiceProfiles.map((profile) => (
                  <article
                    className={
                      profile.id === selectedVoiceProfile?.id
                        ? "voice-profile voice-profile--editor voice-profile--active"
                        : "voice-profile voice-profile--editor"
                    }
                    key={profile.id}
                    onClick={() => setSelectedVoiceProfileId(profile.id)}
                  >
                    <div>
                      <strong>{profile.name}</strong>
                      <span>
                        {profile.samples.length} 个样本 ·{" "}
                        {profile.status === "ready" ? "可用" : "草稿"}
                      </span>
                    </div>
                    <label>
                      <span>模块名称</span>
                      <input
                        defaultValue={profile.name}
                      onBlur={(event) => {
                        const name = event.target.value.trim() || "声音模块";
                        void updateVoiceProfile(profile.id, { name });
                      }}
                      />
                    </label>
                    <label>
                      <span>引擎类型</span>
                      <select
                        defaultValue={profile.engineType || "api"}
                        onChange={(event) =>
                          void updateVoiceProfile(profile.id, {
                            engineType: event.target.value as
                              | "api"
                              | "local"
                              | "gpt-sovits"
                          })
                        }
                      >
                        <option value="api">API 接口</option>
                        <option value="gpt-sovits">GPT-SoVITS</option>
                        <option value="local">本地模型（预留）</option>
                      </select>
                    </label>
                    <label>
                      <span>服务地址</span>
                      <input
                        defaultValue={profile.baseUrl || ""}
                        placeholder="例如：http://127.0.0.1:9880/v1"
                        onBlur={(event) =>
                          void updateVoiceProfile(profile.id, {
                            baseUrl: event.target.value
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>模型名称</span>
                      <input
                        defaultValue={profile.model || ""}
                        placeholder="本地 TTS 模型名，可留空"
                        onBlur={(event) =>
                          void updateVoiceProfile(profile.id, {
                            model: event.target.value
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>引擎声线 ID</span>
                      <input
                        defaultValue={profile.voiceId}
                        placeholder="例如：my-oc"
                        onBlur={(event) =>
                          void updateVoiceProfile(profile.id, {
                            voiceId: event.target.value
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>API Key</span>
                      <input
                        defaultValue={profile.apiKey || ""}
                        placeholder="本地服务通常留空"
                        onBlur={(event) =>
                          void updateVoiceProfile(profile.id, {
                            apiKey: event.target.value
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>本地模型路径</span>
                      <input
                        defaultValue={profile.localModelPath || ""}
                        placeholder="预留：本地声线模型目录"
                        onBlur={(event) =>
                          void updateVoiceProfile(profile.id, {
                            localModelPath: event.target.value
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>参考音频文本</span>
                      <input
                        defaultValue={profile.referenceText || ""}
                        placeholder="参考音频里说的原话，GPT-SoVITS 需要"
                        onBlur={(event) =>
                          void updateVoiceProfile(profile.id, {
                            referenceText: event.target.value
                          })
                        }
                      />
                    </label>
                    <label className="voice-profile-link">
                      <input
                        type="checkbox"
                        checked={
                          (activeProfile?.voiceProfileIds || []).includes(
                            profile.id
                          )
                        }
                        onChange={(event) => {
                          const currentIds =
                            activeProfile?.voiceProfileIds || [];
                          const nextIds = event.target.checked
                            ? [...new Set([...currentIds, profile.id])]
                            : currentIds.filter((id) => id !== profile.id);
                          void saveProfilePatch({ voiceProfileIds: nextIds });
                        }}
                      />
                      <span>用于当前档案</span>
                    </label>
                    <button
                      className="primary-small"
                      type="button"
                      disabled={voiceBusy}
                      onClick={() =>
                        playVoice(
                          profileCharacter.name + "正在测试当前角色声线。",
                          profile
                        )
                      }
                    >
                      <Volume2 size={16} />
                      测试声线
                    </button>
                  </article>
                ))}
                {currentState.voiceProfiles.length === 0 && (
                  <p className="empty-copy">还没有声音样本。</p>
                )}
              </div>
              <div className="library-save-row">
                <button
                  className="library-save-button"
                  type="button"
                  disabled={!selectedVoiceProfile}
                  onClick={async () => {
                    if (!selectedVoiceProfile) return;
                    await updateState({
                      voiceProfiles: currentState.voiceProfiles.map((profile) =>
                        profile.id === selectedVoiceProfile.id
                          ? { ...profile }
                          : profile
                      )
                    });
                  }}
                >
                  <Save size={16} />
                  保存到库
                </button>
                <button
                  className="library-save-button"
                  type="button"
                  disabled={!selectedVoiceProfile}
                  onClick={async () => {
                    if (!selectedVoiceProfile) return;
                    await updateState({
                      voiceProfiles: currentState.voiceProfiles.map((profile) =>
                        profile.id === selectedVoiceProfile.id
                          ? { ...profile }
                          : profile
                      )
                    });
                  }}
                >
                  <Save size={16} />
                  保存到库
                </button>
                {selectedVoiceProfile && (
                  <button
                    className="library-delete-button"
                    type="button"
                    title="删除声音模块"
                    onClick={() => void deleteVoiceModule()}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          )}

          {activeTab === "profile" && (
            <div className="form-section">
              <div className="section-heading">
                <span className="section-kicker">AI 模块</span>
                <h2>把训练完成的行为模块挂到当前档案</h2>
                <p>
                  以后训练好的本地 AI 模块会出现在这里。挂到档案后，桌宠可以通过模组插件调用。
                </p>
              </div>
              <div className="module-source-card">
                <div>
                  <span>训练来源角色档案</span>
                  <strong>{activeProfile?.name || "未选择角色档案"}</strong>
                  <button
                    type="button"
                    disabled={!activeProfile}
                    onClick={() => setProfileEditorOpen(true)}
                  >
                    编辑档案
                  </button>
                </div>
                <p>
                    角色 Skill 保持稳定；运行时 Prompt 会根据当前桌宠的状态变化。
                    两者会按“角色 Skill 优先，状态只调整语气”的顺序一起送入模型。
                </p>
                <label className="module-skill-preview">
                    <span>角色 Skill（稳定，不随状态变化）</span>
                  <textarea
                    readOnly
                    value={activeSkillPrompt}
                    rows={8}
                  />
                </label>
                  <label className="module-skill-preview">
                    <span>运行时 Prompt（自动生成，不保存）</span>
                    <textarea
                      readOnly
                      value={runtimePromptPreview}
                      rows={6}
                    />
                  </label>
              </div>
              {false && (
              <div className="service-config">
                <div className="service-config-heading">
                  <div>
                    <Radio size={18} />
                    <strong>AI 训练与对话接口</strong>
                  </div>
                  <span>{serviceResults.llm || "未测试"}</span>
                </div>
                <div className="service-fields">
                  <label>
                    <span>接口地址</span>
                    <input
                      defaultValue={currentState.settings.services.llm.baseUrl}
                      key={`llm-${currentState.settings.services.llm.baseUrl}`}
                      onBlur={(event) =>
                        saveService("llm", { baseUrl: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>模型名称</span>
                    <input
                      defaultValue={currentState.settings.services.llm.model}
                      key={`llm-${currentState.settings.services.llm.model}`}
                      onBlur={(event) =>
                        saveService("llm", { model: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>API Key</span>
                    <input
                      defaultValue={currentState.settings.services.llm.apiKey}
                      key={`llm-${currentState.settings.services.llm.apiKey}`}
                      placeholder="本地服务可留空"
                      onBlur={(event) =>
                        saveService("llm", { apiKey: event.target.value })
                      }
                    />
                  </label>
                  <button type="button" onClick={() => testService("llm")}>
                    测试连接
                  </button>
                </div>
              </div>
              )}
              <section className="ai-model-selector">
                <div className="ai-model-selector-heading">
                  <div>
                    <span className="section-kicker">本地对话模型</span>
                    <strong>选择已经导入的 AI 模型</strong>
                    <p>
                      这里只读取“模型管理”中已经登记的模型，不会再次打开文件选择窗口。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab("models")}
                  >
                    <Package size={16} />
                    打开模型管理
                  </button>
                </div>
                {(() => {
                  if (
                    currentState.settings.services.llm.mode === "api"
                  ) {
                    return (
                      <div className="ai-model-choice">
                        <div>
                          <strong>当前使用 API 模式</strong>
                          <span>
                            对话请求会发送到模型管理里配置的 API 服务，不需要选择本地模型。
                          </span>
                        </div>
                      </div>
                    );
                  }
                  const llmModels = currentState.localModels.filter(
                    (model) =>
                      model.kind === "llm" &&
                      model.status === "ready" &&
                      model.format !== "api"
                  );
                  const selectedModel = llmModels.find(
                    (model) =>
                      model.id ===
                      (activeProfile?.localModelId ||
                        currentState.localInference.llmModelId)
                  );
                  if (llmModels.length === 0) {
                    return (
                      <div className="ai-model-empty">
                        <strong>还没有可用的 AI 模型</strong>
                        <span>
                          请先到“模型管理 → 对话模型”导入 Qwen、DeepSeek
                          或其他已下载模型。
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div className="ai-model-choice">
                      <label>
                        <span>已导入模型</span>
                        <select
                          value={
                            activeProfile?.localModelId ||
                            currentState.localInference.llmModelId
                          }
                          onChange={(event) => {
                            void saveProfilePatch({
                              localModelId: event.target.value
                            });
                            void window.deskPet.voiceAgent.setModel(
                              "llm",
                              event.target.value
                            );
                          }}
                        >
                          <option value="">请选择对话模型</option>
                          {llmModels.map((model) => (
                            <option value={model.id} key={model.id}>
                              {model.name}
                              {model.parameterSize
                                ? ` · ${model.parameterSize}`
                                : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div>
                        <strong>
                          {selectedModel?.name || "尚未选择模型"}
                        </strong>
                        <span>
                          {selectedModel
                            ? `${selectedModel.family || "本地模型"} · ${
                                selectedModel.format
                              }`
                            : "选择后会立即用于对话测试"}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </section>

              {false && (
              <div className="ai-training-placeholder">
                <strong>AI 训练区</strong>
                <span>
                  训练会使用当前 AI 模块的角色资料，调用本地 Python
                  环境执行 LoRA 微调，并把结果保存到本机 AI 模块目录。
                </span>
                <div className="training-config-grid">
                  <label>
                    <span>基础模型</span>
                    <input
                      defaultValue={
                        activeProfile?.trainingConfig?.baseModel ||
                        "Qwen/Qwen2.5-7B-Instruct"
                      }
                      key={`${activeProfile?.id}-base-model`}
                      onBlur={(event) =>
                        void saveTrainingConfig({
                          baseModel: event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>训练轮数</span>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      defaultValue={
                        activeProfile?.trainingConfig?.epochs || 3
                      }
                      onBlur={(event) =>
                        void saveTrainingConfig({
                          epochs: Number(event.target.value) || 3
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>学习率</span>
                    <input
                      type="number"
                      step="0.00001"
                      defaultValue={
                        activeProfile?.trainingConfig?.learningRate || 0.0002
                      }
                      onBlur={(event) =>
                        void saveTrainingConfig({
                          learningRate: Number(event.target.value) || 0.0002
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>上下文长度</span>
                    <input
                      type="number"
                      min="256"
                      max="8192"
                      defaultValue={
                        activeProfile?.trainingConfig?.maxLength || 1024
                      }
                      onBlur={(event) =>
                        void saveTrainingConfig({
                          maxLength: Number(event.target.value) || 1024
                        })
                      }
                    />
                  </label>
                </div>
                <div className="training-actions">
                  <button
                    type="button"
                    disabled={!activeProfile || trainingBusy}
                    onClick={() => void startTraining()}
                  >
                    {trainingBusy ? "正在启动..." : "开始本地训练"}
                  </button>
                  {activeProfile && (
                    <button
                      type="button"
                      onClick={() =>
                        window.deskPet.openTrainingFolder(activeProfile.id)
                      }
                    >
                      打开训练目录
                    </button>
                  )}
                </div>
              </div>
              )}
              {false && (
              <div className="voice-profile-list">
                {(currentState.aiModules || []).map((module) => (
                  <article className="voice-profile" key={module.id}>
                    <div>
                      <strong>{module.name}</strong>
                      <span>
                        {module.status === "ready"
                          ? "可调用"
                          : module.status === "training"
                            ? "训练中"
                            : "草稿"}
                      </span>
                    </div>
                    <label className="voice-profile-link">
                      <input
                        type="checkbox"
                        checked={
                          (activeProfile?.aiModuleIds || []).includes(module.id)
                        }
                        onChange={(event) => {
                          const currentIds = activeProfile?.aiModuleIds || [];
                          const nextIds = event.target.checked
                            ? [...new Set([...currentIds, module.id])]
                            : currentIds.filter((id) => id !== module.id);
                          void saveProfilePatch({ aiModuleIds: nextIds });
                        }}
                      />
                      <span>用于当前档案</span>
                    </label>
                  </article>
                ))}
                {(currentState.aiModules || []).length === 0 && (
                  <p className="empty-copy">
                    还没有训练完成的 AI 模块。这个位置已经预留好接口。
                  </p>
                )}
              </div>
              )}
              <div className="library-save-row">
                <div className="save-delete-row">
                  <button
                    className="library-save-button"
                    type="button"
                    disabled={!activeProfile}
                    onClick={async () => {
                      if (!activeProfile) return;
                      await saveProfilePatch({ status: "ready" });
                    }}
                  >
                    <Save size={16} />
                    保存到库
                  </button>
                  {activeProfile && (
                    <button
                      className="library-delete-button"
                      type="button"
                      title="删除 AI 模块"
                      onClick={() => void deleteTrainingProfile()}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                <button
                  className="library-save-button"
                  type="button"
                  onClick={async () => {
                    const now = new Date().toISOString();
                    const baseName = "新角色档案";
                    const others = trainingProfiles.map((p) => p.name);
                    const uniqueName = makeUniqueName(baseName, others);
                    const nextProfile: TrainingProfile = {
                      id: makeId("training"),
                      name: uniqueName,
                      petId: currentState.activePetId,
                      status: "draft",
                      localModelId: "",
                      character: { ...currentState.character, name: "新角色" },
                      documents: [],
                      memories: [],
                      voiceProfileIds: [],
                      aiModuleIds: [],
                      createdAt: now,
                      updatedAt: now
                    };
                    await updateState({
                      trainingProfiles: [nextProfile, ...trainingProfiles],
                      activeTrainingProfileId: nextProfile.id,
                      character: nextProfile.character,
                      documents: [],
                      memories: []
                    });
                    setProfileEditorOpen(true);
                  }}
                >
                  <Plus size={16} />
                  创建角色档案
                </button>
              </div>
            </div>
          )}
        </section>

      </div>

      {audioSrc && <audio className="audio-player" src={audioSrc} controls autoPlay />}
    </div>
  );
}
