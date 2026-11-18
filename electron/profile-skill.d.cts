// electron/profile-skill.cjs 的伴生类型声明。
// 该文件是纯函数 CJS 模块：主进程用 require，渲染进程由 Vite 直接 import。
export type ProfileSkillParsed = {
  skill: Record<string, unknown>;
  contract: string;
  customBlocks: { name: string; content: string }[];
  extraSections: { tag: string; content: string }[];
};

/** 从档案生成基础 Skill：返回 { skill: JSON 对象, contract: 文本 }。 */
export function buildGeneratedSkill(profile: unknown): {
  skill: Record<string, unknown>;
  contract: string;
};

/** 档案生成版 ⊕ 手写覆盖 + custom_block 保留区块，输出最终提示词文本。 */
export function buildFinalSkillText(profile: unknown): string;

/** 深合并：override 叶子值覆盖 base。 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown>;

/** 字段级 diff：只保留 next 与 base 不同的叶子字段；无差异返回 undefined。 */
export function diffSkillField(
  base: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> | undefined;

/** 不可覆盖的对话输出规则。 */
export function fixedDialogueOnlyRules(): string[];

/** 解析 Skill 文本，成功返回 ok:true，失败返回 ok:false + error。 */
export function parseSkillText(
  text: string
):
  | ({ ok: true } & ProfileSkillParsed)
  | { ok: false; error: string };
