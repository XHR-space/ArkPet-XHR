# ArkPet 2.1.0 User Guide

Applies to: ArkPet 2.1.0  
Document type: Standalone user guide, not part of the application UI

This guide is written for both first-time users and advanced users who want to configure local AI, custom voice, and modules. Follow the basic workflow first, then continue into the AI, voice, and extension chapters as needed.

## About This Guide

This is not just a list of buttons. It follows the order in which most users set up and expand ArkPet:

1. Understand what ArkPet is and how it differs from a normal chat application.
2. Learn how to launch the app, summon pets, and interact with them on the desktop.
3. Create characters and configure animation, hitbox, and desktop behavior.
4. Build stable character profiles so different characters have different personalities.
5. Connect local AI, speech recognition, and GPT-SoVITS speech synthesis.
6. Install official modules or create your own extension modules.
7. Manage data, backups, updates, and common problems.

## 1. What Makes ArkPet Different

ArkPet is a local-first desktop character workspace. It separates desktop rendering, character personality, voice, modules, and local AI services into independent layers, then binds those layers per character.

### 1.1 Local-first by design

- Character profiles, voice samples, model paths, dialogue settings, and pet state are stored on your computer.
- The app does not require an account or cloud login, except when you explicitly check for updates, download official resources, or connect to an API you configured.
- Closing the management window leaves the desktop pet running. To fully quit, use **Data & Settings → App Control → Quit App**.

### 1.2 Independent multi-pet state

- Each pet has its own name, animations, desktop position, energy, initiative, relationship, and chat window.
- Pets can use different character profiles, voice modules, and modules.
- Multiple pets can stay on the desktop at the same time. The chat window you click last receives keyboard input.

### 1.3 Stable desktop interaction

- The visual overlay remains mouse-transparent. Only the actual character interaction region receives clicks and drags.
- Context menus, automatic text bubbles, full text chat, and voice indicators are anchored to the visible character.
- Full text chat opens in a normal window. It is not always-on-top and does not lock other applications.

### 1.4 A gradual path from simple companion to local AI

- Even without AI models, a pet can display, move, react, play animations, and use pre-recorded voice clips.
- After binding a character profile, the pet can speak in its own personality through text or voice chat.
- After binding a voice module, the pet can use the complete **ASR → LLM → TTS** pipeline.

### 1.5 Modules update separately from the app

- Official modules live in a repository module registry and can be downloaded or updated separately.
- Users can import a local module folder or archive that follows the module format.
- Modules call ArkPet through the restricted `window.arkpet` API for pets, chat, notifications, storage, and window controls.

## 2. Install, Launch, and Main UI

### 2.1 First launch

1. Run `ArkPet Setup 2.1.0.exe`.
2. Launch ArkPet after installation.
3. The app opens on **Home Overview** by default after a full restart.
4. User data is stored under `data/user-data` in the software directory. App updates replace program files while preserving this folder.

The portable edition can be started directly with `ArkPet Portable 2.1.0.exe`. Portable and installed editions keep data relative to their own program location.

### 2.2 Main navigation

The left sidebar contains six pages:

- **Home Overview**: pet status, relationship, time spent, recent activity, and local capability status.
- **Pet Behavior Control**: movement, idle actions, gravity, display scale, and pet encounter behavior.
- **Pet Workshop**: character list, character creation, animations, voice clips, module bindings, and advanced layout.
- **Personal AI Training**: character profiles, text chat testing, voice modules, and local model management.
- **Module Manager**: install official modules, import local modules, enable/disable modules, and edit module settings.
- **Data & Settings**: themes, local services, data folders, backups, automatic updates, and app exit.

### 2.3 Summon and recall a pet

Open **Pet Workshop**. The top-right button follows the current pet state:

- **Release from Window**: summon the selected pet to the desktop.
- **Recall and Sleep**: remove the selected pet from the desktop.

The pet appears on the primary display and normally lands on the top edge of the taskbar.

### 2.4 Close or quit

- Closing the management window hides ArkPet to the background while the pet keeps running.
- Double-click the desktop pet to show the management window again.
- **Data & Settings → App Control → Quit App** fully stops the management window, desktop pet, and background service connections.

## 3. Basic Desktop Pet Use

### 3.1 Mouse controls

- **Click and drag**: move the pet. On release, it keeps momentum and lands on the desktop or taskbar edge.
- **Single-click**: interact normally without freezing other applications.
- **Double-click**: open the ArkPet management window.
- **Right-click**: open the context menu for that pet.

The context menu can include:

- **Text Chat**: open the full chat window for that specific pet.
- **Desktop Sleep**: keep the pet on the desktop but switch it to a sleeping state.
- **Recall and Sleep**: remove it from the desktop.
- Bound module entries, such as auxiliary windows, dialog skins, or climbing tools.

### 3.2 Home Overview

You can switch pets with the arrows or by swiping the character area. The page shows:

- Mood, energy, initiative, and relationship stage.
- Time spent on the desktop today and total time spent.
- Relationship value. The maximum is 200.
- Custom module metrics, such as hunger.
- Local dialogue, speech recognition, and speech synthesis status.
- Recent character activity.

Quick actions:

- **Pet**: slightly increases relationship and initiative.
- **Chat for a while**: opens the full text chat window for that pet.
- **Rest**: puts the pet into desktop sleep mode.

### 3.3 Automatic text and automatic voice

In **Pet Workshop**, the character action panel has independent toggles:

- **Automatic Text**: the AI may generate compact text bubbles on the desktop.
- **Automatic Voice**: controls AI voice and random pre-recorded character voice playback.

The two switches are independent. Manual text chat from the context menu still works when automatic text is disabled.

## 4. Desktop Behavior Control

### 4.1 Movement physics

Settings include:

- **Walk Speed**: changes both travel distance and walking animation speed.
- **Ground Friction**: controls how quickly throw momentum fades. It does not change normal walking.
- **Wall Bounce**: controls how strongly the pet bounces from the left and right screen edges.
- **Ground Bounce**: controls how strongly the pet bounces after landing.

Use **Restore Defaults** to reset these four values.

### 4.2 Idle actions

- When enabled, ArkPet checks for an idle action at the configured interval.
- A higher trigger chance makes idle actions more frequent.
- Once an idle action starts, it finishes unless interrupted by dragging.
- You can disable idle actions completely without disabling normal walking.

### 4.3 Gravity lock

- **Gravity locked**: the pet normally stays near the ground.
- **Gravity unlocked**: the pet can leave the ground and move freely across the desktop.

### 4.4 Display scale

**Pet Size** is a global scale from 60% to 160%. It changes only the displayed size. It does not modify movement speed, friction, or per-character display and hitbox data.

### 4.5 Multiple pets meeting

**Pass-through chance** controls what happens when pets overlap:

- Higher values: pets are more likely to pass through each other on different layers.
- Lower values: pets are more likely to collide and move apart.

### 4.6 Quick-control modules

Global quick-control modules can be added on the right side of **Pet Behavior Control**. Dialog skins and other modules can expose size, background, or open actions here.

## 5. Creating Characters and Animations

### 5.1 Create a Spine character

In **Pet Workshop**, choose **New Pet** and import:

1. The `.skel` skeleton file.
2. The `.atlas` file.
3. The texture-page PNG declared by the atlas.

ArkPet accepts Spine 3.8 skeletons. After import, it reads animation names and prepares the texture according to the atlas requirements.

### 5.2 Action bindings

After creating the character, bind animations for:

- Idle
- Walk
- Fall
- Land
- Drag
- Sleep

Each action can use a generic animation or a named animation from the character. Click **Play** to preview it.

### 5.3 Name uniqueness

Names must be unique inside the same category:

- Pet names must be unique in the pet list.
- Character-profile names must be unique in the profile library.
- Voice-module names must be unique in the voice library.
- Different categories may reuse the same name.

If a duplicate name is entered, ArkPet shows **Name already exists**. If the name is not changed before saving, ArkPet automatically appends a number.

### 5.4 Pre-recorded character voice

**Character Voice** is for fixed audio clips played randomly on the desktop:

- Only WAV is currently accepted.
- You can set the playback interval and probability.
- A scheduled playback may still be skipped by the probability check.
- Each clip can be previewed or removed independently.

Pre-recorded voice and AI-generated voice are separate systems. Pre-recorded voice does not require AI or a voice model.

### 5.5 Module bindings

Each pet has three binding slots:

- **Voice Plugin**: selects the voice module that determines how the pet sounds.
- **Character Profile**: selects the stable identity, personality, and speaking style used for replies.
- **Modules**: adds external module entries that appear in the right-click menu.

Text chat is unavailable when no character profile is bound. Dynamic speech is unavailable when no voice module is bound; text replies can still be displayed.

## 6. Advanced Character Settings

Open **Pet Workshop → Advanced Settings**. The edited pet freezes temporarily so positions can be adjusted precisely.

### 6.1 Three editor modes

- **Character Position**: moves the character inside the display frame.
- **Collision Area**: adjusts the actual desktop click and drag region.
- **Display Frame**: controls the canvas area reserved for animations.

### 6.2 Recommended order

1. Adjust the display frame first so animations have enough room.
2. Adjust character position so the character sits correctly inside the frame.
3. Adjust the collision area last so clicks match the visible body.
4. Click **Save Advanced Settings** when finished.

Changing the collision area does not move the visible character. Moving the character position also moves the collision offset, so the two areas do not need constant recalibration.

### 6.3 Drag and cancel

- Drag operations update a local draft with at most one update per animation frame.
- Press `Esc` to cancel the current drag and restore the previous values.
- Releasing outside the window, losing focus, or receiving a pointer cancel safely ends the session.
- Nothing is written to the character until you click Save.

### 6.4 Unsaved changes

- Leaving advanced settings, switching characters, or closing the app prompts you when unsaved changes exist.
- Session drafts remain available when you return from another page in the same session.
- Switching characters offers Save, Discard, or Cancel.

## 7. Character Profiles and AI Personality

Open **Personal AI Training → Character Profile**.

### 7.1 Character Skill and runtime prompt

ArkPet separates character AI into two layers:

- **Character Skill / Profile**: stable identity, personality, speaking style, worldview, likes, weaknesses, and relationship boundaries.
- **Runtime Prompt**: generated from current energy, initiative, and relationship. It does not overwrite the profile.

This is more stable and easier to maintain than putting everything into one long prompt.

### 7.2 Recommended profile fields

- Name and role.
- Personality: specific and stable traits.
- Speaking style: address terms, tone, sentence length, verbal habits, and boundaries.
- Worldview and history.
- Core values.
- Dislikes and weaknesses.
- Relationship with the user, such as partner, subordinate, friend, or cautious collaborator.

The profile is the character's baseline. Low energy, initiative, or relationship changes expression and willingness, but should not turn the character into someone else.

### 7.3 Reference documents and long-term memory

The profile data structure supports documents and long-term memories:

- Documents are for stories, settings, dialogue samples, and worldview notes.
- Memories are for preferences, agreements, and important experiences that should remain in context.
- Keep both concise and explicit. Do not insert every chat message.

### 7.4 Text chat testing

Use **Text Chat** to test a profile. When no model is available, ArkPet can use a built-in character reply so the page, memory structure, and character boundaries can still be tested.

## 8. Local AI and Model Management

Open **Personal AI Training → Model Management**.

### 8.1 Three model roles

- **TTS**: turns text into speech.
- **ASR**: turns recorded speech into text.
- **LLM**: generates text replies from the character profile and context.

Each capability can use local mode or API mode. LLM API mode accepts an API address, model name, and API key.

### 8.2 Import local models

- ArkPet does not automatically download large language models.
- LLM mode accepts one `.safetensors` file or a complete model folder.
- ASR mode accepts a local model folder.
- ArkPet checks required files and registers valid models in the model library.
- A ready model can be activated with **Set as Current Model**.

### 8.3 Dialogue model compatibility

Qwen and DeepSeek receive first-class support in this release. GGUF, Llama, Mistral, and Gemma have the same integration point and can be enabled later through adapters.

### 8.4 Service connection tests

In **Data & Settings → Local AI**, configure:

- LLM service address and model name.
- ASR service address and model name.
- TTS service address and voice ID.

Click **Test Connection** after starting the local services.

## 9. Voice Modules and Speech Synthesis

Open **Personal AI Training → Voice Module**.

### 9.1 Voice engine and weights

ArkPet uses local GPT-SoVITS as its primary speech synthesis engine.

You need:

1. The official GPT-SoVITS package, about 6.4 GB.
2. GPT `.ckpt` weights.
3. SoVITS `.pth` weights.

Setup order:

1. Click **Download Voice Engine from Official Source**.
2. Extract it and click **Select Local Engine Folder**.
3. Restart ArkPet after the engine location changes.
4. Download or import `.ckpt` and `.pth`.
5. The custom voice weights activate after both files are present.

### 9.2 Import voice samples

Supported sample formats:

- WAV
- MP3
- M4A
- FLAC
- OGG
- WEBM

Use clean, reverberation-free, single-speaker reference audio. Filling in **Reference Audio Transcript** makes the voice more stable.

### 9.3 Save a voice module

1. Create a new voice module.
2. Enter its name and the reference transcript.
3. Add voice samples.
4. Select a default AI module.
5. Click **Save Voice Module**.

The module appears in the voice library only after saving.

### 9.4 How voice and character profiles relate

- The voice module controls **how the pet sounds**.
- The character profile controls **what the pet says and how it speaks**.
- The pet's voice-plugin binding connects both layers to that pet.

### 9.5 Voice training

Training requires:

- At least three audio clips or more than one minute of total audio.
- A transcript for every clip.
- A working CUDA 12.8 training environment.

Workflow:

1. Click **Add Training Audio**.
2. Transcribe with Whisper or enter the original words manually.
3. Check total duration and clip count.
4. Click **Prepare Training Data**.
5. Continue with the training workflow when the environment is ready.

Whisper output can be edited. Proofreading every clip is recommended.

### 9.6 Audio formats

- Synthesized speech is currently output as WAV.
- Voice samples and training material support MP3.
- Random pre-recorded character clips currently accept WAV only.

### 9.7 Full voice conversation

The complete pipeline is:

```text
Microphone recording
→ ASR speech recognition
→ LLM reply based on the character profile
→ TTS synthesis with the bound voice
→ Audio playback
```

Voice conversation requires:

- A bound character profile.
- A bound voice module.
- A working ASR service or local model.
- A working TTS service and voice weights.

## 10. Module Management

Open **Module Manager**.

### 10.1 Install official modules

1. Click **Open Official Module Library**.
2. ArkPet reads the repository module registry.
3. Click **Install** or **Update**.
4. Installed modules appear in the local module library.
5. Official module updates do not require a new app release.

### 10.2 Import local modules

You can import:

- A folder containing `module.json` or `manifest.json`.
- A compatible archive.

After importing, bind the module to a specific pet in **Pet Workshop → Module Plugins**. The context-menu entry appears only after binding.

### 10.3 Module scope

- **Global module**: available to the app or the quick-control area.
- **Pet module**: bound to individual pets.

### 10.4 Module categories

- Dialog skin
- Auxiliary window
- Interaction module
- External extension

### 10.5 Basic module format

A module is a folder:

```text
my-module/
  module.json
  index.html
  other resources
```

Required items:

- `module.json`
- An entry page, `index.html` by default

Common fields:

- `id`: unique module identifier.
- `name`: display name.
- `version`: module version.
- `apiVersion`: currently 1.
- `type`: `interaction` or `dialog-box`.
- `scope`: `global` or `pet`.
- `category`: module category.
- `entry`: entry page.
- `contextMenuLabel`: context-menu text.
- `width`, `height`: initial window size.
- `quickControl`: whether it appears in the behavior quick-control area.

### 10.6 Module APIs

The entry page calls ArkPet through `window.arkpet`:

```text
arkpet.module.info()
arkpet.pets.list()
arkpet.pets.active()
arkpet.pets.onChanged(fn)
arkpet.pet.command({ type })
arkpet.chat.ask(text, petId?)
arkpet.voice.speak(text)
arkpet.storage.get / set / remove / keys
arkpet.activity.log(text)
arkpet.app.notify(title, body)
arkpet.app.openExternal(url)
arkpet.ui.setSize(w, h)
arkpet.ui.setTitle(text)
arkpet.ui.close()
```

Modules cannot directly access Node or the file system. They must use the ArkPet API.

## 11. Data, Settings, and Updates

### 11.1 Themes

**Data & Settings → Theme** provides:

- Default Workshop
- Violet
- Frost Blue
- Jade Green

Themes affect only the management UI. They do not modify character assets or the desktop rendering style.

### 11.2 Data locations

- **Software data folder**: the root ArkPet data folder.
- **User data subfolder**: `data/user-data` under the software folder.
- User data is preserved by automatic updates.

Main items:

- `desk-pet-state.json`: main state file.
- `pet-store/`: per-pet saves.
- `assets/`: character images, voice samples, and voice clips.

### 11.3 Backup and restore

- **Export Backup**: export the current user data.
- **Import Backup**: replace the current state after confirmation.
- **Save Per-Pet Files**: synchronize each pet into `pet-store`.
- **Open Pet Store**: open the per-pet save folder.

Export a backup before moving to another computer, reinstalling, or changing important characters.

### 11.4 Automatic updates

- ArkPet checks for new versions in the background.
- Once downloaded, an update can be installed immediately or applied on normal exit.
- Updates replace program files and preserve `data/user-data`.
- Development mode does not automatically install updates.

### 11.5 Manual check and exit

- **Check for Updates** checks immediately.
- **Update and Exit** appears only when an update is ready.
- **Quit App** is the action that really closes the background process and desktop pet.

## 12. Common Workflows

### 12.1 Minimum setup: show a pet on the desktop

1. Launch ArkPet.
2. Open **Pet Workshop**.
3. Select a character.
4. Click **Release from Window**.
5. Adjust speed, size, and idle actions in **Pet Behavior Control**.

### 12.2 Enable text chat

1. Fill in a profile under **Personal AI Training → Character Profile**.
2. Save it and generate the character Skill.
3. Configure a local LLM or API in **Model Management**.
4. Bind the profile under **Pet Workshop → Module Plugins → Character Profile**.
5. Right-click the pet and choose **Text Chat**.

### 12.3 Enable full voice conversation

1. Finish the text-chat setup.
2. Install GPT-SoVITS.
3. Import `.ckpt` and `.pth`.
4. Create and save a voice module.
5. Bind it under **Module Plugins → Voice Plugin**.
6. Configure an ASR service or local ASR model.
7. Use **Start Conversation** in the voice module to record, recognize, reply, and speak.

### 12.4 Create your own character

1. Prepare Spine 3.8 `.skel`, `.atlas`, and texture PNG files.
2. Create a pet and import the assets in **Pet Workshop**.
3. Bind idle, walk, fall, land, drag, and sleep animations.
4. Adjust display frame, character position, and collision area.
5. Save the character.
6. Bind a character profile and voice module.
7. Release it to the desktop and test it.

### 12.5 Develop a custom module

1. Create a module folder and write `module.json`.
2. Create `index.html`.
3. Use `window.arkpet` for pet, chat, or storage APIs.
4. Import the folder in **Module Manager** for testing.
5. Enable it and edit its settings.
6. Bind it under **Pet Workshop → Module Plugins**.
7. Right-click the pet to test the module entry.

## 13. Troubleshooting

### The pet does not appear on the desktop

- Confirm that you clicked **Release from Window**.
- Check whether the top-right button says **Release from Window**.
- Make sure the ArkPet window was not manually minimized or hidden by Windows.

### Text Chat is missing

The pet has no bound character profile. Open **Pet Workshop → Module Plugins** and bind one.

### A voice module exists but the pet does not speak

Check, in order:

1. Is GPT-SoVITS installed?
2. Are `.ckpt` and `.pth` imported?
3. Is the voice module saved?
4. Is that voice module bound to the pet?
5. Does the service test succeed?

### Can I import MP3 files?

Yes. Voice samples and training material support MP3. ArkPet decodes them internally with FFmpeg and processes the audio as WAV data.

### Why is the generated speech WAV?

The current GPT-SoVITS synthesis output is fixed to WAV and played directly. The upstream engine can support other formats, but ArkPet does not currently expose synthesized results as MP3.

### Why do random pre-recorded clips accept only WAV?

Pre-recorded clips are played directly rather than used as training samples. The selector currently exposes WAV only, so convert MP3 files to WAV before importing.

### The collision box does not match the character in advanced settings

- Make sure the display frame is large enough for the animation.
- Adjust character position so the character is placed correctly.
- Adjust the collision box last instead of using it to move the character.
- Click **Save Advanced Settings** when finished.
- A different animation can have a different visible silhouette. That is an animation change, not necessarily a synchronization error.

### A module is installed but does not appear

- Check whether it is enabled.
- Check whether its scope is global or per-pet.
- Bind per-pet modules to the correct pet.
- The context menu only lists enabled and bound modules.

### Will updates delete my data?

Normal updates do not. User data is stored in `data/user-data`, and updates replace only program files. Export a backup before major changes.

## 14. Quick Reference by Stage

| Stage | What you get | Main location |
|---|---|---|
| Basic | Display, movement, idle actions, interaction | Home Overview, Pet Behavior Control |
| Character | Custom assets, animations, display frame, collision area | Pet Workshop |
| AI | Stable profile and text replies | Personal AI Training → Character Profile / Model Management |
| Voice | Recognition, synthesis, and custom voice | Voice Module, GPT-SoVITS |
| Extension | Official and custom modules | Module Manager, Module Plugins |
| Maintenance | Themes, backup, restore, updates | Data & Settings |

## 15. Feature Summary

- **Local-first**: personality, voice, model settings, and data remain primarily on your computer.
- **Layered character AI**: the profile holds stable identity; the runtime prompt handles energy, initiative, and relationship.
- **Independent multi-pet state**: each pet can have its own profile, voice, animation, and chat.
- **Stable desktop interaction**: clicks, drags, and context menus do not pass through; chat uses normal windows; other applications are not locked.
- **Trainable voice**: reference audio works immediately, and training data can be prepared for a more stable voice.
- **Extensible modules**: official modules update independently, and users can create or import their own.
- **Data-safe updates**: program files are updated while the user-data folder is preserved.
